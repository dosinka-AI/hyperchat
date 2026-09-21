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
 *  page for display and prepends older pages as they load).
 *
 *  Pagination is cursor-based: the client passes the oldest comment it
 *  already holds via `before` (+ `beforeId` as a same-millisecond
 *  tiebreaker) and gets strictly older rows. Unlike page offsets this
 *  cannot drift, duplicate or skip rows when comments are added or
 *  removed while the detail view is open. `more` tells the client
 *  whether another page exists. */
export async function GET(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { postId } = await params
    const post = await db.post.findUnique({ where: { id: postId }, select: { id: true } })
    if (!post) return notFound('Post not found.')

    const beforeRaw = req.nextUrl.searchParams.get('before')
    const beforeIdRaw = req.nextUrl.searchParams.get('beforeId')
    let cursor: { createdAt: Date; id: string } | null = null
    if (beforeRaw) {
      const t = Date.parse(beforeRaw)
      if (!Number.isFinite(t)) return badRequest('Bad cursor.')
      cursor = { createdAt: new Date(t), id: beforeIdRaw ?? '' }
    }

    const PAGE = 30

    const rows = await db.postComment.findMany({
      where: {
        postId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PAGE + 1,
      select: COMMENT_SELECT,
    })

    const more = rows.length > PAGE
    const page = rows.slice(0, PAGE)
    const comments = page.map((c) => ({
      id: c.id,
      text: c.text,
      createdAt: c.createdAt.toISOString(),
      author: c.author,
    }))
    // the next cursor is the oldest row of this page
    const nextBefore = more && page.length
      ? { before: page[page.length - 1].createdAt.toISOString(), beforeId: page[page.length - 1].id }
      : null

    return NextResponse.json({ comments, more, nextBefore })
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
