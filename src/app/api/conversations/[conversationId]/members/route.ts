import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { effectiveOwnerId } from '@/lib/convo-owner'

type Params = { params: Promise<{ conversationId: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  // add a member to a group conversation, enforcing the 5/50 member cap
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
      return forbidden('Only groups can gain members. Direct messages stay 1:1.')
    }

    // invite policy: the owner can lock additions to themselves
    if (conversation.invitePolicy === 'OWNER') {
      const rows = await db.conversationParticipant.findMany({
        where: { conversationId },
        orderBy: { id: 'asc' },
        select: { id: true, userId: true },
      })
      const owner = effectiveOwnerId(conversation.ownerId, rows)
      if (owner !== me.id && me.role !== 'ADMIN') {
        return forbidden('Only the group owner can add members to this group.')
      }
    }

    const body = await req.json()
    const userId = typeof body.userId === 'string' ? body.userId : ''
    if (!userId) return NextResponse.json({ error: 'Pick someone to add.' }, { status: 400 })
    if (userId === me.id) return NextResponse.json({ error: 'You are already in this group.' }, { status: 400 })

    const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, username: true } })
    if (!target) return notFound('User not found.')

    const existing = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    })
    if (existing) return NextResponse.json({ error: 'That person is already in the group.' }, { status: 400 })

    const memberCount = await db.conversationParticipant.count({ where: { conversationId } })
    const max = conversation.limitRaised ? 50 : 5
    if (memberCount >= max) {
      // the client turns this into the raise-the-limit unlock dialog
      return NextResponse.json(
        { error: 'limit', code: 'limit', current: memberCount, max, raisedMax: 50 },
        { status: 409 }
      )
    }

    // blocks gate adds the same way they gate DMs (both directions)
    const block = await db.userBlock.findFirst({
      where: {
        OR: [
          { blockerId: me.id, blockedId: target.id },
          { blockerId: target.id, blockedId: me.id },
        ],
      },
    })
    if (block) {
      return forbidden('You cannot add this user.')
    }

    await db.conversationParticipant.create({
      data: { conversationId, userId },
    })

    const participants = await db.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    })
    await emitToRooms(
      participants.map((p) => userRoom(p.userId)),
      'conversation:new',
      { conversationId, group: true, memberJoined: target.username }
    )

    return NextResponse.json({ ok: true, memberCount: participants.length }, { status: 201 })
  } catch {
    return serverError()
  }
}
