/** The speech engine's voice catalog, shared by the API routes and the
 *  settings UI. `chuichui` is the default: it renders English at a natural
 *  pace (verified against the engine's own transcription; several of the
 *  other voices drag or mispace English sentences). Users can pick any
 *  voice and preview it before committing. */

export type TtsVoiceId = 'chuichui' | 'xiaochen' | 'tongtong' | 'jam' | 'kazi' | 'douji' | 'luodo'

export type TtsVoice = {
  id: TtsVoiceId
  label: string
  /** one short line shown under the voice name in the picker */
  vibe: string
}

export const TTS_VOICES: TtsVoice[] = [
  { id: 'chuichui', label: 'Chuichui', vibe: 'bright and crisp, best fit for english' },
  { id: 'xiaochen', label: 'Xiaochen', vibe: 'calm and even' },
  { id: 'tongtong', label: 'Tongtong', vibe: 'warm and friendly' },
  { id: 'jam', label: 'Jam', vibe: 'british and formal' },
  { id: 'kazi', label: 'Kazi', vibe: 'clear and standard' },
  { id: 'douji', label: 'Douji', vibe: 'natural and easygoing' },
  { id: 'luodo', label: 'Luodo', vibe: 'expressive storyteller' },
]

export const DEFAULT_TTS_VOICE: TtsVoiceId = 'chuichui'
export const DEFAULT_TTS_SPEED = 1

export const TTS_VOICE_IDS = TTS_VOICES.map((v) => v.id) as string[]

/** Coerce anything (query params, DB columns, request bodies) into a valid
 *  voice id, falling back to the default. */
export function coerceTtsVoice(raw: unknown): TtsVoiceId {
  return typeof raw === 'string' && (TTS_VOICE_IDS as string[]).includes(raw) ? (raw as TtsVoiceId) : DEFAULT_TTS_VOICE
}

/** Clamp a speed preference into the engine's 0.5..2.0 window. */
export function coerceTtsSpeed(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return DEFAULT_TTS_SPEED
  return Math.min(2, Math.max(0.5, Math.round(n * 20) / 20))
}
