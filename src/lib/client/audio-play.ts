'use client'

/**
 * Audio playback unlock for WebRTC remote audio.
 *
 * Browsers gate audible autoplay: when play() is called on a remote-audio
 * element outside a user gesture (which is the normal case - tracks arrive
 * seconds after the "join voice" click, often while the tab is in a
 * background window or a cross-origin iframe), the promise rejects and,
 * without this module, the call stays silent forever. The engine used to
 * swallow that rejection with a bare catch.
 *
 * tryPlayAudio() remembers rejected elements and retries them on:
 *  - every subsequent call (new ontrack events re-attempt)
 *  - the next user gesture anywhere in the document (one listener)
 *  - a slow nudge loop while any element is still waiting
 *
 * Also resumes suspended AudioContexts: Safari (and strict Chrome) start
 * contexts suspended outside gestures, which kills the speaking meters and
 * can gate MediaStream playback paths.
 */

const waiting = new Set<HTMLAudioElement>()
let gestureArmed = false
let nudgeTimer: ReturnType<typeof setInterval> | null = null

function armGestureRetry(): void {
  if (gestureArmed || typeof window === 'undefined') return
  gestureArmed = true
  const retry = () => retryWaiting()
  window.addEventListener('pointerdown', retry, { capture: true })
  window.addEventListener('keydown', retry, { capture: true })
  document.addEventListener('visibilitychange', retry)
}

function retryWaiting(): void {
  for (const el of waiting) {
    attempt(el)
  }
}

function attempt(el: HTMLAudioElement): void {
  const p = el.play()
  if (p && typeof p.then === 'function') {
    p.then(() => waiting.delete(el)).catch(() => {
      // still blocked: keep it queued for the next gesture / nudge
    })
  } else {
    waiting.delete(el)
  }
}

function ensureNudge(): void {
  if (nudgeTimer) return
  nudgeTimer = setInterval(() => {
    if (waiting.size === 0) return
    retryWaiting()
  }, 3000)
}

/** Play a remote-audio element, queueing retries when autoplay blocks it. */
export function tryPlayAudio(el: HTMLAudioElement): void {
  armGestureRetry()
  ensureNudge()
  attempt(el)
}

/** Forget an element that no longer needs retrying (peer dropped). */
export function forgetAudio(el: HTMLAudioElement): void {
  waiting.delete(el)
}

/** Resume a (possibly suspended) AudioContext; safe to call repeatedly. */
export function resumeAudioContext(ctx: AudioContext): void {
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {
      /* gesture-gated context: the retry machinery above covers it */
    })
  }
}
