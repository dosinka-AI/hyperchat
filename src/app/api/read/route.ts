import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, conversationRoom, emitToRooms, serverError, unauthorized } from '@/lib/realtime'

const SCOPE_RE = /^(channel|conversation|post):[a-zA-Z0-9]+$/

export async function POST(req: NextRequest) {
  // mark a channel, conversation or forum post as read up to now
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json()
    const scope = typeof body.scope === 'string' ? body.scope : ''
    if (!SCOPE_RE.test(scope)) return badRequest('Invalid scope.')

    const [kind, id] = scope.split(':')

    if (kind === 'channel') {
      const channel = await db.channel.findUnique({
        where: { id },
        include: { server: { include: { members: { select: { userId: true } } } } },
      })
      if (!channel) return badRequest('Channel not found.')
      if (!channel.server.members.some((m) => m.userId === me.id)) {
        return NextResponse.json({ error: 'You are not a member of this server.' }, { status: 403 })
      }
    } else if (kind === 'post') {
      const post = await db.forumPost.findUnique({
        where: { id },
        include: { channel: { include: { server: { include: { members: { select: { userId: true } } } } } } },
      })
      if (!post) return badRequest('Post not found.')
      if (!post.channel.server.members.some((m) => m.userId === me.id)) {
        return NextResponse.json({ error: 'You are not a member of this server.' }, { status: 403 })
      }
    } else {
      const participant = await db.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId: id, userId: me.id } },
      })
      if (!participant) return badRequest('Conversation not found.')
    }

    const lastReadAt = new Date()
    await db.readState.upsert({
      where: { userId_scopeKey: { userId: me.id, scopeKey: scope } },
      create: { userId: me.id, scopeKey: scope, lastReadAt },
      update: { lastReadAt },
    })

    // DM read receipts: tell the other participant their messages were seen
    if (kind === 'conversation') {
      await emitToRooms([conversationRoom(id)], 'read:update', {
        conversationId: id,
        userId: me.id,
        lastReadAt: lastReadAt.toISOString(),
      })
    }

    return NextResponse.json({ ok: true, lastReadAt: lastReadAt.toISOString() })
  } catch {
    return serverError()
  }
}
