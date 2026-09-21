import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, conversationRoom, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { effectiveOwnerId } from '@/lib/convo-owner'

type Params = { params: Promise<{ conversationId: string }> }

/** Bulk-delete the newest messages in a DM or group DM. Everyone can purge
 *  their OWN recent messages; the effective owner of a group (or a site
 *  admin) can purge anyone's, optionally scoped to one member. Mirrors the
 *  channel purge route, including the messages:purge broadcast to every
 *  participant's user room so cached copies update everywhere. */
export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { conversationId } = await params
    const conversation = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, kind: true, name: true, ownerId: true },
    })
    if (!conversation) return notFound('Conversation not found.')

    const participants = await db.conversationParticipant.findMany({
      where: { conversationId },
      orderBy: { id: 'asc' },
      select: { id: true, userId: true },
    })
    if (participants.length === 0) return notFound('Conversation not found.')
    if (!participants.some((p) => p.userId === me.id)) {
      return forbidden('You are not part of this conversation.')
    }

    const body = await req.json()
    const count = typeof body.count === 'number' ? Math.floor(body.count) : 0
    const fromUserId = typeof body.userId === 'string' && body.userId ? body.userId : null
    if (count < 1 || count > 100) return badRequest('Purge between 1 and 100 messages at a time.')

    // power check: only the group's effective owner (or a site admin) may
    // delete other people's messages. DMs never grant that.
    const iOwn = conversation.kind === 'GROUP' && (effectiveOwnerId(conversation.ownerId, participants) === me.id || me.role === 'ADMIN')
    if (fromUserId && fromUserId !== me.id && !iOwn) {
      return forbidden('You can only purge your own messages here.')
    }
    const authorId = iOwn ? fromUserId : me.id

    // take one extra so the final take is exactly count, newest first
    const candidates = await db.message.findMany({
      where: { conversationId, ...(authorId ? { authorId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: count + 1,
      select: { id: true },
    })
    const targets = candidates.slice(0, count)
    if (targets.length === 0) return badRequest('Nothing to purge.')

    const ids = targets.map((m) => m.id)
    await db.message.deleteMany({ where: { id: { in: ids } } })

    // tell every subscriber in the room, plus every participant directly,
    // so cached copies of the conversation in other clients update even when
    // they are not currently viewing (and thus not subscribed to) this room
    const room = conversationRoom(conversationId)
    await emitToRooms(
      [room, ...participants.map((p) => userRoom(p.userId))],
      'messages:purge',
      { room, ids }
    )

    return NextResponse.json({ ok: true, deleted: ids.length })
  } catch {
    return serverError()
  }
}
