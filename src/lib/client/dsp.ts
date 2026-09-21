'use client'

import { audioPrefs } from './audio-prefs'
import { resumeAudioContext } from './audio-play'

/**
 * MicDsp: the real noise / echo / level system for the mic.
 *
 * The browser's built-in processing (echoCancellation / noiseSuppression /
 * autoGainControl constraints) stays on at capture - that is the hardware
 * AEC. On top of it, the outbound mic now rides a WebAudio chain instead of
 * going out raw:
 *
 *   mic -> highpass (85 Hz, kills rumble & hum)
 *       -> compressor (gentle leveling, backs up AGC)
 *       -> gate gain  (the noise gate + echo suppressor, below)
 *       -> MediaStreamAudioDestination  (the track that goes to the peers)
 *
 * The gate closes when the pre-gate RMS sits under the sensitivity pref for
 * longer than the hold window (hysteresis: it opens at `sensitivity`, closes
 * at 60% of it, so it never chatters on a trailing word). The echo
 * suppressor is the half-duplex fallback for when hardware AEC fails
 * (speakers, odd device pairs): while remote audio is loud on my output AND
 * my own level stays far under it, the gate stays forced shut - that's my
 * own voice coming back, not speech.
 *
 * The engine keeps metering the RAW mic (pre-gate), so your input meter
 * still moves when the gate is closed - exactly like Discord: the meter
 * shows what the mic hears, the gate decides what leaves.
 */

/** Gate behavior constants, tuned for speech. */
const GATE_HOLD_MS = 260
const GATE_ATTACK_TC = 0.004
const GATE_RELEASE_TC = 0.05
const GATE_CLOSE_RATIO = 0.6
/** Echo suppression: my RMS must stay under this fraction of the remote
 *  level (and the remote level above ECHO_REMOTE_MIN) for the suppressor
 *  to engage; two consecutive ticks (~80ms) confirm it. */
const ECHO_LOCAL_RATIO = 0.35
const ECHO_REMOTE_MIN = 0.05
const ECHO_CONFIRM_TICKS = 2

/** master level for soundboard clips: loud enough to land, never painful */
const SOUND_LEVEL = 0.9

export class MicDsp {
  private ctx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private highpass: BiquadFilterNode | null = null
  private compressor: DynamicsCompressorNode | null = null
  private gateGain: GainNode | null = null
  private dest: MediaStreamAudioDestinationNode | null = null
  /** pre-gate metering (what the mic actually hears) */
  private meter: AnalyserNode | null = null
  private meterData: Uint8Array<ArrayBuffer> | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  private gateOpen = true
  private lastOpenAt = 0
  private echoTicks = 0
  private remoteLevel = 0
  private stopped = false

  /** Build the chain for a freshly captured mic stream. The AudioContext is
   *  the engine's own (one context for mic + playback, resumed by callers). */
  start(raw: MediaStream, ctx: AudioContext): void {
    this.stop()
    this.stopped = false
    this.ctx = ctx
    resumeAudioContext(ctx)

    const source = ctx.createMediaStreamSource(raw)
    const highpass = ctx.createBiquadFilter()
    highpass.type = 'highpass'
    highpass.frequency.value = 85
    highpass.Q.value = 0.71

    const compressor = ctx.createDynamicsCompressor()
    compressor.threshold.value = -26
    compressor.knee.value = 12
    compressor.ratio.value = 3
    compressor.attack.value = 0.004
    compressor.release.value = 0.25

    const gateGain = ctx.createGain()
    gateGain.gain.value = 1

    const dest = ctx.createMediaStreamDestination()

    // pre-gate meter: hangs off the compressor output, before the gate, so
    // the UI meter reflects true input even while gated shut
    const meter = ctx.createAnalyser()
    meter.fftSize = 1024
    meter.smoothingTimeConstant = 0.5

    source.connect(highpass)
    highpass.connect(compressor)
    compressor.connect(meter)
    compressor.connect(gateGain)
    gateGain.connect(dest)

    this.source = source
    this.highpass = highpass
    this.compressor = compressor
    this.gateGain = gateGain
    this.dest = dest
    this.meter = meter
    this.meterData = new Uint8Array(meter.fftSize)
    this.gateOpen = true
    this.lastOpenAt = performance.now()
    this.echoTicks = 0

    this.timer = setInterval(() => this.tick(), 40)
  }

