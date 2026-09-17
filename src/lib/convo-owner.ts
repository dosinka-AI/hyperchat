/**
 * Effective group owner resolution, server-side.
 *
 * Groups created before the ownerId column existed have no stored owner;
 * for those the oldest participant row (lowest cuid, created first) acts as
 * the owner. Resolution happens on read without writing; a persisted
 * promotion only occurs when the owner leaves (members/me route).
 */

export type OwnerCandidate = { id: string; userId: string }

/** The group owner: the stored ownerId while that user is still a member,
 *  otherwise the oldest participant. null for empty participant sets. */
export function effectiveOwnerId(ownerId: string | null, participants: readonly OwnerCandidate[]): string | null {
  if (ownerId && participants.some((p) => p.userId === ownerId)) return ownerId
  if (participants.length === 0) return null
  const oldest = [...participants].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
  return oldest.userId
}
