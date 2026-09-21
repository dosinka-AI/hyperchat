import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { canReadMessage } from '@/lib/messages'
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'

/** "Remind me about this message": a personal nudge that fires as a toast +
 *  jump link at the chosen time. Pending reminders survive reloads; ones the
 *  client missed fire on next boot. */
export async function GET() {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const rows = await db.reminder.findMany({
      where: { userId: me.id, firedAt: null },
      orderBy: { remindAt: 'asc' },
      include: {
        message: {
          select: {
            id: true,
            content: true,
            channelId: true,
            conversationId: true,
            author: { select: { username: true } },
          },
        },
      },
    })

    return NextResponse.json({
      reminders: rows.map((r) => ({
        id: r.id,
        messageId: r.messageId,
        remindAt: r.remindAt.toISOString(),
        message: {
          id: r.message.id,
          room: r.message.channelId
            ? `channel:${r.message.channelId}`
            : r.message.conversationId
              ? `conversation:${r.message.conversationId}`
              : 'unknown',
          contentPreview: (r.message.content ?? '').slice(0, 120) || null,
          authorUsername: r.message.author.username,
        },
      })),
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
    const messageId = typeof body.messageId === 'string' ? body.messageId : ''
    const remindAtRaw = typeof body.remindAt === 'string' ? body.remindAt : ''
    if (!messageId) return badRequest('Which message?')

    const message = await db.message.findUnique({
      where: { id: messageId },
      select: { id: true, channelId: true, conversationId: true, whisperTargetId: true, authorId: true },
    })
    if (!message) return notFound('That message no longer exists.')
    // a reminder must point at a message the caller can actually read: a
    // swapped id must never smuggle a foreign preview out through the
    // caller's own reminder list
    if (!(await canReadMessage(me.id, message))) {
      return forbidden('You cannot set a reminder on that message.')
    }

    const remindAt = new Date(remindAtRaw)
    if (Number.isNaN(remindAt.getTime())) return badRequest('Pick a valid time.')
    if (remindAt.getTime() <= Date.now() + 5000) return badRequest('Pick a time at least a few seconds ahead.')
    if (remindAt.getTime() > Date.now() + 30 * 24 * 60 * 60 * 1000) {
      return badRequest('Reminders can be at most 30 days out.')
    }

    const row = await db.reminder.create({ data: { userId: me.id, messageId, remindAt } })
    return NextResponse.json({ reminder: { id: row.id, messageId, remindAt: row.remindAt.toISOString() } }, { status: 201 })
  } catch {
    return serverError()
  }
}

/** Mark a reminder as fired (client acks after showing the toast) or cancel it. */
export async function DELETE(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json().catch(() => ({}))
    const id = typeof body.id === 'string' ? body.id : ''
    if (!id) return badRequest('Which reminder?')
    const row = await db.reminder.findFirst({ where: { id, userId: me.id } })
    if (!row) return notFound('That reminder is gone.')
    await db.reminder.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
