'use client'

/**
 * The server soundboard: short audio clips the server's admins uploaded
 * (mp3/wav/ogg/...), played into the outbound voice mix so everyone in the
 * channel hears them, with a local monitor for the sender. Files are fetched
 * from /api/files, decoded once per URL and cached — the synth blips this
 * module used to synthesize are gone: sounds come from the server's own
 * library now.
 */

/** The picker row served by /api/servers/:id/soundboard. */
export type SoundboardSoundSummary = {
  id: string
  serverId: string
  name: string
  url: string
  size: number
  mime: string
  addedById: string
  createdAt: string
}

/** decoded AudioBuffers by file URL: a sound decodes once per session */
const bufferCache = new Map<string, AudioBuffer>()

/** one lazy AudioContext dedicated to decoding (playback happens on the DSP
 *  context); decodeAudioData works on a suspended context just fine */
let decodeCtx: AudioContext | null = null

/** Fetch + decode one sound file, cached by URL. Throws on network or codec
 *  failure so the caller can toast honestly. */
export async function getSoundBuffer(url: string): Promise<AudioBuffer> {
  const hit = bufferCache.get(url)
  if (hit) return hit
  const res = await fetch(url)
  if (!res.ok) throw new Error(`could not load the sound (${res.status})`)
  const bytes = await res.arrayBuffer()
  decodeCtx ??= new AudioContext()
  const buffer = await decodeCtx.decodeAudioData(bytes)
  bufferCache.set(url, buffer)
  return buffer
}

/** Forget every decoded buffer (voice teardown calls this: a fresh session
 *  re-decodes from a warm HTTP cache, and the memory is bounded). */
export function clearSoundCache(): void {
  bufferCache.clear()
}
