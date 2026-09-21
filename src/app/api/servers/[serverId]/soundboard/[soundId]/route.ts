import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ serverId: string; soundId: string }> }

export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId, soundId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of that server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_SERVER)) {
      return forbidden('Only moderators with the Manage Server permission can remove sounds.')
    }

    const sound = await db.soundboardSound.findUnique({ where: { id: soundId } })
    if (!sound || sound.serverId !== serverId) return notFound('No such sound on this server.')

    await db.soundboardSound.delete({ where: { id: soundId } })

    await logServerEvent({
      serverId,
      type: 'server_update',
      actorId: me.id,
      data: { soundRemoved: sound.name },
    })

    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await emitToRooms(members.map((m) => userRoom(m.userId)), 'soundboard:update', { serverId })

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
