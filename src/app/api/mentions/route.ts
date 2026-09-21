import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { serverError, unauthorized } from '@/lib/realtime'
import { ADMIN_BASE_PERMS, PERM } from '@/lib/perm'

/** The mentions inbox ("recent mentions"): every message that pinged me
 *  across my servers and DMs, newest first. A LIKE prefilter narrows the
 *  scan, then a strict mention regex kills false positives like
 *  "@gladiator" matching "@glm". @everyone/@here rows from my servers are
 *  kept too. Whispers aimed at other people never appear. */
export async function GET(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const daysRaw = Number(new URL(req.url).searchParams.get('days') ?? '7')
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 30) : 7
    const after = new Date(Date.now() - days * 86_400_000)
    const token = `@${me.username}`

    // my servers + the channels I may read (private channel filtering
    // follows the server list route's rules)
    const memberships = await db.serverMember.findMany({
      where: { userId: me.id },
      include: {
        customRole: { select: { id: true, permissions: true } },
        server: {
          select: {
            id: true,
            name: true,
            ownerId: true,
            channels: { select: { id: true, name: true, private: true, access: { select: { roleId: true } } } },
          },
        },
      },
    })
    const visibleChannelIds: string[] = []
    for (const m of memberships) {
      const isOwner = m.server.ownerId === me.id
      const perms = isOwner ? PERM.ADMINISTRATOR : m.role === 'ADMIN' ? ADMIN_BASE_PERMS : m.customRole?.permissions ?? 0
      const mod = (perms & (PERM.ADMINISTRATOR | PERM.MANAGE_MESSAGES)) !== 0
      const roleId = m.customRole?.id ?? null
      for (const ch of m.server.channels) {
        if (!ch.private || mod || (roleId && ch.access.some((a) => a.roleId === roleId))) {
          visibleChannelIds.push(ch.id)
        }
      }
    }

    const convos = await db.conversationParticipant.findMany({
      where: { userId: me.id, hidden: false },
      select: { conversation: { select: { id: true, name: true, kind: true } } },
    })
    const conversationIds = convos.map((c) => c.conversation.id)

    const rows = await db.message.findMany({
      where: {
        createdAt: { gt: after },
        authorId: { not: me.id },
        threadOfId: null,
        OR: [
          { channelId: { in: visibleChannelIds }, content: { contains: token } },
          { channelId: { in: visibleChannelIds }, pingsEveryone: true },
          { conversationId: { in: conversationIds }, content: { contains: token } },
        ],
        AND: [{ OR: [{ whisperTargetId: null }, { whisperTargetId: me.id }] }],
      },
      orderBy: { createdAt: 'desc' },
      take: 80,
      select: {
        id: true,
        content: true,
        imageUrl: true,
        pingsEveryone: true,
        createdAt: true,
        channelId: true,
        conversationId: true,
        author: { select: { id: true, username: true, displayName: true, avatarUrl: true, avatarColor: true } },
        channel: { select: { name: true, server: { select: { id: true, name: true } } } },
        conversation: { select: { name: true, kind: true } },
      },
    })

    const mentionRe = new RegExp(`(^|[^\\w@])@${me.username}(?![\\w_])`, 'i')
    const mentions = rows
      .filter((r) => r.pingsEveryone === true || (r.content !== null && mentionRe.test(r.content)))
      .slice(0, 50)
      .map((r) => ({
        id: r.id,
        content: r.content ? r.content.slice(0, 260) : null,
        imageUrl: r.imageUrl,
        pingsEveryone: r.pingsEveryone === true,
        createdAt: r.createdAt.toISOString(),
        author: r.author,
        scope: r.channel
          ? {
              kind: 'channel' as const,
              channelId: r.channelId,
              channelName: r.channel.name,
              serverId: r.channel.server.id,
              serverName: r.channel.server.name,
              conversationId: null,
              conversationName: null,
            }
          : {
              kind: 'conversation' as const,
              channelId: null,
              channelName: null,
              serverId: null,
              serverName: null,
              conversationId: r.conversationId,
              conversationName: r.conversation?.name ?? null,
            },
        room: r.channelId ? `channel:${r.channelId}` : `conversation:${r.conversationId}`,
      }))

    const readState = await db.readState.findUnique({
      where: { userId_scopeKey: { userId: me.id, scopeKey: 'mentions' } },
    })
    return NextResponse.json({ mentions, lastReadAt: readState?.lastReadAt.toISOString() ?? null })
  } catch {
    return serverError()
  }
}

/** Mark the whole inbox as seen: the "new" dots in the panel clear. */
export async function POST() {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    await db.readState.upsert({
      where: { userId_scopeKey: { userId: me.id, scopeKey: 'mentions' } },
      update: { lastReadAt: new Date() },
      create: { userId: me.id, scopeKey: 'mentions', lastReadAt: new Date() },
    })
    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
