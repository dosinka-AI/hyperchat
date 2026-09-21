'use client'

import { tryPlayAudio, forgetAudio, resumeAudioContext } from './audio-play'
import { loadLevelPrefs, saveLevelPrefs, clampVolumePercent, readLevel, type LevelPrefs } from './levels'
import { pttPrefs, onPttPrefsChanged, PTT_RELEASE_ALL } from './ptt-prefs'
import {
  audioPrefs,
  micAudioConstraints,
  micConstraintsKey,
  onAudioPrefsChanged,
  applyOutputSink,
  applySinkToContext,
} from './audio-prefs'
import { cameraVideoConstraints, onCallPrefsChanged } from './call-prefs'
import { makeMicDsp, type MicDsp } from './dsp'
import { makeCallRecorder, downloadRecording, type CallRecorder } from './recorder'
import { ICE_SERVERS } from './ice'

/** CallEngine: the WebRTC mesh for 1:1 and group calls in conversations.
 *  A plain singleton like VoiceEngine — the store owns the UI state, this
 *  owns media. Audio always; camera optional; screenshare swaps onto the
 *  video sender via replaceTrack so a stopped share can never freeze the
 *  receiver's last frame (the media flags from the sidecar are the
 *  authoritative off-switch; receivers detach video surfaces on them).
 *
 *  It imports neither the store nor the socket: the socket module injects
 *  the emit function, the store injects the local user id. */

export type CallPeerProfile = {
  userId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  avatarColor: string
  muted: boolean
  deafened: boolean
  video: boolean
  screen: boolean
}

type CallSignalData =
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit }

export type { CallSignalData }

type RemotePeer = {
  userId: string
  pc: RTCPeerConnection
  stream: MediaStream
  audioEl: HTMLAudioElement
  /** WebAudio playback chain: source -> gain -> analyser -> destination.
   *  Riding playback through the gain node is what makes 0-200% per-user
   *  volume possible (an <audio> element caps at 100%); the element stays
   *  attached-but-muted as a fallback when WebAudio cannot run. The
   *  analyser doubles as speaking detection for the call tiles. */
  srcNode: MediaStreamAudioSourceNode | null
  gainNode: GainNode | null
  analyser: AnalyserNode | null
  /** 0..2 - this person's stored listening volume */
  volume: number
  /** local per-person silence (their mute state lives in the sidecar) */
  localMuted: boolean
  /** false when the WebAudio graph failed -> element fallback drives output */
  webaudioOk: boolean
  makingOffer: boolean
  polite: boolean
  iceRestarted: boolean
  /** the sender carrying my outbound MIC to this peer (kept by identity:
   *  once whisper routing replaces its track with null, sender.track no
   *  longer identifies it). The screen-sound sender is separate. */
  micSender: RTCRtpSender | null
  /** the sender carrying the remote-bound screen-share SOUND (a second
   *  audio m-line, separate from the mic sender); null while not sharing
   *  with sound. Tracked by identity so mic restarts never hijack it. */
  screenAudioSender: RTCRtpSender | null
  /** polite peers suppress their INITIAL offer so both sides never race
   *  offers into a glare - a mid-flight rollback can leave Chrome's ICE
   *  gathering dead (zero candidates, the connection sits at "new" forever:
   *  a call that looks connected and carries no audio). Renegotiations
   *  (camera / screenshare changes) always offer regardless of role. */
  awaitingInitialOffer: boolean
  // trickle-ICE candidates that arrived before the remote description:
  // addIceCandidate throws without one, so they park here until the SDP
  // lands (this queue is why calls used to connect but carry no audio -
  // early candidates were silently dropped)
  pendingCandidates: RTCIceCandidateInit[]
  /** screen-share sound from this peer: its own element + gain chain. The
   *  second audio track on the wire (the first is their mic) routes here. */
  screenAudioTrack: MediaStreamTrack | null
  screenAudioEl: HTMLAudioElement | null
  screenSrcNode: MediaStreamAudioSourceNode | null
  screenGainNode: GainNode | null
}

type PeerListener = (peers: Map<string, RemotePeer>) => void

/** Full media/PTT state broadcast by the call engine (see getMediaState):
 * `transmitting` is the composite mic-open flag consumers should render. */
export type CallMediaState = {
  muted: boolean
  deafened: boolean
  cameraOn: boolean
  screenOn: boolean
  pttEnabled: boolean
  pttActive: boolean
  transmitting: boolean
  recording: boolean
}
export type CallMediaListener = (state: CallMediaState) => void
type ActivityListener = (userId: string, speaking: boolean, volume: number) => void

/** Live connection quality for the call, sampled from every peer's
 *  nominated ICE candidate pair (~every 2s). rtt is the worst peer's
 *  round-trip in milliseconds; quality buckets it for the UI. */
export type CallStats = {
  rtt: number | null
  quality: 'good' | 'fair' | 'poor' | 'unknown'
}
type StatsListener = (stats: CallStats) => void

const STANDALONE =
  typeof window !== 'undefined' && !!(window as unknown as { HYPERCHAT_STANDALONE?: boolean }).HYPERCHAT_STANDALONE

/** Screenshare frame budget: the capture asks for up to 60fps and the
 *  video sender's encoding cap matches, so shares run at the display's
 *  full smoothness instead of the legacy 30 (see tuneVideoSender). */
const SCREEN_SHARE_FPS = 60

export class CallEngine {
  private emitFn: ((event: string, payload: unknown) => void) | null = null
  private peerListeners = new Set<PeerListener>()
  private mediaListeners = new Set<CallMediaListener>()
  private activityListeners = new Set<ActivityListener>()
  private statsListeners = new Set<StatsListener>()
  /** per-person listening levels, shared with the voice engine (one storage
   *  key: the volume you set for someone in a voice channel follows them
   *  into your calls with them) */
  private levels: LevelPrefs = loadLevelPrefs()
  private ctxGestureArmed = false

  private callId: string | null = null
  private conversationId: string | null = null
  private meId: string | null = null

  private micStream: MediaStream | null = null
  private camStream: MediaStream | null = null
  private screenStream: MediaStream | null = null
  private remotes = new Map<string, RemotePeer>()
  /** the outbound mic rides this processing chain (noise gate, leveler,
   *  echo suppressor) instead of going out raw */
  private dsp: MicDsp | null = null
  /** the live call recording (mixed taps into one file) */
  private recorder: CallRecorder | null = null
  private recording = false

  /** WebAudio graph for remote playback + level meters (one context for the
   *  whole call; every peer gets its own source/gain/analyser chain) */
  private audioContext: AudioContext | null = null
  private localAnalyser: AnalyserNode | null = null
  private localData: Uint8Array<ArrayBuffer> | null = null
  private loop: ReturnType<typeof setInterval> | null = null
  /** connection-quality sampler (RTT from getStats, every 2s) */
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private lastStats: CallStats = { rtt: null, quality: 'unknown' }
  /** cached media state (stable identity between changes for hooks) */
  private mediaSnapshot: CallMediaState = {
    muted: false,
    deafened: false,
    cameraOn: false,
    screenOn: false,
    pttEnabled: false,
    pttActive: false,
    transmitting: true,
    recording: false,
  }

