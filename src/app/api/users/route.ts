import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { serverError, unauthorized } from '@/lib/realtime'

export async function GET(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const q = (req.nextUrl.searchParams.get('q') || '').trim().toLowerCase()
    if (q.length < 1) {
      return NextResponse.json({ users: [] })
    }

    const users = await db.user.findMany({
      where: {
        AND: [
          { id: { not: me.id } },
          {
            OR: [{ username: { contains: q } }, { displayName: { contains: q } }],
          },
        ],
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        avatarColor: true,
        bio: true,
        customStatus: true,
      },
      take: 20,
      orderBy: { username: 'asc' },
    })

    return NextResponse.json({ users })
  } catch {
    return serverError()
  }
}
