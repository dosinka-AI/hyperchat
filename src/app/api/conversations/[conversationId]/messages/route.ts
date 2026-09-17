import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import {
  AUTHOR_INCLUDE,
  fetchMessagesAround,
  fetchMessagesFor,
  normalizeAttachments,
  toClientMessage,
  validReplyToId,
  applyMarkerSwap,
} from '@/lib/messages'
import {
  badRequest,
  conversationRoom,
  emitToRooms,
  forbidden,
  notFound,
  serverError,
  unauthorized,
  userRoom,
} from '@/lib/realtime'

type Params = { params: Promise<{ conversationId: string }> }

async function getParticipantIds(conversationId: string): Promise<string[] | null> {
  const participants = await db.conversationParticipant.findMany({
    where: { conversationId },
    select: { userId: true },
  })
  return participants.length ? participants.map((p) => p.userId) : null
}

/** Blocks gate DMs in both directions, including inside existing chats. */
async function dmIsBlocked(conversationId: string, senderId: string): Promise<boolean> {
  const others = await db.conversationParticipant.findMany({
    where: { conversationId, userId: { not: senderId } },
    select: { userId: true },
  })
  if (others.length === 0) return false
  const block = await db.userBlock.findFirst({
    where: {
      OR: others.flatMap((o) => [
        { blockerId: senderId, blockedId: o.userId },
        { blockerId: o.userId, blockedId: senderId },
      ]),
    },
  })
  return !!block
}

