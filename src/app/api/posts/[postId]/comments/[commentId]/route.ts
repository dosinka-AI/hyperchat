import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { emitToAll, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'

type Params = { params: Promise<{ postId: string; commentId: string }> }

/** Delete a comment: allowed for the comment's author or the post's author. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { postId, commentId } = await params
    const post = await db.post.findUnique({ where: { id: postId }, select: { id: true, authorId: true } })
    if (!post) return notFound('Post not found.')

    const comment = await db.postComment.findUnique({
      where: { id: commentId },
      select: { id: true, postId: true, authorId: true },
    })
    if (!comment || comment.postId !== postId) return notFound('Comment not found.')

    if (comment.authorId !== me.id && post.authorId !== me.id) {
      return forbidden('You cannot delete this comment.')
    }

    await db.postComment.delete({ where: { id: commentId } })

    const author = await db.user.findUnique({ where: { id: post.authorId }, select: { username: true } })
    if (author) await emitToAll('profile:refresh', { username: author.username })

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
