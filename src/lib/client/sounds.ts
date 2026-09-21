'use client'

/**
 * Hyperion sound engine.
 *
 * Sounds are grouped into three switchable categories (message, join, ui)
 * so the settings page can expose real control instead of one mute-all
 * toggle. Sounds you cause yourself never play: the caller decides (your
 * own messages tick on send, never the receive chime).
 *
 * Master volume persists; focus mode mutes everything; audio unlocks on
 * the first user gesture with the silent noise trick.
 */

export type SoundName =
  | 'click'
  | 'send'
  | 'msg'
  | 'msgunfocused'
  | 'join'
  | 'error'
  | 'enter'
  | 'whoom'
  | 'uiWhoom'
  | 'lightTick'
  | 'midTick'
  | 'heavyTick'
  | 'heavyTick2'
  | 'veryHeavyTick'
  | 'altTick'
  | 'glassTick'
  | 'msgLoud'
  | 'ping'
  | 'beep'
  | 'urgent'
  | 'urgent2'
  | 'ml'
  | 'callRingIn'
  | 'callRingOut'
  | 'callEnter'
  | 'callLeave'
  | 'recStart'
  | 'recStop'

/** Which category each sound belongs to; anything not listed is ui. */
const CATEGORY: Partial<Record<SoundName, 'message' | 'join' | 'ui'>> = {
  msg: 'message',
  msgunfocused: 'message',
  msgLoud: 'message',
  ping: 'message',
  beep: 'message',
  urgent: 'message',
  urgent2: 'message',
  ml: 'message',
  join: 'join',
  enter: 'join',
  callEnter: 'join',
  callLeave: 'join',
  recStart: 'join',
  recStop: 'join',
  error: 'ui',
}

export type SoundCategory = 'message' | 'join' | 'ui'

/** Sound resolution: every name maps to a real file (legacy names included). */
const FILES: Record<string, string> = {
  click: '/sounds/ui-light-tick-sound.wav',
  send: '/sounds/ui-mid-tick-sound.wav',
  msg: '/sounds/message-sound-louder.wav',
  msgunfocused: '/sounds/msgunfocused.wav',
  join: '/sounds/join.wav',
  ping: '/sounds/echoing-ping-sound.wav',
  error: '/sounds/error-sound.wav',
  whoom: '/sounds/aura-woosh-whoom.wav',
  uiWhoom: '/sounds/ui-whoom.wav',
  lightTick: '/sounds/ui-light-tick-sound.wav',
  midTick: '/sounds/ui-mid-tick-sound.wav',
  heavyTick: '/sounds/ui-heavy-tik-sound.wav',
  heavyTick2: '/sounds/ui-heavy-tick-sound-2.wav',
  veryHeavyTick: '/sounds/ui-very-heavy-tick-sound.wav',
  altTick: '/sounds/ui-alternite-tick-sound.wav',
  glassTick: '/sounds/glass-tick-sound.ogg',
  msgLoud: '/sounds/message-sound-louder.wav',
  beep: '/sounds/beep.wav',
  urgent: '/sounds/uiurgent.wav',
  urgent2: '/sounds/uiurgent2.wav',
  enter: '/sounds/enter-sound.wav',
  ml: '/sounds/ml.wav',
  callRingIn: '/sounds/call-ring-in.wav',
  callRingOut: '/sounds/call-ring-out.wav',
  callEnter: '/sounds/call-enter.wav',
  callLeave: '/sounds/call-leave.wav',
  recStart: '/sounds/recording-start.wav',
  recStop: '/sounds/recording-stop.wav',
}

const VOLUMES: Record<string, number> = {
  click: 0.4,
  send: 0.5,
  msg: 0.32,
  msgunfocused: 0.22,
  join: 0.3,
  ping: 0.4,
  error: 0.35,
  whoom: 0.28,
  uiWhoom: 0.2,
  lightTick: 0.4,
  midTick: 0.5,
  heavyTick: 0.45,
  heavyTick2: 0.45,
  veryHeavyTick: 0.45,
  altTick: 0.4,
  glassTick: 0.4,
  msgLoud: 0.45,
  beep: 0.35,
  urgent: 0.35,
  urgent2: 0.35,
  enter: 0.35,
  ml: 0.4,
  callRingIn: 0.5,
  callRingOut: 0.4,
  callEnter: 0.45,
  callLeave: 0.45,
  recStart: 0.6,
  recStop: 0.6,
}

