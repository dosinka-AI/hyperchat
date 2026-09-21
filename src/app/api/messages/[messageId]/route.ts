import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { AUTHOR_INCLUDE, toClientMessage, stripRichTokens, applyMarkerSwap } from '@/lib/messages'
import { badRequest, channelRoom, conversationRoom, emitToRooms, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ messageId: string }> }

function roomsOf(message: { channelId: string | null; conversationId: string | null }): string[] {
  const rooms: string[] = []
  if (message.channelId) rooms.push(channelRoom(message.channelId))
  if (message.conversationId) rooms.push(conversationRoom(message.conversationId))
  return rooms
}

export async function PATCH(req: NextRequest, { params }: Params) {
  // edit your own message
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { messageId } = await params
    const message = await db.message.findUnique({ where: { id: messageId } })
    if (!message) return notFound('Message not found.')
    if (message.authorId !== me.id) return forbidden('You can only edit your own messages.')
    if (!message.channelId && !message.conversationId) return badRequest('This message cannot be edited.')

    const body = await req.json()
    let content = typeof body.content === 'string' ? body.content.trim().slice(0, 2000) : ''
    if (!content && !message.imageUrl) {
      return badRequest('A message cannot be empty.')
    }

    // rich text gating survives edits: a server sender without the
    // formatting perm cannot smuggle tokens in by editing (conversation
    // messages are exempt — dms and group chats keep full freedom)
    if (message.channelId && content) {
      const ctx = await getMemberContext((await db.channel.findUnique({ where: { id: message.channelId }, select: { serverId: true } }))?.serverId ?? '', me.id)
      if (!ctx || !hasPerm(ctx.perms, PERM.FANCY_FORMAT)) {
        content = stripRichTokens(content)
      }
    }

    // the marker token swaps on edits too, so a message edited to carry it
    // renders exactly like one that was born with it
    const marker = applyMarkerSwap(content, me.id)
    content = marker.content

    // edit history: the pre-edit version becomes a snapshot (newest last, capped)
    let history: { content: string; at: string }[] = []
    if (message.editHistory) {
      try {
        const parsed = JSON.parse(message.editHistory)
        if (Array.isArray(parsed)) {
          history = parsed.filter(
            (v): v is { content: string; at: string } =>
              !!v && typeof v === 'object' && typeof v.content === 'string' && typeof v.at === 'string'
          )
        }
      } catch {
        history = []
      }
    }
    if (message.content) {
      history.push({ content: message.content, at: new Date().toISOString() })
      if (history.length > 20) history = history.slice(-20)
    }

    const updated = await db.message.update({
      where: { id: messageId },
      data: { content: content || null, editedAt: new Date(), editHistory: JSON.stringify(history) },
      include: AUTHOR_INCLUDE,
    })

    const rooms = roomsOf(updated)
    const payload = toClientMessage(updated, rooms[0] ?? '')
    await emitToRooms(rooms, 'message:update', payload)

    return NextResponse.json({ message: payload })
  } catch {
    return serverError()
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { messageId } = await params
    const message = await db.message.findUnique({ where: { id: messageId } })
    if (!message) return notFound('Message not found.')

    // authors can delete their own; moderators with MANAGE_MESSAGES can delete anyone's
    if (message.authorId !== me.id && message.channelId) {
      const channel = await db.channel.findUnique({ where: { id: message.channelId }, select: { serverId: true } })
      const ctx = channel ? await getMemberContext(channel.serverId, me.id) : null
      if (!ctx || !hasPerm(ctx.perms, PERM.MANAGE_MESSAGES)) {
        return forbidden('You can only delete your own messages.')
      }
      await logServerEvent({
        serverId: channel!.serverId,
        type: 'message_delete',
        actorId: me.id,
        targetUserId: message.authorId,
        data: { count: 1 },
      })
    } else if (message.authorId !== me.id) {
      return forbidden('You can only delete your own messages.')
    }

    await db.message.delete({ where: { id: messageId } })

    const rooms = roomsOf(message)
    await emitToRooms(rooms, 'message:delete', { messageId, rooms })

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
