import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ channelId: string }> }

const MAX_TAGS = 20

/** tailwind-friendly hex; stored lowercase */
const TAG_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/** The chip row. */
function toSummary(t: { id: string; channelId: string; name: string; color: string; createdAt: Date }) {
  return {
    id: t.id,
    channelId: t.channelId,
    name: t.name,
    color: t.color,
    createdAt: t.createdAt.toISOString(),
  }
}

async function channelContext(channelId: string, userId: string) {
  const channel = await db.channel.findUnique({
    where: { id: channelId },
    select: { id: true, serverId: true },
  })
  if (!channel) return { channel: null, ctx: null }
  const ctx = await getMemberContext(channel.serverId, userId)
  return { channel, ctx }
}

export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { channelId } = await params
    const { channel, ctx } = await channelContext(channelId, me.id)
    if (!channel) return notFound('Channel not found.')
    if (!ctx) return forbidden('You are not a member of this server.')

    const tags = await db.forumTag.findMany({
      where: { channelId },
      orderBy: { createdAt: 'asc' },
    })
    return NextResponse.json({ tags: tags.map(toSummary) })
  } catch {
    return serverError()
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { channelId } = await params
    const { channel, ctx } = await channelContext(channelId, me.id)
    if (!channel) return notFound('Channel not found.')
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_SERVER)) {
      return forbidden('Only moderators with the Manage Server permission can add tags.')
    }

    const body = await req.json()
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 24) : ''
    const color = typeof body.color === 'string' ? body.color.trim() : ''
    if (name.length < 1 || name.length > 24) {
      return badRequest('Tag names are 1-24 characters.')
    }
    if (!TAG_COLOR_RE.test(color)) {
      return badRequest('Tag colors are 6-digit hex codes like #f5f5f5.')
    }

    const count = await db.forumTag.count({ where: { channelId } })
    if (count >= MAX_TAGS) {
      return badRequest(`This channel already has ${MAX_TAGS} tags.`)
    }

    let tag
    try {
      tag = await db.forumTag.create({
        data: { channelId, name, color: color.toLowerCase() },
      })
    } catch (err) {
      // two admins racing the unique (channelId, name) constraint
      if ((err as { code?: string })?.code === 'P2002') {
        return badRequest(`A tag named "${name}" already exists in this channel.`)
      }
      throw err
    }

    await logServerEvent({
      serverId: channel.serverId,
      type: 'server_update',
      actorId: me.id,
      data: { tagAdded: name },
    })

    // live refresh: members re-fetch the tag list when the forum posts load
    const members = await db.serverMember.findMany({ where: { serverId: channel.serverId }, select: { userId: true } })
    await emitToRooms(members.map((m) => userRoom(m.userId)), 'server:refresh', { serverId: channel.serverId })

    return NextResponse.json({ tag: toSummary(tag) }, { status: 201 })
  } catch {
    return serverError()
  }
}
