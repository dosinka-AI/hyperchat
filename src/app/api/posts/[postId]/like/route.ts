import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { emitToAll, notFound, serverError, unauthorized } from '@/lib/realtime'

type Params = { params: Promise<{ postId: string }> }

/** Like a post. Idempotent: liking twice keeps one row and returns the
 *  current count. */
export async function POST(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { postId } = await params
    const post = await db.post.findUnique({ where: { id: postId }, select: { id: true, authorId: true } })
    if (!post) return notFound('Post not found.')

    await db.postLike.upsert({
      where: { postId_userId: { postId, userId: me.id } },
      create: { postId, userId: me.id },
      update: {},
    })

    const likeCount = await db.postLike.count({ where: { postId } })
    const author = await db.user.findUnique({ where: { id: post.authorId }, select: { username: true } })
    if (author) await emitToAll('profile:refresh', { username: author.username })

    return NextResponse.json({ liked: true, likeCount })
  } catch {
    return serverError()
  }
}

/** Remove the caller's like. Idempotent. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { postId } = await params
    const post = await db.post.findUnique({ where: { id: postId }, select: { id: true, authorId: true } })
    if (!post) return notFound('Post not found.')

    await db.postLike.deleteMany({ where: { postId, userId: me.id } })

    const likeCount = await db.postLike.count({ where: { postId } })
    const author = await db.user.findUnique({ where: { id: post.authorId }, select: { username: true } })
    if (author) await emitToAll('profile:refresh', { username: author.username })

    return NextResponse.json({ liked: false, likeCount })
  } catch {
    return serverError()
  }
}
