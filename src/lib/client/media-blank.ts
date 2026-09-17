'use client'

import { useChatStore } from './store'

/** Per-user media blanking ("censor"): an embed you would rather not look
 *  at but want to keep findable (to delete the message later, say) collapses
 *  to a neutral placeholder instead of its poster/frames. Local-only, like
 *  message hiding: other viewers are unaffected.
 *
 *  Persistence is per user AND per message-media: the store is one object
 *  mapping the signed-in username to its own list of media keys (the
 *  upload url, or `yt:<videoId>`), so switching accounts in the same
 *  browser never crosses the streams. Keys match the media identity of a
 *  message's embed; the list is capped per user. */

const KEY = 'hyperchat_hidden_media'
const CAP = 400
const EVENT = 'hyperchat-media-blank-change'

function userScope(): string {
  const me = useChatStore.getState().me
  const u = me?.username
  return typeof u === 'string' && u.length > 0 ? u : '_anon'
}

type Store = Record<string, string[]>

function readStore(): Store {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Store = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string')
      }
      return out
    }
  } catch {
    /* corrupt or blocked storage: start from empty */
  }
  return {}
}

function writeStore(next: Store): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* storage full or blocked: the toggle still applies for this session */
  }
  window.dispatchEvent(new CustomEvent(EVENT))
}

export function loadBlankedUrls(): Set<string> {
  const list = readStore()[userScope()] ?? []
  return new Set(list)
}

export function isBlanked(url: string, set?: Set<string>): boolean {
  return (set ?? loadBlankedUrls()).has(url)
}

/** Flip an embed between blanked and normal. Returns the next set for the
 *  current user. */
export function toggleBlanked(url: string): Set<string> {
  const user = userScope()
  const store = readStore()
  const cur = new Set(store[user] ?? [])
  if (cur.has(url)) cur.delete(url)
  else cur.add(url)
  store[user] = Array.from(cur).slice(-CAP)
  writeStore(store)
  return new Set(store[user])
}

/** Subscribe to blank changes (multiple surfaces can show the same url).
 *  Returns an unsubscribe. */
export function subscribeBlanked(cb: () => void): () => void {
  window.addEventListener(EVENT, cb)
  return () => window.removeEventListener(EVENT, cb)
}
