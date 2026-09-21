/**
 * Voice & audio preferences, shared by the voice-room engine, the call engine
 * and the settings dialog. Same pattern as ptt-prefs: one mutable pref object
 * on globalThis that engines read directly, a commit function that persists
 * and notifies, and dependency-free helpers so module-eval cycles can't form.
 *
 * - input/output device ids: '' means "system default"
 * - sensitivity: RMS threshold (0.005..0.12) below which you count as silent
 * - the three processing flags map 1:1 onto getUserMedia audio constraints
 */

export type AudioPrefs = {
  /** deviceId of the preferred microphone ('' = system default) */
  inputDeviceId: string
  /** deviceId of the preferred output ('' = system default) */
  outputDeviceId: string
  /** speaking-detection RMS threshold; engines treat rms > sensitivity as speech */
  sensitivity: number
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
}

const STORAGE_KEY = 'hyperchat_audio'

export const SENSITIVITY_MIN = 0.005
export const SENSITIVITY_MAX = 0.12
export const DEFAULT_SENSITIVITY = 0.03

export const DEFAULT_AUDIO_PREFS: AudioPrefs = {
  inputDeviceId: '',
  outputDeviceId: '',
  sensitivity: DEFAULT_SENSITIVITY,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

/** globalThis home: survives Fast Refresh module re-evaluations (see
 *  ptt-prefs.ts for the full reasoning — the engines are globalThis
 *  singletons that keep referencing the object they were built with). */
const G = globalThis as unknown as {
  __hyperionAudioPrefs?: AudioPrefs
  __hyperionAudioListeners?: Set<AudioPrefsListener>
}

function readPrefs(): AudioPrefs {
  if (typeof window === 'undefined') return { ...DEFAULT_AUDIO_PREFS }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_AUDIO_PREFS }
    const p = JSON.parse(raw) as Partial<AudioPrefs>
    return {
      inputDeviceId: typeof p.inputDeviceId === 'string' ? p.inputDeviceId : '',
      outputDeviceId: typeof p.outputDeviceId === 'string' ? p.outputDeviceId : '',
      sensitivity:
        typeof p.sensitivity === 'number' && p.sensitivity >= SENSITIVITY_MIN && p.sensitivity <= SENSITIVITY_MAX
          ? p.sensitivity
          : DEFAULT_SENSITIVITY,
      echoCancellation: p.echoCancellation !== false,
      noiseSuppression: p.noiseSuppression !== false,
      autoGainControl: p.autoGainControl !== false,
    }
  } catch {
    return { ...DEFAULT_AUDIO_PREFS }
  }
}

/** The single shared, mutable preference object the engines read from. */
export const audioPrefs: AudioPrefs = (G.__hyperionAudioPrefs ??= readPrefs())

type AudioPrefsListener = (prefs: AudioPrefs) => void
const listeners: Set<AudioPrefsListener> = (G.__hyperionAudioListeners ??= new Set<AudioPrefsListener>())

export function commitAudioPrefs(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(audioPrefs))
  } catch {
    // storage may be unavailable; the in-memory pref still works
  }
  for (const fn of listeners) fn(audioPrefs)
}

export function onAudioPrefsChanged(fn: AudioPrefsListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function resetAudioPrefs(): void {
  Object.assign(audioPrefs, DEFAULT_AUDIO_PREFS)
  commitAudioPrefs()
}

/** MediaTrackConstraints for the mic built from the current prefs — used by
 *  both engines at join and by the settings dialog's live meter. */
export function micAudioConstraints(): MediaTrackConstraints {
  return {
    ...(audioPrefs.inputDeviceId ? { deviceId: { exact: audioPrefs.inputDeviceId } } : {}),
    echoCancellation: audioPrefs.echoCancellation,
    noiseSuppression: audioPrefs.noiseSuppression,
    autoGainControl: audioPrefs.autoGainControl,
  }
}

/** Stable key for "what the current mic stream was acquired with" — when this
 *  changes while live, the engine re-acquires the mic and replaceTrack()s it
 *  into every peer (device or processing changes need a fresh getUserMedia). */
export function micConstraintsKey(): string {
  const { inputDeviceId, echoCancellation, noiseSuppression, autoGainControl } = audioPrefs
  return JSON.stringify({ inputDeviceId, echoCancellation, noiseSuppression, autoGainControl })
}

/** Route one element (a remote <audio>) to the preferred output device.
 *  Feature-detected: Safari lacks setSinkId; a rejected id (device unplugged)
 *  fails soft and keeps whatever output is currently active. */
export function applyOutputSink(el: HTMLMediaElement): void {
  const id = audioPrefs.outputDeviceId
  if (!id) return
  const anyEl = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void>; sinkId?: string }
  if (typeof anyEl.setSinkId !== 'function') return
  if (anyEl.sinkId === id) return
  void anyEl.setSinkId(id).catch(() => {})
}

/** Chrome 110+ can re-route a whole AudioContext (the WebAudio playback path
 *  of both engines rides ctx.destination); fail-soft everywhere else. */
export function applySinkToContext(ctx: AudioContext | null): void {
  if (!ctx) return
  const id = audioPrefs.outputDeviceId
  if (!id) return
  const anyCtx = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: string }
  if (typeof anyCtx.setSinkId !== 'function') return
  if (anyCtx.sinkId === id) return
  void anyCtx.setSinkId(id).catch(() => {})
}
