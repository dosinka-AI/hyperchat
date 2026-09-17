import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToRooms, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'

type Params = { params: Promise<{ username: string }> }

const LIST_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  avatarColor: true,
} as const

/** Follower / following lists for the profile card stats row. */
export async function GET(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { username } = await params
    const list = req.nextUrl.searchParams.get('list') === 'following' ? 'following' : 'followers'
    const user = await db.user.findUnique({
      where: { username: username.toLowerCase() },
      select: { id: true },
    })
    if (!user) return notFound('No user goes by that name.')

    const rows =
      list === 'followers'
        ? await db.follow.findMany({
            where: { followingId: user.id },
            select: { follower: { select: LIST_USER_SELECT } },
            orderBy: { createdAt: 'desc' },
            take: 200,
          })
        : await db.follow.findMany({
            where: { followerId: user.id },
            select: { following: { select: LIST_USER_SELECT } },
            orderBy: { createdAt: 'desc' },
            take: 200,
          })

    return NextResponse.json({ list, users: rows.map((r) => (list === 'followers' ? r.follower : r.following)) })
  } catch {
    return serverError()
  }
}

/** Follow a user. Idempotent: an existing follow just returns the current
 *  state. Follows are independent from the friend system. */
export async function POST(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { username } = await params
    const target = await db.user.findUnique({
      where: { username: username.toLowerCase() },
      select: { id: true, username: true },
    })
    if (!target) return notFound('No user goes by that name.')
    if (target.id === me.id) return badRequest('You cannot follow yourself.')

    // blocks gate follows in both directions, like friendships
    const block = await db.userBlock.findFirst({
      where: {
        OR: [
          { blockerId: me.id, blockedId: target.id },
          { blockerId: target.id, blockedId: me.id },
        ],
      },
    })
    if (block) {
      return NextResponse.json({ error: 'You cannot follow this user.' }, { status: 403 })
    }

    await db.follow.upsert({
      where: { followerId_followingId: { followerId: me.id, followingId: target.id } },
      create: { followerId: me.id, followingId: target.id },
      update: {},
    })

    const followersCount = await db.follow.count({ where: { followingId: target.id } })
    await emitToRooms([userRoom(me.id), userRoom(target.id)], 'profile:refresh', { username: target.username })

    return NextResponse.json({ following: true, followersCount }, { status: 201 })
  } catch {
    return serverError()
  }
}

/** Unfollow a user. Idempotent: missing rows are not an error. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { username } = await params
    const target = await db.user.findUnique({
      where: { username: username.toLowerCase() },
      select: { id: true, username: true },
    })
    if (!target) return notFound('No user goes by that name.')

    await db.follow.deleteMany({ where: { followerId: me.id, followingId: target.id } })

    const followersCount = await db.follow.count({ where: { followingId: target.id } })
    await emitToRooms([userRoom(me.id), userRoom(target.id)], 'profile:refresh', { username: target.username })

    return NextResponse.json({ following: false, followersCount })
  } catch {
    return serverError()
  }
}
