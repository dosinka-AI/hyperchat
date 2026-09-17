import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { emitToRooms, userRoom, notFound, serverError, unauthorized, forbidden } from '@/lib/realtime'

type Params = { params: Promise<{ id: string }> }

/** Accept a pending friend request (addressee only). */
export async function POST(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { id } = await params
    const friendship = await db.friendship.findUnique({ where: { id } })
    if (!friendship) return notFound('Request not found.')
    if (friendship.addresseeId !== me.id) return forbidden('Only the recipient can accept this request.')
    if (friendship.status === 'ACCEPTED') {
      return NextResponse.json({ ok: true, alreadyAccepted: true })
    }

    // temporary request: the window restarts when the friendship actually
    // begins, so a request that sat pending does not arrive pre-expired
    const data: { status: string; expiresAt?: Date | null } = { status: 'ACCEPTED' }
    if (friendship.expiresAt) {
      const windowMs = friendship.expiresAt.getTime() - friendship.createdAt.getTime()
      data.expiresAt = new Date(Date.now() + Math.max(windowMs, 3600_000))
    }
    await db.friendship.update({ where: { id }, data })
    await emitToRooms([userRoom(friendship.requesterId), userRoom(friendship.addresseeId)], 'friends:update', {})

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}

/** Rename a friend (private nickname) or flip the friendship between
 *  temporary and permanent. Either side can do either. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { id } = await params
    const friendship = await db.friendship.findUnique({ where: { id } })
    if (!friendship) return notFound('Friendship not found.')
    if (friendship.requesterId !== me.id && friendship.addresseeId !== me.id) {
      return forbidden('That is not your friendship.')
    }
    if (friendship.status !== 'ACCEPTED') return forbidden('Accept the request first.')

    const body = await req.json()
    const isRequester = friendship.requesterId === me.id
    const data: Record<string, unknown> = {}

    if (typeof body.nickname === 'string') {
      const nick = body.nickname.trim().slice(0, 32)
      data[isRequester ? 'requesterLabel' : 'addresseeLabel'] = nick || null
    }

    if (body.temporary === true) {
      const hours =
        typeof body.hours === 'number' && Number.isFinite(body.hours)
          ? Math.min(Math.max(Math.round(body.hours), 1), 24 * 30)
          : 24
      data.expiresAt = new Date(Date.now() + hours * 3600_000)
    } else if (body.temporary === false) {
      data.expiresAt = null
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ ok: true, unchanged: true })
    }

    await db.friendship.update({ where: { id }, data })
    await emitToRooms([userRoom(friendship.requesterId), userRoom(friendship.addresseeId)], 'friends:update', {})

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}

/** Decline (addressee), cancel (requester) or unfriend (either side). */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { id } = await params
    const friendship = await db.friendship.findUnique({ where: { id } })
    if (!friendship) return notFound('Request not found.')
    if (friendship.requesterId !== me.id && friendship.addresseeId !== me.id) {
      return forbidden('That is not your friendship.')
    }

    await db.friendship.delete({ where: { id } })
    await emitToRooms([userRoom(friendship.requesterId), userRoom(friendship.addresseeId)], 'friends:update', {})

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
