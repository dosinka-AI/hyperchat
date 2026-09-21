import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import type { InsightsPayload } from '@/lib/types'

type Params = { params: Promise<{ serverId: string }> }

const DAY_MS = 86_400_000
const WINDOW_DAYS = 14

/** Server insights (Discord Server Insights parity): 14-day activity window.
 *  Owner/admin-gated — this is staff analytics, not a member-facing page. */
export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return notFound('Server not found.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_SERVER)) {
      return forbidden('Only server managers can view insights.')
    }

    const now = Date.now()
    const windowStart = new Date(now - WINDOW_DAYS * DAY_MS)
    const dayStart = new Date(new Date().toDateString())

    const [memberRows, joinLogs, messageRows, totalMessages] = await Promise.all([
      db.serverMember.findMany({
        where: { serverId },
        select: { userId: true, joinedAt: true, user: { select: { presence: true, lastSeenAt: true } } },
      }),
      db.serverJoinLog.findMany({
        where: { serverId, createdAt: { gte: windowStart } },
        select: { createdAt: true },
      }),
      // messages in this server's channels over the window (bounded fetch)
      db.message.findMany({
        where: {
          channel: { serverId },
          createdAt: { gte: windowStart },
          whisperTargetId: null,
        },
        select: {
          createdAt: true,
          authorId: true,
          author: { select: { displayName: true, username: true } },
          channel: { select: { name: true } },
        },
        take: 50_000,
        orderBy: { createdAt: 'asc' },
      }),
      db.message.count({
        where: { channel: { serverId }, whisperTargetId: null },
      }),
    ])

    const ONLINE_WINDOW = 5 * 60_000
    const online = memberRows.filter((m) => {
      if (!m.user.lastSeenAt) return false
      if (m.user.presence === 'invisible') return false
      return now - new Date(m.user.lastSeenAt).getTime() < ONLINE_WINDOW
    }).length

    // joins + messages per day
    const dayKey = (d: Date) => new Date(d).toISOString().slice(0, 10)
    const joinsByDay: { date: string; count: number }[] = []
    const messagesByDay: { date: string; count: number }[] = []
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const d = new Date(now - i * DAY_MS)
      joinsByDay.push({ date: dayKey(d), count: 0 })
      messagesByDay.push({ date: dayKey(d), count: 0 })
    }
    const joinIndex = new Map(joinsByDay.map((d, i) => [d.date, i]))
    for (const j of joinLogs) {
      const idx = joinIndex.get(dayKey(j.createdAt))
      if (idx !== undefined) joinsByDay[idx].count++
    }
    const msgIndex = new Map(messagesByDay.map((d, i) => [d.date, i]))
    const hourBuckets = new Array(24).fill(0)
    const channelCounts = new Map<string, number>()
    const memberCounts = new Map<string, { name: string; count: number }>()
    for (const m of messageRows) {
      const idx = msgIndex.get(dayKey(m.createdAt))
      if (idx !== undefined) messagesByDay[idx].count++
      hourBuckets[new Date(m.createdAt).getHours()]++
      const chName = m.channel?.name
      if (chName) channelCounts.set(chName, (channelCounts.get(chName) ?? 0) + 1)
      const name = m.author?.displayName || m.author?.username || 'someone'
      const prev = memberCounts.get(m.authorId)
      memberCounts.set(m.authorId, { name, count: (prev?.count ?? 0) + 1 })
    }

    const payload: InsightsPayload = {
      members: {
        total: memberRows.length,
        online,
        joined7d: joinLogs.filter((j) => new Date(j.createdAt).getTime() >= now - 7 * DAY_MS).length,
        joined14d: joinLogs.length,
      },
      messages: {
        total: totalMessages,
        last14d: messageRows.length,
        today: messageRows.filter((m) => new Date(m.createdAt) >= dayStart).length,
      },
      joinsByDay,
      messagesByDay,
      hours: hourBuckets,
      topChannels: [...channelCounts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5),
      topMembers: [...memberCounts.values()].sort((a, b) => b.count - a.count).slice(0, 5),
      activeMembers14d: memberCounts.size,
      windowDays: WINDOW_DAYS,
    }

    return NextResponse.json(payload)
  } catch (err) {
    console.error('[insights GET]', err)
    return serverError()
  }
}
