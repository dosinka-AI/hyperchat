'use client'

/** Per-user "remove for me": messages hidden locally, never deleted for
 *  anyone else. Stored as a capped id list in localStorage. */

const KEY = 'hyperchat-hidden-messages'
const CAP = 800

export function loadHiddenIds(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? new Set(parsed.filter((id) => typeof id === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

export function hideMessageForMe(id: string): Set<string> {
  const next = loadHiddenIds()
  next.add(id)
  // insertion-order cap: the oldest entries drop off the end
  const list = Array.from(next).slice(-CAP)
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* storage full or blocked: the hide still applies for this session */
  }
  return new Set(list)
}
