import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ serverId: string; inviteId: string }> }

export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId, inviteId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_SERVER)) {
      return forbidden('Only moderators can revoke invites.')
    }

    const row = await db.invite.findUnique({ where: { id: inviteId } })
    if (!row || row.serverId !== serverId) return notFound('That invite does not exist.')

    await db.invite.delete({ where: { id: inviteId } })
    await logServerEvent({ serverId, type: 'invite_delete', actorId: me.id, data: { code: row.code } })
    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
