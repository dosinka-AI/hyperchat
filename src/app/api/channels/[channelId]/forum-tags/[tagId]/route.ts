import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { splitTagCsv } from '@/lib/forum'
import { emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ channelId: string; tagId: string }> }

export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { channelId, tagId } = await params
    const channel = await db.channel.findUnique({
      where: { id: channelId },
      select: { id: true, serverId: true },
    })
    if (!channel) return notFound('Channel not found.')
    const ctx = await getMemberContext(channel.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_SERVER)) {
      return forbidden('Only moderators with the Manage Server permission can remove tags.')
    }

    const tag = await db.forumTag.findUnique({ where: { id: tagId } })
    if (!tag || tag.channelId !== channelId) return notFound('No such tag on this channel.')

    await db.forumTag.delete({ where: { id: tagId } })

    // posts must never carry a dead tag name: strip it from every CSV in
    // this channel (bounded: forum channels carry one list of posts)
    const posts = await db.forumPost.findMany({ where: { channelId }, select: { id: true, tags: true } })
    for (const post of posts) {
      const names = splitTagCsv(post.tags)
      if (!names.includes(tag.name)) continue
      await db.forumPost.update({
        where: { id: post.id },
        data: { tags: names.filter((n) => n !== tag.name).join(',') },
      })
    }

    await logServerEvent({
      serverId: channel.serverId,
      type: 'server_update',
      actorId: me.id,
      data: { tagRemoved: tag.name },
    })

    const members = await db.serverMember.findMany({ where: { serverId: channel.serverId }, select: { userId: true } })
    await emitToRooms(members.map((m) => userRoom(m.userId)), 'server:refresh', { serverId: channel.serverId })

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
