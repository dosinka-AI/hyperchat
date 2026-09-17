'use client'

import { useEffect, useRef, useState } from 'react'

/** Real waveforms for any audio url. Voice notes ship recorded levels on the
 *  attachment; every other audio file gets its peaks decoded straight from
 *  the bytes: fetch -> decodeAudioData -> channel-mixed absolute peaks,
 *  resampled per bar count. Results cache by url so a file decodes once for
 *  the whole session, and an in-flight promise is shared across mounts. */

const PEAK_BUCKETS = 240
const CACHE_LIMIT = 48

const peakCache = new Map<string, number[]>()
const inflight = new Map<string, Promise<number[]>>()

let sharedCtx: AudioContext | null = null
function audioCtx(): AudioContext | null {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    sharedCtx ??= new Ctor()
    return sharedCtx
  } catch {
    return null
  }
}

/** Decode the url into PEAK_BUCKETS absolute-peak values (0..1). Cached. */
export function analyzeAudioPeaks(url: string): Promise<number[]> {
  const hit = peakCache.get(url)
  if (hit) return Promise.resolve(hit)
  const running = inflight.get(url)
  if (running) return running

  const job = (async (): Promise<number[]> => {
    const ctx = audioCtx()
    if (!ctx) return []
    try {
      if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined)
      const res = await fetch(url, { credentials: 'same-origin' })
      if (!res.ok) return []
      const buf = await res.arrayBuffer()
      const audio = await ctx.decodeAudioData(buf.slice(0))
      const channels = Math.min(audio.numberOfChannels, 2)
      const len = audio.length
      if (len < 8) return []
      const per = Math.max(1, Math.floor(len / PEAK_BUCKETS))
      const peaks = new Array<number>(PEAK_BUCKETS).fill(0)
      const data: Float32Array[] = []
      for (let c = 0; c < channels; c++) data.push(audio.getChannelData(c))
      for (let b = 0; b < PEAK_BUCKETS; b++) {
        const start = b * per
        const end = Math.min(len, start + per)
        let peak = 0
        for (let i = start; i < end; i++) {
          for (let c = 0; c < channels; c++) {
            const v = Math.abs(data[c][i])
            if (v > peak) peak = v
          }
        }
        peaks[b] = Math.min(1, peak)
      }
      // normalize so quiet files still show shape
      let max = 0
      for (const p of peaks) if (p > max) max = p
      if (max > 0.01) {
        for (let i = 0; i < peaks.length; i++) peaks[i] = Math.min(1, peaks[i] / max)
      }
      if (peakCache.size >= CACHE_LIMIT) {
        const oldest = peakCache.keys().next().value
        if (oldest !== undefined) peakCache.delete(oldest)
      }
      peakCache.set(url, peaks)
      return peaks
    } catch {
      return []
    } finally {
      inflight.delete(url)
    }
  })()

  inflight.set(url, job)
  return job
}

/** Resample high-res peaks (or any 0..1 series) down to `count` bars. */
function resamplePeaks(peaks: number[], count: number): number[] {
  if (peaks.length === 0) return new Array(count).fill(0.08)
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * peaks.length) / count)
    const end = Math.max(start + 1, Math.floor(((i + 1) * peaks.length) / count))
    let peak = 0
    for (let j = start; j < end && j < peaks.length; j++) {
      if (peaks[j] > peak) peak = peaks[j]
    }
    out.push(Math.max(0.08, Math.min(1, peak)))
  }
  return out
}

/** Normalize an attachment waveform payload (0..100 ints or 0..1 fractions). */
function normalizePayload(data: number[] | undefined, count: number): number[] | null {
  if (!Array.isArray(data) || data.length < 8) return null
  const out = data
    .map((v) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return 0.4
      const v01 = v > 1 ? v / 100 : v
      return Math.max(0.08, Math.min(1, v01))
    })
    .slice(0, count)
  while (out.length < Math.min(count, 16)) out.push(0.4)
  return out
}

/** Waveform bars for one audio url. Attachments that carry recorded levels
 *  (voice notes) use them directly; anything else decodes real peaks on
 *  mount (flat quiet bars until they land - never a synthetic fingerprint). */
export function useRealWaveform(url: string, data: number[] | undefined, count: number): number[] {
  const payload = normalizePayload(data, count)
  const [peaks, setPeaks] = useState<number[]>(() => peakCache.get(url) ?? [])
  const askedFor = useRef<string | null>(null)

  useEffect(() => {
    if (payload || askedFor.current === url) return
    askedFor.current = url
    let alive = true
    void analyzeAudioPeaks(url).then((p) => {
      if (!alive || p.length === 0) return
      setPeaks(p)
    })
    return () => {
      alive = false
    }
  }, [url, payload])

  if (payload) return payload
  if (peaks.length > 0) return resamplePeaks(peaks, count)
  return new Array(count).fill(0.14)
}
