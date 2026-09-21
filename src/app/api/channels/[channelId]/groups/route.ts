import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM, CHAN_GROUP_PERM, CHAN_GROUP_PERM_ALL } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ channelId: string }> }

/** TeamSpeak-style channel groups: a per-channel rank layer (Voice /
 *  Operator / Channel admin style) granting channel-scoped powers — kick
 *  from channel, channel mute, grant talk, priority speaker. The three
 *  defaults are seeded lazily the first time anyone opens the panel, so
 *  pre-existing channels get them without a migration. */

const DEFAULT_GROUPS: { name: string; rank: number; permissions: number }[] = [
  { name: 'voice', rank: 1, permissions: 0 },
  { name: 'operator', rank: 2, permissions: CHAN_GROUP_PERM.CHANNEL_MUTE | CHAN_GROUP_PERM.KICK_FROM_CHANNEL },
  { name: 'channel admin', rank: 3, permissions: CHAN_GROUP_PERM_ALL },
]

async function ensureDefaults(channelId: string): Promise<void> {
  const existing = await db.channelGroup.count({ where: { channelId } })
  if (existing > 0) return
  await db.channelGroup.createMany({
    data: DEFAULT_GROUPS.map((g) => ({ channelId, name: g.name, rank: g.rank, permissions: g.permissions })),
  })
}

async function groupsPayload(channelId: string) {
  const groups = await db.channelGroup.findMany({
    where: { channelId },
    orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
    include: {
      members: { orderBy: { createdAt: 'asc' }, select: { userId: true } },
    },
  })
  // ChannelGroupMember carries no User relation (the additive schema kept
  // it lean); resolve the profiles in one pass
  const userIds = [...new Set(groups.flatMap((g) => g.members.map((m) => m.userId)))]
  const users = userIds.length
    ? await db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, username: true, displayName: true, avatarUrl: true, avatarColor: true },
      })
    : []
  const byId = new Map(users.map((u) => [u.id, u]))
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    rank: g.rank,
    permissions: g.permissions,
    members: g.members
      .map((m) => byId.get(m.userId))
      .filter((u): u is NonNullable<typeof u> => !!u)
      .map((u) => ({
        userId: u.id,
        username: u.username,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        avatarColor: u.avatarColor,
      })),
  }))
}

export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const { channelId } = await params
    const channel = await db.channel.findUnique({ where: { id: channelId }, select: { id: true, type: true, serverId: true } })
    if (!channel) return notFound('Channel not found.')
    const ctx = await getMemberContext(channel.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (channel.type !== 'voice' && channel.type !== 'stage') {
      return NextResponse.json({ groups: [] })
    }
    await ensureDefaults(channelId)
    return NextResponse.json({ groups: await groupsPayload(channelId) })
  } catch (err) {
    console.error('[channels/groups GET]', err)
    return serverError()
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const { channelId } = await params
    const channel = await db.channel.findUnique({ where: { id: channelId }, select: { id: true, name: true, type: true, serverId: true } })
    if (!channel) return notFound('Channel not found.')
    const ctx = await getMemberContext(channel.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.ADMINISTRATOR | PERM.MANAGE_CHANNELS)) {
      return forbidden('Only moderators with Manage Channels can edit channel groups.')
    }

    const body = await req.json()
    const name = typeof body.name === 'string' ? body.name.trim().toLowerCase().slice(0, 24) : ''
    if (!name) return badRequest('Group needs a name.')
    const permsNum = typeof body.permissions === 'number' ? Math.floor(body.permissions) : 0
    const permissions = permsNum & CHAN_GROUP_PERM_ALL

    const count = await db.channelGroup.count({ where: { channelId } })
    if (count >= 12) return badRequest('This channel already has 12 groups.')

    const top = await db.channelGroup.findFirst({ where: { channelId }, orderBy: { rank: 'desc' }, select: { rank: true } })
    const created = await db.channelGroup.create({
      data: { channelId, name, rank: (top?.rank ?? 0) + 1, permissions },
    })
    await logServerEvent({
      serverId: channel.serverId,
      type: 'channel_update',
      actorId: me.id,
      data: { name: channel.name, detail: `channel group "${name}" created` },
    })
    return NextResponse.json({ group: { id: created.id, name: created.name, rank: created.rank, permissions: created.permissions, members: [] } })
  } catch (err) {
    console.error('[channels/groups POST]', err)
    return serverError()
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const { channelId } = await params
    const channel = await db.channel.findUnique({ where: { id: channelId }, select: { id: true, name: true, serverId: true } })
    if (!channel) return notFound('Channel not found.')
    const ctx = await getMemberContext(channel.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.ADMINISTRATOR | PERM.MANAGE_CHANNELS)) {
      return forbidden('Only moderators with Manage Channels can edit channel groups.')
    }

    const body = await req.json()
    const groupId = typeof body.groupId === 'string' ? body.groupId : ''
    if (!groupId) return badRequest('Which group?')
    const group = await db.channelGroup.findUnique({ where: { id: groupId } })
    if (!group || group.channelId !== channelId) return notFound('Group not found.')

    const data: { name?: string; permissions?: number } = {}
    if (typeof body.name === 'string') {
      const name = body.name.trim().toLowerCase().slice(0, 24)
      if (!name) return badRequest('Group needs a name.')
      data.name = name
    }
    if (typeof body.permissions === 'number') {
      data.permissions = Math.floor(body.permissions) & CHAN_GROUP_PERM_ALL
    }
    await db.channelGroup.update({ where: { id: groupId }, data })
    await logServerEvent({
      serverId: channel.serverId,
      type: 'channel_update',
      actorId: me.id,
      data: { name: channel.name, detail: `channel group "${group.name}" updated` },
    })
    return NextResponse.json({ groups: await groupsPayload(channelId) })
  } catch (err) {
    console.error('[channels/groups PATCH]', err)
    return serverError()
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const { channelId } = await params
    const channel = await db.channel.findUnique({ where: { id: channelId }, select: { id: true, name: true, serverId: true } })
    if (!channel) return notFound('Channel not found.')
    const ctx = await getMemberContext(channel.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.ADMINISTRATOR | PERM.MANAGE_CHANNELS)) {
      return forbidden('Only moderators with Manage Channels can edit channel groups.')
    }

    const groupId = req.nextUrl.searchParams.get('groupId') ?? ''
    if (!groupId) return badRequest('Which group?')
    const group = await db.channelGroup.findUnique({ where: { id: groupId } })
    if (!group || group.channelId !== channelId) return notFound('Group not found.')
    // cascade unassigns the members, the rank dies with the group
    await db.channelGroup.delete({ where: { id: groupId } })
    await logServerEvent({
      serverId: channel.serverId,
      type: 'channel_update',
      actorId: me.id,
      data: { name: channel.name, detail: `channel group "${group.name}" deleted` },
    })
    return NextResponse.json({ groups: await groupsPayload(channelId) })
  } catch (err) {
    console.error('[channels/groups DELETE]', err)
    return serverError()
  }
}
