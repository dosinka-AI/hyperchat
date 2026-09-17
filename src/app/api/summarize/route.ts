import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'

const MIN_COUNT = 5
const MAX_COUNT = 200

/** per-user cooldown between summarize runs: one recap every 30s is
 *  plenty and keeps the llm cost bounded. in-memory at module scope, so
 *  it applies to every request this process serves. */
const COOLDOWN_MS = 30_000
const lastSuccessAt = new Map<string, number>()

/** Room context label used in the prompt so the model knows what it is
 *  looking at (a dm, a group chat, or a server channel). */
function roomLabel(room: string): string {
  return room.startsWith('channel:') ? 'a server channel' : 'a direct message or group chat'
}

export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json()
    const room = typeof body.room === 'string' ? body.room : ''
    const count = typeof body.count === 'number' ? Math.floor(body.count) : 50
    if (!room.startsWith('channel:') && !room.startsWith('conversation:')) {
      return badRequest('Open a conversation or channel first.')
    }
    if (!Number.isFinite(count) || count < MIN_COUNT || count > MAX_COUNT) {
      return badRequest(`Pick between ${MIN_COUNT} and ${MAX_COUNT} messages.`)
    }

    // 30s per-user cooldown, rejected before any db or llm work happens
    const last = lastSuccessAt.get(me.id)
    if (last !== undefined) {
      const elapsed = Date.now() - last
      if (elapsed < COOLDOWN_MS) {
        const retryAfter = Math.ceil((COOLDOWN_MS - elapsed) / 1000)
        return NextResponse.json({ error: `${retryAfter}s cooldown between summaries`, retryAfter }, { status: 429 })
      }
    }

    // permission gate: the same reads the message list itself would do
    if (room.startsWith('channel:')) {
      const channelId = room.slice('channel:'.length)
      const channel = await db.channel.findUnique({
        where: { id: channelId },
        include: { access: { select: { roleId: true } } },
      })
      if (!channel) return notFound('Channel not found.')
      const ctx = await getMemberContext(channel.serverId, me.id)
      if (!ctx) return forbidden('You are not a member of this server.')
      if (!ctx.canReadChannel(channel)) return forbidden('This channel is limited to specific roles.')
    } else {
      const conversationId = room.slice('conversation:'.length)
      const participation = await db.conversationParticipant.findFirst({
        where: { conversationId, userId: me.id },
        select: { id: true },
      })
      if (!participation) return notFound('Conversation not found.')
    }

    // the newest N human rows: system rows, expired rows and whispers the
    // caller is not part of never make it into the transcript
    const where = room.startsWith('channel:')
      ? { channelId: room.slice('channel:'.length), systemKind: null }
      : {
          conversationId: room.slice('conversation:'.length),
          systemKind: null,
          threadOfId: null,
          OR: [{ whisperTargetId: null }, { authorId: me.id }, { whisperTargetId: me.id }],
        }
    const rows = await db.message.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: count,
      include: { author: { select: { username: true, displayName: true } } },
    })
    if (rows.length === 0) return badRequest('There are no messages here to summarize yet.')
    rows.reverse()

    // build a compact transcript: "name: text [+ media notes]"
    const lines = rows.map((m) => {
      const name = m.author.displayName || m.author.username
      const parts: string[] = []
      if (m.content) parts.push(m.content.replace(/\s+/g, ' ').slice(0, 500))
      if (m.imageUrl) parts.push('[image]')
      if (m.attachments) {
        try {
          const files = JSON.parse(m.attachments) as { name: string; mime: string }[]
          for (const f of Array.isArray(files) ? files.slice(0, 4) : []) {
            parts.push(`[file: ${f.name}${f.mime?.startsWith('video/') ? ' (video)' : f.mime?.startsWith('audio/') ? ' (audio)' : ''}]`)
          }
        } catch {
          parts.push('[file]')
        }
      }
      const time = new Date(m.createdAt).toISOString().slice(11, 16)
      return `${time} ${name}: ${parts.join(' ') || '[empty]'}`
    })

    const { default: ZAI } = await import('z-ai-web-dev-sdk')
    const zai = await ZAI.create()
    const startedAt = Date.now()
    const completion = await zai.chat.completions.create({
      messages: [
        {
          role: 'assistant',
          content:
            'You summarize chat conversations. You receive a transcript of the most recent messages from ' +
            'a chat room, oldest first. Write a tight markdown summary: a one-or-two-sentence overview, then ' +
            '3-6 bullet points covering what was discussed, decisions made, and anything left unresolved. ' +
            'Refer to people by their display names. Note images/files only when they clearly matter. ' +
            'Never invent things that are not in the transcript. Keep it under 180 words. ' +
            'No headings larger than bold text, no preamble like "here is". ' +
            'Write in normal English sentence case: capitalize the first word of every sentence and every ' +
            'proper noun. Do not lowercase the output. The chat messages may be all lowercase — that style ' +
            'belongs to the app interface, but the summary is rendered prose and must read like normally ' +
            'written English. ' +
            'Output ONLY the recap of the conversation — what the people actually said to each other. ' +
            'It is never about the transcript or the machinery around it: do not mention or comment on the ' +
            'transcript, message counts, how many messages exist or were loaded, history, pagination or ' +
            'loading, how the summary was produced, or that a summary was requested at all. Do not explain ' +
            'platform mechanics or add definitions or clarifying asides about the app (accounts, servers, ' +
            'ownership, roles, moderation, how features work). Mention a platform concept only when the ' +
            'users themselves were actively discussing that concept, and even then summarize their ' +
            'discussion rather than explaining the system.',
        },
        {
          role: 'user',
          content: `Transcript of the ${rows.length} most recent messages in ${roomLabel(room)} (oldest first):\n\n${lines.join('\n')}`,
        },
      ],
      thinking: { type: 'disabled' },
    })
    const summary = completion.choices[0]?.message?.content?.trim() ?? ''
    if (!summary) return serverError()

    // the run succeeded: this user's 30s cooldown window starts now
    lastSuccessAt.set(me.id, Date.now())

    return NextResponse.json({
      summary: summary.slice(0, 4000),
      summarized: rows.length,
      from: rows[0].createdAt.toISOString(),
      to: rows[rows.length - 1].createdAt.toISOString(),
      took: Math.max(1, Date.now() - startedAt),
    })
  } catch {
    return serverError()
  }
}

export const dynamic = 'force-dynamic'
