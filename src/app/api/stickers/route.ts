import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'

const MAX_SERVER_STICKERS = 30
const MAX_STICKER_BYTES = 512 * 1024

/** Sticker art uploaded through /api/upload first, then referenced here. */
const STICKER_URL_RE = /^\/api\/files\/[a-zA-Z0-9-]+\.(png|jpg|jpeg|gif|webp|apng)$/

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

export async function GET(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const serverId = req.nextUrl.searchParams.get('serverId')
    if (serverId) {
      const ctx = await getMemberContext(serverId, me.id)
      if (!ctx) return forbidden('You are not a member of that server.')
      const [global, custom] = await Promise.all([
        db.sticker.findMany({ where: { serverId: null }, orderBy: { createdAt: 'asc' } }),
        db.sticker.findMany({ where: { serverId }, orderBy: { createdAt: 'asc' } }),
      ])
      return NextResponse.json({ stickers: [...global, ...custom].map(toSummary) })
    }
    const stickers = await db.sticker.findMany({ where: { serverId: null }, orderBy: { createdAt: 'asc' } })
    return NextResponse.json({ stickers: stickers.map(toSummary) })
  } catch {
    return serverError()
  }
}

export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json()
    const serverId = typeof body.serverId === 'string' ? body.serverId : ''
    if (!serverId) return badRequest('Pick a server for the sticker.')
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of that server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_SERVER)) {
      return forbidden('Only moderators with the Manage Server permission can add stickers.')
    }

    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 32) : ''
    const url = typeof body.url === 'string' ? body.url : ''
    const size = typeof body.size === 'number' ? Math.floor(body.size) : 0
    const mime = typeof body.mime === 'string' ? body.mime : ''
    if (name.length < 1) return badRequest('Give the sticker a name.')
    if (!STICKER_URL_RE.test(url)) {
      return badRequest('Upload the art first (png, jpg, gif, webp or apng).')
    }
    if (size <= 0 || size > MAX_STICKER_BYTES) {
      return badRequest('Stickers are capped at 512 KB.')
    }

    const count = await db.sticker.count({ where: { serverId } })
    if (count >= MAX_SERVER_STICKERS) {
      return badRequest(`This server already has ${MAX_SERVER_STICKERS} stickers.`)
    }

    const sticker = await db.sticker.create({
      data: { serverId, name, url, size, mime, addedById: me.id },
    })
    return NextResponse.json({ sticker: toSummary(sticker) }, { status: 201 })
  } catch {
    return serverError()
  }
}

export async function DELETE(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const id = req.nextUrl.searchParams.get('id')
    if (!id) return badRequest('Pick a sticker to remove.')
    const sticker = await db.sticker.findUnique({ where: { id } })
    if (!sticker) return notFound('Sticker not found.')
    if (!sticker.serverId) return forbidden('This sticker does not belong to a server.')
    const ctx = await getMemberContext(sticker.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of that server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_SERVER)) {
      return forbidden('Only moderators with the Manage Server permission can remove stickers.')
    }
    // message rows keep their url/name snapshots, history stays intact
    await db.sticker.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
