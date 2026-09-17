import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'

type Params = { params: Promise<{ messageId: string }> }

/** Resolve a message permalink (#msg=<id>) into the room that holds it:
 *  which channel or conversation, and whether the row sits inside a thread.
 *  The client uses this to select the room (and open the thread panel)
 *  before jumping. Access-checked exactly like reading the room itself. */
export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { messageId } = await params
    const message = await db.message.findUnique({
      where: { id: messageId },
      select: { id: true, channelId: true, conversationId: true, threadOfId: true, whisperTargetId: true, authorId: true },
    })
    if (!message) return notFound('Message not found.')
    // whispers resolve only for the pair that can see them
    if (message.whisperTargetId && message.whisperTargetId !== me.id && message.authorId !== me.id) {
      return notFound('Message not found.')
    }

    if (message.channelId) {
      const channel = await db.channel.findUnique({
        where: { id: message.channelId },
        include: { access: { select: { roleId: true } } },
      })
      if (!channel) return notFound('Message not found.')
      const ctx = await getMemberContext(channel.serverId, me.id)
      if (!ctx) return forbidden('You are not a member of this server.')
      if (!ctx.canReadChannel(channel)) return forbidden('This channel is limited to specific roles.')
      return NextResponse.json({
        room: `channel:${message.channelId}`,
        channelId: message.channelId,
        threadOfId: message.threadOfId,
      })
    }

    if (message.conversationId) {
      const participant = await db.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId: message.conversationId, userId: me.id } },
      })
      if (!participant) return forbidden('You are not part of this conversation.')
      return NextResponse.json({
        room: `conversation:${message.conversationId}`,
        conversationId: message.conversationId,
        threadOfId: message.threadOfId,
      })
    }

    return badRequest('This message has no room.')
  } catch {
    return serverError()
  }
}
