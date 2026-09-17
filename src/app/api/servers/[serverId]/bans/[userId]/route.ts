import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { logServerEvent } from '@/lib/audit'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'

type Params = { params: Promise<{ serverId: string; userId: string }> }

export async function DELETE(_req: NextRequest, { params }: Params) {
  // unban: needs the Ban Members permission
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId, userId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.BAN_MEMBERS)) return forbidden('You need the Ban Members permission to lift bans.')

    const ban = await db.serverBan.findUnique({
      where: { userId_serverId: { userId, serverId } },
    })
    if (!ban) return notFound('That user is not banned.')

    await db.serverBan.delete({ where: { id: ban.id } })

    await logServerEvent({
      serverId,
      type: 'member_unban',
      actorId: me.id,
      targetUserId: userId,
    })

    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await emitToRooms(
      members.map((m) => userRoom(m.userId)),
      'server:refresh',
      { serverId, unbannedUserId: userId }
    )

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
