import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, channelRoom, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ channelId: string }> }

/** Bulk-delete the newest messages in a channel, optionally only from one author.
 *  Requires MANAGE_MESSAGES. */
export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { channelId } = await params
    const channel = await db.channel.findUnique({ where: { id: channelId }, select: { id: true, name: true, serverId: true } })
    if (!channel) return notFound('Channel not found.')

    const ctx = await getMemberContext(channel.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_MESSAGES)) {
      return forbidden('Only moderators with the Manage Messages permission can purge.')
    }

    const body = await req.json()
    const count = typeof body.count === 'number' ? Math.floor(body.count) : 0
    const fromUserId = typeof body.userId === 'string' && body.userId ? body.userId : null
    if (count < 1 || count > 100) return badRequest('Purge between 1 and 100 messages at a time.')

    // take one extra so the final take is exactly count, newest first
    const candidates = await db.message.findMany({
      where: { channelId, ...(fromUserId ? { authorId: fromUserId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: count + 1,
      select: { id: true, authorId: true },
    })
    const targets = candidates.slice(0, count)
    if (targets.length === 0) return badRequest('Nothing to purge.')

    const ids = targets.map((m) => m.id)
    await db.message.deleteMany({ where: { id: { in: ids } } })

    await logServerEvent({
      serverId: channel.serverId,
      type: 'channel_purge',
      actorId: me.id,
      targetUserId: fromUserId,
      data: { name: channel.name, count: ids.length },
    })

    // tell every subscriber in the room, plus every server member directly, so
    // cached copies of the channel in other clients update even when they are
    // not currently viewing (and thus not subscribed to) this room
    const members = await db.serverMember.findMany({ where: { serverId: channel.serverId }, select: { userId: true } })
    await emitToRooms(
      [channelRoom(channelId), ...members.map((m) => userRoom(m.userId))],
      'messages:purge',
      { room: channelRoom(channelId), ids }
    )

    return NextResponse.json({ ok: true, deleted: ids.length })
  } catch {
    return serverError()
  }
}
