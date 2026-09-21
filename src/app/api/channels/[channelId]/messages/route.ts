import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import {
  AUTHOR_INCLUDE,
  applyMarkerSwap,
  containsMassMention,
  fetchMessagesAround,
  fetchMessagesFor,
  normalizeAttachments,
  serverAuthorDecorator,
  stripRichTokens,
  toClientMessage,
  validReplyToId,
} from '@/lib/messages'
import { badRequest, channelRoom, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'

type Params = { params: Promise<{ channelId: string }> }

async function channelForMember(channelId: string, userId: string) {
  const channel = await db.channel.findUnique({
    where: { id: channelId },
    include: { access: { select: { roleId: true } } },
  })
  if (!channel) return { channel: null, ctx: null }
  const ctx = await getMemberContext(channel.serverId, userId)
  if (!ctx) return { channel, ctx: 'forbidden' as const }
  return { channel, ctx }
}

/** Parse a server's blocked word list into lowercase tokens. */
function blockedWordList(raw: string | undefined | null): string[] {
  if (!raw) return []
  return raw
    .split(/[\n,]+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 2 && w.length <= 40)
}

export async function GET(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { channelId } = await params
    const { channel, ctx } = await channelForMember(channelId, me.id)
    if (!channel) return notFound('Channel not found.')
    if (!ctx || ctx === 'forbidden') return forbidden('You are not a member of this server.')
    if (!ctx.canReadChannel(channel)) return forbidden('This channel is limited to specific roles.')

    const before = req.nextUrl.searchParams.get('before') || undefined
    const after = req.nextUrl.searchParams.get('after') || undefined
    const anchor = req.nextUrl.searchParams.get('anchor') || undefined
    const decorate = await serverAuthorDecorator(channel.serverId)
    // my read stamp powers the NEW divider on entry
    const readState = await db.readState.findUnique({
      where: { userId_scopeKey: { userId: me.id, scopeKey: `channel:${channelId}` } },
    })
    // friends-only read receipts: each FRIEND of mine who is a member of
    // this channel's server and has read here — their latest stamp, so my
    // own messages can show "seen" chips without any polling. One query
    // pair per channel load, riding the existing read flow.
    const friendRows = await db.friendship.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [{ requesterId: me.id }, { addresseeId: me.id }],
      },
      select: { requesterId: true, addresseeId: true },
    })
    const friendIds = friendRows
      .map((f) => (f.requesterId === me.id ? f.addresseeId : f.requesterId))
      .filter((id) => id !== me.id)
    let friendReadAt: Record<string, string> = {}
    if (friendIds.length > 0) {
      const memberRows = await db.serverMember.findMany({
        where: { serverId: channel.serverId },
        select: { userId: true },
      })
      const memberIds = new Set(memberRows.map((m) => m.userId))
      const readRows = await db.readState.findMany({
        where: {
          scopeKey: `channel:${channelId}`,
          userId: { in: friendIds.filter((id) => memberIds.has(id)) },
        },
        select: { userId: true, lastReadAt: true },
      })
      friendReadAt = Object.fromEntries(readRows.map((r) => [r.userId, r.lastReadAt.toISOString()]))
    }
    if (anchor) {
      // permalink jump: a window centered on the anchor row instead of the
      // newest page; hasNewer drives the client's jump-to-present bar
      const res = await fetchMessagesAround(me.id, { channelId }, anchor, channelRoom(channelId), 12, decorate)
      if (!res) return notFound('Message not found.')
      return NextResponse.json({ ...res, myReadAt: readState ? readState.lastReadAt.toISOString() : null, friendReadAt })
    }
    const result = await fetchMessagesFor(me.id, { channelId }, channelRoom(channelId), before, 50, after, decorate)
    return NextResponse.json({ ...result, myReadAt: readState ? readState.lastReadAt.toISOString() : null, friendReadAt })
  } catch {
    return serverError()
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { channelId } = await params
    const { channel, ctx } = await channelForMember(channelId, me.id)
    if (!channel) return notFound('Channel not found.')
    if (!ctx || ctx === 'forbidden') return forbidden('You are not a member of this server.')

    // private channels: only allowed roles and moderators can post
    if (!ctx.canReadChannel(channel)) {
      return forbidden('This channel is limited to specific roles.')
    }

    // moderation timeout: temporary send block
    if (ctx.timedOut) {
      const remaining = Math.max(1, Math.ceil((ctx.timeoutUntil!.getTime() - Date.now()) / 60000))
      return forbidden(`You are timed out in this server for ${remaining} more minute${remaining === 1 ? '' : 's'}.`)
    }

    const canMod = hasPerm(ctx.perms, PERM.MANAGE_MESSAGES)

    // locked channels are read-only except for moderators
    if (channel.locked && !canMod) {
      return forbidden('This channel is locked. Only moderators can post here.')
    }

    const body = await req.json()
    const rawContent = typeof body.content === 'string' ? body.content.trim().slice(0, 2000) : ''
    const marker = applyMarkerSwap(rawContent, me.id)
    let content = marker.content
    const celebrate = marker.celebrate
    const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl : null
    const attachmentsJson = normalizeAttachments(body.attachments)
    const nonce = typeof body.nonce === 'string' ? body.nonce.slice(0, 64) : null

    // rich text (color + size tokens) is a permission in servers: senders
    // without it keep their words, lose the styling (dms and group chats
    // never pass through here and stay free)
    if (content && !hasPerm(ctx.perms, PERM.FANCY_FORMAT)) {
      content = stripRichTokens(content)
    }

    // thread: the reply rides under a root message of this same channel;
    // threads never nest (a thread row cannot root another thread)
    let threadOfId: string | null = null
    if (typeof body.threadOfId === 'string' && body.threadOfId) {
      const root = await db.message.findUnique({
        where: { id: body.threadOfId },
        select: { id: true, channelId: true, threadOfId: true, systemKind: true },
      })
      if (root && root.channelId === channelId && !root.threadOfId && !root.systemKind) {
        threadOfId = root.id
      } else {
        return badRequest('That thread does not exist here.')
      }
    }

    // thread replies carry their context in the panel: no separate reply chip, no whisper
    const replyToId = threadOfId ? null : await validReplyToId(body.replyToId, { channelId })

    // whisper: a private aside inside a server channel. The target must be
    // a member of the server; only the author + target sockets ever see it.
    // (threads have no whispers: the panel context is the conversation)
    let whisperTargetId: string | null = null
    let whisperTargetName: string | null = null
    const whisperTo = !threadOfId && typeof body.whisperTo === 'string' ? body.whisperTo.trim().replace(/^@/, '').toLowerCase() : ''
    if (whisperTo) {
      const target = await db.serverMember.findFirst({
        where: { serverId: channel.serverId, user: { username: whisperTo } },
        select: { userId: true, user: { select: { username: true } } },
      })
      if (!target) return badRequest('That person is not in this server.')
      whisperTargetId = target.userId
      whisperTargetName = target.user.username
    }

    // sticker: send a server sticker whole. The server looks the row up
    // (never trusts client name/url) and snapshots name+url onto the message.
    let stickerName: string | null = null
    let stickerUrl: string | null = null
    if (typeof body.stickerId === 'string' && body.stickerId) {
      const sticker = await db.sticker.findUnique({ where: { id: body.stickerId } })
      if (!sticker || sticker.serverId !== channel.serverId) {
        return badRequest('That sticker is not on this server.')
      }
      stickerName = sticker.name
      stickerUrl = sticker.url
    }

    if (!content && !imageUrl && !attachmentsJson && !stickerUrl) {
      return badRequest('Type a message or attach something.')
    }

    // slowmode: everyone except message managers waits between messages
    if (channel.slowmodeSeconds > 0 && !canMod) {
      const last = await db.message.findFirst({
        where: { channelId, authorId: me.id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })
      if (last) {
        const elapsed = (Date.now() - last.createdAt.getTime()) / 1000
        if (elapsed < channel.slowmodeSeconds) {
          const wait = Math.max(1, Math.ceil(channel.slowmodeSeconds - elapsed))
          return NextResponse.json(
            { error: `Slowmode is on. Wait ${wait} second${wait === 1 ? '' : 's'} before sending again.` },
            { status: 429 }
          )
        }
      }
    }

    // automod: server-defined blocked words
    if (content) {
      const words = blockedWordList(
        (await db.server.findUnique({ where: { id: channel.serverId }, select: { blockedWords: true } }))?.blockedWords
      )
      if (words.length > 0) {
        const haystack = content.toLowerCase()
        const hit = words.find((w) => haystack.includes(w))
        if (hit) {
          return badRequest(`Blocked by server automod: the word "${hit}" is not allowed here.`)
        }
      }
    }

    // @everyone / @here only ping when the sender holds the permission
    const pingsEveryone = !!content && containsMassMention(content) && hasPerm(ctx.perms, PERM.MENTION_EVERYONE)

    const message = await db.message.create({
      data: {
        channelId,
        authorId: me.id,
        content: content || null,
        imageUrl,
        attachments: attachmentsJson,
        replyToId,
        threadOfId,
        pingsEveryone,
        whisperTargetId,
        whisperTargetName,
        stickerName,
        stickerUrl,
      },
      include: AUTHOR_INCLUDE,
    })

    // sending marks the channel read for the author
    const now = new Date()
    await db.readState.upsert({
      where: { userId_scopeKey: { userId: me.id, scopeKey: `channel:${channelId}` } },
      create: { userId: me.id, scopeKey: `channel:${channelId}`, lastReadAt: now },
      update: { lastReadAt: now },
    })

    const room = channelRoom(channelId)
    const decorate = await serverAuthorDecorator(channel.serverId)
    // thread sends stamp the absolute thread size so every client sets the
    // root's bar instead of incrementing (echoes can arrive more than once)
    const threadTotal = threadOfId
      ? await db.message.count({ where: { threadOfId } })
      : undefined
    const payload = { ...toClientMessage(message, room, decorate), nonce, ...(threadTotal !== undefined ? { threadTotal } : {}), ...(celebrate ? { fx: true } : {}) }
    if (whisperTargetId) {
      // whispers skip the channel room: only the pair receives the echo
      await emitToRooms([userRoom(me.id), userRoom(whisperTargetId)], 'message:new', payload)
    } else {
      await emitToRooms([room], 'message:new', payload)
    }

    return NextResponse.json({ message: payload }, { status: 201 })
  } catch {
    return serverError()
  }
}