  private muted = false
  private deafened = false
  private cameraOn = false
  private screenOn = false

  // push-to-talk: same shared pref as voice rooms (one preference, both
  // surfaces); `muted` remains the hard mute and always wins over the key
  private pttActive = false
  private lastBroadcastMute = false

  /** what the live mic stream was acquired with (device + processing flags);
   * a change while in a call triggers a live re-acquire + replaceTrack */
  private liveMicKey: string | null = null
  private micRestarting = false
  /** guards the live camera swap so a pref burst can't double-acquire */
  private cameraRestarting = false
  /** mic whisper routing: while set, my outbound mic rides ONLY this peer's
   *  connection - every other peer's mic sender drops its track (the m-line
   *  stays alive, see setPeerMicTrack) and peers joining mid-whisper never
   *  get one. Receiving is untouched: I still hear everyone. */
  private whisperPeerId: string | null = null

  constructor() {
    onPttPrefsChanged(() => {
      this.pttActive = false
      this.applyMicEnable()
      this.syncMuteBroadcast()
      this.fireMedia()
    })
    onAudioPrefsChanged(() => this.applyAudioPrefs())
    // a camera pref change while live re-acquires the camera (the mic path
    // has its own watcher through audio prefs)
    onCallPrefsChanged(() => {
      if (this.callId && this.cameraOn && !this.cameraRestarting) void this.restartCamera()
    })
  }

  /** React to any audio pref change while in a call: re-route output
   * instantly, and swap the mic source when the acquisition constraints
   * changed. Sensitivity needs no work - rms() reads the pref each tick. */
  private applyAudioPrefs(): void {
    applySinkToContext(this.audioContext)
    for (const r of this.remotes.values()) applyOutputSink(r.audioEl)
    if (this.callId && this.micStream && !this.micRestarting && micConstraintsKey() !== this.liveMicKey) {
      void this.restartMic()
    }
  }

