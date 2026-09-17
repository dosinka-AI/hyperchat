import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { fetchPresenceSnapshot, forbidden, serverError, unauthorized } from '@/lib/realtime'

/** Site-admin user directory for account suspensions. ADMIN accounts only.
 *  Presence comes from the LIVE realtime map (connected sockets), not the
 *  stored preference: the panel shows who is actually online right now. */
export async function GET(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  if (me.role !== 'ADMIN') return forbidden()

  try {
    const q = (req.nextUrl.searchParams.get('q') || '').trim().toLowerCase()
    const [users, live] = await Promise.all([
      db.user.findMany({
        where: q
          ? { OR: [{ username: { contains: q } }, { displayName: { contains: q } }] }
          : undefined,
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          username: true,
          displayName: true,
          role: true,
          presence: true,
          avatarUrl: true,
          avatarColor: true,
          bannedUntil: true,
          banReason: true,
          createdAt: true,
        },
      }),
      fetchPresenceSnapshot(),
    ])

    return NextResponse.json({
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        // live connection state: connected users show their broadcast status,
        // everyone else is genuinely offline in this list
        presence: live.statuses[u.id] ?? 'offline',
        avatarUrl: u.avatarUrl,
        avatarColor: u.avatarColor,
        bannedUntil: u.bannedUntil ? u.bannedUntil.toISOString() : null,
        banReason: u.banReason,
        createdAt: u.createdAt.toISOString(),
      })),
    })
  } catch {
    return serverError()
  }
}
