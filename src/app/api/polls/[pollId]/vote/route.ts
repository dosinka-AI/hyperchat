import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { broadcastPollRefresh, messageRoomForReader, parsePollOptions } from '@/lib/polls'

type Params = { params: Promise<{ pollId: string }> }

/** Vote on a poll (toggle semantics): single-choice polls replace my pick,
 *  multi-choice polls toggle the option. A poll whose timer ran out closes
 *  lazily here (the scheduler also sweeps). The refreshed message row
 *  broadcasts to the room so every open client re-renders the bars. */
export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { pollId } = await params
    const body = await req.json().catch(() => ({}))
    const optionIndex = typeof body.optionIndex === 'number' ? Math.floor(body.optionIndex) : -1

    const poll = await db.poll.findUnique({
      where: { id: pollId },
      select: { id: true, options: true, allowMulti: true, endsAt: true, closedAt: true, messageId: true },
    })
    if (!poll) return notFound('Poll not found.')

    const options = parsePollOptions(poll.options)
    if (optionIndex < 0 || optionIndex >= options.length) {
      return badRequest('That option does not exist.')
    }

    const message = await db.message.findUnique({
      where: { id: poll.messageId },
      select: { channelId: true, conversationId: true, whisperTargetId: true, authorId: true },
    })
    if (!message) return notFound('Poll not found.')
    const room = await messageRoomForReader(message, me.id)
    if (!room) return forbidden('You cannot vote in that room.')

    // lazy close: a poll past its timer is closed by whoever touches it next
    let justClosed = false
    if (!poll.closedAt && poll.endsAt && poll.endsAt.getTime() <= Date.now()) {
      await db.poll.update({ where: { id: poll.id }, data: { closedAt: new Date() } })
      justClosed = true
    }
    if (poll.closedAt || justClosed) {
      return NextResponse.json({ error: 'That poll already ended.' }, { status: 410 })
    }

    const existing = await db.pollVote.findMany({
      where: { pollId: poll.id, userId: me.id },
      select: { id: true, optionIndex: true },
    })

    if (poll.allowMulti) {
      const mine = existing.find((v) => v.optionIndex === optionIndex)
      if (mine) {
        await db.pollVote.delete({ where: { id: mine.id } })
      } else {
        await db.pollVote.create({ data: { pollId: poll.id, userId: me.id, optionIndex } })
      }
    } else {
      const others = existing.filter((v) => v.optionIndex !== optionIndex)
      if (others.length > 0) {
        await db.pollVote.deleteMany({ where: { id: { in: others.map((v) => v.id) } } })
      }
      const mine = existing.find((v) => v.optionIndex === optionIndex)
      if (mine) {
        await db.pollVote.delete({ where: { id: mine.id } })
      } else {
        await db.pollVote.create({ data: { pollId: poll.id, userId: me.id, optionIndex } })
      }
    }

    await broadcastPollRefresh(poll.messageId, room)
    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
