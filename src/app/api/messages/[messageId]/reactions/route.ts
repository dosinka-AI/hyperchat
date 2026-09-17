import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { AUTHOR_INCLUDE, groupReactions, toClientMessage } from '@/lib/messages'
import { badRequest, channelRoom, conversationRoom, emitToRooms, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'

type Params = { params: Promise<{ messageId: string }> }

/** Accept any single emoji the picker can produce: pictographs, ZWJ sequences,
 *  skin-tone modifiers, variation selectors and keycaps. Caps runaway strings. */
function isValidEmoji(input: string): boolean {
  if (!input || input.length > 24) return false
   
  const ok = /^[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{20E3}\u{E0020}-\u{E007F}]+$/u
  return ok.test(input)
}

export async function POST(req: NextRequest, { params }: Params) {
  // toggle a reaction on/off
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { messageId } = await params
    const message = await db.message.findUnique({
      where: { id: messageId },
      include: { reactions: { select: { emoji: true, userId: true, createdAt: true, id: true }, orderBy: { createdAt: 'asc' } } },
    })
    if (!message) return notFound('Message not found.')

    // permission: channel messages need server membership, DMs need participation
    if (message.channelId) {
      const channel = await db.channel.findUnique({
        where: { id: message.channelId },
        select: { serverId: true },
      })
      const ctx = channel ? await getMemberContext(channel.serverId, me.id) : null
      if (!ctx) {
        return forbidden('You cannot react to that message.')
      }
      // a timeout silences every form of expression, reactions included
      if (ctx.timedOut) {
        const remaining = Math.max(1, Math.ceil((ctx.timeoutUntil!.getTime() - Date.now()) / 60000))
        return forbidden(`You are timed out in this server for ${remaining} more minute${remaining === 1 ? '' : 's'}.`)
      }
    } else if (message.conversationId) {
      const participant = await db.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId: message.conversationId, userId: me.id } },
      })
      if (!participant) return forbidden('You cannot react to that message.')
    } else {
      return badRequest('This message cannot be reacted to.')
    }

    const body = await req.json()
    const emoji = typeof body.emoji === 'string' ? body.emoji : ''

    // custom emoji: ":name:" tokens are valid inside the server that owns them
    const customMatch = emoji.match(/^:([a-z0-9_]{2,32}):$/)
    if (customMatch) {
      if (!message.channelId) return badRequest('Custom emoji react in servers only.')
      const channel = await db.channel.findUnique({
        where: { id: message.channelId },
        select: { serverId: true },
      })
      const name = customMatch[1]
      const exists = channel
        ? await db.serverEmoji.findUnique({
            where: { serverId_name: { serverId: channel.serverId, name } },
            select: { id: true },
          })
        : null
      if (!exists) return badRequest('That emoji does not exist in this server.')
    } else if (!isValidEmoji(emoji)) {
      return badRequest('Pick a reaction from the emoji picker.')
    }

    const existing = message.reactions.find((r) => r.emoji === emoji && r.userId === me.id)
    if (existing) {
      // find the actual row id through a targeted lookup
      const row = await db.reaction.findFirst({
        where: { messageId, userId: me.id, emoji },
      })
      if (row) await db.reaction.delete({ where: { id: row.id } })
    } else {
      try {
        // explicit ms-precision stamp: the DB default only carries whole
        // seconds, and rapid reactions in one second would tie and shuffle
        await db.reaction.create({ data: { messageId, userId: me.id, emoji, createdAt: new Date() } })
      } catch (err) {
        // two rapid toggles can race the unique (messageId, userId, emoji)
        // constraint: treat the duplicate as already-reacted instead of a 500
        if ((err as { code?: string })?.code !== 'P2002') throw err
      }
    }

    const fresh = await db.message.findUnique({
      where: { id: messageId },
      include: AUTHOR_INCLUDE,
    })
    if (!fresh) return notFound('Message not found.')

    const rooms: string[] = []
    if (fresh.channelId) rooms.push(channelRoom(fresh.channelId))
    if (fresh.conversationId) rooms.push(conversationRoom(fresh.conversationId))

    const payload = {
      messageId,
      room: rooms[0] ?? '',
      reactions: groupReactions(fresh.reactions),
    }
    await emitToRooms(rooms, 'message:reaction', payload)

    return NextResponse.json(payload)
  } catch {
    return serverError()
  }
}
