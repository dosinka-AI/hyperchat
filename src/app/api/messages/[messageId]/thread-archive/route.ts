import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, channelRoom, conversationRoom, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { PERM } from '@/lib/perm'
import { AUTHOR_INCLUDE, toClientMessage, serverAuthorDecorator } from '@/lib/messages'

type Params = { params: Promise<{ messageId: string }> }

/** Discord-style thread archive / unarchive. Manual archive: the root's
 *  author, anyone who replied in the thread, or moderators. Unarchiving is
 *  open to the same people. A new reply always revives the thread (the send
 *  routes clear the stamp). */
export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const { messageId } = await params
    const body = await req.json()
    const archived = body.archived !== false
    const root = await db.message.findUnique({ where: { id: messageId }, include: AUTHOR_INCLUDE })
    if (!root || root.threadOfId) return notFound('Thread not found.')
    if (!root.channelId && !root.conversationId) return badRequest('This message cannot root a thread.')

    let allowed = root.authorId === me.id
    if (!allowed && root.channelId) {
      const channel = await db.channel.findUnique({ where: { id: root.channelId }, select: { serverId: true } })
      const ctx = channel ? await getMemberContext(channel.serverId, me.id) : null
      if (ctx && (ctx.perms & (PERM.ADMINISTRATOR | PERM.MANAGE_MESSAGES)) !== 0) allowed = true
    }
    if (!allowed) {
      // anyone who participated in the thread can keep it alive
      const participated = await db.message.findFirst({
        where: { threadOfId: root.id, authorId: me.id },
        select: { id: true },
      })
      if (participated) allowed = true
    }
    if (!allowed) return forbidden('Only the thread starter, participants or moderators can archive threads.')

    const updated = await db.message.update({
      where: { id: root.id },
      data: archived
        ? { threadArchivedAt: new Date() }
        : { threadArchivedAt: null, threadAutoArchiveHours: 24 },
      include: AUTHOR_INCLUDE,
    })

    // rooms that should see the updated root (its bar re-renders live)
    const rooms: string[] = []
    const users: string[] = []
    if (updated.channelId) {
      const channel = await db.channel.findUnique({
        where: { id: updated.channelId },
        include: { server: { include: { members: { select: { userId: true } } } } },
      })
      if (channel) {
        rooms.push(channelRoom(updated.channelId))
        users.push(...channel.server.members.map((m) => m.userId))
      }
    } else if (updated.conversationId) {
      const participants = await db.conversationParticipant.findMany({
        where: { conversationId: updated.conversationId },
        select: { userId: true },
      })
      rooms.push(conversationRoom(updated.conversationId))
      users.push(...participants.map((p) => p.userId))
    }
    const decorate = updated.channelId
      ? await serverAuthorDecorator((await db.channel.findUnique({ where: { id: updated.channelId }, select: { serverId: true } }))?.serverId ?? '')
      : undefined
    const client = toClientMessage(updated, rooms[0] ?? '', decorate)
    await emitToRooms([...rooms, ...users.map((u) => userRoom(u))], 'message:edited', { message: client })

    return NextResponse.json({ message: client })
  } catch (err) {
    console.error('[thread-archive POST]', err)
    return serverError()
  }
}
