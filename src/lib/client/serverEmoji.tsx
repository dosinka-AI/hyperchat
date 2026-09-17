'use client'

import { cn } from '@/lib/utils'
import { FlagText } from './flags'

/** Client-side registry of the ACTIVE server's custom emoji. The markdown
 *  renderer, reaction chips and pickers read from here: `:name:` tokens that
 *  resolve render as images; unknown names stay literal text (fail-safe —
 *  cross-server contexts never break). */

export type ServerEmojiSummary = {
  id: string
  serverId: string
  name: string
  url: string
  addedById: string
}

const registry = new Map<string, ServerEmojiSummary>()
/** Bumped whenever the active set swaps: quick-bar caches keyed on it go
 * stale the moment room availability changes. */
let registryVersion = 0

/** Swap the active set (called by the store whenever the active server or its
 *  emoji list changes). */
export function setActiveServerEmoji(list: ServerEmojiSummary[]): void {
  registry.clear()
  for (const e of list) registry.set(e.name, e)
  registryVersion++
}

/** Current registry generation for cache invalidation. */
export function getServerEmojiVersion(): number {
  return registryVersion
}

/** Resolve a raw `:name:` token (with or without colons) to its emoji. */
export function lookupServerEmoji(token: string): ServerEmojiSummary | null {
  const name = token.startsWith(':') && token.endsWith(':') && token.length >= 4
    ? token.slice(1, -1)
    : token
  return registry.get(name) ?? null
}

/** True when the bare name is a known custom emoji (composer keeps such
 *  :tokens: literal instead of expanding unicode shortcodes). */
export function isServerEmojiName(name: string): boolean {
  return registry.has(name)
}

/** Renders one emoji cell anywhere: unicode chars pass through, custom
 *  `:name:` tokens render as inline images sized to the text line. */
export function EmojiText({ emoji, className }: { emoji: string; className?: string }) {
  const hit = emoji.startsWith(':') ? lookupServerEmoji(emoji) : null
  if (hit) {
    return (
      <img
        src={hit.url}
        alt={emoji}
        draggable={false}
        loading="lazy"
        className={cn('emoji-img inline-block size-[1.25em] object-contain align-[-0.22em] pointer-events-none select-none', className)}
      />
    )
  }
  return <FlagText text={emoji} className={className} />
}
