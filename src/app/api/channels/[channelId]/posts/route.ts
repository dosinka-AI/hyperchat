import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { loadForumPosts } from '@/lib/forum'
import { AUTHOR_INCLUDE, toClientMessage } from '@/lib/messages'
import { badRequest, channelRoom, emitToRooms, forbidden, notFound, serverError, serverRoom, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'

type Params = { params: Promise<{ channelId: string }> }

async function forumChannelForMember(channelId: string, userId: string) {
  const channel = await db.channel.findUnique({
    where: { id: channelId },
    include: { access: { select: { roleId: true } } },
  })
  if (!channel) return { channel: null, ctx: null }
  const ctx = await getMemberContext(channel.serverId, userId)
  return { channel, ctx }
}

export async function GET(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { channelId } = await params
    const { channel, ctx } = await forumChannelForMember(channelId, me.id)
    if (!channel) return notFound('Channel not found.')
    if (!ctx) return forbidden('You are not a member of this server.')
    if (channel.type !== 'forum') return forbidden('This is not a forum channel.')
    if (!ctx.canReadChannel(channel)) return forbidden('This channel is limited to specific roles.')

    const cursor = req.nextUrl.searchParams.get('cursor') || undefined
    const limit = Number(req.nextUrl.searchParams.get('limit')) || undefined
    const sort = req.nextUrl.searchParams.get('sort') === 'new' ? 'new' : 'latest'

    const posts = await loadForumPosts(channelId, me.id, { cursor, limit, sort })
    return NextResponse.json({ posts })
  } catch {
    return serverError()
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { channelId } = await params
    const { channel, ctx } = await forumChannelForMember(channelId, me.id)
    if (!channel) return notFound('Channel not found.')
    if (!ctx) return forbidden('You are not a member of this server.')
    if (channel.type !== 'forum') return forbidden('This is not a forum channel.')
    if (!ctx.canReadChannel(channel)) return forbidden('This channel is limited to specific roles.')

    if (ctx.timedOut) {
      return forbidden('You are timed out in this server.')
    }
    const canMod = hasPerm(ctx.perms, PERM.MANAGE_MESSAGES)
    if (channel.locked && !canMod) {
      return forbidden('This channel is locked. Only moderators can post here.')
    }

    const body = await req.json()
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : ''
    const content = typeof body.content === 'string' ? body.content.trim().slice(0, 2000) : ''
    if (!title) return badRequest('Give the post a title.')
    if (!content && !body.title) return badRequest('Give the post a title.')

    // title-only posts are allowed: the root message content stays null and
    // the title lives on the ForumPost row
    const rootMessage = await db.message.create({
      data: {
        channelId,
        authorId: me.id,
        content: content || null,
        pingsEveryone: false,
      },
      include: AUTHOR_INCLUDE,
    })

    const post = await db.forumPost.create({
      data: {
        channelId,
        authorId: me.id,
        title,
        firstMessageId: rootMessage.id,
      },
      include: {
        author: { select: { id: true, username: true, displayName: true, avatarUrl: true, avatarColor: true } },
      },
    })

    const summary = {
      id: post.id,
      channelId: post.channelId,
      title: post.title,
      pinned: post.pinned,
      locked: post.locked,
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
      firstMessageId: post.firstMessageId,
      author: post.author,
      replyCount: 0,
      lastReplyAt: null,
      readAt: new Date().toISOString(),
    }

    await emitToRooms([channelRoom(channelId), serverRoom(channel.serverId)], 'forum:post:new', { post: summary })

    return NextResponse.json({ post: summary, message: toClientMessage(rootMessage, channelRoom(channelId)) }, { status: 201 })
  } catch {
    return serverError()
  }
}
