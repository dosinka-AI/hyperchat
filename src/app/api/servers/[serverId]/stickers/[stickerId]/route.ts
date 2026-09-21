import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ serverId: string; stickerId: string }> }

export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId, stickerId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_SERVER)) {
      return forbidden('Only moderators with the Manage Server permission can remove stickers.')
    }

    const sticker = await db.sticker.findUnique({ where: { id: stickerId } })
    if (!sticker || sticker.serverId !== serverId) return notFound('No such sticker on this server.')

    await db.sticker.delete({ where: { id: stickerId } })

    await logServerEvent({
      serverId,
      type: 'server_update',
      actorId: me.id,
      data: { stickerRemoved: sticker.name },
    })

    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await emitToRooms(members.map((m) => userRoom(m.userId)), 'server:refresh', { serverId })

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
