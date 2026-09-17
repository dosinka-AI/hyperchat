import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ serverId: string }> }

const MAX_EMOJI = 50

export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    const emoji = await db.serverEmoji.findMany({
      where: { serverId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, serverId: true, name: true, url: true, addedById: true },
    })
    return NextResponse.json({ emoji })
  } catch {
    return serverError()
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_SERVER)) {
      return forbidden('Only moderators with the Manage Server permission can add emoji.')
    }

    const body = await req.json()
    const name = typeof body.name === 'string' ? body.name.trim().toLowerCase().slice(0, 32) : ''
    const url = typeof body.url === 'string' ? body.url : ''
    if (!/^[a-z0-9_]{2,32}$/.test(name)) {
      return badRequest('Emoji names use 2-32 lowercase letters, numbers or underscores.')
    }
    if (!url.startsWith('/api/files/') || url.length > 200) {
      return badRequest('Upload the image first.')
    }

    const count = await db.serverEmoji.count({ where: { serverId } })
    if (count >= MAX_EMOJI) {
      return badRequest(`This server already has ${MAX_EMOJI} emoji.`)
    }

    const emoji = await db.serverEmoji.create({
      data: { serverId, name, url, addedById: me.id },
      select: { id: true, serverId: true, name: true, url: true, addedById: true },
    })

    await logServerEvent({
      serverId,
      type: 'server_update',
      actorId: me.id,
      data: { emojiAdded: name },
    })

    // live refresh: members re-fetch their emoji list through the store
    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await emitToRooms(members.map((m) => userRoom(m.userId)), 'server:refresh', { serverId })

    return NextResponse.json({ emoji }, { status: 201 })
  } catch {
    return serverError()
  }
}
