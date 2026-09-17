import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToRooms, forbidden, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ serverId: string }> }

/** Reorder channels: admins pass the full ordered id list for the server.
 *  Position is stored globally per server; the sidebar renders by it. */
export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const mctx = await getMemberContext(serverId, me.id)
    if (!mctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(mctx.perms, PERM.MANAGE_CHANNELS)) return forbidden('Only moderators with the Manage Channels permission can reorder channels.')

    const body = await req.json()
    const orderedIds = Array.isArray(body.orderedIds)
      ? body.orderedIds.filter((id: unknown): id is string => typeof id === 'string')
      : []
    if (!orderedIds.length) return badRequest('Pass the ordered channel list.')

    const channels = await db.channel.findMany({ where: { serverId }, select: { id: true } })
    const known = new Set(channels.map((c) => c.id))
    if (orderedIds.length !== channels.length || !orderedIds.every((id) => known.has(id))) {
      return badRequest('The ordered list must cover every channel in this server exactly once.')
    }

    await db.$transaction(
      orderedIds.map((id, index) => db.channel.update({ where: { id }, data: { position: index } }))
    )

    await logServerEvent({ serverId, type: 'channel_update', actorId: me.id, data: { reordered: true } })

    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await emitToRooms(
      members.map((m) => userRoom(m.userId)),
      'server:refresh',
      { serverId }
    )

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
