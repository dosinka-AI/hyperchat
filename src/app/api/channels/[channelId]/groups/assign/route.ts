import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'

type Params = { params: Promise<{ channelId: string }> }

/** Assign (or clear, with null) a member's channel group. Channel-group
 *  membership is one-per-user-per-channel (unique index); moderators with
 *  Manage Channels and channel admins (holders of the full bitmask through
 *  the assign API) can set it. */
export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const { channelId } = await params
    const channel = await db.channel.findUnique({ where: { id: channelId }, select: { id: true, type: true, serverId: true } })
    if (!channel) return notFound('Channel not found.')
    const ctx = await getMemberContext(channel.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.ADMINISTRATOR | PERM.MANAGE_CHANNELS)) {
      return forbidden('Only moderators with Manage Channels can assign channel groups.')
    }

    const body = await req.json()
    const userId = typeof body.userId === 'string' ? body.userId : ''
    if (!userId) return badRequest('Which member?')
    const groupId = typeof body.groupId === 'string' && body.groupId ? body.groupId : null
    if (groupId) {
      const group = await db.channelGroup.findUnique({ where: { id: groupId } })
      if (!group || group.channelId !== channelId) return notFound('Group not found.')
    }
    const member = await db.serverMember.findFirst({
      where: { serverId: channel.serverId, userId },
      select: { id: true },
    })
    if (!member) return badRequest('That user is not a member of this server.')

    if (groupId) {
      await db.channelGroupMember.upsert({
        where: { channelId_userId: { channelId, userId } },
        create: { channelId, userId, groupId },
        update: { groupId },
      })
    } else {
      // clearing the rank removes the membership row entirely
      await db.channelGroupMember.deleteMany({ where: { channelId, userId } })
    }

    const groups = await db.channelGroup.findMany({
      where: { channelId },
      orderBy: [{ rank: 'asc' }, { createdAt: 'asc' }],
      include: {
        members: { orderBy: { createdAt: 'asc' }, select: { userId: true } },
      },
    })
    const userIds = [...new Set(groups.flatMap((g) => g.members.map((m) => m.userId)))]
    const users = userIds.length
      ? await db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, username: true, displayName: true, avatarUrl: true, avatarColor: true },
        })
      : []
    const byId = new Map(users.map((u) => [u.id, u]))
    return NextResponse.json({
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        rank: g.rank,
        permissions: g.permissions,
        members: g.members
          .map((m) => byId.get(m.userId))
          .filter((u): u is NonNullable<typeof u> => !!u)
          .map((u) => ({
            userId: u.id,
            username: u.username,
            displayName: u.displayName,
            avatarUrl: u.avatarUrl,
            avatarColor: u.avatarColor,
          })),
      })),
    })
  } catch (err) {
    console.error('[channels/groups/assign POST]', err)
    return serverError()
  }
}
