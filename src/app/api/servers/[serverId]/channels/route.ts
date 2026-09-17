import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { normalizeChannelName } from '@/lib/messages'
import { badRequest, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { toChannelSummary } from '@/lib/serialize'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ serverId: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_CHANNELS)) {
      return forbidden('Only moderators with the Manage Channels permission can create channels.')
    }

    const body = await req.json()
    const name = normalizeChannelName(typeof body.name === 'string' ? body.name : '')
    const topic = typeof body.topic === 'string' && body.topic.trim() ? body.topic.trim().slice(0, 120) : null
    if (!name || name.length < 1) {
      return badRequest('Channel name must be 1 to 32 characters: letters, numbers, dashes.')
    }

    // channel type is immutable after creation; voice/forum channels keep the
    // plain text-channel schema with a type tag the client switches on
    const type = body.type === 'voice' || body.type === 'forum' ? body.type : 'text'

    const categoryId = typeof body.categoryId === 'string' && body.categoryId ? body.categoryId : null
    if (categoryId) {
      const category = await db.channelCategory.findUnique({ where: { id: categoryId } })
      if (!category || category.serverId !== serverId) {
        return badRequest('That category does not exist in this server.')
      }
    }

    const existing = await db.channel.findUnique({ where: { serverId_name: { serverId, name } } })
    if (existing) return badRequest(`A channel called "${name}" already exists in this server.`)

    const count = await db.channel.count({ where: { serverId } })
    if (count >= 50) return badRequest('This server already has 50 channels.')

    const channel = await db.channel.create({
      data: { serverId, name, topic, position: count, categoryId, type },
    })

    await logServerEvent({
      serverId,
      type: 'channel_create',
      actorId: me.id,
      data: { name },
    })

    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await emitToRooms(
      members.map((m) => userRoom(m.userId)),
      'server:refresh',
      { serverId }
    )

    return NextResponse.json({ channel: toChannelSummary(channel) }, { status: 201 })
  } catch {
    return serverError()
  }
}

type CategoryBody = { name?: unknown }

export async function PUT(req: NextRequest, { params }: Params) {
  // create a channel category
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_CHANNELS)) {
      return forbidden('Only moderators with the Manage Channels permission can create categories.')
    }

    const body = (await req.json()) as CategoryBody
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 32) : ''
    if (!name) return badRequest('Category name must be 1 to 32 characters.')

    const count = await db.channelCategory.count({ where: { serverId } })
    if (count >= 10) return badRequest('This server already has 10 categories.')

    const category = await db.channelCategory.create({
      data: { serverId, name, position: count },
    })

    await logServerEvent({
      serverId,
      type: 'category_create',
      actorId: me.id,
      data: { name },
    })

    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await emitToRooms(
      members.map((m) => userRoom(m.userId)),
      'server:refresh',
      { serverId }
    )

    return NextResponse.json(
      { category: { id: category.id, name: category.name, position: category.position } },
      { status: 201 }
    )
  } catch {
    return serverError()
  }
}
