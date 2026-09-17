import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { notFound, serverError, unauthorized } from '@/lib/realtime'

type Params = { params: Promise<{ username: string }> }

/** Extended profile payload for the profile card: the usual public user plus
 *  post/follower/following counts, the caller's follow state and whether the
 *  user has an active story (and one the caller has not watched yet). */
export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { username } = await params
    const user = await db.user.findUnique({
      where: { username: username.toLowerCase() },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        avatarColor: true,
        bio: true,
        role: true,
        customStatus: true,
        pronouns: true,
        bannerColor: true,
        bannerUrl: true,
        createdAt: true,
      },
    })
    if (!user) return notFound('No user goes by that name.')

    const [postsCount, followersCount, followingCount, isFollowing, activeStories] =
      await Promise.all([
        db.post.count({ where: { authorId: user.id } }),
        db.follow.count({ where: { followingId: user.id } }),
        db.follow.count({ where: { followerId: user.id } }),
        db.follow.findUnique({
          where: { followerId_followingId: { followerId: me.id, followingId: user.id } },
        }),
        db.story.findMany({
          where: { authorId: user.id, expiresAt: { gt: new Date() } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, imageUrl: true, createdAt: true, expiresAt: true },
        }),
      ])

    let hasUnwatchedStory = false
    let storyViewed: Set<string> = new Set()
    if (activeStories.length > 0) {
      if (user.id === me.id) {
        // own stories never carry an unwatched ring for their author
        storyViewed = new Set(activeStories.map((s) => s.id))
      } else {
        const watched = await db.storyView.findMany({
          where: { userId: me.id, storyId: { in: activeStories.map((s) => s.id) } },
          select: { storyId: true },
        })
        storyViewed = new Set(watched.map((w) => w.storyId))
      }
      hasUnwatchedStory = activeStories.some((s) => !storyViewed.has(s.id))
    }

    return NextResponse.json({
      user,
      stats: {
        posts: postsCount,
        followers: followersCount,
        following: followingCount,
      },
      isFollowing: isFollowing !== null,
      hasActiveStory: activeStories.length > 0,
      hasUnwatchedStory,
      stories: activeStories.map((s) => ({
        id: s.id,
        imageUrl: s.imageUrl,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        viewed: storyViewed.has(s.id),
      })),
    })
  } catch {
    return serverError()
  }
}
