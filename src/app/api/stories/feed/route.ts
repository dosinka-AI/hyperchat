import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { serverError, unauthorized } from '@/lib/realtime'

const USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  avatarColor: true,
} as const

/** Story tray feed: active stories of me plus everyone I follow, grouped per
 *  user, own group first, others newest-first by their latest story. */
export async function GET() {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const followingRows = await db.follow.findMany({
      where: { followerId: me.id },
      select: { followingId: true },
    })

    const authorIds = [me.id, ...followingRows.map((r) => r.followingId)]
    const stories = await db.story.findMany({
      where: { authorId: { in: authorIds }, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      include: { author: { select: USER_SELECT } },
    })

    const viewedRows = stories.length
      ? await db.storyView.findMany({
          where: { userId: me.id, storyId: { in: stories.map((s) => s.id) } },
          select: { storyId: true },
        })
      : []
    const viewedSet = new Set(viewedRows.map((v) => v.storyId))

    // group per user, keeping each user's stories newest-first
    const byUser = new Map<string, { user: (typeof stories)[number]['author']; stories: typeof stories }>()
    for (const story of stories) {
      const group = byUser.get(story.authorId)
      if (group) group.stories.push(story)
      else byUser.set(story.authorId, { user: story.author, stories: [story] })
    }

    const groups = [...byUser.values()].map((group) => {
      const allViewed = group.stories.every((s) => s.authorId === me.id || viewedSet.has(s.id))
      return {
        user: group.user,
        allViewed,
        latestAt: group.stories[0].createdAt.toISOString(),
        stories: group.stories.map((s) => ({
          id: s.id,
          imageUrl: s.imageUrl,
          createdAt: s.createdAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
          viewed: s.authorId === me.id || viewedSet.has(s.id),
        })),
      }
    })

    // own group first, then everyone else newest-first
    groups.sort((a, b) => {
      const aMe = a.user.id === me.id ? 1 : 0
      const bMe = b.user.id === me.id ? 1 : 0
      if (aMe !== bMe) return bMe - aMe
      return b.latestAt.localeCompare(a.latestAt)
    })

    return NextResponse.json({ groups })
  } catch {
    return serverError()
  }
}
