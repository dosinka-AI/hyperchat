import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, channelRoom, emitToRooms, forbidden, notFound, serverError, serverRoom, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ channelId: string }> }

const MAX_TAGS = 20

/** Forum tags (Discord): per-channel colored labels posts can carry.
 *  Members read; Manage Channels holders create/delete. */
export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { channelId } = await params
    const channel = await db.channel.findUnique({ where: { id: channelId }, select: { serverId: true, type: true } })
    if (!channel) return notFound('Channel not found.')
    const ctx = await getMemberContext(channel.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')

    const tags = await db.forumTag.findMany({
      where: { channelId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, channelId: true, name: true, color: true },
    })
    return NextResponse.json({ tags })
  } catch {
    return serverError()
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { channelId } = await params
    const channel = await db.channel.findUnique({ where: { id: channelId }, select: { serverId: true, type: true } })
    if (!channel) return notFound('Channel not found.')
    if (channel.type !== 'forum') return badRequest('Tags belong to forum channels.')
    const ctx = await getMemberContext(channel.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_CHANNELS)) {
      return forbidden('Only moderators with the Manage Channels permission can create tags.')
    }

    const body = await req.json()
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 20) : ''
    const color = typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : '#e0533d'
    if (!name) return badRequest('Tag names use 1-20 characters.')

    const count = await db.forumTag.count({ where: { channelId } })
    if (count >= MAX_TAGS) return badRequest(`This channel already has ${MAX_TAGS} tags.`)

    const dupe = await db.forumTag.findFirst({ where: { channelId, name } })
    if (dupe) return badRequest('A tag with that name already exists.')

    const tag = await db.forumTag.create({
      data: { channelId, name, color },
      select: { id: true, channelId: true, name: true, color: true },
    })
    await logServerEvent({ serverId: channel.serverId, type: 'forum_tag_create', actorId: me.id, data: { channelId, name } })
    await emitToRooms([channelRoom(channelId), serverRoom(channel.serverId)], 'forum:tags:update', { channelId })
    return NextResponse.json({ tag }, { status: 201 })
  } catch {
    return serverError()
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { channelId } = await params
    const channel = await db.channel.findUnique({ where: { id: channelId }, select: { serverId: true } })
    if (!channel) return notFound('Channel not found.')
    const ctx = await getMemberContext(channel.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_CHANNELS)) {
      return forbidden('Only moderators with the Manage Channels permission can delete tags.')
    }

    const tagId = req.nextUrl.searchParams.get('tagId') || ''
    const tag = await db.forumTag.findUnique({ where: { id: tagId } })
    if (!tag || tag.channelId !== channelId) return notFound('Tag not found.')

    await db.forumTag.delete({ where: { id: tag.id } })
    await logServerEvent({ serverId: channel.serverId, type: 'forum_tag_delete', actorId: me.id, data: { channelId, name: tag.name } })
    await emitToRooms([channelRoom(channelId), serverRoom(channel.serverId)], 'forum:tags:update', { channelId })
    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
