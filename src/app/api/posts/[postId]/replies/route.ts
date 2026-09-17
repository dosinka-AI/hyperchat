import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { findForumPost, forumPostMeta } from '@/lib/forum'
import { AUTHOR_INCLUDE, serverAuthorDecorator, toClientMessage } from '@/lib/messages'
import { badRequest, channelRoom, emitToRooms, forbidden, notFound, serverError, serverRoom, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'

type Params = { params: Promise<{ postId: string }> }

/** A reply inside a forum post. Reuses the thread message machinery: the
 *  reply is a Message with threadOfId = post.firstMessageId, so the client's
 *  thread cache and MessageList never fork. */
export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { postId } = await params
    const post = await findForumPost(postId)
    if (!post) return notFound('Post not found.')
    if (!post.firstMessageId) return badRequest('This post has no thread.')

    const channel = await db.channel.findUnique({
      where: { id: post.channelId },
      include: { access: { select: { roleId: true } } },
    })
    if (!channel) return notFound('Post not found.')
    const ctx = await getMemberContext(channel.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!ctx.canReadChannel(channel)) return forbidden('This channel is limited to specific roles.')

    if (ctx.timedOut) return forbidden('You are timed out in this server.')
    const canMod = hasPerm(ctx.perms, PERM.MANAGE_MESSAGES)
    if ((post.locked || channel.locked) && !canMod) {
      return forbidden('This post is locked.')
    }

    const body = await req.json()
    const content = typeof body.content === 'string' ? body.content.trim().slice(0, 2000) : ''
    if (!content) return badRequest('Type a reply.')

    const message = await db.message.create({
      data: {
        channelId: post.channelId,
        authorId: me.id,
        content,
        threadOfId: post.firstMessageId,
        pingsEveryone: false,
      },
      include: AUTHOR_INCLUDE,
    })

    const decorate = await serverAuthorDecorator(channel.serverId)
    const payload = toClientMessage(message, channelRoom(post.channelId), decorate)
    await emitToRooms([channelRoom(post.channelId)], 'message:new', payload)

    // keep the post list's reply count + last activity live
    const meta = await forumPostMeta(post.firstMessageId)
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
      replyCount: meta.replyCount,
      lastReplyAt: meta.lastReplyAt,
      readAt: null,
    }
    await emitToRooms([channelRoom(post.channelId), serverRoom(channel.serverId)], 'forum:post:update', { post: summary })

    return NextResponse.json({ message: payload }, { status: 201 })
  } catch {
    return serverError()
  }
}
