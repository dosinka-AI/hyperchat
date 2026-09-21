import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireSiteAdmin } from '@/lib/siteAdmin'

/**
 * GET /api/admin/audit — the latest 100 server audit events across every
 * server (Task 6-c). The audit table already existed (ServerEvent, fed by
 * src/lib/audit.ts since the server-settings build), so this lists it;
 * no new audit table was added.
 */
export async function GET() {
  const gate = await requireSiteAdmin()
  if (!gate.ok) return gate.response

  try {
    const rows = await db.serverEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        type: true,
        data: true,
        createdAt: true,
        server: { select: { id: true, name: true } },
        actor: { select: { username: true } },
        targetUser: { select: { username: true } },
      },
    })

    return NextResponse.json({
      events: rows.map((r) => ({
        id: r.id,
        type: r.type,
        serverId: r.server.id,
        serverName: r.server.name,
        actor: r.actor?.username ?? null,
        target: r.targetUser?.username ?? null,
        data: r.data,
        createdAt: r.createdAt.toISOString(),
      })),
    })
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
