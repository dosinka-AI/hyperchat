import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { serverError, unauthorized } from '@/lib/realtime'

/** Page size for the Discover grid. */
const PAGE_SIZE = 24

/** Public server discovery: every PUBLIC server the caller does not
 *  already belong to. Biggest first ("members") or newest first ("new"),
 *  paginated 24 rows at a time. */
export async function GET(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const q = (req.nextUrl.searchParams.get('q') || '').trim().toLowerCase()
    const sort = req.nextUrl.searchParams.get('sort') === 'new' ? 'new' : 'members'
    const parsedOffset = parseInt(req.nextUrl.searchParams.get('offset') || '0', 10)
    const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0

    const servers = await db.server.findMany({
      where: {
        visibility: 'PUBLIC',
        members: { none: { userId: me.id } },
        ...(q
          ? { OR: [{ name: { contains: q } }, { description: { contains: q } }] }
          : {}),
      },
      orderBy:
        sort === 'new' ? [{ createdAt: 'desc' }] : [{ members: { _count: 'desc' } }, { createdAt: 'desc' }],
      take: PAGE_SIZE,
      skip: offset,
      select: {
        id: true,
        name: true,
        description: true,
        iconUrl: true,
        bannerColor: true,
        _count: { select: { members: true } },
      },
    })

    return NextResponse.json({
      servers: servers.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        iconUrl: s.iconUrl,
        bannerColor: s.bannerColor,
        memberCount: s._count.members,
      })),
    })
  } catch {
    return serverError()
  }
}
