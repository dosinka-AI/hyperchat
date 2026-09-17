import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { AUTHOR_INCLUDE, toClientMessage } from '@/lib/messages'
import { badRequest, notFound, serverError, unauthorized } from '@/lib/realtime'

/** Personal saved-messages collection. Bookmarks are private: only the
 *  author can list, add, note, or remove their own bookmarks. */
export async function GET() {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const rows = await db.bookmark.findMany({
      where: { userId: me.id },
      orderBy: { createdAt: 'desc' },
      include: { message: { include: AUTHOR_INCLUDE } },
    })

    // resolve each message's scope name (channel name or DM partner)
    const channelIds = new Set<string>()
    const convoIds = new Set<string>()
    for (const r of rows) {
      if (r.message.channelId) channelIds.add(r.message.channelId)
      if (r.message.conversationId) convoIds.add(r.message.conversationId)
    }
    const [channels, convos] = await Promise.all([
      channelIds.size
        ? db.channel.findMany({
            where: { id: { in: [...channelIds] } },
            select: { id: true, name: true },
          })
        : [],
      convoIds.size
        ? db.conversation.findMany({
            where: { id: { in: [...convoIds] } },
            select: { id: true, participants: { where: { userId: { not: me.id } }, select: { user: { select: { username: true } } } } },
          })
        : [],
    ])
    const channelNames = new Map<string, string>(channels.map((c) => [c.id, c.name] as [string, string]))
    const convoNames = new Map<string, string>(convos.map((c) => [c.id, `@${c.participants[0]?.user.username ?? 'unknown'}`] as [string, string]))

    return NextResponse.json({
      bookmarks: rows.map((r) => {
        const room = r.message.channelId
          ? `channel:${r.message.channelId}`
          : r.message.conversationId
            ? `conversation:${r.message.conversationId}`
            : 'unknown'
        const scopeName = r.message.channelId
          ? channelNames.get(r.message.channelId) ?? 'deleted channel'
          : r.message.conversationId
            ? convoNames.get(r.message.conversationId) ?? 'deleted conversation'
            : null
        return {
          id: r.id,
          note: r.note,
          createdAt: r.createdAt.toISOString(),
          message: toClientMessage(r.message, room),
          scope: scopeName ? { kind: r.message.channelId ? ('channel' as const) : ('conversation' as const), name: scopeName } : null,
        }
      }),
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
    if (!messageId) return badRequest('Which message?')

    const message = await db.message.findUnique({ where: { id: messageId }, select: { id: true } })
    if (!message) return notFound('That message no longer exists.')

    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 190) : ''

    const existing = await db.bookmark.findUnique({
      where: { userId_messageId: { userId: me.id, messageId } },
    })
    if (existing) {
      // toggling: update the note when given, remove when asked
      if (body.remove === true) {
        await db.bookmark.delete({ where: { id: existing.id } })
        return NextResponse.json({ saved: false })
      }
      if (note && note !== existing.note) {
        await db.bookmark.update({ where: { id: existing.id }, data: { note } })
        return NextResponse.json({ saved: true, note })
      }
      return NextResponse.json({ saved: true, note: existing.note })
    }

    await db.bookmark.create({ data: { userId: me.id, messageId, note } })
    return NextResponse.json({ saved: true, note }, { status: 201 })
  } catch {
    return serverError()
  }
}
