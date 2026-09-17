'use client'

import { useEffect, useState } from 'react'
import { Send, X } from 'lucide-react'

/** Voice-note capture UI: the compact recording bar that REPLACES the
 *  composer row while a recording is live. The capture engine (MediaRecorder
 *  + AnalyserNode) lives in MessageInput; this component renders the live
 *  state and forwards the two intents (cancel / stop + send).
 *
 *  Levels flow through a ref-resident channel at ~12 Hz so the composer
 *  itself never re-renders during a recording — only this bar does. */

/** bars stored (and rendered) per voice message */
export const VOICE_BAR_COUNT = 40
/** recordings under this length are discarded as accidental taps */
export const VOICE_MIN_SECONDS = 0.5
/** hard cap: the recorder auto-stops and sends at 3:00 */
export const VOICE_CAP_SECONDS = 180

export type VoiceSnapshot = {
  /** live recording length in seconds */
  seconds: number
  /** newest-last rolling window of RMS levels (0..1) */
  levels: number[]
}

export type VoiceLevelChannel = ReturnType<typeof createLevelChannel>

/** Ref-resident broadcaster: the capture loop pushes snapshots without
 *  touching React state; the bar owns its own state and re-renders alone. */
export function createLevelChannel() {
  const listeners = new Set<(snap: VoiceSnapshot) => void>()
  let last: VoiceSnapshot = { seconds: 0, levels: [] }
  return {
    push(snap: VoiceSnapshot) {
      last = snap
      listeners.forEach((listener) => listener(snap))
    },
    subscribe(listener: (snap: VoiceSnapshot) => void) {
      listeners.add(listener)
      listener(last)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

/** Collapse the sampled RMS levels into exactly `bars` peaks, stored as
 *  INTEGERS 0..100 (documented scale: 100 * peak level of the bucket, where
 *  1.0 means the bucket peaked near full scale; typical speech peaks land
 *  around 20-70, silence reads 0). */
export function resampleWaveform(samples: number[], bars = VOICE_BAR_COUNT): number[] {
  const out: number[] = []
  if (samples.length === 0) return new Array(bars).fill(0)
  for (let i = 0; i < bars; i++) {
    const start = Math.floor((i * samples.length) / bars)
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor(((i + 1) * samples.length) / bars)))
    let peak = 0
    for (let j = start; j < end; j++) {
      const v = samples[j]
      if (Number.isFinite(v) && v > peak) peak = v
    }
    out.push(Math.round(Math.min(1, peak) * 100))
  }
  return out
}

function timerText(seconds: number) {
  const whole = Math.floor(Math.max(0, seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function VoiceRecorderBar({
  channel,
  onCancel,
  onSend,
}: {
  channel: VoiceLevelChannel
  onCancel: () => void
  onSend: () => void
}) {
  const [snap, setSnap] = useState<VoiceSnapshot>({ seconds: 0, levels: [] })

  useEffect(() => channel.subscribe(setSnap), [channel])

  // the bar IS the composer while recording: enter sends, escape cancels.
  // keystrokes aimed at another surface (picker search, dialogs) pass through.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if (e.key === 'Enter') {
        e.preventDefault()
        onSend()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, onSend])

  // right-aligned window of the newest levels; a quiet baseline keeps the
  // row legible through silence
  const bars = Array.from({ length: VOICE_BAR_COUNT }, (_, i) => {
    const idx = snap.levels.length - VOICE_BAR_COUNT + i
    const level = idx >= 0 ? snap.levels[idx] : 0
    return Math.max(0.08, Math.min(1, level))
  })

  return (
    <div className="flex items-center gap-2.5 px-2.5 py-2 fade-in" role="status" aria-label="recording a voice message">
      <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
        <span className="absolute inset-0 rounded-full bg-red-500/60 animate-ping" />
        <span className="relative size-2.5 rounded-full bg-red-500" />
      </span>
      <span className="text-[11px] font-bold tabular-nums text-foreground/90 shrink-0">{timerText(snap.seconds)}</span>
      <span className="flex items-end gap-[2px] h-4 min-w-0 flex-1 overflow-hidden" aria-hidden="true">
        {bars.map((level, i) => (
          <span
            key={i}
            className="w-[3px] rounded-full bg-hyper/75 transition-[height] duration-100 ease-out"
            style={{ height: `${Math.round(level * 100)}%` }}
          />
        ))}
      </span>
      <button
        type="button"
        onClick={onCancel}
        className="grid place-items-center size-7 shrink-0 rounded-sm text-muted-foreground hover:text-destructive hover:bg-accent transition-colors"
        aria-label="cancel recording"
        title="cancel"
      >
        <X className="size-4" />
      </button>
      <button
        type="button"
        onClick={onSend}
        className="grid place-items-center size-7 shrink-0 rounded-sm bg-hyper text-white hover:bg-hyper/90 transition-colors"
        aria-label="stop and send voice message"
        title="stop and send"
      >
        <Send className="size-3.5" />
      </button>
    </div>
  )
}
