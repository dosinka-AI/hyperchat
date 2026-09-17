import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { fetchThread, serverAuthorDecorator } from '@/lib/messages'
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'

type Params = { params: Promise<{ messageId: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { messageId } = await params
    const root = await db.message.findUnique({
      where: { id: messageId },
      select: { channelId: true, conversationId: true },
    })
    if (!root) return notFound('Message not found.')

    let decorate
    if (root.channelId) {
      const channel = await db.channel.findUnique({
        where: { id: root.channelId },
        include: { access: { select: { roleId: true } } },
      })
      if (!channel) return notFound('Message not found.')
      const ctx = await getMemberContext(channel.serverId, me.id)
      if (!ctx) return forbidden('You are not a member of this server.')
      if (!ctx.canReadChannel(channel)) return forbidden('This channel is limited to specific roles.')
      decorate = await serverAuthorDecorator(channel.serverId)
    } else if (root.conversationId) {
      const participant = await db.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId: root.conversationId, userId: me.id } },
      })
      if (!participant) return forbidden('You are not part of this conversation.')
    } else {
      return badRequest('This message cannot carry a thread.')
    }

    const thread = await fetchThread(messageId, me.id, decorate)
    if (!thread) return notFound('Message not found.')
    return NextResponse.json({ ...thread, count: thread.messages.length })
  } catch {
    return serverError()
  }
}
