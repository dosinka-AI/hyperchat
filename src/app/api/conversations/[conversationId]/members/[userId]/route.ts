import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { effectiveOwnerId } from '@/lib/convo-owner'

type Params = { params: Promise<{ conversationId: string; userId: string }> }

export async function DELETE(_req: NextRequest, { params }: Params) {
  // kick a member from a group: the owner (or a site admin) removes someone
  // else's participant row; leaving is the separate members/me route
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { conversationId, userId } = await params
    const participant = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId: me.id } },
    })
    if (!participant) return notFound('Conversation not found.')
    const conversation = await db.conversation.findUnique({ where: { id: conversationId } })
    if (!conversation) return notFound('Conversation not found.')
    if (conversation.kind !== 'GROUP') {
      return forbidden('Only groups can kick members.')
    }

    if (userId === me.id) {
      return forbidden('Leave the group yourself instead.')
    }

    const rows = await db.conversationParticipant.findMany({
      where: { conversationId },
      orderBy: { id: 'asc' },
      select: { id: true, userId: true },
    })
    const owner = effectiveOwnerId(conversation.ownerId, rows)
    if (me.role !== 'ADMIN' && owner !== me.id) {
      return forbidden('Only the group owner can kick members.')
    }
    if (userId === owner) {
      return forbidden('The group owner cannot be kicked.')
    }

    const target = rows.find((r) => r.userId === userId)
    if (!target) return notFound('That person is not in this group.')
    const targetUser = await db.user.findUnique({
      where: { id: userId },
      select: { username: true },
    })
    if (!targetUser) return notFound('User not found.')

    await db.conversationParticipant.delete({ where: { id: target.id } })

    // everyone left in the group plus the kicked member: all refresh their
    // conversation lists, so the group updates everywhere at once
    await emitToRooms(
      [...rows.filter((r) => r.userId !== userId).map((r) => userRoom(r.userId)), userRoom(userId)],
      'conversation:new',
      { conversationId, group: true, memberKicked: targetUser.username }
    )

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
