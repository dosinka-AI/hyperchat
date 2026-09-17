import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToAll, notFound, serverError, unauthorized } from '@/lib/realtime'

const PAGE_SIZE = 12
const FILE_URL_RE = /^\/api\/files\/[a-zA-Z0-9._-]+$/

/** Post projection used by the grid feed. */
async function toFeedPost(postId: string) {
  const post = await db.post.findUnique({
    where: { id: postId },
    include: { _count: { select: { likes: true, comments: true } } },
  })
  if (!post) return null
  return {
    id: post.id,
    imageUrl: post.imageUrl,
    caption: post.caption,
    likeCount: post._count.likes,
    commentCount: post._count.comments,
    createdAt: post.createdAt.toISOString(),
  }
}

/** Paginated grid feed for a user's profile: newest first, page size 12. */
export async function GET(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const username = (req.nextUrl.searchParams.get('username') ?? '').toLowerCase()
    const offsetRaw = Number(req.nextUrl.searchParams.get('offset') ?? '0')
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0
    if (!username) return badRequest('Pick a profile.')

    const user = await db.user.findUnique({
      where: { username },
      select: { id: true },
    })
    if (!user) return notFound('No user goes by that name.')

    const rows = await db.post.findMany({
      where: { authorId: user.id },
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: PAGE_SIZE + 1,
      include: { _count: { select: { likes: true, comments: true } } },
    })

    const posts = rows.slice(0, PAGE_SIZE).map((p) => ({
      id: p.id,
      imageUrl: p.imageUrl,
      caption: p.caption,
      likeCount: p._count.likes,
      commentCount: p._count.comments,
      createdAt: p.createdAt.toISOString(),
    }))

    return NextResponse.json({ posts, nextOffset: rows.length > PAGE_SIZE ? offset + PAGE_SIZE : null })
  } catch {
    return serverError()
  }
}

/** Create a post. The image itself rides the existing upload flow: the client
 *  POSTs the file to /api/upload first and hands the returned /api/files URL
 *  here together with the caption. */
export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json()
    const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl : ''
    const caption = typeof body.caption === 'string' ? body.caption : ''
    if (!FILE_URL_RE.test(imageUrl)) return badRequest('Attach an image.')

    const post = await db.post.create({
      data: {
        authorId: me.id,
        imageUrl,
        caption: caption.slice(0, 2000),
      },
    })

    await emitToAll('profile:refresh', { username: me.username })

    const feed = await toFeedPost(post.id)
    return NextResponse.json({ post: feed }, { status: 201 })
  } catch {
    return serverError()
  }
}