export async function GET(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { conversationId } = await params
    const participantIds = await getParticipantIds(conversationId)
    if (!participantIds) return notFound('Conversation not found.')
    if (!participantIds.includes(me.id)) return forbidden('You are not part of this conversation.')

    const before = req.nextUrl.searchParams.get('before') || undefined
    const after = req.nextUrl.searchParams.get('after') || undefined
    const anchor = req.nextUrl.searchParams.get('anchor') || undefined
    // temporary-message expiry stamps ride along so clients (and probes) can
    // see when each row auto-deletes; null / absent = permanent
    const expiryRows = await db.message.findMany({
      where: { conversationId, expiresAt: { not: null } },
      select: { id: true, expiresAt: true },
    })
    const expiryAt = new Map(expiryRows.map((r) => [r.id, r.expiresAt ? r.expiresAt.toISOString() : null]))
    if (anchor) {
      // permalink jump: window centered on the anchor row
      const res = await fetchMessagesAround(me.id, { conversationId }, anchor, conversationRoom(conversationId))
      if (!res) return notFound('Message not found.')
      const readStateAnchor = await db.readState.findUnique({
        where: { userId_scopeKey: { userId: me.id, scopeKey: `conversation:${conversationId}` } },
      })
      const messagesAnchor = res.messages.map((m) => ({
        ...m,
        expiresAt: expiryAt.get(m.id) ?? null,
      }))
      return NextResponse.json({
        ...res,
        messages: messagesAnchor,
        myReadAt: readStateAnchor ? readStateAnchor.lastReadAt.toISOString() : null,
      })
    }
    const result = await fetchMessagesFor(me.id, { conversationId }, conversationRoom(conversationId), before, 50, after)
    const messages = result.messages.map((m) => ({
      ...m,
      expiresAt: expiryAt.get(m.id) ?? null,
    }))
    // my read stamp powers the NEW divider on entry
    const readState = await db.readState.findUnique({
      where: { userId_scopeKey: { userId: me.id, scopeKey: `conversation:${conversationId}` } },
    })
    return NextResponse.json({ ...result, messages, myReadAt: readState ? readState.lastReadAt.toISOString() : null })
  } catch {
    return serverError()
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { conversationId } = await params
    const participantIds = await getParticipantIds(conversationId)
    if (!participantIds) return notFound('Conversation not found.')
    if (!participantIds.includes(me.id)) return forbidden('You are not part of this conversation.')
    if (await dmIsBlocked(conversationId, me.id)) {
      return forbidden('You cannot message this user.')
    }

    // temporary messages (1:1 DMs): every new message carries its expiry
    const conversation = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { kind: true, tempExpiryMinutes: true },
    })
    const expiresAt =
      conversation && conversation.kind === 'DM' && conversation.tempExpiryMinutes
        ? new Date(Date.now() + conversation.tempExpiryMinutes * 60 * 1000)
        : null

    const body = await req.json()
    const rawContent = typeof body.content === 'string' ? body.content.trim().slice(0, 2000) : ''
    const { content, celebrate } = applyMarkerSwap(rawContent, me.id)
    const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl : null
    const attachmentsJson = normalizeAttachments(body.attachments)
    // client nonce for optimistic sends: echoed back, never persisted
    const nonce = typeof body.nonce === 'string' ? body.nonce.slice(0, 64) : null

    // thread: the reply rides under a root message of this same conversation
    let threadOfId: string | null = null
    if (typeof body.threadOfId === 'string' && body.threadOfId) {
      const root = await db.message.findUnique({
        where: { id: body.threadOfId },
        select: { id: true, conversationId: true, threadOfId: true, systemKind: true },
      })
      if (root && root.conversationId === conversationId && !root.threadOfId && !root.systemKind) {
        threadOfId = root.id
      } else {
        return badRequest('That thread does not exist here.')
      }
    }

    const replyToId = threadOfId ? null : await validReplyToId(body.replyToId, { conversationId })

    // whisper: /whisper lands as a private row only the author + target see.
    // the target must be a participant (group) — in a 1:1 DM a whisper is
    // just the message itself, so it degrades to a normal send. Threads
    // have no whispers: the panel context is the conversation.
    let whisperTargetId: string | null = null
    let whisperTargetName: string | null = null
    const whisperTo = !threadOfId && typeof body.whisperTo === 'string' ? body.whisperTo.trim().replace(/^@/, '').toLowerCase() : ''
    if (whisperTo) {
      const target = participantIds.length > 2
        ? await db.user.findUnique({
            where: { username: whisperTo },
            select: { id: true, username: true },
          })
        : null
      if (!target || !participantIds.includes(target.id)) {
        return badRequest('That person is not in this conversation.')
      }
      whisperTargetId = target.id
      whisperTargetName = target.username
    }

    if (!content && !imageUrl && !attachmentsJson) {
      return badRequest('Type a message or attach something.')
    }

    const message = await db.message.create({
      data: {
        conversationId,
        authorId: me.id,
        content: content || null,
        imageUrl,
        attachments: attachmentsJson,
        replyToId,
        threadOfId,
        expiresAt,
        whisperTargetId,
        whisperTargetName,
      },
      include: AUTHOR_INCLUDE,
    })

    // a new message un-hides the conversation for everyone in it
    await db.conversationParticipant.updateMany({
      where: { conversationId, hidden: true },
      data: { hidden: false },
    })

    // sending marks the conversation read for the author
    const now = new Date()
    await db.readState.upsert({
      where: { userId_scopeKey: { userId: me.id, scopeKey: `conversation:${conversationId}` } },
      create: { userId: me.id, scopeKey: `conversation:${conversationId}`, lastReadAt: now },
      update: { lastReadAt: now },
    })

    const room = conversationRoom(conversationId)
    // expiry stamp rides on the payload (and the socket echo) so temporary
    // messages are visible as such from the moment they land
    // thread sends also stamp the absolute thread size: clients set the root's
    // bar to it instead of incrementing (echoes can arrive more than once)
    const threadTotal = threadOfId
      ? await db.message.count({ where: { threadOfId } })
      : undefined
    const payload = {
      ...toClientMessage(message, room),
      nonce,
      expiresAt: message.expiresAt ? message.expiresAt.toISOString() : null,
      ...(threadTotal !== undefined ? { threadTotal } : {}),
      ...(celebrate ? { fx: true } : {}),
    }
    if (whisperTargetId) {
      // whispers bypass the room entirely: only the two involved sockets hear it
      await emitToRooms([userRoom(me.id), userRoom(whisperTargetId)], 'message:new', payload)
    } else {
      await emitToRooms([room, ...participantIds.map((id) => userRoom(id))], 'message:new', payload)
    }

    return NextResponse.json({ message: payload }, { status: 201 })
  } catch {
    return serverError()
  }
}
