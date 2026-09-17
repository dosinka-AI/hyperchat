import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { emitToRooms, userRoom, badRequest, serverError, unauthorized } from '@/lib/realtime'
import { FRIEND_USER_SELECT, toPublicUser } from '@/lib/users'
import type { FriendSummary } from '@/lib/types'

export async function GET() {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const rows = await db.friendship.findMany({
      where: { OR: [{ requesterId: me.id }, { addresseeId: me.id }] },
      include: {
        requester: { select: FRIEND_USER_SELECT },
        addressee: { select: FRIEND_USER_SELECT },
      },
      orderBy: { updatedAt: 'desc' },
    })

    const friends: FriendSummary[] = []
    const incoming: FriendSummary[] = []
    const outgoing: FriendSummary[] = []

    for (const row of rows) {
      const isRequester = row.requesterId === me.id
      const other = isRequester ? row.addressee : row.requester
      const summary: FriendSummary = {
        friendshipId: row.id,
        user: toPublicUser(other),
        direction: isRequester ? 'outgoing' : 'incoming',
        nickname: (isRequester ? row.requesterLabel : row.addresseeLabel) ?? null,
        expiresAt: row.status === 'ACCEPTED' && row.expiresAt ? row.expiresAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
      }
      if (row.status === 'ACCEPTED') friends.push(summary)
      else if (isRequester) outgoing.push(summary)
      else incoming.push(summary)
    }

    return NextResponse.json({ friends, incoming, outgoing })
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
    // temporary friends: the friendship dissolves itself after this window
    const temporaryHours =
      typeof body.temporaryHours === 'number' && Number.isFinite(body.temporaryHours)
        ? Math.min(Math.max(Math.round(body.temporaryHours), 1), 24 * 30)
        : null
    if (!username) return badRequest('Enter a username.')

    const target = await db.user.findUnique({
      where: { username },
      select: FRIEND_USER_SELECT,
    })
    if (!target) {
      return NextResponse.json({ error: 'No user with that username.' }, { status: 404 })
    }
    if (target.id === me.id) return badRequest('You cannot friend yourself.')

    // blocks gate friendship in both directions
    const block = await db.userBlock.findFirst({
      where: {
        OR: [
          { blockerId: me.id, blockedId: target.id },
          { blockerId: target.id, blockedId: me.id },
        ],
      },
    })
    if (block) {
      return NextResponse.json({ error: 'You cannot friend this user.' }, { status: 403 })
    }

    // reverse pending request: accept it instead of creating a duplicate
    const reverse = await db.friendship.findUnique({
      where: { requesterId_addresseeId: { requesterId: target.id, addresseeId: me.id } },
    })
    if (reverse) {
      if (reverse.status === 'ACCEPTED') {
        return NextResponse.json({ error: 'You are already friends.' }, { status: 409 })
      }
      const updated = await db.friendship.update({
        where: { id: reverse.id },
        data: {
          status: 'ACCEPTED',
          ...(temporaryHours ? { expiresAt: new Date(Date.now() + temporaryHours * 3600_000) } : {}),
        },
      })
      await emitToRooms([userRoom(me.id), userRoom(target.id)], 'friends:update', {})
      return NextResponse.json({ friendship: { id: updated.id, status: 'ACCEPTED' } }, { status: 201 })
    }

    const existing = await db.friendship.findUnique({
      where: { requesterId_addresseeId: { requesterId: me.id, addresseeId: target.id } },
    })
    if (existing) {
      return NextResponse.json(
        { error: existing.status === 'ACCEPTED' ? 'You are already friends.' : 'Request already sent.' },
        { status: 409 }
      )
    }

    const created = await db.friendship.create({
      data: {
        requesterId: me.id,
        addresseeId: target.id,
        status: 'PENDING',
        ...(temporaryHours ? { expiresAt: new Date(Date.now() + temporaryHours * 3600_000) } : {}),
      },
    })
    await emitToRooms([userRoom(me.id), userRoom(target.id)], 'friends:update', {})

    return NextResponse.json({ friendship: { id: created.id, status: 'PENDING' } }, { status: 201 })
  } catch {
    return serverError()
  }
}