  /** The processed track to send to peers. Null if never started or failed. */
  getOutboundTrack(): MediaStreamTrack | null {
    return this.dest?.stream.getAudioTracks()[0] ?? null
  }

  /** Tap for the call recorder: the post-processor, pre-gate mix point (the
   *  recorder wants your voice even at gate-release tails - actually this
   *  taps what leaves, gate included, matching what others hear). */
  getTapNode(): AudioNode | null {
    return this.gateGain
  }

  /** The engine pushes the loudest remote output level (~10Hz) here; drives
   *  the half-duplex echo suppressor. */
  setRemoteLevel(level: number): void {
    this.remoteLevel = level
  }

  /** Soundboard clip: a decoded AudioBuffer mixed straight into the outbound
   *  track, bypassing the gate (a sound always goes out, even in silence) and
   *  monitored on the local output so the sender hears what they pressed.
   *  No-op before start() / after stop(). */
  playSoundBuffer(buffer: AudioBuffer): void {
    if (!this.ctx || !this.dest || this.stopped) return
    const t = this.ctx.currentTime
    const master = this.ctx.createGain()
    master.gain.value = SOUND_LEVEL
    for (const out of [this.dest, this.ctx.destination]) {
      try {
        master.connect(out)
      } catch {
        /* a dead output node (teardown racing the click): the rest still play */
      }
    }
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.connect(master)
    src.onended = () => {
      try {
        master.disconnect()
      } catch {
        /* already gone */
      }
    }
    src.start(t)
  }

  get active(): boolean {
    return !!this.dest && !this.stopped
  }

  private tick(): void {
    if (!this.gateGain || !this.meter || !this.meterData || !this.ctx) return
    const rms = this.rms(this.meter, this.meterData)
    const now = performance.now()
    const openAt = audioPrefs.sensitivity
    const closeAt = openAt * GATE_CLOSE_RATIO

    // speech detection with hysteresis
    if (rms > openAt) {
      this.gateOpen = true
      this.lastOpenAt = now
    } else if (this.gateOpen && rms < closeAt && now - this.lastOpenAt > GATE_HOLD_MS) {
      this.gateOpen = false
    }

    // echo suppressor: remote loud + me far quieter = my own echo coming
    // back; needs ECHO_CONFIRM_TICKS consecutive ticks to engage so speech
    // onsets never clip
    const echoSuspect = this.remoteLevel > ECHO_REMOTE_MIN && rms < this.remoteLevel * ECHO_LOCAL_RATIO
    if (echoSuspect) this.echoTicks++
    else this.echoTicks = 0
    const suppressed = this.echoTicks >= ECHO_CONFIRM_TICKS

    const target = this.gateOpen && !suppressed ? 1 : 0
    const tc = target > (this.gateGain.gain.value ?? 0) ? GATE_ATTACK_TC : GATE_RELEASE_TC
    try {
      this.gateGain.gain.setTargetAtTime(target, this.ctx.currentTime, tc)
    } catch {
      this.gateGain.gain.value = target
    }
  }

  private rms(analyser: AnalyserNode, data: Uint8Array<ArrayBuffer>): number {
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    return Math.sqrt(sum / data.length)
  }

  /** Tear the chain down and stop the loop. Safe to call twice. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    try {
      this.source?.disconnect()
      this.highpass?.disconnect()
      this.compressor?.disconnect()
      this.meter?.disconnect()
      this.gateGain?.disconnect()
    } catch {
      /* nodes already gone */
    }
    this.source = null
    this.highpass = null
    this.compressor = null
    this.gateGain = null
    this.meter = null
    this.meterData = null
    // the destination node keeps the track alive until GC; stopping the raw
    // stream upstream ends the audio anyway. Just drop the reference.
    this.dest = null
    this.stopped = true
  }
}

/** globalThis home so Fast Refresh module swaps reuse one constructor set. */
const G = globalThis as unknown as { __hyperionMicDspFactory?: () => MicDsp }
G.__hyperionMicDspFactory ??= () => new MicDsp()
export const makeMicDsp = G.__hyperionMicDspFactory
