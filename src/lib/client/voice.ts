'use client'

/** VoiceEngine: the WebRTC mesh for voice channels. A plain singleton, not
 *  a hook, so the store and components share one media session. It owns the
 *  local mic, the RTCPeerConnections, the AudioContext analysers and the
 *  speaking detection; the store owns the UI state it drives.
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
  makingOffer: boolean
  polite: boolean
  iceRestarted: boolean
}

type ActivityListener = (userId: string, speaking: boolean, volume: number) => void
type StateListener = (state: { connected: boolean; muted: boolean; deafened: boolean; unavailable: boolean }) => void

const STANDALONE = typeof window !== 'undefined' && !!(window as unknown as { HYPERCHAT_STANDALONE?: boolean }).HYPERCHAT_STANDALONE

export class VoiceEngine {
  private emitFn: ((event: string, payload: unknown) => void) | null = null
  private activityListeners = new Set<ActivityListener>()
  private stateListeners = new Set<StateListener>()

  private channelId: string | null = null
  private serverId: string | null = null
  private meId: string | null = null
  private sessionId: string | null = null

  private localStream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private localAnalyser: AnalyserNode | null = null
  private localData: Uint8Array<ArrayBuffer> | null = null
  private remotes = new Map<string, RemotePeer>()
  private loop: ReturnType<typeof setInterval> | null = null

  private muted = false
  private deafened = false
  private unavailable = false

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

  getState() {
    return { connected: !!this.channelId, muted: this.muted, deafened: this.deafened, unavailable: this.unavailable }
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

  private isPolite(otherId: string): boolean {
    // one stable winner per pair: the lexically smaller id is "polite" and
    // rolls back on glare, the larger one re-asserts its offer
    return (this.meId ?? '') < otherId
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
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      throw new Error(name === 'NotAllowedError' || name === 'NotFoundError' ? 'mic-denied' : 'mic-failed')
    }

    this.channelId = channelId
    this.serverId = serverId
    this.meId = meId
    this.sessionId = Math.random().toString(36).slice(2, 12)
    this.localStream = stream
    this.unavailable = false
    this.setupLocalAudio()
    this.startLoop()

    this.emit('voice:join', { channelId, serverId, sessionId: this.sessionId })
    this.fireState()
  }

  leave(): void {
    if (this.channelId) this.emit('voice:leave', {})
    this.teardownMedia()
    this.channelId = null
    this.serverId = null
    this.sessionId = null
    this.unavailable = false
    this.fireState()
  }

  toggleMute(): boolean {
    this.muted = !this.muted
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) track.enabled = !this.muted
    }
    this.emit('voice:mute', { muted: this.muted })
    this.fireState()
    return this.muted
  }

  toggleDeafen(): boolean {
    this.deafened = !this.deafened
    for (const r of this.remotes.values()) r.audioEl.muted = this.deafened
    this.emit('voice:deafen', { deafen: this.deafened })
    this.fireState()
    return this.deafened
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

  /** Relay-only signaling: opaque SDP/ICE from another peer. */
  handleSignal(msg: { from?: string; data?: VoiceSignalData }): void {
    if (!msg?.from || !msg?.data || msg.from === this.meId) return
    const data = msg.data
    if (data.type === 'offer') void this.handleOffer(msg.from, data.sdp)
    else if (data.type === 'answer') void this.handleAnswer(msg.from, data.sdp)
    else if (data.type === 'ice') void this.handleIce(msg.from, data.candidate)
  }

  private async handleOffer(from: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    const r = this.ensurePeer(from)
    const offerCollision = r.makingOffer || r.pc.signalingState !== 'stable'
    const ignoreOffer = !r.polite && offerCollision
    if (ignoreOffer) return
    await r.pc.setRemoteDescription(sdp)
    const answer = await r.pc.createAnswer()
    await r.pc.setLocalDescription(answer)
    if (r.pc.localDescription) {
      this.emit('voice:signal', { to: from, data: { type: 'answer', sdp: r.pc.localDescription.toJSON() } })
    }
  }

  private async handleAnswer(from: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    const r = this.ensurePeer(from)
    await r.pc.setRemoteDescription(sdp)
  }

  private async handleIce(from: string, candidate: RTCIceCandidateInit): Promise<void> {
    const r = this.ensurePeer(from)
    try {
      await r.pc.addIceCandidate(candidate)
    } catch {
      // a candidate that no longer applies is harmless
    }
  }

  private ensurePeer(userId: string): RemotePeer {
    const existing = this.remotes.get(userId)
    if (existing) return existing

    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    const stream = new MediaStream()
    const audioEl = new Audio()
    audioEl.autoplay = true
    audioEl.muted = this.deafened

    const r: RemotePeer = {
      userId,
      pc,
      stream,
      audioEl,
      analyser: null,
      makingOffer: false,
      polite: this.isPolite(userId),
      iceRestarted: false,
    }
    this.remotes.set(userId, r)

    // add our mic to every peer we open; negotiationneeded sends the offer
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream)
    }

    pc.onnegotiationneeded = () => {
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

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.emit('voice:signal', { to: userId, data: { type: 'ice', candidate: e.candidate.toJSON() } })
      }
    }

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' && !r.iceRestarted) {
        r.iceRestarted = true
        void pc.restartIce()
      }
    }

    pc.ontrack = (e) => {
      stream.addTrack(e.track)
      this.wireRemoteAudio(r)
    }

    this.wireRemoteAudio(r)
    return r
  }

  private wireRemoteAudio(r: RemotePeer): void {
    if (r.analyser || !this.audioContext) return
    const ctx = this.audioContext
    const source = ctx.createMediaStreamSource(r.stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.6
    source.connect(analyser) // metering only: playback rides the audio element
    r.analyser = analyser
    r.audioEl.srcObject = r.stream
    void r.audioEl.play().catch(() => {
      /* autoplay may be blocked until the next gesture; harmless */
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
    r.audioEl.pause()
    r.audioEl.srcObject = null
    r.audioEl.remove()
    this.remotes.delete(userId)
  }

  private setupLocalAudio(): void {
    if (!this.localStream) return
    const ctx = (this.audioContext ??= new AudioContext())
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
    if (this.meId && this.localAnalyser && this.localData) {
      const m = this.rms(this.localAnalyser, this.localData)
      this.fireActivity(this.meId, m.speaking, m.volume)
    }
    for (const [userId, r] of this.remotes) {
      if (!r.analyser) continue
      const data = new Uint8Array(r.analyser.fftSize)
      const m = this.rms(r.analyser, data)
      this.fireActivity(userId, m.speaking, m.volume)
    }
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
    return { speaking: rms > 0.03, volume }
  }

  private teardownMedia(): void {
    this.stopLoop()
    for (const userId of Array.from(this.remotes.keys())) this.dropPeer(userId)
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) track.stop()
    }
    this.localStream = null
    if (this.audioContext) {
      void this.audioContext.close().catch(() => {})
    }
    this.audioContext = null
    this.localAnalyser = null
    this.localData = null
    this.muted = false
    this.deafened = false
  }
}

export const voiceEngine = new VoiceEngine()
