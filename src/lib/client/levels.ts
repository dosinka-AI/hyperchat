'use client'

/** Per-user listening levels, shared by the voice-room engine and the call
 *  engine: one storage key, one meaning — "how loud I want to hear this
 *  person" follows them from a voice channel into a call and back.
 *
 *  vol is a percentage 0..200 (100 = untouched; >100 boosts quiet mics via a
 *  WebAudio gain node, which is why playback rides a gain chain instead of a
 *  plain <audio> element capped at 100%). mute is a local-only per-person
 *  silence ("I can't hear this one person without hanging up on everyone"). */

export type LevelPrefs = { vol: Record<string, number>; mute: string[] }

export const LEVELS_KEY = 'hyperchat_voice_levels'

export function loadLevelPrefs(): LevelPrefs {
  if (typeof window === 'undefined') return { vol: {}, mute: [] }
  try {
    const raw = window.localStorage.getItem(LEVELS_KEY)
    if (!raw) return { vol: {}, mute: [] }
    const parsed = JSON.parse(raw) as Partial<LevelPrefs>
    return {
      vol: parsed.vol && typeof parsed.vol === 'object' ? parsed.vol : {},
      mute: Array.isArray(parsed.mute) ? parsed.mute.filter((m) => typeof m === 'string') : [],
    }
  } catch {
    return { vol: {}, mute: [] }
  }
}

export function saveLevelPrefs(p: LevelPrefs): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LEVELS_KEY, JSON.stringify(p))
  } catch {
    /* storage full or blocked: levels keep working for this session */
  }
}

/** Clamp a user-supplied percentage into the 0..200 range. */
export function clampVolumePercent(percent: number): number {
  return Math.max(0, Math.min(200, Math.round(percent)))
}

/** Read one person's stored level with defaults (100%, not muted). */
export function readLevel(prefs: LevelPrefs, userId: string): { volume: number; localMuted: boolean } {
  return {
    volume: typeof prefs.vol[userId] === 'number' ? prefs.vol[userId] : 100,
    localMuted: prefs.mute.includes(userId),
  }
}
