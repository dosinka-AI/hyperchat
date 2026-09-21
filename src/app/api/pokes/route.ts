import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { serverError, unauthorized } from '@/lib/realtime'

/** My poke inbox: the 50 most recent pokes aimed at me, newest first,
 *  with the sender's profile folded in. */
export async function GET(_req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const pokes = await db.poke.findMany({
      where: { toUserId: me.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        message: true,
        readAt: true,
        createdAt: true,
        from: { select: { id: true, username: true, displayName: true, avatarUrl: true, avatarColor: true } },
      },
    })
    const unread = pokes.filter((p) => !p.readAt).length
    return NextResponse.json({
      pokes: pokes.map((p) => ({
        id: p.id,
        message: p.message,
        readAt: p.readAt ? p.readAt.toISOString() : null,
        createdAt: p.createdAt.toISOString(),
        from: p.from,
      })),
      unread,
    })
  } catch {
    return serverError()
  }
}
