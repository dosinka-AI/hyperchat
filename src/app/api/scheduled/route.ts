import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, notFound, serverError, unauthorized } from '@/lib/realtime'

const SCOPE_RE = /^(channel|conversation):[a-zA-Z0-9]+$/

/** Scheduled messages: composed now, delivered later by the server-side
 *  scheduler in instrumentation.ts. Only the author manages their queue. */
export async function GET() {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const rows = await db.scheduledMessage.findMany({
      where: { authorId: me.id, sentAt: null },
      orderBy: { sendAt: 'asc' },
    })

    // resolve scope names for display
    const channelIds = new Set<string>()
    const convoIds = new Set<string>()
    for (const r of rows) {
      const [, id] = r.scopeKey.split(':')
      if (r.scopeKey.startsWith('channel:')) channelIds.add(id)
      else convoIds.add(id)
    }
    const [channels, convos] = await Promise.all([
      channelIds.size
        ? db.channel.findMany({ where: { id: { in: [...channelIds] } }, select: { id: true, name: true } })
        : [],
      convoIds.size
        ? db.conversation.findMany({
            where: { id: { in: [...convoIds] } },
            select: { id: true, participants: { where: { userId: { not: me.id } }, select: { user: { select: { username: true } } } } },
          })
        : [],
    ])
    const channelNames = new Map<string, string>(channels.map((c) => [c.id, `#${c.name}`] as [string, string]))
    const convoNames = new Map<string, string>(convos.map((c) => [c.id, `@${c.participants[0]?.user.username ?? 'unknown'}`] as [string, string]))

    return NextResponse.json({
      scheduled: rows.map((r) => ({
        id: r.id,
        scopeKey: r.scopeKey,
        scopeName: r.scopeKey.startsWith('channel:')
          ? channelNames.get(r.scopeKey.slice('channel:'.length)) ?? 'deleted channel'
          : convoNames.get(r.scopeKey.slice('conversation:'.length)) ?? 'deleted conversation',
        content: r.content,
        sendAt: r.sendAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
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
    const scopeKey = typeof body.scopeKey === 'string' ? body.scopeKey : ''
    const content = typeof body.content === 'string' ? body.content.trim().slice(0, 2000) : ''
    const sendAtRaw = typeof body.sendAt === 'string' ? body.sendAt : ''

    if (!SCOPE_RE.test(scopeKey)) return badRequest('Pick a channel or conversation.')
    if (!content) return badRequest('Type the message to schedule.')
    const sendAt = new Date(sendAtRaw)
    if (Number.isNaN(sendAt.getTime())) return badRequest('Pick a valid time.')
    if (sendAt.getTime() <= Date.now() + 5000) return badRequest('Pick a time at least a few seconds ahead.')
    if (sendAt.getTime() > Date.now() + 30 * 24 * 60 * 60 * 1000) {
      return badRequest('Scheduled messages can be at most 30 days out.')
    }

    // the author must still be able to see the target scope
    const [kind, id] = scopeKey.split(':')
    if (kind === 'channel') {
      const channel = await db.channel.findUnique({ where: { id }, select: { serverId: true } })
      if (!channel) return notFound('That channel no longer exists.')
      const member = await db.serverMember.findFirst({
        where: { serverId: channel.serverId, userId: me.id },
      })
      if (!member) return forbiddenResponse()
    } else {
      const participant = await db.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId: id, userId: me.id } },
      })
      if (!participant) return forbiddenResponse()
    }

    const row = await db.scheduledMessage.create({
      data: { authorId: me.id, scopeKey, content, sendAt },
    })
    return NextResponse.json(
      {
        scheduled: {
          id: row.id,
          scopeKey: row.scopeKey,
          scopeName: kind === 'channel' ? `#${await channelNameOf(id)}` : `@${await dmNameOf(id, me.id)}`,
          content: row.content,
          sendAt: row.sendAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
        },
      },
      { status: 201 }
    )
  } catch {
    return serverError()
  }
}

export async function DELETE(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json()
    const id = typeof body.id === 'string' ? body.id : ''
    if (!id) return badRequest('Which scheduled message?')
    const row = await db.scheduledMessage.findFirst({ where: { id, authorId: me.id } })
    if (!row) return notFound('That scheduled message is gone.')
    await db.scheduledMessage.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}

function forbiddenResponse() {
  return NextResponse.json({ error: 'You are not part of that conversation.' }, { status: 403 })
}

async function channelNameOf(channelId: string): Promise<string> {
  const c = await db.channel.findUnique({ where: { id: channelId }, select: { name: true } })
  return c?.name ?? 'deleted channel'
}

async function dmNameOf(conversationId: string, meId: string): Promise<string> {
  const p = await db.conversationParticipant.findFirst({
    where: { conversationId, userId: { not: meId } },
    select: { user: { select: { username: true } } },
  })
  return p?.user.username ?? 'unknown'
}