  /** Live mic swap (same flow as the voice engine): fresh getUserMedia under
   * the new constraints, replaceTrack into every peer's audio sender, stop
   * the old tracks, rebuild the local meter, re-apply mute/PTT. Camera and
   * screen senders are untouched. Failure keeps the current mic. */
  private async restartMic(): Promise<void> {
    if (!this.micStream || this.micRestarting) return
    this.micRestarting = true
    const old = this.micStream
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ audio: micAudioConstraints() })
      if (!fresh.getAudioTracks().length) {
        for (const t of fresh.getTracks()) t.stop()
        return
      }
      const track = fresh.getAudioTracks()[0]
      const outbound = this.dsp?.getOutboundTrack() ?? track
      for (const r of this.remotes.values()) {
        // only the mic sender: the screen-audio sender (when a share runs
        // with sound) keeps its own track
        for (const sender of r.pc.getSenders()) {
          if (sender.track?.kind === 'audio' && sender !== r.screenAudioSender) {
            void sender.replaceTrack(outbound).catch(() => {})
          }
        }
      }
      this.micStream = fresh
      this.liveMicKey = micConstraintsKey()
      for (const t of old.getTracks()) t.stop()
      this.applyMicEnable()
      this.setupLocalAudio()
      // rebuild the processing chain on the fresh stream (peers now get the
      // new outbound track via the replaceTrack above)
      if (this.audioContext) {
        this.dsp?.stop()
        this.dsp = makeMicDsp()
        this.dsp.start(fresh, this.audioContext)
        const nextOut = this.dsp.getOutboundTrack()
        if (nextOut) {
          for (const r of this.remotes.values()) {
            for (const sender of r.pc.getSenders()) {
              if (sender.track?.kind === 'audio' && sender !== r.screenAudioSender) {
                void sender.replaceTrack(nextOut).catch(() => {})
              }
            }
          }
        }
      }
      // whisper routing survives a mic swap: peers outside the private
      // line go back to a null track (the loop above only touched senders
      // that still carried one)
      if (this.whisperPeerId !== null) {
        for (const r of this.remotes.values()) {
          this.setPeerMicTrack(r, r.userId === this.whisperPeerId ? this.currentOutboundTrack() : null)
        }
      }
    } catch {
      // device vanished or denied: keep the current mic and its key
    } finally {
      this.micRestarting = false
    }
  }

  /** Live camera swap (pref-driven): fresh getUserMedia under the new
   *  constraints, replaceTrack into every peer's video sender, stop the old
   *  tracks. Mic, screen and negotiation are untouched. Failure keeps the
   *  current camera. */
  private async restartCamera(): Promise<void> {
    if (!this.camStream || this.cameraRestarting) return
    this.cameraRestarting = true
    const old = this.camStream
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: cameraVideoConstraints() })
      if (!fresh.getVideoTracks().length) {
        for (const t of fresh.getTracks()) t.stop()
        return
      }
      for (const r of this.remotes.values()) {
        // screen share rides the same sender: only swap when the screen is
        // NOT the live source, so a device change can't hijack a share
        if (!this.screenOn) this.replaceVideoTrack(r.pc, fresh)
      }
      this.camStream = fresh
      for (const t of old.getTracks()) t.stop()
    } catch {
      // device vanished or denied: keep the current camera
    } finally {
      this.cameraRestarting = false
      this.fireMedia()
    }
  }

  setEmitter(fn: (event: string, payload: unknown) => void): void {
    this.emitFn = fn
  }

  /** Live speaking/volume observations (~10Hz): userId may be me (the local
   *  mic meter) or a remote peer. Components subscribe per tile. */
  onActivity(fn: ActivityListener): () => void {
    this.activityListeners.add(fn)
    return () => this.activityListeners.delete(fn)
  }

  onPeers(fn: PeerListener): () => void {
    this.peerListeners.add(fn)
    fn(this.remotes)
    return () => this.peerListeners.delete(fn)
  }

  onMedia(fn: CallMediaListener): () => void {
    this.mediaListeners.add(fn)
    fn(this.getMediaState())
    return () => this.mediaListeners.delete(fn)
  }

  /** Live connection-quality samples while a call runs. */
  onStats(fn: StatsListener): () => void {
    this.statsListeners.add(fn)
    fn(this.lastStats)
    return () => this.statsListeners.delete(fn)
  }

  getCallStats(): CallStats {
    return this.lastStats
  }

  getMediaState(): CallMediaState {
    return this.mediaSnapshot
  }

  /** Rebuild + cache the media state object (stable identity between
   *  changes, so useSyncExternalStore consumers bail correctly), then fan
   *  it out. Every mutation of the underlying fields funnels through here. */
  private fireMedia(): void {
    this.mediaSnapshot = {
      muted: this.muted,
      deafened: this.deafened,
      cameraOn: this.cameraOn,
      screenOn: this.screenOn,
      pttEnabled: pttPrefs.enabled,
      pttActive: this.pttActive,
      transmitting: !this.muted && (!pttPrefs.enabled || this.pttActive),
      recording: this.recording,
    }
    for (const fn of this.mediaListeners) fn(this.mediaSnapshot)
  }

  /** Effective mic-open state: hard mute wins, push-to-talk gates the rest. */
  private applyMicEnable(): void {
    const enabled = !this.muted && (!pttPrefs.enabled || this.pttActive)
    if (this.micStream) {
      for (const track of this.micStream.getAudioTracks()) track.enabled = enabled
    }
  }

  /** Broadcast the composite mute flag for this call (drives the remote
   *  muted badges) - only on actual changes, so key tapping stays quiet. */
  private syncMuteBroadcast(): void {
    const flag = this.muted || (pttPrefs.enabled && !this.pttActive)
    if (flag !== this.lastBroadcastMute) {
      this.lastBroadcastMute = flag
      this.emit('call:mute', { callId: this.callId, muted: flag })
    }
  }

  /** Hold-to-talk key edge from the router in ptt.ts. */
  handlePttKey(code: string, down: boolean): void {
    if (!pttPrefs.enabled || !this.callId) return
    const mine = code === pttPrefs.key
    if (down && mine && !this.pttActive) {
      this.pttActive = true
      this.applyMicEnable()
      this.syncMuteBroadcast()
      this.fireMedia()
    } else if (!down && (mine || code === PTT_RELEASE_ALL) && this.pttActive) {
      this.pttActive = false
      this.applyMicEnable()
      this.syncMuteBroadcast()
      this.fireMedia()
    }
  }

  getPeerStream(userId: string): MediaStream | null {
    return this.remotes.get(userId)?.stream ?? null
  }

  /** The local camera or screen stream for the picture-in-picture preview
   *  (screen wins while sharing — it is what others see). */
  getLocalPreviewStream(): MediaStream | null {
    if (this.screenOn && this.screenStream) return this.screenStream
    if (this.cameraOn && this.camStream) return this.camStream
    return null
  }

  get callActive(): boolean {
    return !!this.callId
  }

  /** Set one person's listening volume for this call, 0..200 percent.
   *  Applies live to the gain node (or the fallback element) and persists —
   *  shared with voice-channel levels. */
  setRemoteVolume(userId: string, percent: number): void {
    const clamped = clampVolumePercent(percent)
    this.levels.vol[userId] = clamped
    saveLevelPrefs(this.levels)
    const r = this.remotes.get(userId)
    if (r) {
      r.volume = clamped / 100
      this.applyOutputLevel(r)
    }
  }

  /** Locally silence one person in this call without anyone else noticing. */
  setRemoteLocalMute(userId: string, muted: boolean): void {
    if (muted) {
      if (!this.levels.mute.includes(userId)) this.levels.mute.push(userId)
    } else {
      this.levels.mute = this.levels.mute.filter((id) => id !== userId)
    }
    saveLevelPrefs(this.levels)
    const r = this.remotes.get(userId)
    if (r) {
      r.localMuted = muted
      this.applyOutputLevel(r)
    }
  }

  /** This person's listening level for UI initialization. */
  getLevelState(userId: string): { volume: number; localMuted: boolean } {
    return readLevel(this.levels, userId)
  }

  /** Re-register with the realtime service after a socket (re)connect: the
   *  sidecar dropped this participant when the old socket died, which killed
   * SDP/ICE relay for every peer - the call stays on screen but no audio
   * flows. call:accept re-adds us (and re-broadcasts call:state so every
   * peer re-meshes). No-op when no call is active or the call died
   * server-side (the accept is then ignored). */
  rejoinAfterReconnect(): void {
    if (!this.callId || !this.meId) return
    this.emit('call:accept', { callId: this.callId })
    // media flags survive on the engine; re-assert them so the refreshed
    // participant row reflects camera/screen truth
    if (this.cameraOn) this.emit('call:media-state', { callId: this.callId, video: true })
    if (this.screenOn) this.emit('call:media-state', { callId: this.callId, screen: true })
  }

  private emit(event: string, payload: unknown): void {
    this.emitFn?.(event, payload)
  }

  private firePeers(): void {
    for (const fn of this.peerListeners) fn(this.remotes)
  }

  private fireActivity(userId: string, speaking: boolean, volume: number): void {
    this.activityFires++
    this.lastActivity = { userId, speaking, volume }
    for (const fn of this.activityListeners) fn(userId, speaking, volume)
  }

  /** QA instrumentation: how many activity events fired + the last one. */
  activityFires = 0
  lastActivity: { userId: string; speaking: boolean; volume: number } | null = null

  private isPolite(otherId: string): boolean {
    return (this.meId ?? '') < otherId
  }

  /** Acquire the mic and join the call. `withVideo` also opens the camera
   *  before joining. `accept: true` (callee path) emits call:accept — the
   *  caller is already registered server-side by the store's call:start.
   *  Throws 'mic-denied' / 'cam-denied' style errors so the store can
   *  toast without joining. */
  async join(
    callId: string,
    conversationId: string,
    meId: string,
    opts?: { withVideo?: boolean; accept?: boolean }
  ): Promise<void> {
    if (STANDALONE) throw new Error('call-unavailable')

    let mic: MediaStream
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: micAudioConstraints() })
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      throw new Error(name === 'NotAllowedError' || name === 'NotFoundError' ? 'mic-denied' : 'mic-failed')
    }

    this.callId = callId
    this.conversationId = conversationId
    this.meId = meId
    this.micStream = mic
    this.liveMicKey = micConstraintsKey()
    this.muted = false
    this.deafened = false
    this.pttActive = false
    this.lastBroadcastMute = false
    // fresh call: no whisper line carried over
    this.whisperPeerId = null
    this.applyMicEnable()
    this.setupLocalAudio()
    this.startLoop()
    // the outbound mic rides the DSP chain (noise gate + leveler + echo
    // suppressor); the raw stream keeps driving the local meter
    if (this.audioContext) {
      this.dsp = makeMicDsp()
      this.dsp.start(mic, this.audioContext)
    }

    if (opts?.withVideo) {
      try {
        const cam = await navigator.mediaDevices.getUserMedia({
          video: cameraVideoConstraints(),
        })
        this.camStream = cam
        this.cameraOn = true
      } catch {
        this.cameraOn = false
        this.camStream = null
        // camera failure is not fatal: the call proceeds as audio
      }
    }

    if (opts?.accept) {
      this.emit('call:accept', { callId })
    }
    if (this.cameraOn) this.emit('call:media-state', { callId, video: true })
    this.fireMedia()
    this.firePeers()
  }

  /** Turn the camera on or off. Negotiation flows through the single video
   *  sender per peer (added when the camera first appears). */
  async setCamera(on: boolean): Promise<void> {
    if (on === this.cameraOn) return
    if (on) {
      try {
        const cam = await navigator.mediaDevices.getUserMedia({
          video: cameraVideoConstraints(),
        })
        this.camStream = cam
        this.cameraOn = true
        for (const r of this.remotes.values()) this.attachVideoTo(r.pc, cam)
      } catch {
        throw new Error('cam-denied')
      }
    } else {
      this.cameraOn = false
      if (this.camStream) {
        for (const track of this.camStream.getTracks()) track.stop()
        this.camStream = null
      }
      // keep the m-line alive with a null replacement when no screen runs;
      // receivers detach on the media flag instead of freezing
      for (const r of this.remotes.values()) this.replaceVideoTrack(r.pc, this.screenOn ? this.screenStream : null)
    }
    this.emit('call:media-state', { callId: this.callId, video: this.cameraOn })
    this.fireMedia()
  }

  /** Start or stop sharing the screen. The screen track replaces whatever
   *  the video sender currently carries (camera when both run); stopping a
   *  share swaps back to the camera when it's on, else removes the track —
   *  and the media-state flag tells receivers to drop the surface. */
  async setScreen(on: boolean): Promise<void> {
    if (on === this.screenOn) return
    if (on) {
      let screen: MediaStream
      try {
        screen = await navigator.mediaDevices.getDisplayMedia({
          // 60fps streaming: ask for the display's full frame rate (capped
          // at 60) with a 1080p ideal — the sender tuning below keeps the
          // frames flowing even when bandwidth forces resolution down
          video: {
            frameRate: { ideal: SCREEN_SHARE_FPS, max: SCREEN_SHARE_FPS },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          // system / tab sound rides along when the picker offers it (the
          // user ticks "share audio"); processing stays off shared sound
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        })
      } catch {
        throw new Error('screen-cancelled')
      }
      // 'motion' tells the encoder this track favors framerate over
      // resolution — critical for staying smooth at 60fps under pressure
      const screenTrack = screen.getVideoTracks()[0]
      if (screenTrack) screenTrack.contentHint = 'motion'
      this.screenStream = screen
      this.screenOn = true
      for (const r of this.remotes.values()) {
        this.replaceVideoTrack(r.pc, screen)
        this.attachScreenAudioTo(r, screen)
      }
      // once-per-share runtime proof for QA / devtools (each sender tuned)
      console.debug('[call] screen sender: 60fps motion')
      // local echo of the share ending (user clicked the browser bar)
      for (const track of screen.getTracks()) {
        track.addEventListener('ended', () => {
          void this.setScreen(false)
        })
      }
    } else {
      this.screenOn = false
      if (this.screenStream) {
        for (const track of this.screenStream.getTracks()) track.stop()
        this.screenStream = null
      }
      for (const r of this.remotes.values()) {
        if (this.cameraOn && this.camStream) this.replaceVideoTrack(r.pc, this.camStream)
        else this.replaceVideoTrack(r.pc, null)
        this.detachScreenAudio(r)
      }
    }
    this.emit('call:media-state', { callId: this.callId, screen: this.screenOn })
    this.fireMedia()
  }

  /** Give the share's sound its own m-line per peer: the mic keeps its
   *  sender, the screen-audio track gets a second one (receivers route the
   *  second audio track to the screen-sound chain). No-op for a silent
   *  share (no audio track in the picker's offering). */
  private attachScreenAudioTo(r: RemotePeer, screen: MediaStream): void {
    const track = screen.getAudioTracks()[0]
    if (!track) return
    if (r.screenAudioSender) {
      void r.screenAudioSender.replaceTrack(track).catch(() => {})
    } else {
      r.screenAudioSender = r.pc.addTrack(track, screen)
    }
  }

  /** Retire the screen-sound m-line (the share stopped or never had sound).
   *  The negotiated m-line stays alive with a null track. */
  private detachScreenAudio(r: RemotePeer): void {
    if (!r.screenAudioSender) return
    void r.screenAudioSender.replaceTrack(null).catch(() => {})
  }

  toggleMute(): boolean {
    this.muted = !this.muted
    this.applyMicEnable()
    this.syncMuteBroadcast()
    this.fireMedia()
    return this.muted
  }

  toggleDeafen(): boolean {
    this.deafened = !this.deafened
    // both playback paths react (gain node when WebAudio runs, element otherwise)
    for (const r of this.remotes.values()) this.applyOutputLevel(r)
    this.emit('call:deafen', { callId: this.callId, deafened: this.deafened })
    this.fireMedia()
    return this.deafened
  }

  /** Whisper routing: while a target is set, my mic goes ONLY to them (null
   *  restores everyone). The store owns the decision + tells the target
   *  through the sidecar; this only moves the local tracks. */
  setWhisperPeer(targetUserId: string | null): void {
    if (this.whisperPeerId === targetUserId) return
    this.whisperPeerId = targetUserId
    for (const r of this.remotes.values()) {
      this.setPeerMicTrack(r, this.whisperPeerId === null || r.userId === this.whisperPeerId ? this.currentOutboundTrack() : null)
    }
  }

  /** The track my mic should currently ride outbound: the DSP-processed
   *  chain's output when live, else the raw capture track. */
  private currentOutboundTrack(): MediaStreamTrack | null {
    return this.dsp?.getOutboundTrack() ?? this.micStream?.getAudioTracks()[0] ?? null
  }

  /** Point one peer's mic sender at a track; null stops sending my mic to
   *  them WITHOUT tearing down the negotiated m-line (the same trick
   *  detachScreenAudio uses), so restoring is a plain replaceTrack away. */
  private setPeerMicTrack(r: RemotePeer, track: MediaStreamTrack | null): void {
    if (r.micSender) {
      if (r.micSender.track !== track) void r.micSender.replaceTrack(track).catch(() => {})
      return
    }
    if (track && this.micStream) r.micSender = r.pc.addTrack(track, this.micStream)
  }

  /** Reconcile peers with the sidecar's participant list (from call:state). */
  onParticipants(participants: CallPeerProfile[]): void {
    if (!this.callId || !this.meId) return
    const ids = new Set(participants.map((p) => p.userId).filter((id) => id !== this.meId))
    for (const id of ids) this.ensurePeer(id)
    for (const id of Array.from(this.remotes.keys())) {
      if (!ids.has(id)) this.dropPeer(id)
    }
  }

  /** Authoritative media flags per remote: when both video and screen are
   *  off, the remote video surface detaches — this is the stop-share fix.
   *  When one is on, the receiver attaches whatever video track exists. */
  onMediaFlags(userId: string, video: boolean, screen: boolean): void {
    const r = this.remotes.get(userId)
    if (!r) return
    const hasVideoTrack = r.stream.getVideoTracks().length > 0
    const shouldShow = (video || screen) && hasVideoTrack
    const audioOnly = !video && !screen
    if (audioOnly) {
      // detach video so the last frame never freezes on screen
      r.stream.getVideoTracks().forEach((t) => r.stream.removeTrack(t))
    } else if (shouldShow && !hasVideoTrack) {
      // the track may arrive slightly after the flag; nothing to do yet,
      // ontrack will add it
    }
    this.firePeers()
  }

  handleSignal(msg: { from?: string; callId?: string; data?: CallSignalData }): void {
    if (!msg?.from || msg.from === this.meId || !msg.data) return
    // a signal for a different call (a stale tab of the same account still
    // holds an engine from an older session) must never touch this mesh
    if (msg.callId && this.callId && msg.callId !== this.callId) return
    const data = msg.data
    if (data.type === 'offer') void this.handleOffer(msg.from, data.sdp)
    else if (data.type === 'answer') void this.handleAnswer(msg.from, data.sdp)
    else if (data.type === 'ice') void this.handleIce(msg.from, data.candidate)
  }

  /** The call ended for me: stop all media and every peer. */
  teardown(): void {
    // an in-flight recording gets its file out before the audio graph dies
    if (this.recording) void this.stopRecording()
    this.stopLoop()
    this.dsp?.stop()
    this.dsp = null
    for (const id of Array.from(this.remotes.keys())) this.dropPeer(id)
    if (this.micStream) for (const track of this.micStream.getTracks()) track.stop()
    if (this.camStream) for (const track of this.camStream.getTracks()) track.stop()
    if (this.screenStream) for (const track of this.screenStream.getTracks()) track.stop()
    this.micStream = null
    this.camStream = null
    this.screenStream = null
    this.liveMicKey = null
    if (this.audioContext) {
      void this.audioContext.close().catch(() => {})
    }
    this.audioContext = null
    this.localAnalyser = null
    this.localData = null
    this.callId = null
    this.conversationId = null
    this.meId = null
    this.muted = false
    this.deafened = false
    this.cameraOn = false
    this.screenOn = false
    this.pttActive = false
    this.lastBroadcastMute = false
    this.recording = false
    // the call's whisper routing dies with it
    this.whisperPeerId = null
    this.fireMedia()
    this.firePeers()
  }

  // ---- call recording ----

  /** Start recording the call's mix (my mic + every remote voice + share
   *  sound) into one file. Throws 'rec-unavailable' when MediaRecorder
   *  can't run; the store toasts. The call:recording broadcast carries the
   *  flag to every participant (warning sounds + REC badges ride it). */
  startRecording(): void {
    if (!this.callId || !this.audioContext || this.recording) return
    const taps: AudioNode[] = []
    const micTap = this.dsp?.getTapNode()
    if (micTap) taps.push(micTap)
    for (const r of this.remotes.values()) {
      if (r.gainNode) taps.push(r.gainNode)
      if (r.screenGainNode) taps.push(r.screenGainNode)
    }
    const rec = makeCallRecorder()
    rec.start(this.audioContext, taps)
    this.recorder = rec
    this.recording = true
    this.emit('call:recording', { callId: this.callId, recording: true })
    this.fireMedia()
  }

  /** Stop the recording and hand the file to the browser. Returns the
   *  downloaded filename (null when nothing was captured). */
  async stopRecording(): Promise<string | null> {
    if (!this.recording) return null
    this.recording = false
    if (this.callId) this.emit('call:recording', { callId: this.callId, recording: false })
    this.fireMedia()
    const rec = this.recorder
    this.recorder = null
    const out = rec ? await rec.stop() : null
    if (!out) return null
    return downloadRecording(out.blob, out.ext)
  }

  /** A peer's playback chain appeared mid-recording: fold it into the mix. */
  tapIntoRecording(node: AudioNode | null): void {
    if (!this.recording || !node || !this.recorder) return
    this.recorder.addTap(node)
  }

  private async handleOffer(from: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    let r = this.ensurePeer(from)
    const offerCollision = r.makingOffer || r.pc.signalingState !== 'stable'
    if (offerCollision && !r.polite) return
    if (offerCollision && r.polite) {
      // true glare: rebuild the peer clean instead of a mid-flight rollback
      // (Chrome's ICE gathering can die on rollback - zero candidates ever)
      const parked = r.pendingCandidates
      this.dropPeer(from)
      r = this.ensurePeer(from)
      r.pendingCandidates = parked
      r.awaitingInitialOffer = false
    }
    r.awaitingInitialOffer = false
    try {
      await r.pc.setRemoteDescription(sdp)
    } catch {
      // Chrome refuses certain renegotiation offers on an established pc
      // ("RTP extension ID reassignment not supported ... collision on an
      // active mid") when the two sides generated offers independently.
      // Rebuilding the peer clean and applying the offer there negotiates
      // the same media without the unhandled rejection.
      const parked = r.pendingCandidates
      this.dropPeer(from)
      r = this.ensurePeer(from)
      r.pendingCandidates = parked
      r.awaitingInitialOffer = false
      try {
        await r.pc.setRemoteDescription(sdp)
      } catch {
        return // irrecoverable sdp: the designated-offerer path re-negotiates
      }
    }
    await this.drainCandidates(r)
    const answer = await r.pc.createAnswer()
    await r.pc.setLocalDescription(answer)
    if (r.pc.localDescription) {
      this.emit('call:signal', { callId: this.callId, to: from, data: { type: 'answer', sdp: r.pc.localDescription.toJSON() } })
    }
  }

  private async handleAnswer(from: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    const r = this.ensurePeer(from)
    if (r.pc.signalingState === 'have-local-offer') {
      await r.pc.setRemoteDescription(sdp)
      await this.drainCandidates(r)
    }
  }

  private async handleIce(from: string, candidate: RTCIceCandidateInit): Promise<void> {
    const r = this.ensurePeer(from)
    if (!r.pc.remoteDescription) {
      // candidates regularly win the race against the SDP that would make
      // them addable; dropping them here is what used to kill the media
      r.pendingCandidates.push(candidate)
      return
    }
    try {
      await r.pc.addIceCandidate(candidate)
    } catch {
      /* stale candidates are harmless */
    }
  }

  /** Feed every buffered candidate to the now-described connection. */
  private async drainCandidates(r: RemotePeer): Promise<void> {
    while (r.pendingCandidates.length > 0) {
      const candidate = r.pendingCandidates.shift()
      if (!candidate) continue
      try {
        await r.pc.addIceCandidate(candidate)
      } catch {
        // stale after a rollback or restart: the next candidates apply
      }
    }
  }

  private ensurePeer(userId: string): RemotePeer {
    const existing = this.remotes.get(userId)
    if (existing) return existing

    // shared ICE list: dual STUN by default, plus a TURN relay when the
    // deployment sets the NEXT_PUBLIC_TURN_* env vars (see lib/client/ice.ts)
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const stream = new MediaStream()
    const audioEl = new Audio()
    audioEl.autoplay = true
    audioEl.muted = this.deafened
    applyOutputSink(audioEl)

    const r: RemotePeer = {
      userId,
      pc,
      stream,
      audioEl,
      srcNode: null,
      gainNode: null,
      analyser: null,
      volume: readLevel(this.levels, userId).volume / 100,
      localMuted: this.levels.mute.includes(userId),
      webaudioOk: false,
      makingOffer: false,
      polite: this.isPolite(userId),
      iceRestarted: false,
      awaitingInitialOffer: this.isPolite(userId),
      pendingCandidates: [],
      micSender: null,
      screenAudioSender: null,
      screenAudioTrack: null,
      screenAudioEl: null,
      screenSrcNode: null,
      screenGainNode: null,
    }
    this.remotes.set(userId, r)

    if (this.micStream) {
      // the DSP outbound track when the chain is live (gate / leveler /
      // echo suppression applied); raw tracks otherwise
      const outbound = this.dsp?.getOutboundTrack()
      if (outbound) {
        r.micSender = pc.addTrack(outbound, this.micStream)
      } else {
        for (const track of this.micStream.getAudioTracks()) {
          const sender = pc.addTrack(track, this.micStream)
          if (!r.micSender) r.micSender = sender
        }
      }
      // whisper routing: a peer that joins mid-whisper never hears my mic
      // (the m-line still negotiates; the track simply stays null)
      if (this.whisperPeerId !== null && userId !== this.whisperPeerId) this.setPeerMicTrack(r, null)
    }
    if (this.camStream && this.cameraOn) {
      for (const track of this.camStream.getVideoTracks()) pc.addTrack(track, this.camStream)
    } else if (this.screenStream && this.screenOn) {
      // a peer created mid-share gets the screen on its video m-line with
      // the full 60fps maintain-framerate policy
      for (const track of this.screenStream.getVideoTracks()) {
        this.tuneVideoSender(pc.addTrack(track, this.screenStream), true)
      }
    }
    if (this.screenStream && this.screenOn) {
      // a peer created mid-share also gets the share's sound m-line
      const screenAudio = this.screenStream.getAudioTracks()[0]
      if (screenAudio) r.screenAudioSender = pc.addTrack(screenAudio, this.screenStream)
    }

    pc.onnegotiationneeded = () => {
      if (r.awaitingInitialOffer) {
        // designated-offerer rule: the impolite (larger-id) side initiates;
        // swallowing this event keeps initial offers unilateral
        r.awaitingInitialOffer = false
        return
      }
      void (async () => {
        r.makingOffer = true
        try {
          await pc.setLocalDescription()
          if (pc.localDescription) {
            this.emit('call:signal', { callId: this.callId, to: userId, data: { type: 'offer', sdp: pc.localDescription.toJSON() } })
          }
        } finally {
          r.makingOffer = false
        }
      })()
    }

    // designated-offerer-dead fallback: if the initiator never sends its
    // offer, answer the deadlock by offering ourselves after a grace period
    if (r.awaitingInitialOffer) {
      setTimeout(() => {
        const cur = this.remotes.get(userId)
        if (cur !== r || r.pc.remoteDescription) return
        r.awaitingInitialOffer = false
        void (async () => {
          r.makingOffer = true
          try {
            await r.pc.setLocalDescription()
            if (r.pc.localDescription) {
              this.emit('call:signal', { callId: this.callId, to: userId, data: { type: 'offer', sdp: r.pc.localDescription.toJSON() } })
            }
          } finally {
            r.makingOffer = false
          }
        })()
      }, 3500)
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.emit('call:signal', { callId: this.callId, to: userId, data: { type: 'ice', candidate: e.candidate.toJSON() } })
      }
    }

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' && !r.iceRestarted) {
        r.iceRestarted = true
        void pc.restartIce()
      } else if (pc.iceConnectionState === 'failed' && r.iceRestarted) {
        // restart didn't save it: drop the peer so the next call:state
        // broadcast re-creates it with a fresh negotiation
        this.dropPeer(userId)
      }
    }

    pc.ontrack = (e) => {
      if (e.track.kind === 'audio') {
        const existing = r.stream.getAudioTracks()
        if (existing.length > 0 && !existing.includes(e.track)) {
          // the SECOND audio track on the wire is this peer's screen-share
          // sound: it gets its own element + gain chain instead of the mic
          // path (the mic keeps r.stream and the per-peer analyser)
          this.wireScreenAudio(r, e.track)
        } else if (!existing.includes(e.track)) {
          r.stream.addTrack(e.track)
          // re-attach a FRESH stream object: Chrome is unreliable about picking
          // up tracks added to an already-attached stream, and this element was
          // attached while the stream was still empty
          r.audioEl.srcObject = new MediaStream(r.stream.getAudioTracks())
          tryPlayAudio(r.audioEl)
          this.wireRemoteAudio(r)
          this.applyOutputLevel(r)
        }
      } else {
        // keep exactly one video track live at a time (replaceTrack flow)
        const current = r.stream.getVideoTracks()
        for (const t of current) {
          if (t !== e.track) r.stream.removeTrack(t)
        }
        if (!r.stream.getVideoTracks().includes(e.track)) r.stream.addTrack(e.track)
        // a remotely-stopped track must not linger as a frozen frame
        e.track.addEventListener('ended', () => {
          r.stream.removeTrack(e.track)
          this.firePeers()
        })
        e.track.addEventListener('mute', () => {
          /* mute alone doesn't drop the surface; the media flag does */
        })
      }
      this.firePeers()
    }

    this.firePeers()
    return r
  }

  /** Add (or re-add) the current camera tracks to a peer's connection.
   *  The sender policy resets to camera defaults (a camera taking the
   *  m-line back from a share must not keep screen tuning). */
  private attachVideoTo(pc: RTCPeerConnection, cam: MediaStream): void {
    const track = cam.getVideoTracks()[0]
    if (!track) return
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
    if (sender) {
      void sender.replaceTrack(track)
      this.tuneVideoSender(sender, false)
    } else {
      this.tuneVideoSender(pc.addTrack(track, cam), false)
    }
  }

  /** Swap the video sender's track; null removes it (negotiated removal —
   *  receivers also drop the surface from the media flag). Sender tuning
   *  follows the source: the screen stream gets 60fps maintain-framerate,
   * anything else restores camera defaults. */
  private replaceVideoTrack(pc: RTCPeerConnection, source: MediaStream | null): void {
    const track = source?.getVideoTracks()[0] ?? null
    const screen = source !== null && source === this.screenStream
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
    if (sender) {
      void sender.replaceTrack(track)
      this.tuneVideoSender(sender, screen)
    } else if (track) {
      this.tuneVideoSender(pc.addTrack(track, source!), screen)
    }
  }

  /** Sender-side policy for the single video m-line each peer gets. A
   *  screenshare must degrade by shedding RESOLUTION, never frames: under
   *  bandwidth pressure 'maintain-framerate' (plus the 'motion' hint on
   *  the track itself) keeps the share smooth at up to SCREEN_SHARE_FPS
   *  while the picture softens, which is the right trade for a screen.
   *  Anything else on the wire (camera, or nothing) restores the browser
   *  defaults — the camera pipeline keeps its own behavior untouched.
   *
   *  Feature detection: Firefox and Safari ship no degradationPreference
   *  (the 'in' check skips cleanly there), and Firefox's
   *  RTCRtpEncodingParameters has no maxFramerate member — WebIDL ignores
   *  unrecognized dictionary members, so the write is a harmless no-op
   *  there and a real cap in Chrome/Safari. setParameters rejections
   *  (mid-negotiation, torn-down pc) swallow: the share still runs on
   *  browser-default tuning. */
  private tuneVideoSender(sender: RTCRtpSender, screen: boolean): void {
    let params: RTCRtpSendParameters
    try {
      params = sender.getParameters()
    } catch {
      return
    }
    if (screen) {
      if ('degradationPreference' in params) params.degradationPreference = 'maintain-framerate'
      if (!Array.isArray(params.encodings)) params.encodings = []
      if (params.encodings.length === 0) params.encodings.push({})
      for (const enc of params.encodings) enc.maxFramerate = SCREEN_SHARE_FPS
    } else {
      if ('degradationPreference' in params) params.degradationPreference = 'balanced'
      for (const enc of params.encodings ?? []) enc.maxFramerate = undefined
    }
    void sender.setParameters(params).catch(() => {
      /* stale transactionId or an un-negotiated m-line: harmless */
    })
  }

  private dropPeer(userId: string): void {
    const r = this.remotes.get(userId)
    if (!r) return
    r.pc.onicecandidate = null
    r.pc.onnegotiationneeded = null
    r.pc.ontrack = null
    r.pc.oniceconnectionstatechange = null
    r.pc.close()
    // tear the WebAudio chain down before the element so no stray sample
    // keeps playing through the destination
    try {
      r.srcNode?.disconnect()
      r.gainNode?.disconnect()
      r.analyser?.disconnect()
    } catch {
      /* nodes already gone */
    }
    r.srcNode = null
    r.gainNode = null
    r.analyser = null
    this.teardownScreenAudio(r)
    forgetAudio(r.audioEl)
    r.audioEl.pause()
    r.audioEl.srcObject = null
    r.audioEl.remove()
    this.remotes.delete(userId)
    this.firePeers()
  }

  /** Build (or rebuild) this peer's WebAudio chain: source -> gain ->
   *  analyser -> destination. Playback rides the gain node so per-user
   *  volume can reach 200% and local mute/deafen cut cleanly; the analyser
   *  drives the speaking meters. Anything failing here flips the peer to
   *  the plain <audio> element fallback. The graph binds to the tracks
   *  present at creation, so it waits for a live audio track (ontrack). */
  private wireRemoteAudio(r: RemotePeer): void {
    if (r.stream.getAudioTracks().length === 0) return
    if (!this.audioContext) return
    const ctx = this.audioContext

    if (!r.srcNode || !r.gainNode || !r.analyser) {
      try {
        r.srcNode?.disconnect()
        r.analyser?.disconnect()
        const source = ctx.createMediaStreamSource(r.stream)
        const gain = ctx.createGain()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 2048
        analyser.smoothingTimeConstant = 0.6
        source.connect(gain)
        gain.connect(analyser)
        analyser.connect(ctx.destination)
        r.srcNode = source
        r.gainNode = gain
        r.analyser = analyser
        r.webaudioOk = true
      } catch {
        // WebAudio is unavailable or the stream rejected: the element (kept
        // attached and playing by ontrack) takes over as the output
        r.webaudioOk = false
      }
    }
    resumeAudioContext(ctx)
    this.armContextGestureResume()
    this.applyOutputLevel(r)
    // a peer whose playback chain just appeared joins an ongoing recording
    this.tapIntoRecording(r.gainNode)
  }

  /** Compute this peer's effective output level and push it to whichever
   *  playback path is live: gain node when WebAudio runs, else the element
   *  (which caps at 100% and uses muted for the silence cases). The
   *  screen-share sound chain follows the same volume / deafen / local
   *  silence as their voice. */
  private applyOutputLevel(r: RemotePeer): void {
    const silent = this.deafened || r.localMuted
    if (r.webaudioOk && r.gainNode) {
      const target = silent ? 0 : r.volume
      try {
        r.gainNode.gain.setTargetAtTime(target, r.gainNode.context.currentTime, 0.02)
      } catch {
        r.gainNode.gain.value = target
      }
      // keep the fallback element aligned in case WebAudio dies later
      r.audioEl.muted = true
      r.audioEl.volume = Math.min(1, r.volume)
    } else {
      r.audioEl.muted = silent
      r.audioEl.volume = Math.min(1, r.volume)
    }
    if (r.screenGainNode) {
      const target = silent ? 0 : r.volume
      try {
        r.screenGainNode.gain.setTargetAtTime(target, r.screenGainNode.context.currentTime, 0.02)
      } catch {
        r.screenGainNode.gain.value = target
      }
      if (r.screenAudioEl) r.screenAudioEl.muted = true
    } else if (r.screenAudioEl) {
      r.screenAudioEl.muted = silent
      r.screenAudioEl.volume = Math.min(1, r.volume)
    }
  }

  /** A context created outside a user gesture can sit suspended, which would
   *  silence every WebAudio output. One page-level listener resumes it on
   *  the first interaction; re-armed per call, removed once running. */
  private armContextGestureResume(): void {
    if (this.ctxGestureArmed || typeof window === 'undefined') return
    this.ctxGestureArmed = true
    const resume = () => {
      const ctx = this.audioContext
      if (!ctx) {
        window.removeEventListener('pointerdown', resume)
        window.removeEventListener('keydown', resume)
        this.ctxGestureArmed = false
        return
      }
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
      if (ctx.state === 'running') {
        window.removeEventListener('pointerdown', resume)
        window.removeEventListener('keydown', resume)
        this.ctxGestureArmed = false
      }
    }
    window.addEventListener('pointerdown', resume, { passive: true })
    window.addEventListener('keydown', resume)
  }

  /** Build (or rebuild) this peer's screen-sound chain: the second audio
   *  track (their shared system / tab sound) plays through its own element
   *  and gain node at the same listening volume as their voice, silenced
   *  by deafen and per-person local mute exactly like the mic path. */
  private wireScreenAudio(r: RemotePeer, track: MediaStreamTrack): void {
    if (r.screenAudioTrack === track) return
    this.teardownScreenAudio(r)
    r.screenAudioTrack = track
    const el = new Audio()
    el.autoplay = true
    // WebAudio drives the output when it can; the element is the fallback
    // (applyOutputLevel unmutes it only in that case)
    el.muted = true
    applyOutputSink(el)
    el.srcObject = new MediaStream([track])
    tryPlayAudio(el)
    r.screenAudioEl = el
    if (this.audioContext) {
      try {
        const ctx = this.audioContext
        const source = ctx.createMediaStreamSource(el.srcObject as MediaStream)
        const gain = ctx.createGain()
        source.connect(gain)
        gain.connect(ctx.destination)
        r.screenSrcNode = source
        r.screenGainNode = gain
      } catch {
        /* element fallback carries the sound */
      }
    }
    this.applyOutputLevel(r)
    this.tapIntoRecording(r.screenGainNode)
    track.addEventListener('ended', () => {
      if (r.screenAudioTrack !== track) return
      this.teardownScreenAudio(r)
      this.firePeers()
    })
    if (this.audioContext) {
      resumeAudioContext(this.audioContext)
      this.armContextGestureResume()
    }
  }

  /** Stop + forget this peer's INBOUND screen-sound chain (their share
   *  stopped). The outbound sender handle (when I am sharing with sound)
   *  is a different m-line and stays for reuse. */
  private teardownScreenAudio(r: RemotePeer): void {
    r.screenAudioTrack = null
    try {
      r.screenSrcNode?.disconnect()
      r.screenGainNode?.disconnect()
    } catch {
      /* nodes already gone */
    }
    r.screenSrcNode = null
    r.screenGainNode = null
    if (r.screenAudioEl) {
      forgetAudio(r.screenAudioEl)
      r.screenAudioEl.pause()
      r.screenAudioEl.srcObject = null
      r.screenAudioEl.remove()
      r.screenAudioEl = null
    }
  }

  /** Local mic meter: the same AudioContext that plays remotes also feeds
   *  the self speaking indicator. */
  private setupLocalAudio(): void {
    if (!this.micStream) return
    const ctx = (this.audioContext ??= new AudioContext())
    resumeAudioContext(ctx)
    // drop the previous meter (mic restarts rebuild it) so it cannot keep
    // feeding stale silence into fireActivity
    this.localAnalyser?.disconnect()
    const source = ctx.createMediaStreamSource(this.micStream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.6
    source.connect(analyser)
    this.localAnalyser = analyser
    this.localData = new Uint8Array(analyser.fftSize)
  }

  private startLoop(): void {
    if (this.loop) return
    this.loop = setInterval(() => this.measure(), 100)
    if (!this.statsTimer) {
      this.lastStats = { rtt: null, quality: 'unknown' }
      this.statsTimer = setInterval(() => void this.pollStats(), 2000)
    }
  }

  private stopLoop(): void {
    if (this.loop) {
      clearInterval(this.loop)
      this.loop = null
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
    }
    this.lastStats = { rtt: null, quality: 'unknown' }
  }

  private measure(): void {
    let maxRemote = 0
    if (this.meId && this.localAnalyser && this.localData && !this.muted) {
      const m = this.rms(this.localAnalyser, this.localData)
      this.fireActivity(this.meId, m.speaking, m.volume)
    }
    for (const [userId, r] of this.remotes) {
      if (!r.analyser) continue
      const data = new Uint8Array(r.analyser.fftSize)
      const m = this.rms(r.analyser, data)
      if (m.volume > maxRemote) maxRemote = m.volume
      this.fireActivity(userId, m.speaking, m.volume)
    }
    // feed the echo suppressor: how loud the call is on my output right now
    this.dsp?.setRemoteLevel(maxRemote)
  }

  /** Sample the worst nominated candidate-pair RTT across peers and
   *  bucket it for the connection-quality indicator. */
  private async pollStats(): Promise<void> {
    let worst: number | null = null
    for (const r of this.remotes.values()) {
      try {
        const stats = await r.pc.getStats()
        stats.forEach((report) => {
          const any = report as unknown as {
            type: string
            nominated?: boolean
            state?: string
            currentRoundTripTime?: number
          }
          if (
            any.type === 'candidate-pair' &&
            any.nominated === true &&
            any.state === 'succeeded' &&
            typeof any.currentRoundTripTime === 'number'
          ) {
            const rtt = any.currentRoundTripTime * 1000
            if (worst === null || rtt > worst) worst = rtt
          }
        })
      } catch {
        // a closing pc rejects getStats; the next tick retries
      }
    }
    const quality: CallStats['quality'] =
      worst === null ? 'unknown' : worst < 180 ? 'good' : worst < 400 ? 'fair' : 'poor'
    if (worst !== this.lastStats.rtt || quality !== this.lastStats.quality) {
      this.lastStats = { rtt: worst, quality }
    }
    for (const fn of this.statsListeners) fn(this.lastStats)
  }

  private rms(analyser: AnalyserNode, data: Uint8Array<ArrayBuffer>): { speaking: boolean; volume: number } {
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / data.length)
    const volume = Math.max(0, Math.min(1, rms * 8))
    return { speaking: rms > audioPrefs.sensitivity, volume }
  }
}

