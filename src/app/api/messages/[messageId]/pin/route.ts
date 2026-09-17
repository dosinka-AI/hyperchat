import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { AUTHOR_INCLUDE, toClientMessage } from '@/lib/messages'
import { channelRoom, conversationRoom, emitToRooms, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'

type Params = { params: Promise<{ messageId: string }> }

async function canPin(message: { channelId: string | null; conversationId: string | null }, userId: string): Promise<boolean | 'error'> {
  if (message.channelId) {
    const channel = await db.channel.findUnique({
      where: { id: message.channelId },
      select: { serverId: true },
    })
    if (!channel) return 'error'
    const ctx = await getMemberContext(channel.serverId, userId)
    if (!ctx) return 'error'
    return hasPerm(ctx.perms, PERM.MANAGE_MESSAGES)
  }
  if (message.conversationId) {
    const participant = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId: message.conversationId, userId } },
    })
    return !!participant
  }
  return false
}

export async function POST(_req: NextRequest, { params }: Params) {
  // pin
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { messageId } = await params
    const message = await db.message.findUnique({ where: { id: messageId } })
    if (!message) return notFound('Message not found.')

    const allowed = await canPin(message, me.id)
    if (allowed === 'error') return forbidden('You cannot pin that message.')
    if (!allowed) return forbidden('You need the Manage Messages permission to pin in servers.')

    const updated = await db.message.update({
      where: { id: messageId },
      data: { pinned: true, pinnedAt: new Date() },
      include: AUTHOR_INCLUDE,
    })

    const rooms: string[] = []
    if (updated.channelId) rooms.push(channelRoom(updated.channelId))
    if (updated.conversationId) rooms.push(conversationRoom(updated.conversationId))

    const payload = toClientMessage(updated, rooms[0] ?? '')
    await emitToRooms(rooms, 'message:update', payload)

    // DMs and group chats get a "x pinned a message" row everyone can click
    // to jump straight into the pins overlay
    if (updated.conversationId) {
      const system = await db.message.create({
        data: {
          conversationId: updated.conversationId,
          authorId: me.id,
          systemKind: 'pin',
          systemData: JSON.stringify({ messageId: updated.id, byUsername: me.username }),
        },
        include: AUTHOR_INCLUDE,
      })
      const sysPayload = toClientMessage(system, conversationRoom(updated.conversationId))
      await emitToRooms(rooms, 'message:new', sysPayload)
    }

    return NextResponse.json({ message: payload })
  } catch {
    return serverError()
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  // unpin
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { messageId } = await params
    const message = await db.message.findUnique({ where: { id: messageId } })
    if (!message) return notFound('Message not found.')

    const allowed = await canPin(message, me.id)
    if (allowed === 'error') return forbidden('You cannot unpin that message.')
    if (!allowed) return forbidden('Only the owner or admins can unpin in servers.')

    const updated = await db.message.update({
      where: { id: messageId },
      data: { pinned: false, pinnedAt: null },
      include: AUTHOR_INCLUDE,
    })

    const rooms: string[] = []
    if (updated.channelId) rooms.push(channelRoom(updated.channelId))
    if (updated.conversationId) rooms.push(conversationRoom(updated.conversationId))

    const payload = toClientMessage(updated, rooms[0] ?? '')
    await emitToRooms(rooms, 'message:update', payload)

    if (updated.conversationId) {
      const system = await db.message.create({
        data: {
          conversationId: updated.conversationId,
          authorId: me.id,
          systemKind: 'unpin',
          systemData: JSON.stringify({ messageId: updated.id, byUsername: me.username }),
        },
        include: AUTHOR_INCLUDE,
      })
      const sysPayload = toClientMessage(system, conversationRoom(updated.conversationId))
      await emitToRooms(rooms, 'message:new', sysPayload)
    }

    return NextResponse.json({ message: payload })
  } catch {
    return serverError()
  }
}