/** The voice picker in settings: every shipped sound, one entry per file. */
export const VOICES: { id: SoundName; label: string }[] = [
  { id: 'msg', label: 'message chime' },
  { id: 'msgLoud', label: 'loud message' },
  { id: 'msgunfocused', label: 'quiet message' },
  { id: 'ping', label: 'ping' },
  { id: 'beep', label: 'beep' },
  { id: 'ml', label: 'ml' },
  { id: 'urgent', label: 'urgent' },
  { id: 'urgent2', label: 'urgent 2' },
  { id: 'join', label: 'join' },
  { id: 'enter', label: 'enter' },
  { id: 'error', label: 'error' },
  { id: 'whoom', label: 'whoom' },
  { id: 'uiWhoom', label: 'ui whoom' },
  { id: 'click', label: 'light tick' },
  { id: 'midTick', label: 'mid tick' },
  { id: 'altTick', label: 'alternate tick' },
  { id: 'glassTick', label: 'glass tick' },
  { id: 'heavyTick', label: 'heavy tick' },
  { id: 'heavyTick2', label: 'heavy tick 2' },
  { id: 'veryHeavyTick', label: 'very heavy tick' },
  { id: 'callEnter', label: 'voice join' },
  { id: 'callLeave', label: 'voice leave' },
]

/** Events whose voices can be swapped from settings. 'ui' covers every
 *  ui-category name at once (all the ticks share one voice). */
export type SoundEvent = 'msg' | 'msgunfocused' | 'join' | 'ping' | 'error' | 'ui'

const VOICE_KEY = 'hyperchat-sound-voices'

/** Unfocused tabs get a volume penalty. */
const UNFOCUSED_PENALTY = 0.3

const REPEAT_GUARD_MS = 70

const CATS_KEY = 'hyperchat-sound-cats'

type CatMap = { message: boolean; join: boolean; ui: boolean }

function loadCats(): CatMap {
  const fallback: CatMap = { message: true, join: true, ui: true }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(CATS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallback
    return {
      message: parsed.message !== false,
      join: parsed.join !== false,
      ui: parsed.ui !== false,
    }
  } catch {
    return fallback
  }
}

class SoundEngine {
  private cache = new Map<string, HTMLAudioElement>()
  private unlocked = false
  private unfocused = false
  private lastPlayed = new Map<string, number>()
  /** focus mode override: when false, all sounds are suppressed */
  private enabledOverride: boolean | null = null

  get isUnlocked(): boolean {
    return this.unlocked
  }

  /** Sounds can be turned off entirely from the account page. Default: on. */
  isEnabled(): boolean {
    if (typeof window === 'undefined') return false
    if (this.enabledOverride === false) return false
    try {
      return localStorage.getItem('hyperchat-sounds') !== 'off'
    } catch {
      return true
    }
  }

  /** Focus mode mutes everything without touching the saved pref. */
  setEnabledOverride(override: boolean | null): void {
    this.enabledOverride = override
  }

  setEnabled(enabled: boolean): void {
    try {
      localStorage.setItem('hyperchat-sounds', enabled ? 'on' : 'off')
    } catch {
      /* storage may be blocked; the toggle just will not persist */
    }
  }

  /** Per-category switches (message / join / ui). */
  getCategoryEnabled(cat: SoundCategory): boolean {
    return loadCats()[cat]
  }

  setCategoryEnabled(cat: SoundCategory, enabled: boolean): void {
    try {
      const cats = loadCats()
      cats[cat] = enabled
      localStorage.setItem(CATS_KEY, JSON.stringify(cats))
    } catch {
      /* best-effort persistence */
    }
  }

  /** Per-event voice overrides: which voice each event plays. Null = default. */
  getEventVoice(event: SoundEvent): SoundName | null {
    if (typeof window === 'undefined') return null
    try {
      const raw = localStorage.getItem(VOICE_KEY)
      if (!raw) return null
      const parsed = JSON.parse(raw)
      const id = parsed ? parsed[event] : null
      return typeof id === 'string' && id in FILES ? (id as SoundName) : null
    } catch {
      return null
    }
  }

  setEventVoice(event: SoundEvent, voice: SoundName | null): void {
    try {
      const raw = localStorage.getItem(VOICE_KEY)
      const parsed = raw ? JSON.parse(raw) : {}
      const map = parsed && typeof parsed === 'object' ? parsed : {}
      if (voice === null) delete map[event]
      else map[event] = voice
      localStorage.setItem(VOICE_KEY, JSON.stringify(map))
    } catch {
      /* best-effort persistence */
    }
  }

  resetEventVoices(): void {
    try {
      localStorage.removeItem(VOICE_KEY)
    } catch {
      /* best-effort persistence */
    }
  }

