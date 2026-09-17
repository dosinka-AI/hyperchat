import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { findForumPost, forumPostMeta } from '@/lib/forum'
import { channelRoom, emitToRooms, emitToAll, forbidden, notFound, serverError, serverRoom, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'

type Params = { params: Promise<{ postId: string }> }

async function postSummaryFor(post: NonNullable<Awaited<ReturnType<typeof findForumPost>>>) {
  const meta = await forumPostMeta(post.firstMessageId)
  return {
    id: post.id,
    channelId: post.channelId,
    title: post.title,
    pinned: post.pinned,
    locked: post.locked,
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
    firstMessageId: post.firstMessageId,
    author: post.author,
    replyCount: meta.replyCount,
    lastReplyAt: meta.lastReplyAt,
    readAt: null,
  }
}

/** Profile-post detail: full post plus the first 30 comments and the
 *  caller's like state. Posts are public within the platform. */
export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { postId } = await params
    const post = await db.post.findUnique({
      where: { id: postId },
      include: {
        author: {
          select: { id: true, username: true, displayName: true, avatarUrl: true, avatarColor: true },
        },
        _count: { select: { likes: true, comments: true } },
      },
    })
    if (!post) return notFound('Post not found.')

    const likedByMe = (await db.postLike.findUnique({
      where: { postId_userId: { postId, userId: me.id } },
    })) !== null

    const comments = await db.postComment.findMany({
      where: { postId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: {
        author: {
          select: { id: true, username: true, displayName: true, avatarUrl: true, avatarColor: true },
        },
      },
    })

    return NextResponse.json({
      post: {
        id: post.id,
        imageUrl: post.imageUrl,
        caption: post.caption,
        createdAt: post.createdAt.toISOString(),
        likeCount: post._count.likes,
        commentCount: post._count.comments,
        likedByMe,
        author: post.author,
      },
      comments: comments
        .slice()
        .reverse()
        .map((c) => ({
          id: c.id,
          text: c.text,
          createdAt: c.createdAt.toISOString(),
          author: c.author,
        })),
    })
  } catch {
    return serverError()
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { postId } = await params
    const post = await findForumPost(postId)
    if (!post) return notFound('Post not found.')

    // post.channelId is a Channel id; resolve the channel's server first.
    const channel = await db.channel.findUnique({ where: { id: post.channelId }, select: { serverId: true } })
    if (!channel) return notFound('Post not found.')
    const memberCtx = await getMemberContext(channel.serverId, me.id)
    if (!memberCtx) return forbidden('You are not a member of this server.')

    const canMod = hasPerm(memberCtx.perms, PERM.MANAGE_MESSAGES)
    const isAuthor = post.authorId === me.id

    const body = await req.json()
    const data: { title?: string; pinned?: boolean; locked?: boolean } = {}

    if (typeof body.title === 'string') {
      const title = body.title.trim().slice(0, 200)
      if (!title) return NextResponse.json({ error: 'Give the post a title.' }, { status: 400 })
      // title is author-or-mod editable
      if (!isAuthor && !canMod) return forbidden('You cannot edit this post.')
      data.title = title
    }
    // pinned / locked are moderation-only
    if (body.pinned !== undefined) {
      if (!canMod) return forbidden('Only moderators can pin posts.')
      if (typeof body.pinned !== 'boolean') return NextResponse.json({ error: 'pinned must be true or false.' }, { status: 400 })
      data.pinned = body.pinned
    }
    if (body.locked !== undefined) {
      if (!canMod) return forbidden('Only moderators can lock posts.')
      if (typeof body.locked !== 'boolean') return NextResponse.json({ error: 'locked must be true or false.' }, { status: 400 })
      data.locked = body.locked
    }

    const updated = await db.forumPost.update({ where: { id: postId }, data, include: { author: { select: { id: true, username: true, displayName: true, avatarUrl: true, avatarColor: true } } } })
    const summary = await postSummaryFor(updated)

    await emitToRooms([channelRoom(updated.channelId), serverRoom(channel.serverId)], 'forum:post:update', { post: summary })

    return NextResponse.json({ post: summary })
  } catch {
    return serverError()
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { postId } = await params

    // profile posts (author-only delete) live on the same path as forum
    // posts: try the profile table first, then fall through to the forum
    const profilePost = await db.post.findUnique({
      where: { id: postId },
      select: { id: true, authorId: true },
    })
    if (profilePost) {
      if (profilePost.authorId !== me.id) return forbidden('You cannot delete this post.')
      await db.post.delete({ where: { id: postId } })
      await emitToAll('profile:refresh', { username: me.username })
      return NextResponse.json({ ok: true })
    }

    const post = await findForumPost(postId)
    if (!post) return notFound('Post not found.')

    const channel = await db.channel.findUnique({ where: { id: post.channelId }, select: { serverId: true } })
    if (!channel) return notFound('Post not found.')
    const ctx = await getMemberContext(channel.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')

    const canMod = hasPerm(ctx.perms, PERM.MANAGE_MESSAGES)
    if (post.authorId !== me.id && !canMod) return forbidden('You cannot delete this post.')

    const channelId = post.channelId
    const serverId = channel.serverId

    // delete the post row; the root message and its thread cascade below.
    await db.forumPost.delete({ where: { id: postId } })
    if (post.firstMessageId) {
      // removing the root cascades thread messages via threadOfId relation
      await db.message.deleteMany({ where: { id: post.firstMessageId } })
    }

    await emitToRooms([channelRoom(channelId), serverRoom(serverId)], 'forum:post:delete', { postId })

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
