import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'

type Params = { params: Promise<{ eventId: string }> }

/** Cancel (or delete) a scheduled event. Moderators only; cancel keeps the
 *  row (Discord shows "canceled"), delete removes it outright. */
export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const { eventId } = await params
    const event = await db.scheduledEvent.findUnique({ where: { id: eventId }, select: { serverId: true } })
    if (!event) return notFound('Event not found.')
    const ctx = await getMemberContext(event.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.ADMINISTRATOR | PERM.MANAGE_SERVER)) {
      return forbidden('Only moderators can cancel events.')
    }
    const body = await req.json().catch(() => ({}) as Record<string, unknown>)
    const mode = body.mode === 'delete' ? 'delete' : 'cancel'
    if (mode === 'delete') {
      await db.scheduledEvent.delete({ where: { id: eventId } })
    } else {
      await db.scheduledEvent.update({ where: { id: eventId }, data: { canceledAt: new Date() } })
    }
    return NextResponse.json({ ok: true, mode })
  } catch (err) {
    console.error('[events/[eventId] POST]', err)
    return serverError()
  }
}
