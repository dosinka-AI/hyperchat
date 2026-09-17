import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { normalizeChannelName } from '@/lib/messages'
import { badRequest, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom, channelRoom } from '@/lib/realtime'
import { toChannelSummary } from '@/lib/serialize'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ channelId: string }> }

const SLOWMODE_CHOICES = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

async function loadChannelWithMembership(channelId: string, userId: string) {
  const channel = await db.channel.findUnique({ where: { id: channelId } })
  if (!channel) return { channel: null, ctx: null }
  const ctx = await getMemberContext(channel.serverId, userId)
  return { channel, ctx }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { channelId } = await params
    const { channel, ctx } = await loadChannelWithMembership(channelId, me.id)
    if (!channel) return notFound('Channel not found.')
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_CHANNELS)) {
      return forbidden('Only moderators with the Manage Channels permission can edit channels.')
    }

    const body = await req.json()
    const data: {
      name?: string
      topic?: string | null
      slowmodeSeconds?: number
      locked?: boolean
      private?: boolean
    } = {}

    if (typeof body.name === 'string' && body.name.trim()) {
      const name = normalizeChannelName(body.name)
      if (!name) return badRequest('Channel name must be 1 to 32 characters.')
      const existing = await db.channel.findUnique({ where: { serverId_name: { serverId: channel.serverId, name } } })
      if (existing && existing.id !== channelId) {
        return badRequest(`A channel called "${name}" already exists in this server.`)
      }
      data.name = name
    }
    if (typeof body.topic === 'string') {
      data.topic = body.topic.trim() ? body.topic.trim().slice(0, 120) : null
    }
    if (body.slowmodeSeconds !== undefined) {
      if (typeof body.slowmodeSeconds !== 'number' || !SLOWMODE_CHOICES.includes(body.slowmodeSeconds)) {
        return badRequest('Slowmode must be one of: off, 5s, 10s, 15s, 30s, 1m, 2m, 5m, 10m, 15m, 30m, 1h.')
      }
      data.slowmodeSeconds = body.slowmodeSeconds
    }
    if (body.locked !== undefined) {
      if (typeof body.locked !== 'boolean') return badRequest('locked must be true or false.')
      data.locked = body.locked
    }
    if (body.private !== undefined) {
      if (typeof body.private !== 'boolean') return badRequest('private must be true or false.')
      data.private = body.private
    }

    const updated = await db.channel.update({ where: { id: channelId }, data })

    // replace the private-channel access list when provided
    if (Array.isArray(body.accessRoleIds)) {
      const wanted: string[] = []
      for (const id of body.accessRoleIds) {
        if (typeof id !== 'string') continue
        const role = await db.role.findUnique({ where: { id }, select: { id: true, serverId: true } })
        if (role && role.serverId === channel.serverId && !wanted.includes(role.id)) wanted.push(role.id)
      }
      await db.channelAccess.deleteMany({ where: { channelId } })
      if (wanted.length > 0) {
        await db.channelAccess.createMany({ data: wanted.map((roleId) => ({ channelId, roleId })) })
      }
    }

    await logServerEvent({
      serverId: channel.serverId,
      type: 'channel_update',
      actorId: me.id,
      data: {
        name: updated.name,
        topic: updated.topic,
        slowmodeSeconds: updated.slowmodeSeconds,
        locked: updated.locked,
        private: updated.private,
      },
    })

    const members = await db.serverMember.findMany({ where: { serverId: channel.serverId }, select: { userId: true } })
    await emitToRooms(
      members.map((m) => userRoom(m.userId)),
      'server:refresh',
      { serverId: channel.serverId }
    )

    const fresh = await db.channel.findUnique({ where: { id: channelId }, include: { access: { select: { roleId: true } } } })
    return NextResponse.json({ channel: toChannelSummary(fresh ?? updated) })
  } catch {
    return serverError()
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { channelId } = await params
    const { channel, ctx } = await loadChannelWithMembership(channelId, me.id)
    if (!channel) return notFound('Channel not found.')
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_CHANNELS)) {
      return forbidden('Only moderators with the Manage Channels permission can delete channels.')
    }

    // never allow deleting the last channel of a server
    const channelCount = await db.channel.count({ where: { serverId: channel.serverId } })
    if (channelCount <= 1) return badRequest('A server needs at least one channel.')

    await db.channel.delete({ where: { id: channelId } })

    await logServerEvent({
      serverId: channel.serverId,
      type: 'channel_delete',
      actorId: me.id,
      data: { name: channel.name },
    })

    const members = await db.serverMember.findMany({ where: { serverId: channel.serverId }, select: { userId: true } })
    await emitToRooms(
      [...members.map((m) => userRoom(m.userId)), channelRoom(channelId)],
      'server:refresh',
      { serverId: channel.serverId }
    )

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