  /** Master volume, 0..1, persisted. Default: full. */
  getVolume(): number {
    if (typeof window === 'undefined') return 1
    try {
      const raw = localStorage.getItem('hyperchat-volume')
      const v = raw === null ? 1 : Number(raw)
      return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
    } catch {
      return 1
    }
  }

  setVolume(volume: number): void {
    try {
      localStorage.setItem('hyperchat-volume', String(Math.min(1, Math.max(0, volume))))
    } catch {
      /* best-effort persistence */
    }
  }

  /** Unlock audio playback with a silent noise burst. Call on first gesture. */
  unlock(): void {
    if (this.unlocked || typeof window === 'undefined') return
    this.unlocked = true
    try {
      const el = this.ensure('noise')
      el.volume = 0.001
      el.currentTime = 0
      void el.play().catch(() => {
        this.unlocked = false
      })
    } catch {
      this.unlocked = false
    }
  }

  setUnfocused(unfocused: boolean): void {
    this.unfocused = unfocused
  }

  play(name: SoundName, volumeScale = 1): void {
    if (typeof window === 'undefined') return
    if (!this.isEnabled()) return
    // category gate: message chimes can be turned off without losing clicks
    const cat = CATEGORY[name] ?? 'ui'
    if (!loadCats()[cat]) return
    // voice resolution: an event override wins (the 'ui' override retunes
    // every tick at once), otherwise the name itself
    let resolved: string | null = name in FILES ? name : 'click'
    const uiVoice = this.getEventVoice('ui')
    if (cat === 'ui' && uiVoice) resolved = uiVoice
    const eventVoice = this.getEventVoice(name as SoundEvent)
    if (eventVoice) resolved = eventVoice
    if (!resolved || !(resolved in FILES)) return
    const now = performance.now()
    const last = this.lastPlayed.get(resolved) ?? -Infinity
    if (now - last < REPEAT_GUARD_MS) return
    this.lastPlayed.set(resolved, now)

    try {
      const el = this.ensure(resolved)
      const base = VOLUMES[resolved] ?? 0.4
      el.volume = Math.min(
        1,
        base * volumeScale * this.getVolume() * (this.unfocused ? UNFOCUSED_PENALTY : 1)
      )
      el.currentTime = 0
      void el.play().catch(() => {
        /* autoplay still blocked; the next gesture will unlock it */
      })
    } catch {
      /* a missing file or a broken element should never break the app */
    }
  }

  /** Preview a specific voice from the settings picker: no event override,
   *  no category gate, so the picker always sounds exactly the chosen file. */
  previewVoice(name: SoundName): void {
    if (typeof window === 'undefined') return
    if (!this.isEnabled()) return
    const resolved = name in FILES ? name : 'click'
    try {
      const el = this.ensure(resolved)
      el.volume = Math.min(1, (VOLUMES[resolved] ?? 0.4) * this.getVolume())
      el.currentTime = 0
      void el.play().catch(() => {
        /* autoplay still blocked; the next gesture will unlock it */
      })
    } catch {
      /* a missing file or a broken element should never break the app */
    }
  }

  private ensure(name: string): HTMLAudioElement {
    const file = name === 'noise' ? '/sounds/noise.wav' : FILES[name] ?? '/sounds/ui-light-tick-sound.wav'
    // the standalone html build inlines its sounds as data urls
    const overrides = (window as unknown as { __HYPERCHAT_SOUNDS?: Record<string, string> }).__HYPERCHAT_SOUNDS
    const src = overrides?.[file] ?? file
    let el = this.cache.get(src)
    if (!el) {
      el = new Audio(src)
      el.preload = 'auto'
      this.cache.set(src, el)
    }
    return el
  }

  /** Call rings loop until stopped, at their own volume, immune to category
   *  gates and the repeat guard (a ring must keep ringing). One loop element
   *  each for in/out so switching states never overlaps. */
  startRingLoop(name: 'callRingIn' | 'callRingOut'): void {
    if (typeof window === 'undefined') return
    try {
      const el = this.ensure(name)
      el.loop = true
      el.volume = Math.min(1, (VOLUMES[name] ?? 0.45) * this.getVolume())
      if (el.paused) {
        el.currentTime = 0
        void el.play().catch(() => {
          /* autoplay may block until gesture; the accept click unlocks it */
        })
      }
    } catch {
      /* never break the call flow over a sound */
    }
  }

  stopRingLoop(name: 'callRingIn' | 'callRingOut'): void {
    if (typeof window === 'undefined') return
    try {
      const el = this.ensure(name)
      el.pause()
      el.currentTime = 0
    } catch {
      /* ignore */
    }
  }
}

export const sounds = new SoundEngine()
