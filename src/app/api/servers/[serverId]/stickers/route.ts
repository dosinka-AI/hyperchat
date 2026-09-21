import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToRooms, forbidden, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ serverId: string }> }

const MAX_STICKERS = 50

/** Uploads the whole app rides: /api/files/<uuid>.<ext> */
const STICKER_URL_RE = /^\/api\/files\/[a-zA-Z0-9-]+\.(png|apng|gif|webp|jpg|jpeg)$/

/** Per-file cap: stickers are small reaction images, not wallpapers. */
const MAX_STICKER_BYTES = 1024 * 1024

/** The picker row. */
function toSummary(s: { id: string; serverId: string | null; name: string; url: string; size: number; mime: string; addedById: string; createdAt: Date }) {
  return {
    id: s.id,
    serverId: s.serverId,
    name: s.name,
    url: s.url,
    size: s.size,
    mime: s.mime,
    addedById: s.addedById,
    createdAt: s.createdAt.toISOString(),
  }
}

export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of that server.')
    const stickers = await db.sticker.findMany({
      where: { serverId },
      orderBy: { createdAt: 'asc' },
    })
    return NextResponse.json({ stickers: stickers.map(toSummary) })
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
      return forbidden('Only moderators with the Manage Server permission can add stickers.')
    }

    const body = await req.json()
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 32) : ''
    const url = typeof body.url === 'string' ? body.url : ''
    const size = typeof body.size === 'number' ? Math.max(0, Math.floor(body.size)) : 0
    const mime = typeof body.mime === 'string' ? body.mime.slice(0, 40) : 'image/png'
    if (name.length < 1 || name.length > 32) {
      return badRequest('Sticker names are 1-32 characters.')
    }
    if (!STICKER_URL_RE.test(url)) {
      return badRequest('Upload a PNG, GIF, WEBP or JPG image first.')
    }
    if (size > MAX_STICKER_BYTES) {
      return badRequest('Stickers must be under 1 MB.')
    }

    const count = await db.sticker.count({ where: { serverId } })
    if (count >= MAX_STICKERS) {
      return badRequest(`This server already has ${MAX_STICKERS} stickers.`)
    }

    const sticker = await db.sticker.create({
      data: { serverId, name, url, size, mime, addedById: me.id },
    })

    await logServerEvent({
      serverId,
      type: 'server_update',
      actorId: me.id,
      data: { stickerAdded: name },
    })

    // live refresh: members re-fetch their sticker list through the store
    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await emitToRooms(members.map((m) => userRoom(m.userId)), 'server:refresh', { serverId })

    return NextResponse.json({ sticker: toSummary(sticker) }, { status: 201 })
  } catch {
    return serverError()
  }
}
