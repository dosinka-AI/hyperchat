import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ serverId: string }> }

export async function POST(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const server = await db.server.findUnique({ where: { id: serverId }, select: { id: true, ownerId: true } })
    if (!server) return notFound('Server not found.')
    if (server.ownerId === me.id) {
      return forbidden('Owners cannot leave their own server. Delete it instead.')
    }

    const membership = await db.serverMember.findUnique({
      where: { userId_serverId: { userId: me.id, serverId } },
    })
    if (!membership) return forbidden('You are not a member of that server.')

    await db.serverMember.delete({ where: { id: membership.id } })

    await logServerEvent({
      serverId,
      type: 'member_leave',
      actorId: me.id,
      targetUserId: me.id,
    })

    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await emitToRooms(
      [...members.map((m) => userRoom(m.userId)), userRoom(me.id)],
      'server:refresh',
      { serverId }
    )

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
