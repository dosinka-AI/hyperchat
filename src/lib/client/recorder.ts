'use client'

/**
 * CallRecorder: records what you hear in a call - every remote voice, their
 * screen-share sound, and your own mic - as one mixed file. The engine hands
 * over a list of tap nodes (WebAudio nodes whose output is exactly the mix
 * you hear); this builds a MediaStreamAudioDestinationNode, connects every
 * tap into it, and records the resulting stream with MediaRecorder.
 *
 * On stop the blob resolves back to the caller, which triggers the browser
 * download (see downloadRecording). The warning sounds and the red REC
 * badges are NOT this module's business: they ride the call:recording /
 * voice:recording broadcasts so the whole call hears them.
 */

function pickMime(): { mimeType: string; ext: string } | null {
  if (typeof MediaRecorder === 'undefined') return null
  const candidates: { mimeType: string; ext: string }[] = [
    { mimeType: 'audio/webm;codecs=opus', ext: 'webm' },
    { mimeType: 'audio/webm', ext: 'webm' },
    { mimeType: 'audio/mp4', ext: 'm4a' },
    { mimeType: 'audio/ogg;codecs=opus', ext: 'ogg' },
  ]
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c.mimeType)) return c
    } catch {
      /* isTypeSupported can throw on exotic builds; try the next */
    }
  }
  return null
}

export class CallRecorder {
  private dest: MediaStreamAudioDestinationNode | null = null
  private taps: AudioNode[] = []
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private ext = 'webm'

  get active(): boolean {
    return !!this.recorder && this.recorder.state !== 'inactive'
  }

  /** Begin recording the given tap nodes. Throws 'rec-unavailable' when
   *  MediaRecorder is missing or supports nothing. */
  start(ctx: AudioContext, taps: AudioNode[]): void {
    if (this.active) return
    const pick = pickMime()
    if (!pick) throw new Error('rec-unavailable')
    this.stopGraph()
    this.ext = pick.ext
    this.chunks = []

    const dest = ctx.createMediaStreamDestination()
    const live = taps.filter(Boolean)
    for (const t of live) {
      try {
        t.connect(dest)
      } catch {
        /* a dead node just skips the mix */
      }
    }
    this.dest = dest
    this.taps = live

    const rec = new MediaRecorder(dest.stream, { mimeType: pick.mimeType })
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data)
    }
    rec.start(1000)
    this.recorder = rec
  }

  /** Fold a tap that appeared after recording began (a peer joined the call
   *  mid-recording) into the running mix. */
  addTap(node: AudioNode): void {
    if (!this.dest || !this.active) return
    try {
      node.connect(this.dest)
      this.taps.push(node)
    } catch {
      /* dead node: skip */
    }
  }

  /** Stop and resolve the finished recording (null when nothing was
   *  captured). Always disconnects the taps from the mix destination. */
  async stop(): Promise<{ blob: Blob; ext: string } | null> {
    const rec = this.recorder
    if (!rec || rec.state === 'inactive') {
      this.stopGraph()
      return null
    }
    const done = new Promise<void>((resolve) => {
      rec.onstop = () => resolve()
      // safety: if onstop never fires (a bug elsewhere), resolve anyway
      setTimeout(resolve, 2000)
    })
    try {
      rec.stop()
    } catch {
      /* already stopped */
    }
    await done
    this.recorder = null
    this.stopGraph()
    if (this.chunks.length === 0) return null
    const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' })
    this.chunks = []
    if (blob.size === 0) return null
    return { blob, ext: this.ext }
  }

  /** Disconnect taps without touching the recorder (internal cleanup). */
  private stopGraph(): void {
    if (this.dest) {
      for (const t of this.taps) {
        try {
          t.disconnect(this.dest)
        } catch {
          /* already disconnected */
        }
      }
    }
    this.dest = null
    this.taps = []
  }
}

/** Hand the finished recording to the browser as a file download. */
export function downloadRecording(blob: Blob, ext: string): string {
  const url = URL.createObjectURL(blob)
  const d = new Date()
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('') + '-' + [String(d.getHours()).padStart(2, '0'), String(d.getMinutes()).padStart(2, '0')].join('')
  const name = `hyperchat-recording-${stamp}.${ext}`
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // let the download grab the blob before revoking
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return name
}

/** globalThis factory: survives Fast Refresh module re-evaluation. */
const G = globalThis as unknown as { __hyperionCallRecorderFactory?: () => CallRecorder }
G.__hyperionCallRecorderFactory ??= () => new CallRecorder()
export const makeCallRecorder = G.__hyperionCallRecorderFactory
