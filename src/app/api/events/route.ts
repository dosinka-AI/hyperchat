import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, forbidden, serverError, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import type { ScheduledEventSummary } from '@/lib/types'

/** Discord-style scheduled server events: announcements of things happening
 *  at a time, optionally tied to a channel. Anyone in the server can see and
 *  mark themselves as going; moderators (MANAGE_SERVER) create and cancel. */

type EventRow = {
  id: string
  serverId: string
  channelId: string | null
  name: string
  description: string | null
  startsAt: Date
  endsAt: Date | null
  canceledAt: Date | null
  createdById: string
}

async function eventsPayload(serverId: string, meId: string): Promise<ScheduledEventSummary[]> {
  const events = await db.scheduledEvent.findMany({
    where: { serverId },
    orderBy: { startsAt: 'asc' },
    take: 100,
    include: {
      attendees: {
        orderBy: { createdAt: 'asc' },
        include: { user: { select: { id: true, username: true, displayName: true, avatarUrl: true, avatarColor: true } } },
      },
      createdBy: { select: { username: true } },
    },
  })
  const channelIds = [...new Set(events.map((e) => e.channelId).filter((c): c is string => !!c))]
  const channels = channelIds.length
    ? await db.channel.findMany({ where: { id: { in: channelIds } }, select: { id: true, name: true } })
    : []
  const channelNames = new Map(channels.map((c) => [c.id, c.name]))
  return events.map((e) => ({
    id: e.id,
    serverId: e.serverId,
    channelId: e.channelId,
    channelName: e.channelId ? channelNames.get(e.channelId) ?? null : null,
    name: e.name,
    description: e.description,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt?.toISOString() ?? null,
    canceledAt: e.canceledAt?.toISOString() ?? null,
    createdById: e.createdById,
    createdByUsername: e.createdBy.username,
    attendeeCount: e.attendees.length,
    attendees: e.attendees.map((a) => ({
      userId: a.user.id,
      username: a.user.username,
      displayName: a.user.displayName,
      avatarUrl: a.user.avatarUrl,
      avatarColor: a.user.avatarColor,
    })),
    iAmGoing: e.attendees.some((a) => a.userId === meId),
  }))
}

export async function GET(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const serverId = req.nextUrl.searchParams.get('serverId') ?? ''
    if (!serverId) return badRequest('Which server?')
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    return NextResponse.json({ events: await eventsPayload(serverId, me.id) })
  } catch (err) {
    console.error('[events GET]', err)
    return serverError()
  }
}

export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const body = await req.json()
    const serverId = typeof body.serverId === 'string' ? body.serverId : ''
    if (!serverId) return badRequest('Which server?')
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.ADMINISTRATOR | PERM.MANAGE_SERVER)) {
      return forbidden('Only moderators can schedule events.')
    }

    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : ''
    if (!name) return badRequest('The event needs a name.')
    const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim().slice(0, 400) : null
    const startsAtRaw = typeof body.startsAt === 'string' ? new Date(body.startsAt) : null
    if (!startsAtRaw || Number.isNaN(startsAtRaw.getTime())) return badRequest('When does it start?')
    // within a year; not more than a day in the past
    const now = Date.now()
    if (startsAtRaw.getTime() < now - 86_400_000 || startsAtRaw.getTime() > now + 365 * 86_400_000) {
      return badRequest('Pick a start time within the next year.')
    }
    const endsAtRaw = typeof body.endsAt === 'string' && body.endsAt ? new Date(body.endsAt) : null
    if (endsAtRaw && (!Number.isNaN(endsAtRaw.getTime()) ? endsAtRaw.getTime() <= startsAtRaw.getTime() : false)) {
      return badRequest('The end has to come after the start.')
    }
    let channelId: string | null = null
    if (typeof body.channelId === 'string' && body.channelId) {
      const channel = await db.channel.findUnique({ where: { id: body.channelId }, select: { id: true, serverId: true } })
      if (!channel || channel.serverId !== serverId) return badRequest('That channel is not in this server.')
      channelId = channel.id
    }

    await db.scheduledEvent.create({
      data: {
        serverId,
        channelId,
        name,
        description,
        startsAt: startsAtRaw,
        endsAt: endsAtRaw && !Number.isNaN(endsAtRaw.getTime()) ? endsAtRaw : null,
        createdById: me.id,
      },
    })
    return NextResponse.json({ events: await eventsPayload(serverId, me.id) }, { status: 201 })
  } catch (err) {
    console.error('[events POST]', err)
    return serverError()
  }
}
