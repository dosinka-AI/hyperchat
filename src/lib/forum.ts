import { db } from '@/lib/db'
import type { ForumPostSummary, PublicUser } from '@/lib/types'

/** Forum posts reuse the existing Message threadOfId machinery: the post row
 *  carries firstMessageId (the root message) and replies are thread rows
 *  under that root. This helper serializes posts with reply counts + the
 *  viewer's read stamp, without touching MessageList. */

type ForumPostRow = {
  id: string
  channelId: string
  title: string
  pinned: boolean
  locked: boolean
  createdAt: Date
  updatedAt: Date
  firstMessageId: string | null
  author: PublicUser
}

export const FORUM_POST_AUTHOR = {
  author: {
    select: { id: true, username: true, displayName: true, avatarUrl: true, avatarColor: true },
  },
} as const

export function toForumPostSummary(
  post: ForumPostRow,
  replyCount: number,
  lastReplyAt: string | null,
  readAt: string | null
): ForumPostSummary {
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
    replyCount,
    lastReplyAt,
    readAt,
  }
}

/** Load a forum channel's posts: pinned first, then activity (or creation)
 *  order. Cursor pages through creation time. Kept intentionally simple:
 *  forums in this wave are bounded, so the list loads at once and the
 *  client sorts the two supported modes in one pass. */
export async function loadForumPosts(
  channelId: string,
  userId: string,
  opts: { cursor?: string; limit?: number; sort?: 'latest' | 'new' } = {}
): Promise<ForumPostSummary[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 200))
  const cursor = typeof opts.cursor === 'string' && opts.cursor ? new Date(opts.cursor) : null
  const sort = opts.sort === 'new' ? 'new' : 'latest'

  const posts = await db.forumPost.findMany({
    where: { channelId, ...(cursor ? { createdAt: { lt: cursor } } : {}) },
    orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
    take: limit,
    include: FORUM_POST_AUTHOR,
  })

  const rootIds = posts.map((p) => p.firstMessageId).filter((id): id is string => !!id)
  let counts = new Map<string, { count: number; max: Date | null }>()
  if (rootIds.length > 0) {
    const groups = await db.message.groupBy({
      by: ['threadOfId'],
      where: { threadOfId: { in: rootIds } },
      _count: { _all: true },
      _max: { createdAt: true },
    })
    for (const g of groups) {
      if (g.threadOfId) counts.set(g.threadOfId, { count: g._count._all, max: g._max.createdAt })
    }
  }

  const readRows = await db.readState.findMany({
    where: { userId, scopeKey: { in: posts.map((p) => `post:${p.id}`) } },
    select: { scopeKey: true, lastReadAt: true },
  })
  const readMap = new Map(readRows.map((r) => [r.scopeKey.slice('post:'.length), r.lastReadAt.toISOString()]))

  const summaries = posts.map((p) => {
    const meta = p.firstMessageId ? counts.get(p.firstMessageId) : undefined
    const lastReplyAt = meta?.max ? meta.max.toISOString() : null
    return toForumPostSummary(p, meta?.count ?? 0, lastReplyAt, readMap.get(p.id) ?? null)
  })

  // pinned posts always lead; the rest follow the chosen sort key.
  const activityAt = (s: ForumPostSummary) => s.lastReplyAt ?? s.createdAt
  return summaries.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const ka = sort === 'latest' ? activityAt(a) : a.createdAt
    const kb = sort === 'latest' ? activityAt(b) : b.createdAt
    return ka < kb ? 1 : ka > kb ? -1 : a.id < b.id ? -1 : 1
  })
}

/** Fetch one post with its author, or null. */
export async function findForumPost(postId: string) {
  return db.forumPost.findUnique({ where: { id: postId }, include: FORUM_POST_AUTHOR })
}

/** Reply count + last activity for a single post, in one grouped query. */
export async function forumPostMeta(firstMessageId: string | null): Promise<{ replyCount: number; lastReplyAt: string | null }> {
  if (!firstMessageId) return { replyCount: 0, lastReplyAt: null }
  const agg = await db.message.aggregate({
    where: { threadOfId: firstMessageId },
    _count: { _all: true },
    _max: { createdAt: true },
  })
  return {
    replyCount: agg._count._all,
    lastReplyAt: agg._max.createdAt ? agg._max.createdAt.toISOString() : null,
  }
}
