import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { AUTHOR_INCLUDE, toClientMessage } from '@/lib/messages'
import { channelRoom, conversationRoom, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'

type Params = { params: Promise<{ messageId: string }> }

/** Forward: copy a message into another room with attribution. The sender
 *  must be able to read the source; the target gates mirror the normal
 *  send path (membership, timeout, locked). Copies carry content, image and
 *  attachments — never pins, whispers or reply context. */
export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { messageId } = await params
    const source = await db.message.findUnique({
      where: { id: messageId },
      include: { author: { select: { username: true } } },
    })
    if (!source) return notFound('Message not found.')
    if (!source.content && !source.imageUrl && !source.attachments) {
      return NextResponse.json({ error: 'Nothing to forward.' }, { status: 400 })
    }
    // whispers stay between the pair: a third party must never be able to
    // copy a private aside out by forwarding its id
    if (source.whisperTargetId && source.whisperTargetId !== me.id && source.authorId !== me.id) {
      return forbidden('You cannot forward that message.')
    }

    // read access on the source: members see channel rows, participants see DMs.
    // Private channels additionally require the same read grant as the
    // message-list route itself — a member without access must not be able to
    // exfiltrate a private channel's content by forwarding a known message id.
    if (source.channelId) {
      const channel = await db.channel.findUnique({
        where: { id: source.channelId },
        include: { access: { select: { roleId: true } } },
      })
      const ctx = channel ? await getMemberContext(channel.serverId, me.id) : null
      if (!ctx || !ctx.canReadChannel(channel!)) return forbidden('You cannot forward that message.')
    } else if (source.conversationId) {
      const participant = await db.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId: source.conversationId, userId: me.id } },
      })
      if (!participant) return forbidden('You cannot forward that message.')
    } else {
      return forbidden('You cannot forward that message.')
    }

    const body = await req.json()
    const targetType = body.targetType === 'conversation' ? 'conversation' : body.targetType === 'channel' ? 'channel' : null
    const targetId = typeof body.targetId === 'string' ? body.targetId : ''
    if (!targetType || !targetId) {
      return NextResponse.json({ error: 'Pick where to send it.' }, { status: 400 })
    }

    let targetRooms: string[] = []
    let payloadRoom = ''

    if (targetType === 'channel') {
      const channel = await db.channel.findUnique({
        where: { id: targetId },
        include: { access: { select: { roleId: true } } },
      })
      if (!channel) return notFound('Channel not found.')
      const ctx = await getMemberContext(channel.serverId, me.id)
      if (!ctx) return forbidden('You are not a member of that server.')
      if (!ctx.canReadChannel(channel)) return forbidden('That channel is limited to specific roles.')
      if (ctx.timedOut) {
        const remaining = Math.max(1, Math.ceil((ctx.timeoutUntil!.getTime() - Date.now()) / 60000))
        return forbidden(`You are timed out in this server for ${remaining} more minute${remaining === 1 ? '' : 's'}.`)
      }
      if (channel.locked && !hasPerm(ctx.perms, PERM.MANAGE_MESSAGES)) {
        return forbidden('That channel is locked. Only moderators can post there.')
      }
      payloadRoom = channelRoom(targetId)
      targetRooms = [payloadRoom]
    } else {
      const participant = await db.conversationParticipant.findUnique({
        where: { conversationId_userId: { conversationId: targetId, userId: me.id } },
      })
      if (!participant) return forbidden('You are not part of that conversation.')
      payloadRoom = conversationRoom(targetId)
      const members = await db.conversationParticipant.findMany({
        where: { conversationId: targetId },
        select: { userId: true },
      })
      targetRooms = [payloadRoom, ...members.map((m) => userRoom(m.userId))]
    }

    const forwarded = await db.message.create({
      data: {
        channelId: targetType === 'channel' ? targetId : null,
        conversationId: targetType === 'conversation' ? targetId : null,
        authorId: me.id,
        content: source.content,
        imageUrl: source.imageUrl,
        attachments: source.attachments,
        forwardedFromId: source.id,
        forwardedFromName: source.author.username,
      },
      include: AUTHOR_INCLUDE,
    })

    const payload = toClientMessage(forwarded, payloadRoom)
    await emitToRooms(targetRooms, 'message:new', payload)

    return NextResponse.json({ message: payload }, { status: 201 })
  } catch {
    return serverError()
  }
}
