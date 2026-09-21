'use client'

/**
 * Call spaces: how a conversation's calls are addressed.
 *
 * The main call of a conversation lives at its plain id. Extra "rooms"
 * (channels for calls, group-chat feature) live at a synthetic space id:
 *
 *   <conversationId>~<roomSlug>
 *
 * The sidecar treats a space id as just another conversation key - no
 * schema, no persistence, the room IS its live call. Clients strip the
 * suffix to find the owning conversation and derive the room's name.
 */

export const ROOM_SEP = '~'

/** The owning conversation id of any call space id. */
export function baseConversationId(spaceId: string): string {
  const i = spaceId.indexOf(ROOM_SEP)
  return i === -1 ? spaceId : spaceId.slice(0, i)
}

/** The room slug when this space is an extra room ('' for the main call). */
export function roomSlugOf(spaceId: string): string {
  const i = spaceId.indexOf(ROOM_SEP)
  return i === -1 ? '' : spaceId.slice(i + 1)
}

/** Human label for a room slug. */
export function roomLabelOf(spaceId: string): string {
  const slug = roomSlugOf(spaceId)
  if (!slug) return ''
  return slug.replace(/-/g, ' ')
}

/** Slugify a user-entered room name; falls back to a timestamped id. */
export function roomSlugFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug || `room-${Date.now().toString(36)}`
}

/** The space id of a room in a conversation. */
export function roomSpaceId(conversationId: string, slug: string): string {
  return `${conversationId}${ROOM_SEP}${slug}`
}
