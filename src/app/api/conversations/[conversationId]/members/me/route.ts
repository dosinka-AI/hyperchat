import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { effectiveOwnerId } from '@/lib/convo-owner'

type Params = { params: Promise<{ conversationId: string }> }

export async function DELETE(_req: NextRequest, { params }: Params) {
  // leave a group: the participant row is actually removed (DMs use /hide,
  // which only hides and resurrects on the next message). When the leaver is
  // the effective owner, the oldest remaining member is promoted and the
  // ownership is persisted (legacy groups start with no stored owner).
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { conversationId } = await params
    const participant = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId: me.id } },
    })
    if (!participant) return notFound('Conversation not found.')
    const conversation = await db.conversation.findUnique({ where: { id: conversationId } })
    if (!conversation) return notFound('Conversation not found.')
    if (conversation.kind !== 'GROUP') {
      return forbidden('Direct messages are closed with the close button, not left.')
    }

    const rows = await db.conversationParticipant.findMany({
      where: { conversationId },
      orderBy: { id: 'asc' },
      select: { id: true, userId: true },
    })
    const wasOwner = effectiveOwnerId(conversation.ownerId, rows) === me.id

    await db.conversationParticipant.delete({ where: { id: participant.id } })

    const remaining = rows.filter((r) => r.userId !== me.id)
    if (remaining.length === 0) {
      // last one out: the whole group goes (messages cascade with it)
      await db.conversation.delete({ where: { id: conversationId } })
    } else {
      const successor = remaining[0].userId
      if (wasOwner && conversation.ownerId !== successor) {
        await db.conversation.update({
          where: { id: conversationId },
          data: { ownerId: successor },
        })
      }
      await emitToRooms(
        remaining.map((p) => userRoom(p.userId)),
        'conversation:new',
        { conversationId, group: true, memberLeft: me.username }
      )
    }

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
