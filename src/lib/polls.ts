import { db } from '@/lib/db'
import type { PollSummary } from '@/lib/types'

/** Poll option count window (Discord allows 2..10). */
export const POLL_MIN_OPTIONS = 2
export const POLL_MAX_OPTIONS = 10
export const POLL_MAX_OPTION_LEN = 55
export const POLL_MAX_QUESTION_LEN = 300
/** default open-ended duration when the author picks one: 24h */
export const POLL_DURATION_HOURS = [1, 8, 24, 72, 168] as const

/** Validate the request-body poll shape: { question, options[], allowMulti,
 *  durationHours? }. Returns null when unusable (the message then sends as
 *  a plain row, exactly like an invalid reply degrades). */
export function parsePollInput(raw: unknown): {
  question: string
  options: string[]
  allowMulti: boolean
  endsAt: Date | null
} | null {
  if (!raw || typeof raw !== 'object') return null
  const body = raw as { question?: unknown; options?: unknown; allowMulti?: unknown; durationHours?: unknown }
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, POLL_MAX_QUESTION_LEN) : ''
  if (!question) return null
  if (!Array.isArray(body.options)) return null
  const options: string[] = []
  for (const o of body.options) {
    if (typeof o !== 'string') continue
    const text = o.trim().slice(0, POLL_MAX_OPTION_LEN)
    if (text) options.push(text)
    if (options.length >= POLL_MAX_OPTIONS) break
  }
  if (options.length < POLL_MIN_OPTIONS) return null
  const allowMulti = body.allowMulti === true
  let endsAt: Date | null = null
  if (typeof body.durationHours === 'number' && Number.isFinite(body.durationHours)) {
    const hours = Math.min(168, Math.max(1, Math.round(body.durationHours)))
    endsAt = new Date(Date.now() + hours * 3600_000)
  }
  return { question, options, allowMulti, endsAt }
}

/** Parse the options JSON column; malformed data degrades to []. */
export function parsePollOptions(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((o): o is string => typeof o === 'string')
  } catch {
    return []
  }
}

/** Serialize a poll row (with votes selected) into the client shape. */
export function pollSummaryOf(poll: {
  id: string
  question: string
  options: string
  allowMulti: boolean
  endsAt: Date | null
  closedAt: Date | null
  createdById: string
  votes: { optionIndex: number; userId: string }[]
}): PollSummary {
  return {
    id: poll.id,
    question: poll.question,
    options: parsePollOptions(poll.options),
    allowMulti: poll.allowMulti,
    endsAt: poll.endsAt ? poll.endsAt.toISOString() : null,
    closedAt: poll.closedAt ? poll.closedAt.toISOString() : null,
    createdById: poll.createdById,
    votes: poll.votes,
  }
}

/** Can this user read the message a poll lives on? Same visibility rules as
 *  the room listings (channel role access, whisper privacy, DM membership).
 *  Returns the room key when readable, null otherwise. */
export async function messageRoomForReader(
  message: { channelId: string | null; conversationId: string | null; whisperTargetId: string | null; authorId: string },
  userId: string,
  memberCheck?: (serverId: string, userId: string) => Promise<{ canReadChannel: (channel: { private: boolean; access: { roleId: string }[] }) => boolean } | null>
): Promise<string | null> {
  if (message.channelId) {
    const channel = await db.channel.findUnique({
      where: { id: message.channelId },
      include: { access: { select: { roleId: true } } },
    })
    if (!channel) return null
    const ctx = memberCheck
      ? await memberCheck(channel.serverId, userId)
      : await (await import('@/lib/serverPerms')).getMemberContext(channel.serverId, userId)
    if (!ctx) return null
    if (!ctx.canReadChannel(channel)) return null
    if (message.whisperTargetId && userId !== message.authorId && userId !== message.whisperTargetId) return null
    return `channel:${message.channelId}`
  }
  if (message.conversationId) {
    const participant = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId: message.conversationId, userId } },
    })
    if (!participant) return null
    return `conversation:${message.conversationId}`
  }
  return null
}

/** Re-fetch the message with its poll + votes and push it as message:update
 *  to the room, so every open client re-renders the vote bars. */
export async function broadcastPollRefresh(messageId: string, room: string): Promise<void> {
  const { AUTHOR_INCLUDE, serverAuthorDecorator, toClientMessage } = await import('@/lib/messages')
  const { emitToRooms } = await import('@/lib/realtime')
  const row = await db.message.findUnique({ where: { id: messageId }, include: AUTHOR_INCLUDE })
  if (!row) return
  const decorate = row.channelId
    ? await serverAuthorDecorator(
        (await db.channel.findUnique({ where: { id: row.channelId }, select: { serverId: true } }))?.serverId ?? ''
      )
    : undefined
  await emitToRooms([room], 'message:update', toClientMessage(row, room, decorate ?? undefined))
}

/** Who may end a poll: its author, or a channel mod (MANAGE_MESSAGES) when
 *  the poll lives in a server channel. Returns the room key, null otherwise. */
export async function canEndPoll(pollId: string, userId: string): Promise<string | null> {
  const poll = await db.poll.findUnique({
    where: { id: pollId },
    select: { createdById: true, messageId: true },
  })
  if (!poll) return null
  const message = await db.message.findUnique({
    where: { id: poll.messageId },
    select: { channelId: true, conversationId: true, whisperTargetId: true, authorId: true },
  })
  if (!message) return null
  const room = await messageRoomForReader(message, userId)
  if (!room) return null
  if (poll.createdById === userId) return room
  if (message.channelId) {
    const channel = await db.channel.findUnique({
      where: { id: message.channelId },
      include: { access: { select: { roleId: true } } },
    })
    if (channel) {
      const ctx = await (await import('@/lib/serverPerms')).getMemberContext(channel.serverId, userId)
      if (ctx && (await import('@/lib/perm')).hasPerm(ctx.perms, (await import('@/lib/perm')).PERM.MANAGE_MESSAGES)) {
        return room
      }
    }
  }
  return null
}
