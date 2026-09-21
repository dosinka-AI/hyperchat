import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { notFound, serverError, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'

type Params = { params: Promise<{ eventId: string }> }

/** Toggle my "going" mark on an event. Any server member; leaving is the
 *  same toggle. Idempotent per unique (eventId, userId). */
export async function POST(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const { eventId } = await params
    const event = await db.scheduledEvent.findUnique({ where: { id: eventId }, select: { serverId: true } })
    if (!event) return notFound('Event not found.')
    const ctx = await getMemberContext(event.serverId, me.id)
    if (!ctx) return notFound('Event not found.')

    const existing = await db.eventAttendee.findUnique({
      where: { eventId_userId: { eventId, userId: me.id } },
    })
    if (existing) {
      await db.eventAttendee.delete({ where: { id: existing.id } })
      return NextResponse.json({ going: false })
    }
    await db.eventAttendee.create({ data: { eventId, userId: me.id } })
    return NextResponse.json({ going: true })
  } catch (err) {
    console.error('[events/attend POST]', err)
    return serverError()
  }
}
