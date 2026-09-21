import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireSiteAdmin } from '@/lib/siteAdmin'

/**
 * GET /api/admin/vault?page= — every vault upload (Task 6-c). Site-admin
 * only; the owner audits his own drive. Newest first, 50 per page.
 */
const PAGE_SIZE = 50

export async function GET(req: NextRequest) {
  const gate = await requireSiteAdmin()
  if (!gate.ok) return gate.response

  try {
    const pageRaw = Number(req.nextUrl.searchParams.get('page') || '1')
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1

    const [total, rows] = await Promise.all([
      db.fileUpload.count(),
      db.fileUpload.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        select: {
          id: true,
          filename: true,
          size: true,
          mime: true,
          status: true,
          expiresAt: true,
          downloadCount: true,
          createdAt: true,
          conversationId: true,
          uploader: { select: { username: true, avatarUrl: true, avatarColor: true } },
        },
      }),
    ])

    return NextResponse.json({
      uploads: rows.map((r) => ({
        id: r.id,
        filename: r.filename,
        size: r.size,
        mime: r.mime,
        status: r.status,
        expiresAt: r.expiresAt.toISOString(),
        downloadCount: r.downloadCount,
        createdAt: r.createdAt.toISOString(),
        conversationId: r.conversationId,
        uploader: r.uploader
          ? { username: r.uploader.username, avatarUrl: r.uploader.avatarUrl, avatarColor: r.uploader.avatarColor }
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