/** globalThis singleton: same reasoning as the voice engine - the mic, the
 *  camera and every RTCPeerConnection must survive Fast Refresh instead of
 *  leaking into an unreachable orphan module generation. */
const CALL_ENGINE_KEY = '__hyperionCallEngine'
const G = globalThis as unknown as { [CALL_ENGINE_KEY]?: CallEngine }
export const callEngine = (G[CALL_ENGINE_KEY] ??= new CallEngine())

if (typeof window !== 'undefined') {
  ;(window as unknown as { __hyperionCallDebug?: () => unknown }).__hyperionCallDebug = () => {
    const eng = callEngine as unknown as {
      callId: string | null
      remotes: Map<string, RemotePeer>
      getMediaState: () => CallMediaState
      audioContext: AudioContext | null
    }
    return {
      callId: eng.callId,
      audioCtx: eng.audioContext ? eng.audioContext.state : null,
      activityFires: (eng as unknown as { activityFires: number }).activityFires,
      lastActivity: (eng as unknown as { lastActivity: unknown }).lastActivity,
      localAnalyser: (() => {
        const e2 = eng as unknown as { localAnalyser: AnalyserNode | null; localData: Uint8Array | null }
        if (!e2.localAnalyser || !e2.localData) return null
        e2.localAnalyser.getByteTimeDomainData(e2.localData as Uint8Array<ArrayBuffer>)
        let sum = 0
        for (let i = 0; i < e2.localData.length; i++) {
          const v = (e2.localData[i] - 128) / 128
          sum += v * v
        }
        return Math.round(Math.sqrt(sum / e2.localData.length) * 1000) / 1000
      })(),
      ...eng.getMediaState(),
      peers: Array.from(eng.remotes.entries()).map(([id, r]) => ({
        userId: id.slice(-6),
        ice: r.pc.iceConnectionState,
        conn: r.pc.connectionState,
        signaling: r.pc.signalingState,
        remoteAudio: r.stream.getAudioTracks().length,
        screenAudio: r.screenAudioTrack ? true : false,
        remoteVideo: r.stream.getVideoTracks().length,
        audioPaused: r.audioEl.paused,
        audioMuted: r.audioEl.muted,
        webaudio: r.webaudioOk,
        gain: r.gainNode ? r.gainNode.gain.value : null,
        volume: r.volume,
        localMuted: r.localMuted,
        stats: r.pc.getStats(),
      })),
    }
  }
}
