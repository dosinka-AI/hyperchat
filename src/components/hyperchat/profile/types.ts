// Shared types for the Instagram-style profile system (posts, follows,
// stories). Local to this module: src/lib/types.ts is owned elsewhere.

import type { ProfileUserBrief } from '@/lib/client/api'

export type ProfileFeedPost = {
  id: string
  imageUrl: string
  caption: string
  likeCount: number
  commentCount: number
  createdAt: string
}

export type ProfileStory = {
  id: string
  imageUrl: string
  createdAt: string
  expiresAt: string
  viewed?: boolean
}

export type ProfileStoryGroup = {
  user: ProfileUserBrief
  stories: ProfileStory[]
  /** caller has watched every story in the sequence */
  allViewed: boolean
  latestAt: string
}

export type ProfileShow = {
  user: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    avatarColor: string
    bio: string
    role: string
    customStatus: string | null
    pronouns: string | null
    bannerColor: string | null
    bannerUrl: string | null
    createdAt: string
  }
  stats: { posts: number; followers: number; following: number }
  isFollowing: boolean
  hasActiveStory: boolean
  hasUnwatchedStory: boolean
  stories: ProfileStory[]
}

export type ProfileComment = {
  id: string
  text: string
  createdAt: string
  author: ProfileUserBrief
}
