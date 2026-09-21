import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ serverId: string }> }

const MAX_SOUNDS = 24

/** Uploads the whole app rides: /api/files/<uuid>.<ext> */
const SOUND_URL_RE = /^\/api\/files\/[a-zA-Z0-9-]+\.(mp3|wav|ogg|m4a|flac|aac|opus)$/

/** Per-file cap: soundboard clips are seconds long, not songs. */
const MAX_SOUND_BYTES = 2 * 1024 * 1024

/** The picker row: metadata only, the audio itself streams from `url`. */
function toSummary(s: { id: string; serverId: string; name: string; url: string; size: number; mime: string; addedById: string; createdAt: Date }) {
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

    const sounds = await db.soundboardSound.findMany({
      where: { serverId },
      orderBy: { createdAt: 'asc' },
    })
    return NextResponse.json({ sounds: sounds.map(toSummary) })
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
    if (!ctx) return forbidden('You are not a member of that server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_SERVER)) {
      return forbidden('Only moderators with the Manage Server permission can add sounds.')
    }

    const body = await req.json()
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 32) : ''
    const url = typeof body.url === 'string' ? body.url : ''
    const size = typeof body.size === 'number' ? Math.floor(body.size) : 0
    const mime = typeof body.mime === 'string' ? body.mime : ''
    if (name.length < 1) {
      return badRequest('Give the sound a name.')
    }
    if (!SOUND_URL_RE.test(url)) {
      return badRequest('Upload the audio file first (mp3, wav, ogg, m4a, flac, aac or opus).')
    }
    if (size <= 0 || size > MAX_SOUND_BYTES) {
      return badRequest('Sounds are capped at 2 MB.')
    }

    const count = await db.soundboardSound.count({ where: { serverId } })
    if (count >= MAX_SOUNDS) {
      return badRequest(`This server already has ${MAX_SOUNDS} sounds.`)
    }

    const sound = await db.soundboardSound.create({
      data: { serverId, name, url, size, mime, addedById: me.id },
    })

    await logServerEvent({
      serverId,
      type: 'server_update',
      actorId: me.id,
      data: { soundAdded: name },
    })

    // live refresh: any member whose picker already holds this server's list
    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await emitToRooms(members.map((m) => userRoom(m.userId)), 'soundboard:update', { serverId })

    return NextResponse.json({ sound: toSummary(sound) }, { status: 201 })
  } catch {
    return serverError()
  }
}
