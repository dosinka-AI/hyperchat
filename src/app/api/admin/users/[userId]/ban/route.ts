import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'

type Params = { params: Promise<{ userId: string }> }

const DAY_MS = 86_400_000
const MAX_DAYS = 3650
/** Permanent suspensions store a far-future date; null means active. */
const PERMANENT = new Date('2999-12-31')

/** Suspend (or permanently ban) a site account. Site admins only. */
export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  if (me.role !== 'ADMIN') return forbidden()

  try {
    const { userId } = await params
    if (userId === me.id) return forbidden('You cannot suspend yourself.')

    const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, role: true } })
    if (!target) return notFound('User not found.')
    if (target.role === 'ADMIN') return forbidden('Admins cannot be suspended.')

    const body = await req.json()
    const rawDays = body.days
    let bannedUntil: Date
    if (rawDays === null) {
      bannedUntil = PERMANENT
    } else {
      const days = typeof rawDays === 'number' ? rawDays : Number(rawDays)
      if (!Number.isFinite(days) || days <= 0) {
        return badRequest('Days must be a positive number.')
      }
      bannedUntil = new Date(Date.now() + Math.min(days, MAX_DAYS) * DAY_MS)
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : ''

    await db.user.update({
      where: { id: userId },
      data: { bannedUntil, banReason: reason || null },
    })

    // kick the target's client: the socket handler swaps to the suspended view
    await emitToRooms([userRoom(userId)], 'account:suspended', {
      reason: reason || null,
      until: bannedUntil.toISOString(),
    })

    return NextResponse.json({ ok: true, bannedUntil: bannedUntil.toISOString() })
  } catch {
    return serverError()
  }
}

/** Lift a suspension: clears both fields and nudges the user's client. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  if (me.role !== 'ADMIN') return forbidden()

  try {
    const { userId } = await params
    const target = await db.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!target) return notFound('User not found.')

    await db.user.update({
      where: { id: userId },
      data: { bannedUntil: null, banReason: null },
    })

    await emitToRooms([userRoom(userId)], 'user:update', { userId })

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
