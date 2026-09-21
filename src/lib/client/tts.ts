/**
 * Client-side TTS playback for /tts messages.
 *
 * One voice at a time: starting a row stops any other playing row. Audio is
 * fetched from /api/messages/:id/tts (which synthesizes once and caches),
 * decoded into a blob URL, and played through a single HTMLAudioElement.
 * Volume follows the app sound volume so the settings slider stays honest.
 */

import { sounds } from './sounds'
import type { ClientMessage } from '@/lib/types'

type PlayingRow = { messageId: string; audio: HTMLAudioElement; url: string }

let playing: PlayingRow | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

/** Subscribe to play-state changes (message id now playing, or null). */
export function subscribeTts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function ttsPlayingId(): string | null {
  return playing?.messageId ?? null
}

export function stopTts(): void {
  if (!playing) return
  playing.audio.pause()
  playing.audio.src = ''
  URL.revokeObjectURL(playing.url)
  playing = null
  emit()
}

/** Fetch + play the spoken version of a /tts message. Clicking a playing
 *  row stops it (toggle behavior at the call site via ttsPlayingId). */
export async function playMessageTts(message: ClientMessage): Promise<void> {
  if (!message.isTts) return
  if (playing?.messageId === message.id) {
    stopTts()
    return
  }
  stopTts()
  try {
    const res = await fetch(`/api/messages/${encodeURIComponent(message.id)}/tts`)
    if (!res.ok) return
    const blob = await res.blob()
    if (blob.size === 0) return
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    audio.volume = Math.min(1, Math.max(0, sounds.getVolume()))
    audio.onended = () => stopTts()
    audio.onerror = () => stopTts()
    playing = { messageId: message.id, audio, url }
    emit()
    await audio.play()
  } catch {
    stopTts()
  }
}
