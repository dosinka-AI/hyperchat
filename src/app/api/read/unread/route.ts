import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, unauthorized, serverError } from '@/lib/realtime'

/** Discord-style "mark unread from here": rewinds my read stamp for a
 *  channel or conversation to just before the picked message, so the room
 *  re-badges and the NEW divider lands above that row. The same access
 *  checks as the plain read route. */
export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const body = await req.json()
    const scope = typeof body.scope === 'string' ? body.scope : ''
    const messageId = typeof body.messageId === 'string' ? body.messageId : ''
    if (!/^(channel|conversation):[a-zA-Z0-9]+$/.test(scope)) return badRequest('Invalid scope.')
    if (!messageId) return badRequest('Which message?')

    const [kind, id] = scope.split(':')
    const message = await db.message.findUnique({ where: { id: messageId }, select: { createdAt: true, channelId: true, conversationId: true } })
    if (!message) return badRequest('Message not found.')

    if (kind === 'channel') {
      if (message.channelId !== id) return badRequest('That message is not in this channel.')
      const channel = await db.channel.findUnique({ where: { id }, include: { server: { include: { members: { select: { userId: true } } } } } })
      if (!channel || !channel.server.members.some((m) => m.userId === me.id)) {
        return NextResponse.json({ error: 'You are not a member of this server.' }, { status: 403 })
      }
    } else {
      if (message.conversationId !== id) return badRequest('That message is not in this conversation.')
      const participant = await db.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId: id, userId: me.id } },
      })
      if (!participant) return badRequest('Conversation not found.')
    }

    // one second before the picked row: the divider logic is "first message
    // newer than my stamp", so this puts it exactly above the pick
    const lastReadAt = new Date(message.createdAt.getTime() - 1000)
    await db.readState.upsert({
      where: { userId_scopeKey: { userId: me.id, scopeKey: scope } },
      create: { userId: me.id, scopeKey: scope, lastReadAt },
      update: { lastReadAt },
    })

    return NextResponse.json({ ok: true, lastReadAt: lastReadAt.toISOString() })
  } catch (err) {
    console.error('[read/unread POST]', err)
    return serverError()
  }
}
