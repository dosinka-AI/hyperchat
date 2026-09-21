/**
 * Push-to-talk key router: the single window-level key listener that feeds
 * hold-to-talk events into whichever engine (voice room or call) is live.
 *
 * Rules:
 *  - key repeats are ignored (only the edges matter)
 *  - keys typed into inputs, textareas, select boxes and contenteditable
 *    surfaces never trigger PTT (so chatting while holding the key elsewhere
 *    stays clean)
 *  - losing the window releases the key (a keyup that never arrives would
 *    leave the mic open forever)
 *
 * Wired once per page from ChatApp via initPushToTalk(); the engines no-op
 * the events unless push-to-talk is enabled and they hold a live session.
 */

import { voiceEngine } from './voice'
import { callEngine } from './call'

const WIRED_FLAG = '__hyperionPttWired'

/** True when a key event originated inside an input, textarea, select or
 *  contenteditable surface — shared so call shortcuts (M/D/F) can reuse the
 *  exact same typing guard as the PTT router. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return el.isContentEditable === true
}

export function initPushToTalk(): void {
  if (typeof window === 'undefined') return
  const g = globalThis as unknown as { [WIRED_FLAG]?: boolean }
  if (g[WIRED_FLAG]) return
  g[WIRED_FLAG] = true

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.repeat || isTypingTarget(e.target)) return
      voiceEngine.handlePttKey(e.code, true)
      callEngine.handlePttKey(e.code, true)
    },
    { capture: true }
  )

  window.addEventListener(
    'keyup',
    (e) => {
      voiceEngine.handlePttKey(e.code, false)
      callEngine.handlePttKey(e.code, false)
    },
    { capture: true }
  )

  // the keyup can be lost when the window loses focus mid-hold (alt-tab,
  // cmd-tab, opening devtools): force-release so the mic never sticks open
  window.addEventListener('blur', () => {
    voiceEngine.handlePttKey('__ptt_release_all__', false)
    callEngine.handlePttKey('__ptt_release_all__', false)
  })
}
