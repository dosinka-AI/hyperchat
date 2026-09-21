/**
 * Push-to-talk preferences, shared by the voice-room engine and the call
 * engine. One preference, both surfaces: enabling it in a voice room also
 * enables it for calls.
 *
 * Deliberately dependency-free (both engines import it at construction time,
 * so a cycle here would be a module-eval hazard).
 */

export type PttPrefs = {
  enabled: boolean
  /** a KeyboardEvent.code, e.g. 'KeyV', 'Space', 'ShiftLeft' */
  key: string
}

const STORAGE_KEY = 'hyperchat_ptt'
export const DEFAULT_PTT_KEY = 'KeyV'
/** sentinel code used to release any held key (window blur) */
export const PTT_RELEASE_ALL = '__ptt_release_all__'

/** globalThis home: a Fast Refresh re-evaluates this module, but the engines
 *  (also globalThis singletons) keep referencing whatever object they were
 *  built with - so the pref object and its listener set must survive module
 *  generations, or toggling PTT after a refresh would update a dead copy. */
const G = globalThis as unknown as {
  __hyperionPttPrefs?: PttPrefs
  __hyperionPttListeners?: Set<PttListener>
}

function readPrefs(): PttPrefs {
  if (typeof window === 'undefined') return { enabled: false, key: DEFAULT_PTT_KEY }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { enabled: false, key: DEFAULT_PTT_KEY }
    const parsed = JSON.parse(raw) as Partial<PttPrefs>
    return {
      enabled: parsed.enabled === true,
      key: typeof parsed.key === 'string' && parsed.key ? parsed.key : DEFAULT_PTT_KEY,
    }
  } catch {
    return { enabled: false, key: DEFAULT_PTT_KEY }
  }
}

/** The single shared, mutable preference object both engines read from. */
export const pttPrefs: PttPrefs = (G.__hyperionPttPrefs ??= readPrefs())

type PttListener = (prefs: PttPrefs) => void
const listeners: Set<PttListener> = (G.__hyperionPttListeners ??= new Set<PttListener>())

/** Commit a mutation made on `pttPrefs`: persist it and notify subscribers
 *  (both engines re-apply their mic state and re-render their UI). */
export function commitPttPrefs(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pttPrefs))
  } catch {
    // storage may be unavailable (private mode); the in-memory pref still works
  }
  for (const fn of listeners) fn(pttPrefs)
}

export function onPttPrefsChanged(fn: PttListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Human label for a KeyboardEvent.code: 'KeyV' -> 'V', 'Space' -> 'space',
 *  'ShiftLeft' -> 'left shift', 'Digit3' -> '3', arrows keep their names. */
export function pttKeyLabel(code: string): string {
  if (!code) return ''
  if (code.startsWith('Key') && code.length === 4) return code.slice(3)
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5)
  if (code.startsWith('Numpad')) return 'numpad ' + code.slice(6)
  const named: Record<string, string> = {
    Space: 'space',
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ShiftLeft: 'left shift',
    ShiftRight: 'right shift',
    ControlLeft: 'left ctrl',
    ControlRight: 'right ctrl',
    AltLeft: 'left alt',
    AltRight: 'right alt',
    MetaLeft: 'left cmd',
    MetaRight: 'right cmd',
    Enter: 'enter',
    Tab: 'tab',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Quote: "'",
    Backslash: '\\',
    Comma: ',',
    Period: '.',
    Slash: '/',
    CapsLock: 'caps lock',
    Insert: 'insert',
    Delete: 'delete',
    Home: 'home',
    End: 'end',
    PageUp: 'page up',
    PageDown: 'page down',
  }
  return named[code] ?? code.toLowerCase()
}
