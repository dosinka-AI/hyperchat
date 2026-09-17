import type { PublicUser } from '@/lib/types'

/** Standard public-user projection shared by friends, blocks and profiles. */
export const FRIEND_USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  avatarColor: true,
  bio: true,
  customStatus: true,
  pronouns: true,
  createdAt: true,
} as const

type FriendUserRow = {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  avatarColor: string
  bio: string
  customStatus: string | null
  pronouns?: string | null
  createdAt: Date
}

export function toPublicUser(u: FriendUserRow): PublicUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    avatarColor: u.avatarColor,
    bio: u.bio,
    customStatus: u.customStatus,
    pronouns: u.pronouns ?? null,
    createdAt: u.createdAt.toISOString(),
  }
}
