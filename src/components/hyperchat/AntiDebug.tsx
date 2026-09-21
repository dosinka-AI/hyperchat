'use client'

import { useEffect, useState } from 'react'

/**
 * Anti-debugging hardening for deployed alphas ("raise the floor" mode).
 *
 * Active only in production builds (NODE_ENV is inlined at build time by
 * Next, so dev/QA sessions - and the sandbox - never run it). Two opt-outs:
 *  - build-time: NEXT_PUBLIC_ANTI_DEBUG=off disables it entirely, for
 *    debugging a production build with a clean console.
 *  - dev-time: localStorage hc_antidebug=force turns it ON in a dev build,
 *    which is how this file gets verified without a production server. The
 *    flag can only ever enable, never disable, so it is not a bypass.
 *
 * Detection (two independent signals, re-checked every ~2s):
 *  1. a console probe object with a getter - browsers only evaluate logged
 *     objects when devtools actually renders them, so the getter firing
 *     means the console is open (works even after the minifier runs).
 *  2. a timed debugger statement - with devtools open, `debugger` pauses
 *     execution and the measured delta explodes. Survives as long as the
 *     minifier keeps the statement; silently harmless if it does not.
 *
 * On trip: a full-screen cover blocks the app, the console is wiped, and
 * common devtools shortcuts are swallowed. Self-healing: a few clean ticks
 * after the tools close, the cover lifts and everything resumes - sessions,
 * sockets and state were never touched underneath.
 *
 * Honest scope: this is friction for "open devtools and poke at it" - the
 * simplest kind of tampering - not real security. Sessions are httpOnly
 * cookies and every API route re-validates the caller server-side, which
 * remains the actual boundary.
 */

const TRIP_AFTER = 2 // consecutive hits before the cover goes up
const CLEAR_AFTER = 3 // consecutive clean ticks before it lifts again
const TICK_MS = 1900

const IS_PRODUCTION = process.env.NODE_ENV === 'production'
const KILLED_AT_BUILD = process.env.NEXT_PUBLIC_ANTI_DEBUG === 'off'

function isForceEnabled(): boolean {
  try {
    return window.localStorage.getItem('hc_antidebug') === 'force'
  } catch {
    return false
  }
}

/** The keys that summon devtools (best effort: Chrome reserves some of
 * these before the page sees them - kept for the browsers that do deliver
 * them, and it costs nothing). */
function isDevtoolsShortcut(e: KeyboardEvent): boolean {
  const key = e.key.toLowerCase()
  if (e.key === 'F12') return true
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.shiftKey && (key === 'i' || key === 'j' || key === 'c')) return true
  return false
}

export default function AntiDebug() {
  const [tripped, setTripped] = useState(false)

  useEffect(() => {
    if (KILLED_AT_BUILD) return
    if (!(IS_PRODUCTION || isForceEnabled())) return

    let hits = 0
    let misses = 0
    let getterFired = false
    let timer: ReturnType<typeof setTimeout> | null = null

    // the probe: only evaluated when devtools renders a logged object
    const probe = {
      get hc() {
        getterFired = true
        return 0
      },
    }

    const tick = () => {
      const consoleProbeFired = getterFired
      getterFired = false

      // timed debugger: a no-op (or stripped) statement costs ~0ms; an open
      // devtools pauses on it and the delta gives it away
      const t0 = performance.now()
      debugger
      const debuggerPaused = performance.now() - t0 > 120

      const caught = consoleProbeFired || debuggerPaused
      if (caught) {
        hits++
        misses = 0
      } else {
        misses++
        hits = 0
      }

      if (hits >= TRIP_AFTER) {
        setTripped(true)
        // wipe whatever the console accumulated while it was open
        console.clear?.()
      } else if (misses >= CLEAR_AFTER) {
        setTripped(false)
      }

      // log the next probe for the following tick to inspect
      console.log(probe)

      // slight jitter so the rhythm is not trivially predictable
      timer = setTimeout(tick, TICK_MS + Math.random() * 400)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (isDevtoolsShortcut(e)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    // capture phase: swallow the shortcut before app handlers can react
    window.addEventListener('keydown', onKeyDown, true)
    tick()

    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  if (!tripped) return null

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed inset-0 z-[9999] bg-background grid place-items-center select-none"
    >
      <div className="text-foreground text-lg font-semibold lowercase">
        debugger detected
      </div>
    </div>
  )
}
