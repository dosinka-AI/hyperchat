import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { notFound, serverError, unauthorized } from '@/lib/realtime'

type Params = { params: Promise<{ code: string }> }

/** Resolve a shareable hyperion.gg/<code> invite into a server preview
 *  for message embeds. Exact code match first; codes are mixed case so a
 *  miss falls back to a case-insensitive scan. */
export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { code } = await params
    const raw = decodeURIComponent(code).trim()
    if (!/^[a-zA-Z0-9]{4,32}$/.test(raw)) {
      return notFound('invite not found')
    }

    let server = await db.server.findUnique({
      where: { inviteCode: raw },
      select: {
        id: true,
        name: true,
        description: true,
        iconUrl: true,
        bannerColor: true,
        inviteCode: true,
        visibility: true,
        _count: { select: { members: true } },
      },
    })

    if (!server) {
      // SQLite LIKE is case-insensitive for ASCII, so this narrows the
      // scan; the strict compare keeps partial matches from resolving
      const candidates = await db.server.findMany({
        where: { inviteCode: { contains: raw } },
        select: {
          id: true,
          name: true,
          description: true,
          iconUrl: true,
          bannerColor: true,
          visibility: true,
          inviteCode: true,
          _count: { select: { members: true } },
        },
      })
      const lower = raw.toLowerCase()
      const hit = candidates.find((c) => c.inviteCode.toLowerCase() === lower)
      if (hit) server = hit
    }

    if (!server) return notFound('invite not found')

    return NextResponse.json({
      server: {
        id: server.id,
        name: server.name,
        description: server.description,
        iconUrl: server.iconUrl,
        bannerColor: server.bannerColor,
        inviteCode: server.inviteCode,
        memberCount: server._count.members,
        visibility: server.visibility,
      },
    })
  } catch {
    return serverError()
  }
}
