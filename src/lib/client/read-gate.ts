'use client'

/**
 * The honest read gate.
 *
 * A room only counts as "read" when the human is demonstrably present:
 * the tab focused AND visible, and a pointer/key/wheel input within the
 * last MOUSE_STALE_MS. A sleeping machine, a background tab or a parked
 * reader never "reads" anything, so read receipts stay honest.
 *
 * This module is deliberately tiny and self-contained: it owns two facts
 * (focused, mouseActiveAt) and one derived flag (ready). Consumers ask
 * `getReadGate()` synchronously at decision time — the freshness of
 * `mouseActive` is computed from Date.now() on every call, so staleness
 * closes the gate exactly at the 30s boundary without any polling.
 *
 * `subscribeReadGate` fires ONLY when `ready` actually flips (a stored
 * last-ready value, never per-mousemove), which is all the store needs to
 * re-run its honest read check when attention returns to the app.
 */

/** how long after the last input we still consider the user at the keyboard */
export const MOUSE_STALE_MS = 30_000

/** true while the window both reports focus and is the visible document */
let focused = false
/** epoch ms of the last pointer / key / wheel input (page load counts: the
 *  user just did something to get here) */
let mouseActiveAt = 0
/** the last `ready` value we announced to subscribers (null = never fired) */
let lastReady: boolean | null = null

const listeners = new Set<() => void>()

function mouseActive(): boolean {
  return Date.now() - mouseActiveAt < MOUSE_STALE_MS
}

function ready(): boolean {
  return focused && mouseActive()
}

function syncFocus(): void {
  focused = document.visibilityState === 'visible' && document.hasFocus()
}

/** announce a readiness flip to subscribers; silent when nothing changed */
function fireIfFlipped(): void {
  const next = ready()
  if (lastReady !== null && next === lastReady) return
  lastReady = next
  for (const cb of Array.from(listeners)) {
    try {
      cb()
    } catch {
      // one broken listener must never break the flip loop
    }
  }
}

/** staleness is time-based, not event-based: while the user is active the
 *  timer keeps getting pushed back and never fires; the moment they stop,
 *  it fires at the 30s boundary and flips `ready` off (so the NEXT input
 *  flips it back on and wakes the subscribers) */
let staleTimer: ReturnType<typeof setTimeout> | null = null

function noteActivity(): void {
  mouseActiveAt = Date.now()
  if (staleTimer !== null) clearTimeout(staleTimer)
  staleTimer = setTimeout(() => {
    staleTimer = null
    fireIfFlipped()
  }, MOUSE_STALE_MS)
  fireIfFlipped()
}

if (typeof window !== 'undefined') {
  // focus truth combines the window's own focus events with the document's
  // visibility (a visible-but-blurred window is not reading either)
  window.addEventListener('focus', () => {
    syncFocus()
    fireIfFlipped()
  })
  window.addEventListener('blur', () => {
    syncFocus()
    fireIfFlipped()
  })
  document.addEventListener('visibilitychange', () => {
    syncFocus()
    fireIfFlipped()
  })

  // passive input listeners: they never preventDefault, they only watch
  for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const) {
    window.addEventListener(type, noteActivity, { passive: true })
  }

  syncFocus()
  // arriving on the page IS activity (a click or reload brought us here)
  mouseActiveAt = Date.now()
  lastReady = ready()
}

export type ReadGate = {
  /** tab focused AND document visible */
  focused: boolean
  /** input within the last MOUSE_STALE_MS */
  mouseActive: boolean
  /** focused && mouseActive: everything the honest read marking needs */
  ready: boolean
}

/** synchronous snapshot; safe on the server (everything false) */
export function getReadGate(): ReadGate {
  if (typeof window === 'undefined') return { focused: false, mouseActive: false, ready: false }
  return { focused, mouseActive: mouseActive(), ready: focused && mouseActive() }
}

/**
 * Subscribe to readiness flips (both directions). Callbacks fire when
 * `ready` changes value — never on every mousemove. Returns an
 * unsubscribe function. Server-side: registers a callback that can never
 * fire (no events are attached there).
 */
export function subscribeReadGate(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
