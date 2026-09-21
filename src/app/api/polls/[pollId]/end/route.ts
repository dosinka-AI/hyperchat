import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { broadcastPollRefresh, canEndPoll } from '@/lib/polls'

type Params = { params: Promise<{ pollId: string }> }

/** End a poll early: the author or a channel moderator (MANAGE_MESSAGES).
 *  Ending freezes the votes and lets every client render the final tally. */
export async function POST(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { pollId } = await params
    const poll = await db.poll.findUnique({ where: { id: pollId }, select: { id: true, messageId: true, closedAt: true } })
    if (!poll) return notFound('Poll not found.')

    const room = await canEndPoll(pollId, me.id)
    if (!room) return forbidden('Only the poll author or a moderator can end it.')

    if (!poll.closedAt) {
      await db.poll.update({ where: { id: poll.id }, data: { closedAt: new Date() } })
      await broadcastPollRefresh(poll.messageId, room)
    }
    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
