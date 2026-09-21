import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireSiteAdmin } from '@/lib/siteAdmin'

/**
 * GET /api/admin/users?query=&page= — the admin panel's user directory
 * (Task 6-c, replaces the legacy role-gated directory). Search matches
 * username / display name / email; pagination caps at 50 rows per page.
 *
 * The admin sees full emails (it is his server), verified state, the site
 * admin flag, server + message counts, last message time and the ban row.
 */
const PAGE_SIZE = 50

export async function GET(req: NextRequest) {
  const gate = await requireSiteAdmin()
  if (!gate.ok) return gate.response

  try {
    const query = (req.nextUrl.searchParams.get('query') || '').trim()
    const pageRaw = Number(req.nextUrl.searchParams.get('page') || '1')
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1

    const where = query
      ? {
          OR: [
            { username: { contains: query.toLowerCase() } },
            { displayName: { contains: query } },
            { email: { contains: query.toLowerCase() } },
          ],
        }
      : undefined

    const [total, rows] = await Promise.all([
      db.user.count({ where }),
      db.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          emailVerifiedAt: true,
          siteAdmin: true,
          avatarUrl: true,
          avatarColor: true,
          createdAt: true,
          siteBan: { select: { reason: true, bannedAt: true, bannedBy: true } },
          _count: { select: { memberships: true, messages: true } },
        },
      }),
    ])

    // last message stamp per user (one indexed max query per row, capped at
    // the page size — honest "last active" for the owner's directory)
    const lastMessages = await Promise.all(
      rows.map((u) =>
        db.message.findFirst({
          where: { authorId: u.id },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        })
      )
    )

    return NextResponse.json({
      users: rows.map((u, i) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        email: u.email,
        verified: u.emailVerifiedAt !== null,
        siteAdmin: u.siteAdmin,
        avatarUrl: u.avatarUrl,
        avatarColor: u.avatarColor,
        createdAt: u.createdAt.toISOString(),
        serverCount: u._count.memberships,
        messageCount: u._count.messages,
        lastMessageAt: lastMessages[i]?.createdAt.toISOString() ?? null,
        banned: u.siteBan
          ? { reason: u.siteBan.reason, bannedAt: u.siteBan.bannedAt.toISOString(), bannedBy: u.siteBan.bannedBy }
          : null,
      })),
      page,
      pageSize: PAGE_SIZE,
      total,
    })
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
