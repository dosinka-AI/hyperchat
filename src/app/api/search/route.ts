import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { AUTHOR_INCLUDE, toClientMessage } from '@/lib/messages'
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { ADMIN_BASE_PERMS, hasPerm, PERM } from '@/lib/perm'

const MAX_RESULTS = 25

export async function GET(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const q = (req.nextUrl.searchParams.get('q') || '').trim()
    const serverId = req.nextUrl.searchParams.get('serverId') || ''
    // scope=conversations: only the user's DMs and group chats, no servers
    const conversationsOnly = req.nextUrl.searchParams.get('scope') === 'conversations'
    // conversationId: pin the search to one DM/group the user is part of
    const conversationId = req.nextUrl.searchParams.get('conversationId') || ''
    if (!q) return badRequest('Type something to search for.')

    const needle = q.toLowerCase()

    // set of channel ids the searcher is allowed to read
    const readableChannelIds = new Set<string>()

    let where
    if (conversationId) {
      // single-conversation scope (the header search inside a DM/group)
      const participation = await db.conversationParticipant.findFirst({
        where: { conversationId, userId: me.id },
        select: { id: true },
      })
      if (!participation) return notFound('Conversation not found.')
      where = { conversationId }
    } else if (serverId) {
      const ctx = await getMemberContext(serverId, me.id)
      if (!ctx) return forbidden('You are not a member of that server.')
      const channels = await db.channel.findMany({
        where: { serverId },
        include: { access: { select: { roleId: true } } },
      })
      const mod = hasPerm(ctx.perms, PERM.MANAGE_MESSAGES) || hasPerm(ctx.perms, PERM.ADMINISTRATOR)
      for (const ch of channels) {
        if (!ch.private || mod || (ctx.roleId && ch.access.some((a) => a.roleId === ctx.roleId))) {
          readableChannelIds.add(ch.id)
        }
      }
      where = { channel: { serverId } }
    } else if (conversationsOnly) {
      // the sidebar search: every DM and group chat the user is in
      const participations = await db.conversationParticipant.findMany({
        where: { userId: me.id },
        select: { conversationId: true },
      })
      where = { conversationId: { in: participations.map((p) => p.conversationId) } }
    } else {
      // everything I can see: my servers' channels and my conversations
      const memberships = await db.serverMember.findMany({
        where: { userId: me.id },
        include: {
          customRole: { select: { id: true, permissions: true } },
          server: {
            include: { channels: { select: { id: true, private: true, access: { select: { roleId: true } } } } },
          },
        },
      })
      for (const m of memberships) {
        const perms = m.server.ownerId === me.id
          ? PERM.ADMINISTRATOR
          : m.role === 'ADMIN'
            ? ADMIN_BASE_PERMS
            : m.customRole?.permissions ?? 0
        const mod = hasPerm(perms, PERM.MANAGE_MESSAGES) || hasPerm(perms, PERM.ADMINISTRATOR)
        for (const ch of m.server.channels) {
          if (!ch.private || mod || (m.customRole && ch.access.some((a) => a.roleId === m.customRole!.id))) {
            readableChannelIds.add(ch.id)
          }
        }
      }
      const myServerIds = memberships.map((m) => m.serverId)
      const participations = await db.conversationParticipant.findMany({
        where: { userId: me.id },
        select: { conversationId: true },
      })
      const myConversationIds = participations.map((p) => p.conversationId)
      where = {
        OR: [
          { channel: { serverId: { in: myServerIds } } },
          { conversationId: { in: myConversationIds } },
        ],
      }
    }

    // SQLite contains is case sensitive, so pull recent rows and match in memory
    const candidates = await db.message.findMany({
      where: { ...where, content: { contains: q } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: AUTHOR_INCLUDE,
    })

    // search hits whisper/private rows only if they involve the searcher:
    // whisper rows the searcher is not part of stay hidden in every scope
    const visible = (m: (typeof candidates)[number]) =>
      !m.whisperTargetId || m.authorId === me.id || m.whisperTargetId === me.id
    const results = candidates
      .filter(
        (m) =>
          visible(m) &&
          (m.content || '').toLowerCase().includes(needle) &&
          (!m.channelId || readableChannelIds.has(m.channelId))
      )
      .slice(0, MAX_RESULTS)
      .map((m) => ({
        ...toClientMessage(m, m.channelId ? `channel:${m.channelId}` : `conversation:${m.conversationId}`),
        channelName: null as string | null,
      }))

    return NextResponse.json({ messages: results })
  } catch {
    return serverError()
  }
}

export const dynamic = 'force-dynamic'
