import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToAll, notFound, serverError, unauthorized } from '@/lib/realtime'

type Params = { params: Promise<{ postId: string }> }

const COMMENT_SELECT = {
  id: true,
  text: true,
  createdAt: true,
  author: {
    select: { id: true, username: true, displayName: true, avatarUrl: true, avatarColor: true },
  },
} as const

/** Paginated comment list, newest page first (the client reverses each
 *  page for display and prepends older pages as they load). */
export async function GET(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { postId } = await params
    const post = await db.post.findUnique({ where: { id: postId }, select: { id: true } })
    if (!post) return notFound('Post not found.')

    const offsetRaw = Number(req.nextUrl.searchParams.get('offset') ?? '0')
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0
    const PAGE = 30

    const rows = await db.postComment.findMany({
      where: { postId },
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: PAGE + 1,
      select: COMMENT_SELECT,
    })

    const comments = rows.slice(0, PAGE).map((c) => ({
      id: c.id,
      text: c.text,
      createdAt: c.createdAt.toISOString(),
      author: c.author,
    }))

    return NextResponse.json({ comments, nextOffset: rows.length > PAGE ? offset + PAGE : null })
  } catch {
    return serverError()
  }
}

/** Add a comment. Posts are public: any signed-in user can comment. */
export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { postId } = await params
    const post = await db.post.findUnique({ where: { id: postId }, select: { id: true, authorId: true } })
    if (!post) return notFound('Post not found.')

    const body = await req.json()
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 500) : ''
    if (!text) return badRequest('Write something first.')

    const created = await db.postComment.create({
      data: { postId, authorId: me.id, text },
      select: COMMENT_SELECT,
    })

    const author = await db.user.findUnique({ where: { id: post.authorId }, select: { username: true } })
    if (author) await emitToAll('profile:refresh', { username: author.username })

    return NextResponse.json(
      { comment: { id: created.id, text: created.text, createdAt: created.createdAt.toISOString(), author: created.author } },
      { status: 201 }
    )
  } catch {
    return serverError()
  }
}
