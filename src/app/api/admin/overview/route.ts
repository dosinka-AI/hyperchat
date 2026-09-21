import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireSiteAdmin } from '@/lib/siteAdmin'
import { vaultDiskUsageBytes } from '@/lib/bootstrap'
import { fetchOnlineUserIds } from '@/lib/realtime'

/**
 * GET /api/admin/overview — the admin panel's stat cards (Task 6-c).
 * Site-admin only. Counts are cheap indexed queries; the vault disk number
 * streams the vault directory (the one place the app talks to the owner's
 * drive, so the panel shows honest bytes); onlineNow counts live sockets via
 * the sidecar's presence endpoint.
 */
export async function GET() {
  const gate = await requireSiteAdmin()
  if (!gate.ok) return gate.response

  try {
    const dayMs = 24 * 60 * 60_000
    const now = new Date()
    const last24h = new Date(now.getTime() - dayMs)
    const last7d = new Date(now.getTime() - 7 * dayMs)

    const [
      totalUsers,
      verifiedUsers,
      newUsers,
      totalMessages,
      messages24h,
      totalServers,
      vaultUploads,
      vaultReady,
      vaultUploading,
      vaultExpiring,
      onlineIds,
      diskUsageBytes,
    ] = await Promise.all([
      db.user.count(),
      db.user.count({ where: { emailVerifiedAt: { not: null } } }),
      db.user.count({ where: { createdAt: { gte: last7d } } }),
      db.message.count(),
      db.message.count({ where: { createdAt: { gte: last24h } } }),
      db.server.count(),
      db.fileUpload.count(),
      db.fileUpload.count({ where: { status: 'ready' } }),
      db.fileUpload.count({ where: { status: 'uploading' } }),
      // live soon: expires within the next 24h and not already past
      db.fileUpload.count({
        where: { status: { in: ['uploading', 'ready'] }, expiresAt: { gte: now, lt: new Date(now.getTime() + dayMs) } },
      }),
      fetchOnlineUserIds(),
      vaultDiskUsageBytes(),
    ])

    // sum of logical bytes of finished uploads (what the vault would restore)
    const readyAgg = await db.fileUpload.aggregate({
      where: { status: 'ready' },
      _sum: { size: true },
    })

    return NextResponse.json({
      users: { total: totalUsers, verified: verifiedUsers, newLast7d: newUsers },
      messages: { total: totalMessages, last24h: messages24h },
      servers: { total: totalServers },
      vault: {
        uploads: vaultUploads,
        readyBytes: readyAgg._sum.size ?? 0,
        uploading: vaultUploading,
        expiredSoon: vaultExpiring,
        diskUsageBytes,
      },
      onlineNow: onlineIds.length,
    })
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
