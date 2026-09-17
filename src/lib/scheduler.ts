/**
 * Server-side scheduler for delayed delivery features.
 *
 * - ScheduledMessage rows: written when a user composes "send later".
 *   This tick persists and broadcasts them at the chosen time, running the
 *   same gates as the interactive POST routes (membership, locks, automod,
 *   timeouts, slowmode). Rows that can never succeed (kicked, automod,
 *   blocked DM) are dropped so queues do not spin forever.
 * - Reminder rows are client-fired: the client polls them on boot and ticks
 *   locally, so this loop only needs to prune reminders whose message died.
 * - Temporary messages: rows whose expiresAt has passed are deleted here
 *   every sweep, so auto-deleting DMs vanish for everyone without any
 *   browser open (reactions, bookmarks, reminders cascade with the row,
 *   the same cleanup path the interactive delete route uses).
 */

import { db } from '@/lib/db'
import { AUTHOR_INCLUDE, containsMassMention, serverAuthorDecorator, toClientMessage } from '@/lib/messages'
import { channelRoom, conversationRoom, emitToRooms, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'

type TickResult = { delivered: number; dropped: number; deferred: number }

function blockedWordList(raw: string | undefined | null): string[] {
  if (!raw) return []
  return raw
    .split(/[\n,]+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w.length >= 2 && w.length <= 40)
}

async function deliverChannelMessage(row: {
  id: string
  authorId: string
  content: string
}): Promise<'sent' | 'deferred' | 'dropped'> {
  const channelId = row.id
  const channel = await db.channel.findUnique({
    where: { id: channelId },
    include: { access: { select: { roleId: true } } },
  })
  if (!channel) return 'dropped'
  const ctx = await getMemberContext(channel.serverId, row.authorId)
  if (!ctx) return 'dropped'
  if (!ctx.canReadChannel(channel)) return 'dropped'

  // timed out: wait it out, the timeout expires and delivery resumes
  if (ctx.timedOut) return 'deferred'

  const canMod = hasPerm(ctx.perms, PERM.MANAGE_MESSAGES)
  if (channel.locked && !canMod) return 'deferred'

  if (channel.slowmodeSeconds > 0 && !canMod) {
    const last = await db.message.findFirst({
      where: { channelId, authorId: row.authorId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    if (last && (Date.now() - last.createdAt.getTime()) / 1000 < channel.slowmodeSeconds) return 'deferred'
  }

  const server = await db.server.findUnique({ where: { id: channel.serverId }, select: { blockedWords: true } })
  const words = blockedWordList(server?.blockedWords)
  if (words.length > 0) {
    const haystack = row.content.toLowerCase()
    if (words.some((w) => haystack.includes(w))) return 'dropped'
  }

  const pingsEveryone = containsMassMention(row.content) && hasPerm(ctx.perms, PERM.MENTION_EVERYONE)
  const message = await db.message.create({
    data: { channelId, authorId: row.authorId, content: row.content, pingsEveryone },
    include: AUTHOR_INCLUDE,
  })

  const now = new Date()
  await db.readState.upsert({
    where: { userId_scopeKey: { userId: row.authorId, scopeKey: `channel:${channelId}` } },
    create: { userId: row.authorId, scopeKey: `channel:${channelId}`, lastReadAt: now },
    update: { lastReadAt: now },
  })

  const room = channelRoom(channelId)
  const decorate = await serverAuthorDecorator(channel.serverId)
  await emitToRooms([room], 'message:new', toClientMessage(message, room, decorate))
  return 'sent'
}

async function deliverConversationMessage(row: {
  scopeKey: string
  authorId: string
  content: string
}): Promise<'sent' | 'deferred' | 'dropped'> {
  const conversationId = row.scopeKey.slice('conversation:'.length)
  const participants = await db.conversationParticipant.findMany({
    where: { conversationId },
    select: { userId: true },
  })
  if (!participants.length) return 'dropped'
  if (!participants.some((p) => p.userId === row.authorId)) return 'dropped'

  // blocks gate DMs in both directions
  const others = participants.filter((p) => p.userId !== row.authorId)
  if (others.length > 0) {
    const block = await db.userBlock.findFirst({
      where: {
        OR: others.flatMap((o) => [
          { blockerId: row.authorId, blockedId: o.userId },
          { blockerId: o.userId, blockedId: row.authorId },
        ]),
      },
    })
    if (block) return 'dropped'
  }

  // temporary messages (1:1 DMs): scheduled sends expire like live ones
  const conversation = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { kind: true, tempExpiryMinutes: true },
  })
  const expiresAt =
    conversation && conversation.kind === 'DM' && conversation.tempExpiryMinutes
      ? new Date(Date.now() + conversation.tempExpiryMinutes * 60 * 1000)
      : null

  const message = await db.message.create({
    data: { conversationId, authorId: row.authorId, content: row.content, expiresAt },
    include: AUTHOR_INCLUDE,
  })

  await db.conversationParticipant.updateMany({
    where: { conversationId, hidden: true },
    data: { hidden: false },
  })

  const now = new Date()
  await db.readState.upsert({
    where: { userId_scopeKey: { userId: row.authorId, scopeKey: `conversation:${conversationId}` } },
    create: { userId: row.authorId, scopeKey: `conversation:${conversationId}`, lastReadAt: now },
    update: { lastReadAt: now },
  })

  const room = conversationRoom(conversationId)
  await emitToRooms([room, ...participants.map((p) => userRoom(p.userId))], 'message:new', toClientMessage(message, room))
  return 'sent'
}

/** Delete expired temporary messages and broadcast their removal to the room
 *  they live in. Reactions, bookmarks and reminders cascade with the row,
 *  which is the exact cleanup the interactive delete route relies on. */
export async function sweepExpiredMessages(): Promise<number> {
  let swept = 0
  try {
    const expired = await db.message.findMany({
      where: { expiresAt: { lte: new Date() } },
      select: { id: true, channelId: true, conversationId: true },
      take: 200,
    })
    for (const msg of expired) {
      try {
        const rooms: string[] = []
        if (msg.channelId) rooms.push(channelRoom(msg.channelId))
        if (msg.conversationId) rooms.push(conversationRoom(msg.conversationId))
        await db.message.delete({ where: { id: msg.id } })
        await emitToRooms(rooms, 'message:delete', { messageId: msg.id, rooms })
        swept++
      } catch {
        // already gone between select and delete: fine
      }
    }
  } catch {
    // db not ready yet: the next sweep retries
  }
  return swept
}

/** Temporary friendships dissolve silently once their window passes. */
export async function sweepExpiredFriendships(): Promise<number> {
  let swept = 0
  try {
    const expired = await db.friendship.findMany({
      where: { expiresAt: { not: null, lte: new Date() } },
      select: { id: true, requesterId: true, addresseeId: true },
      take: 100,
    })
    for (const row of expired) {
      try {
        await db.friendship.delete({ where: { id: row.id } })
        await emitToRooms(
          [userRoom(row.requesterId), userRoom(row.addresseeId)],
          'friends:update',
          {}
        )
        swept++
      } catch {
        // already gone between select and delete: fine
      }
    }
  } catch {
    // db not ready yet: the next sweep retries
  }
  return swept
}

/** Expired stories vanish on their own: rows past their 24h expiresAt are
 *  deleted every sweep, so rings gray out and story feeds forget them even
 *  with every browser closed. StoryView markers cascade with the row. */
export async function sweepExpiredStories(): Promise<number> {
  let swept = 0
  try {
    const expired = await db.story.findMany({
      where: { expiresAt: { lte: new Date() } },
      select: { id: true },
      take: 200,
    })
    for (const row of expired) {
      try {
        await db.story.delete({ where: { id: row.id } })
        swept++
      } catch {
        // already gone between select and delete: fine
      }
    }
  } catch {
    // db not ready yet: the next sweep retries
  }
  return swept
}

export async function schedulerTick(): Promise<TickResult> {
  const result: TickResult = { delivered: 0, dropped: 0, deferred: 0 }
  try {
    const due = await db.scheduledMessage.findMany({
      where: { sentAt: null, sendAt: { lte: new Date() } },
      take: 25,
      orderBy: { sendAt: 'asc' },
    })

    for (const row of due) {
      try {
        const outcome = row.scopeKey.startsWith('channel:')
          ? await deliverChannelMessage({ id: row.scopeKey.slice('channel:'.length), authorId: row.authorId, content: row.content })
          : await deliverConversationMessage({ scopeKey: row.scopeKey, authorId: row.authorId, content: row.content })
        if (outcome === 'sent') {
          await db.scheduledMessage.update({ where: { id: row.id }, data: { sentAt: new Date() } })
          result.delivered++
        } else if (outcome === 'dropped') {
          await db.scheduledMessage.delete({ where: { id: row.id } })
          result.dropped++
        } else {
          result.deferred++
        }
      } catch {
        // transient error: retried on the next tick
        result.deferred++
      }
    }
  } catch {
    // db not ready yet: the next tick retries
  }
  return result
}
