import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, notFound, serverError, unauthorized } from '@/lib/realtime'

/** A saved GIF must be a remote http(s) url; data urls belong to uploads. */
function validGifUrl(raw: unknown): raw is string {
  return typeof raw === 'string' && /^https?:\/\/\S+$/i.test(raw) && raw.length <= 2048
}

export async function GET() {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const rows = await db.savedGif.findMany({
      where: { userId: me.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, url: true, title: true, createdAt: true },
    })
    return NextResponse.json({
      gifs: rows.map((r) => ({ id: r.id, url: r.url, title: r.title })),
    })
  } catch {
    return serverError()
  }
}

export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const body = await req.json()
    if (!validGifUrl(body.url)) return badRequest('That GIF cannot be saved.')
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : 'gif'
    const row = await db.savedGif.upsert({
      where: { userId_url: { userId: me.id, url: body.url } },
      update: { title },
      create: { userId: me.id, url: body.url, title: title || 'gif' },
      select: { id: true, url: true, title: true },
    })
    return NextResponse.json({ gif: row })
  } catch {
    return serverError()
  }
}

export async function DELETE(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const url = req.nextUrl.searchParams.get('url') || ''
    if (!validGifUrl(url)) return badRequest('That GIF cannot be removed.')
    const row = await db.savedGif.findUnique({
      where: { userId_url: { userId: me.id, url } },
      select: { id: true },
    })
    if (!row) return notFound('That GIF is not saved.')
    await db.savedGif.delete({ where: { id: row.id } })
    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
