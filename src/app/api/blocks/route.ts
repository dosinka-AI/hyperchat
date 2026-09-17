import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { emitToRooms, userRoom, badRequest, serverError, unauthorized } from '@/lib/realtime'
import { FRIEND_USER_SELECT, toPublicUser } from '@/lib/users'

export async function GET() {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const blocks = await db.userBlock.findMany({
      where: { blockerId: me.id },
      include: { blocked: { select: FRIEND_USER_SELECT } },
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json({ blocked: blocks.map((b) => toPublicUser(b.blocked)) })
  } catch {
    return serverError()
  }
}

export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json()
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
    const userId = typeof body.userId === 'string' ? body.userId : ''
    if (!username && !userId) return badRequest('Pick a user to block.')

    const target = userId
      ? await db.user.findUnique({ where: { id: userId }, select: FRIEND_USER_SELECT })
      : await db.user.findUnique({ where: { username }, select: FRIEND_USER_SELECT })

    if (!target) return NextResponse.json({ error: 'No user with that name.' }, { status: 404 })
    if (target.id === me.id) return badRequest('You cannot block yourself.')

    await db.userBlock.upsert({
      where: { blockerId_blockedId: { blockerId: me.id, blockedId: target.id } },
      create: { blockerId: me.id, blockedId: target.id },
      update: {},
    })

    // blocking cuts any friendship in both directions
    await db.friendship.deleteMany({
      where: {
        OR: [
          { requesterId: me.id, addresseeId: target.id },
          { requesterId: target.id, addresseeId: me.id },
        ],
      },
    })

    await emitToRooms([userRoom(me.id), userRoom(target.id)], 'friends:update', {})
    await emitToRooms([userRoom(me.id)], 'blocks:update', {})

    return NextResponse.json({ ok: true, user: toPublicUser(target) }, { status: 201 })
  } catch {
    return serverError()
  }
}
