import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { fetchLiveCalls, fetchOnlineUserIds, fetchPresenceSnapshot, serverError, unauthorized } from '@/lib/realtime'

const EPOCH = new Date(0)

/**
 * HTTP sync fallback. The websocket layer is the fast path, but proxies,
 * sleep-wake cycles and flaky networks silently break it. Polling this
 * endpoint keeps presence, messages, member lists and unread counts moving
 * even when sockets fail, so nothing ever needs a reload to update.
 */
export async function GET(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const room = req.nextUrl.searchParams.get('room') || ''

    // presence straight from the realtime service
    const onlineUserIds = await fetchOnlineUserIds()
    const presence = await fetchPresenceSnapshot()

    // my servers + stamps
    const memberships = await db.serverMember.findMany({
      where: { userId: me.id },
      include: {
        server: {
          select: {
            id: true,
            _count: { select: { members: true, channels: true } },
          },
        },
      },
    })

    const myChannelIds: string[] = []
    const serverStamps = await Promise.all(
      memberships.map(async (m) => {
        const channels = await db.channel.findMany({
          where: { serverId: m.server.id },
          select: { id: true },
        })
        for (const c of channels) myChannelIds.push(c.id)
        const lastMessage = await db.message.findFirst({
          where: { channel: { serverId: m.server.id } },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        })
        return {
          serverId: m.server.id,
          memberCount: m.server._count.members,
          channelCount: m.server._count.channels,
          lastMessageAt: lastMessage ? lastMessage.createdAt.toISOString() : null,
        }
      })
    )

    // my read states
    const readStates = await db.readState.findMany({ where: { userId: me.id } })
    const readAt = new Map<string, Date>()
    for (const r of readStates) readAt.set(r.scopeKey, r.lastReadAt)

    // unread counts + mention counts per channel
    const channelUnread: Record<string, number> = {}
    const channelMentions: Record<string, number> = {}
    const mentionNeedle = `%@${me.username}%`
    await Promise.all(
      myChannelIds.map(async (channelId) => {
        const scope = `channel:${channelId}`
        const since = readAt.get(scope) ?? EPOCH
        const count = await db.message.count({
          where: { channelId, createdAt: { gt: since } },
        })
        if (count > 0) {
          channelUnread[channelId] = count
          // how many of the unread ones mention me (directly or via @everyone)
          const mentions = await db.message.count({
            where: {
              channelId,
              createdAt: { gt: since },
              authorId: { not: me.id },
              OR: [{ content: { contains: mentionNeedle } }, { pingsEveryone: true }],
            },
          })
          if (mentions > 0) channelMentions[channelId] = mentions
        }
      })
    )

    // conversations with stamps + read receipts
    const participations = await db.conversationParticipant.findMany({
      where: { userId: me.id },
      include: {
        conversation: {
          include: {
            participants: {
              where: { userId: { not: me.id } },
              select: { userId: true },
            },
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { id: true, createdAt: true },
            },
          },
        },
      },
    })

    // group read receipts: every OTHER participant's stamp per conversation.
    // One findMany covers all conversation scopes, then the rows group by
    // conversation — filtered to CURRENT other participants so a departed
    // member's stale read row never shows up as a reader.
    const othersReadByConv = new Map<string, Record<string, string>>()
    const otherMemberIds = new Map<string, Set<string>>()
    for (const p of participations) {
      othersReadByConv.set(p.conversationId, {})
      otherMemberIds.set(
        p.conversationId,
        new Set(p.conversation.participants.map((pt) => pt.userId))
      )
    }
    const convScopes = [...othersReadByConv.keys()].map((id) => `conversation:${id}`)
    const othersReadRows = convScopes.length
      ? await db.readState.findMany({
          where: { scopeKey: { in: convScopes }, userId: { not: me.id } },
        })
      : []
    for (const r of othersReadRows) {
      const conversationId = r.scopeKey.slice('conversation:'.length)
      const entry = othersReadByConv.get(conversationId)
      if (!entry || !otherMemberIds.get(conversationId)?.has(r.userId)) continue
      entry[r.userId] = r.lastReadAt.toISOString()
    }

    const conversationStamps = await Promise.all(
      participations.map(async (p) => {
        const conversationId = p.conversationId
        const scope = `conversation:${conversationId}`
        const since = readAt.get(scope) ?? EPOCH
        const unreadCount = await db.message.count({
          where: { conversationId, createdAt: { gt: since } },
        })
        const otherId = p.conversation.participants[0]?.userId
        const otherRead = otherId
          ? await db.readState.findUnique({
              where: { userId_scopeKey: { userId: otherId, scopeKey: scope } },
            })
          : null
        const last = p.conversation.messages[0]
        return {
          conversationId,
          lastMessageId: last?.id ?? null,
          lastMessageAt: last ? last.createdAt.toISOString() : null,
          otherLastReadAt: otherRead ? otherRead.lastReadAt.toISOString() : null,
          othersReadAt: othersReadByConv.get(conversationId) ?? {},
          hidden: p.hidden,
          unreadCount,
        }
      })
    )

    // the tail of the currently open room, so missed socket events get caught
    let roomLastMessage: { id: string; createdAt: string } | null = null
    if (/^(channel|conversation):[a-zA-Z0-9]+$/.test(room)) {
      const [kind, id] = room.split(':')
      const last = await db.message.findFirst({
        where: kind === 'channel' ? { channelId: id } : { conversationId: id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true },
      })
      roomLastMessage = last ? { id: last.id, createdAt: last.createdAt.toISOString() } : null
    }

    // blocks + mutes so the client can gate DMs and sounds without a reload
    const [blockedRows, muteRows] = await Promise.all([
      db.userBlock.findMany({ where: { blockerId: me.id }, select: { blockedId: true } }),
      db.muteState.findMany({ where: { userId: me.id }, select: { scopeKey: true } }),
    ])

    // live calls in my conversations, straight from the realtime service
    // (a page loaded mid-call shows the join affordances immediately). Call
    // ROOMS ride synthetic space ids (`convId~room`): they hydrate too when
    // the conversation they hang off is mine
    const myConversationIds = participations.map((p) => p.conversationId)
    const liveCalls = await fetchLiveCalls(myConversationIds)

    return NextResponse.json({
      onlineUserIds,
      presenceStatuses: presence.statuses,
      awaySince: presence.awaySince,
      lastSeen: presence.lastSeen,
      liveCalls,
      serverStamps,
      conversationStamps,
      channelUnread,
      channelMentions,
      roomLastMessage,
      blockedUserIds: blockedRows.map((b) => b.blockedId),
      mutedScopes: muteRows.map((m) => m.scopeKey),
    })
  } catch {
    return serverError()
  }
}
