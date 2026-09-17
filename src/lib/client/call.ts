'use client'

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
  makingOffer: boolean
  polite: boolean
  iceRestarted: boolean
}

type PeerListener = (peers: Map<string, RemotePeer>) => void
export type CallMediaListener = (state: {
  muted: boolean
  deafened: boolean
  cameraOn: boolean
  screenOn: boolean
}) => void

const STANDALONE =
  typeof window !== 'undefined' && !!(window as unknown as { HYPERCHAT_STANDALONE?: boolean }).HYPERCHAT_STANDALONE

export class CallEngine {
  private emitFn: ((event: string, payload: unknown) => void) | null = null
  private peerListeners = new Set<PeerListener>()
  private mediaListeners = new Set<CallMediaListener>()

  private callId: string | null = null
  private conversationId: string | null = null
  private meId: string | null = null

  private micStream: MediaStream | null = null
  private camStream: MediaStream | null = null
  private screenStream: MediaStream | null = null
  private remotes = new Map<string, RemotePeer>()

  private muted = false
  private deafened = false
  private cameraOn = false
  private screenOn = false

  setEmitter(fn: (event: string, payload: unknown) => void): void {
    this.emitFn = fn
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

  getMediaState() {
    return { muted: this.muted, deafened: this.deafened, cameraOn: this.cameraOn, screenOn: this.screenOn }
  }

  getPeerStream(userId: string): MediaStream | null {
    return this.remotes.get(userId)?.stream ?? null
  }

  /** Mute/unmute a remote peer's playback (screenshare + mic audio). */
  setPeerAudioMuted(userId: string, muted: boolean): void {
    const r = this.remotes.get(userId)
    if (!r) return
    r.audioEl.muted = muted || this.deafened
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

  private emit(event: string, payload: unknown): void {
    this.emitFn?.(event, payload)
  }

  private firePeers(): void {
    for (const fn of this.peerListeners) fn(this.remotes)
  }

  private fireMedia(): void {
    const state = this.getMediaState()
    for (const fn of this.mediaListeners) fn(state)
  }

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
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      throw new Error(name === 'NotAllowedError' || name === 'NotFoundError' ? 'mic-denied' : 'mic-failed')
    }

    this.callId = callId
    this.conversationId = conversationId
    this.meId = meId
    this.micStream = mic
    this.muted = false
    this.deafened = false

    if (opts?.withVideo) {
      try {
        const cam = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
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
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
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
   *  share swaps back to the camera when it's on, else removes the track.
   *  System/tab audio is requested when the browser allows it. */
  async setScreen(on: boolean): Promise<void> {
    if (on === this.screenOn) return
    if (on) {
      let screen: MediaStream
      try {
        screen = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30 } },
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          } as MediaTrackConstraints,
        })
      } catch {
        throw new Error('screen-cancelled')
      }
      this.screenStream = screen
      this.screenOn = true
      for (const r of this.remotes.values()) {
        this.replaceVideoTrack(r.pc, screen)
        this.attachScreenAudioTo(r.pc, screen)
      }
      // local echo of the share ending (user clicked the browser bar)
      for (const track of screen.getVideoTracks()) {
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
        this.detachScreenAudioFrom(r.pc)
      }
    }
    this.emit('call:media-state', { callId: this.callId, screen: this.screenOn })
    this.fireMedia()
  }

  toggleMute(): boolean {
    this.muted = !this.muted
    if (this.micStream) {
      for (const track of this.micStream.getAudioTracks()) track.enabled = !this.muted
    }
    this.emit('call:mute', { callId: this.callId, muted: this.muted })
    this.fireMedia()
    return this.muted
  }

  toggleDeafen(): boolean {
    this.deafened = !this.deafened
    for (const r of this.remotes.values()) r.audioEl.muted = this.deafened
    this.emit('call:deafen', { callId: this.callId, deafened: this.deafened })
    this.fireMedia()
    return this.deafened
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

  handleSignal(msg: { from?: string; data?: CallSignalData }): void {
    if (!msg?.from || msg.from === this.meId || !msg.data) return
    const data = msg.data
    if (data.type === 'offer') void this.handleOffer(msg.from, data.sdp)
    else if (data.type === 'answer') void this.handleAnswer(msg.from, data.sdp)
    else if (data.type === 'ice') void this.handleIce(msg.from, data.candidate)
  }

  /** The call ended for me: stop all media and every peer. */
  teardown(): void {
    for (const id of Array.from(this.remotes.keys())) this.dropPeer(id)
    if (this.micStream) for (const track of this.micStream.getTracks()) track.stop()
    if (this.camStream) for (const track of this.camStream.getTracks()) track.stop()
    if (this.screenStream) for (const track of this.screenStream.getTracks()) track.stop()
    this.micStream = null
    this.camStream = null
    this.screenStream = null
    this.callId = null
    this.conversationId = null
    this.meId = null
    this.muted = false
    this.deafened = false
    this.cameraOn = false
    this.screenOn = false
    this.fireMedia()
    this.firePeers()
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
      this.emit('call:signal', { callId: this.callId, to: from, data: { type: 'answer', sdp: r.pc.localDescription.toJSON() } })
    }
  }

  private async handleAnswer(from: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    const r = this.ensurePeer(from)
    if (r.pc.signalingState === 'have-local-offer') {
      await r.pc.setRemoteDescription(sdp)
    }
  }

  private async handleIce(from: string, candidate: RTCIceCandidateInit): Promise<void> {
    const r = this.ensurePeer(from)
    try {
      await r.pc.addIceCandidate(candidate)
    } catch {
      /* stale candidates are harmless */
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
      makingOffer: false,
      polite: this.isPolite(userId),
      iceRestarted: false,
    }
    this.remotes.set(userId, r)

    if (this.micStream) {
      for (const track of this.micStream.getAudioTracks()) pc.addTrack(track, this.micStream)
    }
    if (this.camStream && this.cameraOn) {
      for (const track of this.camStream.getVideoTracks()) pc.addTrack(track, this.camStream)
    } else if (this.screenStream && this.screenOn) {
      for (const track of this.screenStream.getVideoTracks()) pc.addTrack(track, this.screenStream)
    }

    pc.onnegotiationneeded = () => {
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

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.emit('call:signal', { callId: this.callId, to: userId, data: { type: 'ice', candidate: e.candidate.toJSON() } })
      }
    }

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed' && !r.iceRestarted) {
        r.iceRestarted = true
        void pc.restartIce()
      }
    }

    pc.ontrack = (e) => {
      if (e.track.kind === 'audio') {
        if (!r.stream.getAudioTracks().includes(e.track)) r.stream.addTrack(e.track)
        r.audioEl.srcObject = new MediaStream(r.stream.getAudioTracks())
        void r.audioEl.play().catch(() => {
          /* autoplay may need a gesture; harmless */
        })
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

  /** Add (or re-add) the current camera tracks to a peer's connection. */
  private attachVideoTo(pc: RTCPeerConnection, cam: MediaStream): void {
    const track = cam.getVideoTracks()[0]
    if (!track) return
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
    if (sender) {
      void sender.replaceTrack(track)
    } else {
      pc.addTrack(track, cam)
    }
  }

  /** Swap the video sender's track; null removes it (negotiated removal.
   *  receivers also drop the surface from the media flag). */
  private replaceVideoTrack(pc: RTCPeerConnection, source: MediaStream | null): void {
    const track = source?.getVideoTracks()[0] ?? null
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
    if (sender) {
      void sender.replaceTrack(track)
    } else if (track) {
      pc.addTrack(track, source!)
    }
  }

  /** Attach system/tab audio from a screenshare alongside the mic track. */
  private attachScreenAudioTo(pc: RTCPeerConnection, screen: MediaStream): void {
    const track = screen.getAudioTracks()[0]
    if (!track) return
    const existing = pc.getSenders().find((s) => s.track && s.track !== this.micStream?.getAudioTracks()[0] && s.track.kind === 'audio')
    if (existing) {
      void existing.replaceTrack(track)
    } else {
      pc.addTrack(track, screen)
    }
  }

  private detachScreenAudioFrom(pc: RTCPeerConnection): void {
    const micTrack = this.micStream?.getAudioTracks()[0] ?? null
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind === 'audio' && sender.track !== micTrack) {
        void sender.replaceTrack(null)
      }
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
    r.audioEl.pause()
    r.audioEl.srcObject = null
    r.audioEl.remove()
    this.remotes.delete(userId)
    this.firePeers()
  }
}

export const callEngine = new CallEngine()
