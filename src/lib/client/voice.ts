'use client'

import { tryPlayAudio, forgetAudio, resumeAudioContext } from './audio-play'
import { getSoundBuffer } from './soundboard'
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
import { ICE_SERVERS } from './ice'
import { makeMicDsp, type MicDsp } from './dsp'
import { makeCallRecorder, downloadRecording, type CallRecorder } from './recorder'

/** VoiceEngine: the WebRTC mesh for voice channels. A plain singleton, not
 *  a hook, so the store and components share one media session. It owns the
 *  local mic, the camera and screen-share streams (the screen replaces the
 *  camera on the single video sender while sharing, and its sound rides a
 *  second audio m-line), the RTCPeerConnections, the AudioContext
 *  analysers and the speaking detection; the store owns the UI state it
 *  drives.
 *
 *  It imports neither the store nor the socket: the store passes the current
 *  user id on join, and the socket module injects the emit function once.
 *  Signaling is relay-only — SDP and ICE stay opaque end to end. */

type VoiceSignalData =
  | { type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { type: 'ice'; candidate: RTCIceCandidateInit }

type RemotePeer = {
  userId: string
  pc: RTCPeerConnection
  stream: MediaStream
  audioEl: HTMLAudioElement
  analyser: AnalyserNode | null
  /** WebAudio playback chain: source -> gain -> analyser -> destination.
   *  Riding playback through the gain node is what makes 0-200% per-user
   *  volume possible (an <audio> element caps at 100%); the element stays
   *  attached-but-muted as a fallback when WebAudio cannot run. */
  srcNode: MediaStreamAudioSourceNode | null
  gainNode: GainNode | null
  /** 0..2 - this person's stored listening volume */
  volume: number
  /** local per-person silence (server-side mute state lives in the sidecar) */
  localMuted: boolean
  /** false when the WebAudio graph failed -> element fallback drives output */
  webaudioOk: boolean
  makingOffer: boolean
  polite: boolean
  iceRestarted: boolean
  /** polite peers suppress their INITIAL offer: the lexically-larger id
   *  initiates, so both sides never race offers into a glare. A simultaneous
   *  pair of initial offers forces the polite side into a mid-flight
   * rollback, after which Chrome's ICE gathering can die (zero candidates,
   * connection stuck at "new" forever - the silent-voice bug). Renegotiations
   * (mute/video changes) always offer regardless of role. */
  awaitingInitialOffer: boolean
  // trickle-ICE candidates that arrived before the remote description:
  // addIceCandidate throws without one, so they park here until the SDP
  // lands (this queue is why calls used to connect but carry no audio -
  // early candidates were silently dropped)
  pendingCandidates: RTCIceCandidateInit[]
  /** the sender carrying my outbound MIC to this peer (kept by identity:
   *  once whisper routing replaces its track with null, sender.track no
   *  longer identifies it). The screen-sound sender is separate. */
  micSender: RTCRtpSender | null
  /** the sender carrying the remote-bound screen-share SOUND (a second
   *  audio m-line, separate from the mic sender); null while not sharing
   *  with sound. Tracked by identity so mic restarts never hijack it. */
  screenAudioSender: RTCRtpSender | null
  /** screen-share sound from this peer: its own element + gain chain. The
   *  second audio track on the wire (the first is their mic) routes here. */
  screenAudioTrack: MediaStreamTrack | null
  screenAudioEl: HTMLAudioElement | null
  screenSrcNode: MediaStreamAudioSourceNode | null
  screenGainNode: GainNode | null
}

type ActivityListener = (userId: string, speaking: boolean, volume: number) => void
type StateListener = (state: {
  connected: boolean
  muted: boolean
  deafened: boolean
  unavailable: boolean
  pttEnabled: boolean
  pttActive: boolean
  transmitting: boolean
  recording: boolean
  cameraOn: boolean
  screenOn: boolean
}) => void

const STANDALONE = typeof window !== 'undefined' && !!(window as unknown as { HYPERCHAT_STANDALONE?: boolean }).HYPERCHAT_STANDALONE

/** voice-stage moderation: while the channel's priority speaker transmits,
 *  every OTHER peer's local output ducks to this fraction of their
 *  configured volume, so the crown always cuts through. The crown
 *  themselves, deafen and per-person local silence are never touched. */
const PRIORITY_DUCK_FACTOR = 0.15

/** Screenshare frame budget: the capture asks for up to 60fps and the
 *  video sender's encoding cap matches, so shares run at the display's
 *  full smoothness instead of the legacy 30 (see tuneVideoSender). */
const SCREEN_SHARE_FPS = 60

export class VoiceEngine {
  private emitFn: ((event: string, payload: unknown) => void) | null = null
  private activityListeners = new Set<ActivityListener>()
  private stateListeners = new Set<StateListener>()
  private levels: LevelPrefs = loadLevelPrefs()
  private ctxGestureArmed = false

  private channelId: string | null = null
  private serverId: string | null = null
  private meId: string | null = null
  private sessionId: string | null = null

  private localStream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private localAnalyser: AnalyserNode | null = null
  private localData: Uint8Array<ArrayBuffer> | null = null
  private remotes = new Map<string, RemotePeer>()
  /** outbound mic processing chain: noise gate + leveler + echo suppressor */
  private dsp: MicDsp | null = null
  /** live voice-channel recording (mixed taps into one file) */
  private recorder: CallRecorder | null = null
  private recording = false
  private loop: ReturnType<typeof setInterval> | null = null

  private muted = false
  private deafened = false
  private unavailable = false

  // push-to-talk: shared pref object (see ptt-prefs.ts); while enabled the
  // mic only opens while the key is held. `pttActive` is the physical key
  // state, `muted` stays the user's hard mute and always wins.
  private pttActive = false
  private lastBroadcastMute = false

  /** what the live mic stream was acquired with (device + processing flags);
   * a change while connected triggers a live re-acquire + replaceTrack */
  private liveMicKey: string | null = null
  private micRestarting = false

  /** local camera + screen-share streams. The single video sender per peer
   *  carries whichever is live (screen replaces the camera while sharing);
   *  the screen's sound rides its own second audio m-line per peer. */
  private camStream: MediaStream | null = null
  private screenStream: MediaStream | null = null
  private cameraOn = false
  private screenOn = false
  /** guards the live camera swap so a pref burst can't double-acquire */
  private cameraRestarting = false
  /** re-render ticks for the video stage (peer set / track changes) */
  private peerListeners = new Set<() => void>()
  /** whose screen shares I am WATCHING (opt-in): a share not in this set
   *  keeps its audio silent locally — not watching means not hearing it.
   *  Cleared whenever the channel is left. */
  private screenWatched = new Set<string>()
  /** voice-stage moderation: the channel's priority speaker (from
   *  voice:state, set by the store) and whether they are transmitting right
   *  now (tracked from the speaking meter). While both hold, every OTHER
   *  peer's output ducks (see applyOutputLevel). */
  private priorityUserId: string | null = null
  private prioritySpeaking = false
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
      this.fireState()
    })
    onAudioPrefsChanged(() => this.applyAudioPrefs())
    // a camera pref change while live re-acquires the camera (the mic path
    // has its own watcher through audio prefs)
    onCallPrefsChanged(() => {
      if (this.channelId && this.cameraOn && !this.cameraRestarting) void this.restartCamera()
    })
  }

  /** React to any audio pref change while live: re-route output instantly,
   * and swap the mic source when the acquisition constraints changed (input
   * device or processing toggles). Sensitivity needs no work - rms() reads
   * the pref directly every tick. */
  private applyAudioPrefs(): void {
    applySinkToContext(this.audioContext)
    for (const r of this.remotes.values()) {
      applyOutputSink(r.audioEl)
      if (r.screenAudioEl) applyOutputSink(r.screenAudioEl)
    }
    if (this.channelId && this.localStream && !this.micRestarting && micConstraintsKey() !== this.liveMicKey) {
      void this.restartMic()
    }
  }

  /** Live mic swap: acquire a fresh stream under the new constraints, fold
   * it into every peer's mic sender via replaceTrack (no renegotiation
   * needed - the screen-audio sender keeps its own track), stop the old
   * tracks, rebuild the local analyser, and re-apply the effective mute/PTT
   * state on the new track. Failure keeps the old mic.
   */
  private async restartMic(): Promise<void> {
    if (!this.localStream || this.micRestarting) return
    this.micRestarting = true
    const old = this.localStream
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
      this.localStream = fresh
      this.liveMicKey = micConstraintsKey()
      for (const t of old.getTracks()) t.stop()
      this.applyMicEnable()
      this.setupLocalAudio()
      // rebuild the processing chain on the fresh stream
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
      // the local preview stream swapped identity: tick both listener sets
      this.fireState()
      this.firePeers()
    }
  }

  setEmitter(fn: (event: string, payload: unknown) => void): void {
    this.emitFn = fn
  }

  onActivity(fn: ActivityListener): () => void {
    this.activityListeners.add(fn)
    return () => this.activityListeners.delete(fn)
  }

  onState(fn: StateListener): () => void {
    this.stateListeners.add(fn)
    return () => this.stateListeners.delete(fn)
  }

  /** Subscribe to peer/stream changes: the mesh gaining or losing a peer,
   *  a remote track landing or ending, or media flags flipping all tick
   *  the listeners — the re-render signal for the video stage. */
  onPeers(fn: () => void): () => void {
    this.peerListeners.add(fn)
    fn()
    return () => this.peerListeners.delete(fn)
  }

  getState() {
    return {
      connected: !!this.channelId,
      muted: this.muted,
      deafened: this.deafened,
      unavailable: this.unavailable,
      pttEnabled: pttPrefs.enabled,
      pttActive: this.pttActive,
      transmitting: !this.muted && (!pttPrefs.enabled || this.pttActive),
      recording: this.recording,
      cameraOn: this.cameraOn,
      screenOn: this.screenOn,
    }
  }

  /** Effective mic-open state: hard mute wins, push-to-talk gates the rest. */
  private applyMicEnable(): void {
    const enabled = !this.muted && (!pttPrefs.enabled || this.pttActive)
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) track.enabled = enabled
    }
  }

  /** Broadcast the composite mute flag to the room (drives everyone else's
   *  muted badge on my tile) - only when it actually changes, so PTT key
   * tapping does not spam the socket. */
  private syncMuteBroadcast(): void {
    const flag = this.muted || (pttPrefs.enabled && !this.pttActive)
    if (flag !== this.lastBroadcastMute) {
      this.lastBroadcastMute = flag
      this.emit('voice:mute', { muted: flag })
    }
  }

  /** Hold-to-talk key edge from the router in ptt.ts. */
  handlePttKey(code: string, down: boolean): void {
    if (!pttPrefs.enabled || !this.channelId) return
    const mine = code === pttPrefs.key
    if (down && mine && !this.pttActive) {
      this.pttActive = true
      this.applyMicEnable()
      this.syncMuteBroadcast()
      this.fireState()
    } else if (!down && (mine || code === PTT_RELEASE_ALL) && this.pttActive) {
      this.pttActive = false
      this.applyMicEnable()
      this.syncMuteBroadcast()
      this.fireState()
    }
  }

  /** This peer's inbound media (their mic audio + their live video track)
   *  for the video stage; null when no peer exists. */
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

  /** True while this peer's screen share carries sound (their second audio
   *  m-line). Drives the "sharing sound" chip on their video tile. */
  getPeerScreenAudio(userId: string): boolean {
    return !!this.remotes.get(userId)?.screenAudioTrack
  }

  /** Opt in / out of one peer's screen share. Watching lets the share's
   *  audio through; not watching keeps it silent (the tile itself is the
   *  UI's business — this is the audio half of the click-to-watch model). */
  setScreenWatch(userId: string, watching: boolean): void {
    if (watching) this.screenWatched.add(userId)
    else this.screenWatched.delete(userId)
    const r = this.remotes.get(userId)
    if (r) this.applyOutputLevel(r)
  }

  /** Whether I am currently watching this peer's screen (engine truth for
   *  the UI, e.g. the context menu's watch / stop-watching row). */
  isScreenWatched(userId: string): boolean {
    return this.screenWatched.has(userId)
  }

  /** Voice-stage moderation: the channel's priority speaker (null clears).
   *  The store calls this whenever the crown moves (voice:state); while the
   *  crowned one transmits, every other peer's output ducks. Transmission
   *  tracking resets with the crown and re-arms from the speaking meter. */
  setPriority(userId: string | null): void {
    if (this.priorityUserId === userId) return
    this.priorityUserId = userId
    this.prioritySpeaking = false
    for (const r of this.remotes.values()) this.applyOutputLevel(r)
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
    return this.dsp?.getOutboundTrack() ?? this.localStream?.getAudioTracks()[0] ?? null
  }

  /** Point one peer's mic sender at a track; null stops sending my mic to
   *  them WITHOUT tearing down the negotiated m-line (the same trick
   *  detachScreenAudio uses), so restoring is a plain replaceTrack away. */
  private setPeerMicTrack(r: RemotePeer, track: MediaStreamTrack | null): void {
    if (r.micSender) {
      if (r.micSender.track !== track) void r.micSender.replaceTrack(track).catch(() => {})
      return
    }
    if (track && this.localStream) r.micSender = r.pc.addTrack(track, this.localStream)
  }

  private emit(event: string, payload: unknown): void {
    this.emitFn?.(event, payload)
  }

  private fireState(): void {
    const state = this.getState()
    for (const fn of this.stateListeners) fn(state)
  }

  private fireActivity(userId: string, speaking: boolean, volume: number): void {
    for (const fn of this.activityListeners) fn(userId, speaking, volume)
  }

  private firePeers(): void {
    for (const fn of this.peerListeners) fn()
  }

  private isPolite(otherId: string): boolean {
    // one stable winner per pair: the lexically smaller id is "polite" and
    // rolls back on glare, the larger one re-asserts its offer
    return (this.meId ?? '') < otherId
  }

  /** Re-announce membership after a socket (re)connect or a realtime
   *  service restart. The sidecar drops voice presence the moment a socket
   * dies, so without this the mic stays live while every other participant
   * sees us gone - a ghost state with no audio. Idempotent: only fires when
   * a channel is genuinely active. */
  rejoinAfterReconnect(): void {
    if (!this.channelId || !this.meId || this.unavailable) return
    this.sessionId = Math.random().toString(36).slice(2, 12)
    this.emit('voice:join', {
      channelId: this.channelId,
      serverId: this.serverId ?? '',
      sessionId: this.sessionId,
    })
    // media flags survive on the engine; re-assert them so the refreshed
    // participant row reflects camera/screen truth
    if (this.cameraOn) this.emit('voice:media', { video: true })
    if (this.screenOn) this.emit('voice:media', { screen: true })
  }

  /** Set one person's listening volume, 0..200 percent. Applies live to the
   *  gain node (or the fallback element) and persists across sessions. */
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

  /** Locally silence one person without anyone else being affected. */
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

  /** Current per-person listening levels for UI initialization: volume in
   *  percent (default 100) and the local-mute flag. */
  getLevelState(userId: string): { volume: number; localMuted: boolean } {
    return readLevel(this.levels, userId)
  }

  /** Compute this peer's effective output level and push it to whichever
   *  playback path is live: gain node when WebAudio runs, else the element
   *  (which caps at 100% and uses muted for the silence cases). The
   *  screen-share sound chain follows the same volume / deafen / local
   *  silence as their voice — plus the watch gate: a share I have not
   *  clicked "watch" on stays silent too. */
  private applyOutputLevel(r: RemotePeer): void {
    const silent = this.deafened || r.localMuted
    const screenSilent = silent || !this.screenWatched.has(r.userId)
    // priority-speaker ducking: while the crowned one transmits, every
    // OTHER peer's output drops to a fraction of their configured volume.
    // Deafen and local silence still win outright (silent stays silent),
    // and the crown themselves is never ducked.
    const ducked = this.prioritySpeaking && this.priorityUserId !== null && r.userId !== this.priorityUserId
    const effective = ducked ? r.volume * PRIORITY_DUCK_FACTOR : r.volume
    if (r.webaudioOk && r.gainNode) {
      const target = silent ? 0 : effective
      try {
        r.gainNode.gain.setTargetAtTime(target, r.gainNode.context.currentTime, 0.02)
      } catch {
        r.gainNode.gain.value = target
      }
      // keep the fallback element aligned in case WebAudio dies later
      r.audioEl.muted = true
      r.audioEl.volume = Math.min(1, effective)
    } else {
      r.audioEl.muted = silent
      r.audioEl.volume = Math.min(1, effective)
    }
    if (r.screenGainNode) {
      const target = screenSilent ? 0 : effective
      try {
        r.screenGainNode.gain.setTargetAtTime(target, r.screenGainNode.context.currentTime, 0.02)
      } catch {
        r.screenGainNode.gain.value = target
      }
      if (r.screenAudioEl) r.screenAudioEl.muted = true
    } else if (r.screenAudioEl) {
      r.screenAudioEl.muted = screenSilent
      r.screenAudioEl.volume = Math.min(1, effective)
    }
  }

  /** Request the mic and enter the mesh. Resolves once the local stream is
   *  live and the join event is queued. Throws on mic denial so the caller
   *  can toast and never join. The standalone build has no sidecar, so join
   *  resolves into an 'unavailable' state the UI surfaces inline. */
  async join(channelId: string, serverId: string, meId: string): Promise<void> {
    if (STANDALONE) {
      this.channelId = channelId
      this.serverId = serverId
      this.meId = meId
      this.unavailable = true
      this.fireState()
      return
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: micAudioConstraints() })
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      throw new Error(name === 'NotAllowedError' || name === 'NotFoundError' ? 'mic-denied' : 'mic-failed')
    }

    this.channelId = channelId
    this.serverId = serverId
    this.meId = meId
    this.sessionId = Math.random().toString(36).slice(2, 12)
    this.localStream = stream
    this.liveMicKey = micConstraintsKey()
    this.unavailable = false
    this.pttActive = false
    this.lastBroadcastMute = false
    // fresh room: no crown carried over (voice:state re-seeds it if one
    // is already live in this channel)
    this.priorityUserId = null
    this.prioritySpeaking = false
    // and no whisper line: routing dies with the session
    this.whisperPeerId = null
    this.applyMicEnable()
    this.setupLocalAudio()
    this.startLoop()
    // outbound mic rides the DSP chain; the raw stream feeds the meter
    if (this.audioContext) {
      this.dsp = makeMicDsp()
      this.dsp.start(stream, this.audioContext)
    }

    this.emit('voice:join', { channelId, serverId, sessionId: this.sessionId })
    this.fireState()
    this.firePeers()
  }

  leave(): void {
    if (this.channelId) this.emit('voice:leave', {})
    this.teardownMedia()
    this.channelId = null
    this.serverId = null
    this.sessionId = null
    this.unavailable = false
    this.pttActive = false
    this.screenWatched.clear()
    this.fireState()
  }

  /** Local-only teardown for a takeover: another tab or device of this
   *  account owns the voice presence now, so this session must stop its
   *  mic and peers WITHOUT announcing a leave (the sidecar would route it
   *  at the new owner's row; its ownership guard ignores it, but staying
   *  quiet is cleaner). */
  teardownMediaOnly(): void {
    this.teardownMedia()
    this.channelId = null
    this.serverId = null
    this.sessionId = null
    this.unavailable = false
    this.pttActive = false
    this.screenWatched.clear()
    this.fireState()
  }

  toggleMute(): boolean {
    this.muted = !this.muted
    this.applyMicEnable()
    this.syncMuteBroadcast()
    this.fireState()
    return this.muted
  }

  /** Soundboard clip into the channel mix: fetch + decode once per URL,
   *  then everyone hears it (and so do I). No-op when not connected - the
   *  DSP chain does not exist. Throws on load/codec failure so the store
   *  can toast honestly. */
  async playSound(url: string): Promise<void> {
    const buffer = await getSoundBuffer(url)
    this.dsp?.playSoundBuffer(buffer)
  }

  toggleDeafen(): boolean {
    this.deafened = !this.deafened
    // both playback paths react (gain node when WebAudio runs, element otherwise)
    for (const r of this.remotes.values()) this.applyOutputLevel(r)
    this.emit('voice:deafen', { deafen: this.deafened })
    this.fireState()
    return this.deafened
  }

  /** Turn the camera on or off. Negotiation flows through the single video
   *  sender per peer (added when the camera first appears). Throws
   *  'cam-denied' on acquisition failure so the store can toast without
   *  flipping the toggle. */
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
    this.emit('voice:media', { video: this.cameraOn })
    this.fireState()
  }

  /** Start or stop sharing the screen. The screen track replaces whatever
   *  the video sender currently carries (camera when both run); stopping a
   *  share swaps back to the camera when it's on, else removes the track —
   *  and the voice:media flag tells receivers to drop the surface. Throws
   *  'screen-cancelled' when the picker is dismissed. */
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
      console.debug('[voice] screen sender: 60fps motion')
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
    this.emit('voice:media', { screen: this.screenOn })
    this.fireState()
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

  /** Reconcile the mesh after a 'voice:state' broadcast: create peers for
   *  new arrivals (negotiationneeded fires their offers), drop peers that
   *  left. */
  onRemoteState(participants: { userId: string; sessionId?: string }[]): void {
    if (!this.channelId || !this.meId) return
    const remoteIds = new Set(participants.map((p) => p.userId).filter((id) => id !== this.meId))
    for (const id of remoteIds) this.ensurePeer(id)
    for (const id of Array.from(this.remotes.keys())) {
      if (!remoteIds.has(id)) this.dropPeer(id)
    }
  }

  /** Authoritative media flags per remote (from the sidecar's voice:state
   *  rows): when both video and screen are off, the remote video surface
   *  detaches — this is the stop-share fix. When one is on, the receiver
   *  attaches whatever video track exists. */
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

  /** Relay-only signaling: opaque SDP/ICE from another peer. */
  handleSignal(msg: { from?: string; data?: VoiceSignalData }): void {
    if (!msg?.from || !msg?.data || msg.from === this.meId) return
    const data = msg.data
    if (data.type === 'offer') void this.handleOffer(msg.from, data.sdp)
    else if (data.type === 'answer') void this.handleAnswer(msg.from, data.sdp)
    else if (data.type === 'ice') void this.handleIce(msg.from, data.candidate)
  }

  private async handleOffer(from: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    let r = this.ensurePeer(from)
    const offerCollision = r.makingOffer || r.pc.signalingState !== 'stable'
    if (offerCollision && !r.polite) return
    if (offerCollision && r.polite) {
      // true glare (both sides offering): a mid-flight rollback can leave
      // Chrome's ICE gathering dead, so rebuild the peer clean and negotiate
      // on the incoming offer instead. Parked candidates transfer over.
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
      this.emit('voice:signal', { to: from, data: { type: 'answer', sdp: r.pc.localDescription.toJSON() } })
    }
  }

  private async handleAnswer(from: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    const r = this.ensurePeer(from)
    // an answer only applies while our own offer is pending; a stale answer
    // arriving on a stable pc would throw (call.ts parity)
    if (r.pc.signalingState !== 'have-local-offer') return
    await r.pc.setRemoteDescription(sdp)
    await this.drainCandidates(r)
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
      // a candidate that genuinely no longer applies is harmless
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
      analyser: null,
      srcNode: null,
      gainNode: null,
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

    // add our mic to every peer we open; negotiationneeded sends the offer
    if (this.localStream) {
      // the DSP outbound track when the chain is live; raw otherwise
      const outbound = this.dsp?.getOutboundTrack()
      if (outbound) {
        r.micSender = pc.addTrack(outbound, this.localStream)
      } else {
        for (const track of this.localStream.getTracks()) {
          const sender = pc.addTrack(track, this.localStream)
          if (!r.micSender && track.kind === 'audio') r.micSender = sender
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
        // designated-offerer rule: only the impolite (larger-id) side sends
        // the initial offer. Swallow this one event; renegotiations later
        // in the connection's life still offer normally.
        r.awaitingInitialOffer = false
        return
      }
      void (async () => {
        r.makingOffer = true
        try {
          await pc.setLocalDescription()
          if (pc.localDescription) {
            this.emit('voice:signal', { to: userId, data: { type: 'offer', sdp: pc.localDescription.toJSON() } })
          }
        } finally {
          r.makingOffer = false
        }
      })()
    }

    // designated-offerer-dead fallback: we swallowed our initial offer, but
    // if the other side never sends theirs (lost connection mid-restart),
    // offer ourselves after a grace period so the mesh can never deadlock
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
              this.emit('voice:signal', { to: userId, data: { type: 'offer', sdp: r.pc.localDescription.toJSON() } })
            }
          } finally {
            r.makingOffer = false
          }
        })()
      }, 3500)
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.emit('voice:signal', { to: userId, data: { type: 'ice', candidate: e.candidate.toJSON() } })
      }
    }

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' && !r.iceRestarted) {
        r.iceRestarted = true
        void pc.restartIce()
      } else if (pc.iceConnectionState === 'failed' && r.iceRestarted) {
        // the restart did not save it: drop the peer entirely so the next
        // voice:state broadcast re-creates it with a fresh offer/answer -
        // a dead entry would block re-meshing forever
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

  private wireRemoteAudio(r: RemotePeer): void {
    // the graph binds to the tracks present at creation: wiring while the
    // stream is empty would freeze the meter (and playback) at silence, so
    // it waits for a live audio track
    if (r.stream.getAudioTracks().length === 0) return
    if (!this.audioContext) return
    const ctx = this.audioContext

    // (re)build the chain when it does not exist yet, or when the track set
    // changed (ontrack re-fires): source -> gain -> analyser -> destination.
    // Playback rides the gain node so per-user volume can reach 200% and
    // local mute/deafen cut cleanly; anything failing here flips the peer
    // to the plain <audio> element fallback.
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

  /** A context created outside a user gesture can sit suspended, which would
   *  silence every WebAudio output. One page-level listener resumes it on
   *  the first interaction; re-armed per join, removed once running. */
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

  private dropPeer(userId: string): void {
    const r = this.remotes.get(userId)
    if (!r) return
    r.pc.onicecandidate = null
    r.pc.onnegotiationneeded = null
    r.pc.ontrack = null
    r.pc.oniceconnectionstatechange = null
    r.pc.close()
    // NOTE: screenWatched intent survives a peer drop (the mesh re-wires on
    // reconnect and the watch should survive it; the store clears intent
    // when the sharer stops sharing, leaves, or I stop watching)
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

  private setupLocalAudio(): void {
    if (!this.localStream) return
    const ctx = (this.audioContext ??= new AudioContext())
    resumeAudioContext(ctx)
    // drop the previous meter (mic restarts rebuild it) so it cannot keep
    // feeding stale silence into fireActivity
    this.localAnalyser?.disconnect()
    const source = ctx.createMediaStreamSource(this.localStream)
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
  }

  private stopLoop(): void {
    if (this.loop) {
      clearInterval(this.loop)
      this.loop = null
    }
  }

  private measure(): void {
    let maxRemote = 0
    // the priority speaker's live transmission flag (my own meter when I
    // wear the crown, their analyser otherwise); null while nobody crowned
    let prioritySpeaking: boolean | null = null
    if (this.meId && this.localAnalyser && this.localData) {
      const m = this.rms(this.localAnalyser, this.localData)
      this.fireActivity(this.meId, m.speaking, m.volume)
      if (this.priorityUserId === this.meId) prioritySpeaking = m.speaking
    }
    for (const [userId, r] of this.remotes) {
      if (!r.analyser) continue
      const data = new Uint8Array(r.analyser.fftSize)
      const m = this.rms(r.analyser, data)
      if (m.volume > maxRemote) maxRemote = m.volume
      this.fireActivity(userId, m.speaking, m.volume)
      if (this.priorityUserId === userId) prioritySpeaking = m.speaking
    }
    // priority-speaker ducking: on every speaking transition (either
    // edge) re-level every peer - duck the room while the crown talks,
    // restore when they stop. The crown's own chain is never ducked, so
    // their analyser reading stays the honest transmission signal.
    if (prioritySpeaking !== null && prioritySpeaking !== this.prioritySpeaking) {
      this.prioritySpeaking = prioritySpeaking
      for (const r of this.remotes.values()) this.applyOutputLevel(r)
    }
    // feed the echo suppressor: how loud the channel is on my output now
    this.dsp?.setRemoteLevel(maxRemote)
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

  private teardownMedia(): void {
    // an in-flight recording gets its file out before the graph dies
    if (this.recording) void this.stopRecording()
    this.stopLoop()
    this.dsp?.stop()
    this.dsp = null
    for (const userId of Array.from(this.remotes.keys())) this.dropPeer(userId)
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) track.stop()
    }
    this.localStream = null
    if (this.camStream) {
      for (const track of this.camStream.getTracks()) track.stop()
    }
    this.camStream = null
    if (this.screenStream) {
      for (const track of this.screenStream.getTracks()) track.stop()
    }
    this.screenStream = null
    this.liveMicKey = null
    if (this.audioContext) {
      void this.audioContext.close().catch(() => {})
    }
    this.audioContext = null
    this.localAnalyser = null
    this.localData = null
    this.muted = false
    this.pttActive = false
    this.lastBroadcastMute = false
    this.deafened = false
    this.cameraOn = false
    this.screenOn = false
    this.recording = false
    // the crown (and any live ducking) dies with the session
    this.priorityUserId = null
    this.prioritySpeaking = false
    // so does any whisper routing: nobody's mic stays private past leave
    this.whisperPeerId = null
    this.firePeers()
  }

  // ---- voice-channel recording ----

  /** Start recording this channel's mix (my mic + every remote voice +
   *  share sound) into one file. Throws 'rec-unavailable' when MediaRecorder
   *  can't run. The voice:recording broadcast carries the flag to the whole
   *  channel. */
  startRecording(): void {
    if (!this.channelId || !this.audioContext || this.recording) return
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
    this.emit('voice:recording', { channelId: this.channelId, recording: true })
    this.fireState()
  }

  /** Stop the recording and hand the file to the browser; returns the
   *  downloaded filename (null when nothing was captured). */
  async stopRecording(): Promise<string | null> {
    if (!this.recording) return null
    this.recording = false
    if (this.channelId) this.emit('voice:recording', { channelId: this.channelId, recording: false })
    this.fireState()
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
}

/** The engine instance lives on globalThis: a Fast Refresh re-evaluating
 *  this module must reuse the live engine, or the open microphone and every
 *  RTCPeerConnection leak into an unreachable orphan while the fresh engine
 *  starts empty - voice would silently die until a full page reload. */
const VOICE_ENGINE_KEY = '__hyperionVoiceEngine'
const G = globalThis as unknown as { [VOICE_ENGINE_KEY]?: VoiceEngine }
export const voiceEngine = (G[VOICE_ENGINE_KEY] ??= new VoiceEngine())

if (typeof window !== 'undefined') {
  ;(window as unknown as { __hyperionVoiceDebug?: () => unknown }).__hyperionVoiceDebug = () => {
    const eng = voiceEngine as unknown as {
      channelId: string | null
      remotes: Map<string, RemotePeer>
      getState: () => { connected: boolean; muted: boolean; deafened: boolean; unavailable: boolean }
    }
    const peers = Array.from(eng.remotes.entries()).map(([id, r]) => ({
      userId: id.slice(-6),
      ice: r.pc.iceConnectionState,
      conn: r.pc.connectionState,
      signaling: r.pc.signalingState,
      remoteTracks: r.stream.getAudioTracks().length,
      screenAudio: r.screenAudioTrack ? true : false,
      remoteVideo: r.stream.getVideoTracks().length,
      audioMuted: r.audioEl.muted,
      audioPaused: r.audioEl.paused,
      analyser: !!r.analyser,
      webaudio: r.webaudioOk,
      gain: r.gainNode ? r.gainNode.gain.value : null,
      volume: r.volume,
      localMuted: r.localMuted,
      pendingIce: r.pendingCandidates.length,
    }))
    return { ...eng.getState(), channelId: eng.channelId, peers }
  }
}
