'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useChatStore } from '@/lib/client/store'
import { sounds } from '@/lib/client/sounds'
import { callEngine } from '@/lib/client/call'
import { Avatar } from './Avatar'
import { openContextMenu } from './ContextMenu'
import {
  Phone,
  PhoneOff,
  Video,
  VideoOff,
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  MonitorUp,
  MonitorX,
  PhoneIncoming,
  VolumeX,
  Send,
  Minimize2,
  Maximize2,
  EyeOff,
  Eye,
  Volume2,
  UserRound,
  ArrowDown,
} from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { colorForName } from '@/lib/client/format'

/** The full call surface: incoming ring (accept / decline / mute-ring + a
 *  quick message), outgoing ring (cancel), voice-channel friend rings, and
 *  the in-call stage (mute, deafen, camera, screenshare with expand/hide,
 *  hangup). Hangup is personal leave: the call keeps running for everyone
 *  still in it. */

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Avatar with arrow + white ring pulse synced to the call ring sound. */
function RingingAvatar({
  name,
  color,
  url,
  serverIconUrl,
  serverName,
}: {
  name: string
  color: string
  url: string | null
  serverIconUrl?: string | null
  serverName?: string | null
}) {
  const [showServer, setShowServer] = useState(!!serverIconUrl)
  useEffect(() => {
    if (!serverIconUrl) return
    setShowServer(true)
    const t = setTimeout(() => setShowServer(false), 1100)
    return () => clearTimeout(t)
  }, [serverIconUrl])

  return (
    <div className="relative flex flex-col items-center gap-2">
      <ArrowDown className="size-5 text-white/90 hc-call-arrow" aria-hidden="true" />
      <div className="relative">
        <span
          className="absolute -inset-2 rounded-full border-2 border-white hc-call-ring pointer-events-none"
          aria-hidden="true"
        />
        <span
          className="absolute -inset-4 rounded-full border border-white/40 hc-call-ring pointer-events-none"
          style={{ animationDelay: '0.15s' }}
          aria-hidden="true"
        />
        {showServer && serverIconUrl ? (
          <img
            src={serverIconUrl}
            alt={serverName ?? 'server'}
            className="size-16 rounded-sm object-cover border border-white/20"
            draggable={false}
          />
        ) : showServer && serverName ? (
          <span
            className="size-16 rounded-sm grid place-items-center text-sm font-bold border border-white/20"
            style={{ background: colorForName(serverName) }}
          >
            {serverName.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase()}
          </span>
        ) : (
          <Avatar name={name} color={color} url={url} size="mx" />
        )}
      </div>
    </div>
  )
}

/** One remote participant's video tile. Media flags from the sidecar decide
 *  whether a video surface is mounted. Screenshares can expand fullscreen,
 *  mute their own audio, or be hidden without leaving the call. */
function RemoteTile({
  userId,
  username,
  displayName,
  avatarUrl,
  avatarColor,
  video,
  screen,
  muted,
  expanded,
  hidden,
  onExpand,
  onHide,
  onContext,
}: {
  userId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  avatarColor: string
  video: boolean
  screen: boolean
  muted: boolean
  expanded: boolean
  hidden: boolean
  onExpand: () => void
  onHide: () => void
  onContext: (e: React.MouseEvent) => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [screenMuted, setScreenMuted] = useState(false)

  useEffect(() => {
    const unsub = callEngine.onPeers(() => {
      setStream(callEngine.getPeerStream(userId))
    })
    return unsub
  }, [userId])

  useEffect(() => {
    if (videoRef.current && stream) {
      if (videoRef.current.srcObject !== stream) videoRef.current.srcObject = stream
      videoRef.current.muted = screenMuted
      void videoRef.current.play().catch(() => {
        /* autoplay retry on next interaction */
      })
    }
  }, [stream, screenMuted])

  const showVideo = !hidden && (video || screen) && stream && stream.getVideoTracks().length > 0

  return (
    <div
      className={cn(
        'relative min-w-0 bg-black rounded-sm overflow-hidden border border-white/10 aspect-video',
        expanded ? 'fixed inset-4 z-[95] aspect-auto' : 'flex-1'
      )}
      onContextMenu={onContext}
    >
      {showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className="size-full object-contain"
          aria-label={`${displayName || username}${screen ? ' screen share' : ' camera'}`}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-3 py-8">
            <Avatar name={username} color={avatarColor} url={avatarUrl} size="mx" />
            <p className="text-sm font-semibold">{displayName || username}</p>
            {hidden && <p className="text-[11px] text-muted-foreground">hidden</p>}
            {screen && !hidden && <p className="text-[11px] text-muted-foreground">starting screen share…</p>}
          </div>
        </div>
      )}
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-sm bg-black/70 text-[11px] font-semibold">
        {muted && <MicOff className="size-3 text-red-400" aria-hidden="true" />}
        {screen && <MonitorUp className="size-3 text-hyper" aria-hidden="true" />}
        <span className="truncate max-w-40">{displayName || username}</span>
      </div>
      {(screen || video) && (
        <div className="absolute top-2 right-2 flex items-center gap-1">
          {screen && (
            <button
              type="button"
              onClick={() => {
                const next = !screenMuted
                setScreenMuted(next)
                callEngine.setPeerAudioMuted(userId, next)
              }}
              className="grid place-items-center size-7 rounded-sm bg-black/70 text-white/80 hover:text-white hover:bg-black transition-colors"
              aria-label={screenMuted ? 'unmute share audio' : 'mute share audio'}
              title={screenMuted ? 'unmute audio' : 'mute audio'}
            >
              {screenMuted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
            </button>
          )}
          <button
            type="button"
            onClick={onHide}
            className="grid place-items-center size-7 rounded-sm bg-black/70 text-white/80 hover:text-white hover:bg-black transition-colors"
            aria-label={hidden ? 'show video' : 'hide video'}
            title={hidden ? 'show' : 'hide'}
          >
            {hidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
          </button>
          <button
            type="button"
            onClick={onExpand}
            className="grid place-items-center size-7 rounded-sm bg-black/70 text-white/80 hover:text-white hover:bg-black transition-colors"
            aria-label={expanded ? 'exit fullscreen' : 'watch larger'}
            title={expanded ? 'exit fullscreen' : 'larger view'}
          >
            {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        </div>
      )}
    </div>
  )
}

export function CallOverlay() {
  const incomingCall = useChatStore((s) => s.incomingCall)
  const incomingVoiceRing = useChatStore((s) => s.incomingVoiceRing)
  const activeCall = useChatStore((s) => s.activeCall)
  const callSelf = useChatStore((s) => s.callSelf)
  const me = useChatStore((s) => s.me)
  const acceptIncomingCall = useChatStore((s) => s.acceptIncomingCall)
  const declineIncomingCall = useChatStore((s) => s.declineIncomingCall)
  const letRingIncomingCall = useChatStore((s) => s.letRingIncomingCall)
  const acceptVoiceRing = useChatStore((s) => s.acceptVoiceRing)
  const declineVoiceRing = useChatStore((s) => s.declineVoiceRing)
  const cancelOutgoingCall = useChatStore((s) => s.cancelOutgoingCall)
  const hangupCall = useChatStore((s) => s.hangupCall)
  const toggleCallMute = useChatStore((s) => s.toggleCallMute)
  const toggleCallDeafen = useChatStore((s) => s.toggleCallDeafen)
  const toggleCallCamera = useChatStore((s) => s.toggleCallCamera)
  const toggleCallScreen = useChatStore((s) => s.toggleCallScreen)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const selectConversation = useChatStore((s) => s.selectConversation)
  const openProfile = useChatStore((s) => s.openProfile)
  const openDM = useChatStore((s) => s.openDM)
  const [mounted, setMounted] = useState(false)
  const [quickMessage, setQuickMessage] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [compact, setCompact] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [hiddenIds, setHiddenIds] = useState<Record<string, boolean>>({})
  const { toast } = useToast()

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!activeCall || activeCall.state !== 'active' || !activeCall.acceptedAt) return
    const tick = () => setElapsed(Date.now() - (activeCall.acceptedAt ?? Date.now()))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [activeCall?.state, activeCall?.acceptedAt, activeCall?.callId])

  useEffect(() => {
    const unsub = callEngine.onMedia((state) => {
      const cur = useChatStore.getState().callSelf
      if (cur.muted !== state.muted || cur.deafened !== state.deafened || cur.cameraOn !== state.cameraOn || cur.screenOn !== state.screenOn) {
        useChatStore.setState({ callSelf: state })
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    if (activeCall) {
      useChatStore.setState({ callSelf: callEngine.getMediaState() })
    }
  }, [activeCall?.callId])

  if (!mounted || (!incomingCall && !incomingVoiceRing && !activeCall)) return null

  const localVideo = callEngine.getMediaState().cameraOn || callEngine.getMediaState().screenOn

  // ---------- voice channel friend ring ----------
  if (incomingVoiceRing && !incomingCall) {
    const from = incomingVoiceRing.from
    return createPortal(
      <div className="fixed inset-0 z-[90] bg-black/85 backdrop-blur-md grid place-items-center p-4 fade-in">
        <div
          role="dialog"
          aria-label={`voice invite from ${from.displayName || from.username}`}
          className="w-[min(24rem,94vw)] rounded-sm border border-white/10 bg-app-sidebar p-6 flex flex-col items-center gap-5 shadow-2xl"
        >
          <RingingAvatar
            name={from.username}
            color={from.avatarColor}
            url={from.avatarUrl}
            serverIconUrl={incomingVoiceRing.serverIconUrl}
            serverName={incomingVoiceRing.serverName}
          />
          <div className="text-center">
            <p className="text-lg font-bold tracking-tight">{from.displayName || from.username}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              ringing you into {incomingVoiceRing.serverName} / {incomingVoiceRing.channelName}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void declineVoiceRing()}
              className="grid place-items-center size-14 rounded-full bg-red-500/90 text-white hover:bg-red-500 transition-colors"
              aria-label="decline voice invite"
              title="decline"
            >
              <PhoneOff className="size-6" />
            </button>
            <button
              type="button"
              onClick={() => void acceptVoiceRing()}
              className="grid place-items-center size-14 rounded-full bg-emerald-500/90 text-white hover:bg-emerald-500 transition-colors"
              aria-label="join voice"
              title="join"
            >
              <Phone className="size-6" />
            </button>
          </div>
        </div>
      </div>,
      document.body
    )
  }

  // ---------- incoming conversation call ----------
  if (incomingCall) {
    const from = incomingCall.from
    const conversation = useChatStore.getState().conversations.find((c) => c.id === incomingCall.conversationId)
    async function sendQuickMessage() {
      const text = quickMessage.trim()
      const target = incomingCall
      if (!text || !target) return
      setQuickMessage('')
      await selectConversation(target.conversationId)
      try {
        await sendMessage({ content: text })
        sounds.play('send')
      } catch {
        toast({ title: 'message failed' })
      }
    }
    return createPortal(
      <div className="fixed inset-0 z-[90] bg-black/85 backdrop-blur-md grid place-items-center p-4 fade-in">
        <div
          role="dialog"
          aria-label={`incoming call from ${from.displayName || from.username}`}
          className="w-[min(24rem,94vw)] rounded-sm border border-white/10 bg-app-sidebar p-6 flex flex-col items-center gap-5 shadow-2xl"
        >
          <RingingAvatar
            name={from.username}
            color={from.avatarColor}
            url={from.avatarUrl}
            serverIconUrl={conversation?.kind === 'GROUP' ? conversation.iconUrl : null}
            serverName={conversation?.kind === 'GROUP' ? conversation.name : null}
          />
          <div className="text-center">
            <p className="text-lg font-bold tracking-tight">{from.displayName || from.username}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              incoming {incomingCall.video ? 'video' : 'voice'} call
              {conversation?.kind === 'GROUP' && conversation.name ? ` in ${conversation.name}` : ''}…
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void declineIncomingCall()}
              className="grid place-items-center size-14 rounded-full bg-red-500/90 text-white hover:bg-red-500 transition-colors"
              aria-label="decline call"
              title="decline"
            >
              <PhoneOff className="size-6" />
            </button>
            <button
              type="button"
              onClick={() => void acceptIncomingCall()}
              className="grid place-items-center size-14 rounded-full bg-emerald-500/90 text-white hover:bg-emerald-500 transition-colors"
              aria-label="accept call"
              title="accept"
            >
              <Phone className="size-6" />
            </button>
            <button
              type="button"
              onClick={letRingIncomingCall}
              className="grid place-items-center size-14 rounded-full bg-app-raise border border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25 transition-colors"
              aria-label="mute ring and keep ringing on their end"
              title="mute ring"
            >
              <VolumeX className="size-5" />
            </button>
          </div>

          <form
            className="w-full flex items-center gap-1.5 rounded-sm border border-white/10 bg-app-raise px-2 focus-within:border-hyper/50 transition-colors"
            onSubmit={(e) => {
              e.preventDefault()
              void sendQuickMessage()
            }}
          >
            <input
              value={quickMessage}
              onChange={(e) => setQuickMessage(e.target.value)}
              placeholder="send a message…"
              maxLength={500}
              aria-label="quick message reply"
              className="flex-1 min-w-0 bg-transparent outline-none text-[13px] py-2 placeholder:text-muted-foreground"
            />
            <button
              type="submit"
              disabled={!quickMessage.trim()}
              className="grid place-items-center size-7 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-40"
              aria-label="send message"
            >
              <Send className="size-3.5" />
            </button>
          </form>
        </div>
      </div>,
      document.body
    )
  }

  // ---------- outgoing / in-call ----------
  const active = activeCall!
  const others = active.participants.filter((p) => p.userId !== me?.id)
  const conversations = useChatStore.getState().conversations
  const conversation = conversations.find((c) => c.id === active.conversationId)
  const other = conversation?.otherUser ?? null
  const title =
    conversation?.name ||
    other?.displayName ||
    other?.username ||
    others[0]?.displayName ||
    others[0]?.username ||
    'call'

  function memberMenu(e: React.MouseEvent, p: (typeof others)[number]) {
    openContextMenu(
      e,
      [
        {
          label: 'view profile',
          icon: UserRound,
          onSelect: () => void openProfile(p.username),
        },
        {
          label: 'message',
          icon: Send,
          onSelect: () => void openDM(p.userId),
        },
        { kind: 'separator' },
        {
          label: hiddenIds[p.userId] ? 'show video' : 'hide video',
          icon: hiddenIds[p.userId] ? Eye : EyeOff,
          onSelect: () => setHiddenIds((h) => ({ ...h, [p.userId]: !h[p.userId] })),
        },
        {
          label: expandedId === p.userId ? 'exit larger view' : 'watch larger',
          icon: Maximize2,
          onSelect: () => setExpandedId((id) => (id === p.userId ? null : p.userId)),
          disabled: !(p.video || p.screen),
        },
      ],
      { title: p.displayName || p.username }
    )
  }

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-[90] bg-black/95 backdrop-blur-md flex flex-col fade-in',
        compact && 'inset-auto bottom-4 right-4 w-72 bg-app-sidebar/95 border border-white/10 rounded-sm shadow-2xl'
      )}
    >
      <div className={cn('flex items-center gap-3 px-4 py-3 border-b border-white/10', compact && 'px-3 py-2')}>
        <PhoneIncoming className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold tracking-tight truncate">{title}</p>
          <p className="text-[11px] text-muted-foreground tabular-nums">
            {active.state === 'ringing'
              ? 'calling…'
              : active.acceptedAt
                ? formatDuration(elapsed)
                : 'connecting…'}
            {others.length > 1 ? ` · ${active.participants.length} in call` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            sounds.play('lightTick')
            setCompact((v) => !v)
          }}
          className="grid place-items-center size-8 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label={compact ? 'expand call' : 'minimize call'}
          title={compact ? 'expand' : 'minimize'}
        >
          <Minimize2 className={cn('size-4 transition-transform', compact && 'rotate-180')} />
        </button>
      </div>

      {!compact && (
        <>
          <div className="flex-1 min-h-0 p-4 flex items-center justify-center">
            {others.length === 0 ? (
              <div className="flex flex-col items-center gap-4 py-16">
                <RingingAvatar
                  name={other?.username ?? title}
                  color={other?.avatarColor ?? '#2e2e2e'}
                  url={other?.avatarUrl ?? null}
                />
                <p className="text-sm font-semibold">{title}</p>
                <p className="text-xs text-muted-foreground">
                  {active.state === 'ringing' ? 'waiting for an answer…' : 'nobody else is here'}
                </p>
              </div>
            ) : (
              <div className={cn('grid gap-3 size-full place-content-center', others.length === 1 ? 'max-w-3xl' : 'max-w-5xl grid-cols-2')}>
                {others.map((p) => (
                  <RemoteTile
                    key={p.userId}
                    userId={p.userId}
                    username={p.username}
                    displayName={p.displayName}
                    avatarUrl={p.avatarUrl}
                    avatarColor={p.avatarColor}
                    video={p.video}
                    screen={p.screen}
                    muted={p.muted}
                    expanded={expandedId === p.userId}
                    hidden={!!hiddenIds[p.userId]}
                    onExpand={() => setExpandedId((id) => (id === p.userId ? null : p.userId))}
                    onHide={() => setHiddenIds((h) => ({ ...h, [p.userId]: !h[p.userId] }))}
                    onContext={(e) => memberMenu(e, p)}
                  />
                ))}
              </div>
            )}
          </div>

          {localVideo && <LocalPreview />}

          <div className="flex items-center justify-center gap-2.5 px-4 py-4 border-t border-white/10">
            <CallButton
              active={callSelf.muted}
              label={callSelf.muted ? 'unmute' : 'mute'}
              onClick={toggleCallMute}
            >
              {callSelf.muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
            </CallButton>
            <CallButton
              active={callSelf.deafened}
              label={callSelf.deafened ? 'undeafen' : 'deafen'}
              onClick={toggleCallDeafen}
            >
              {callSelf.deafened ? <HeadphoneOff className="size-5" /> : <Headphones className="size-5" />}
            </CallButton>
            <CallButton
              active={callSelf.cameraOn}
              label={callSelf.cameraOn ? 'camera off' : 'camera on'}
              onClick={() => void toggleCallCamera()}
            >
              {callSelf.cameraOn ? <Video className="size-5" /> : <VideoOff className="size-5" />}
            </CallButton>
            <CallButton
              active={callSelf.screenOn}
              label={callSelf.screenOn ? 'stop sharing' : 'share screen'}
              onClick={() => void toggleCallScreen()}
            >
              {callSelf.screenOn ? <MonitorX className="size-5" /> : <MonitorUp className="size-5" />}
            </CallButton>
            <button
              type="button"
              onClick={() => {
                sounds.play('lightTick')
                if (active.state === 'ringing') cancelOutgoingCall()
                else hangupCall()
              }}
              className="grid place-items-center size-12 rounded-full bg-red-500/90 text-white hover:bg-red-500 transition-colors"
              aria-label={active.state === 'ringing' ? 'cancel call' : 'leave call'}
              title={active.state === 'ringing' ? 'cancel' : 'leave call'}
            >
              <PhoneOff className="size-5" />
            </button>
          </div>
        </>
      )}

      {compact && (
        <div className="flex items-center justify-center gap-2 py-2.5 border-t border-white/10">
          <button
            type="button"
            onClick={toggleCallMute}
            className="grid place-items-center size-8 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label={callSelf.muted ? 'unmute' : 'mute'}
          >
            {callSelf.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
          </button>
          <button
            type="button"
            onClick={() => void toggleCallScreen()}
            className={cn(
              'grid place-items-center size-8 rounded-sm transition-colors',
              callSelf.screenOn ? 'text-hyper bg-hyper/15' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )}
            aria-label={callSelf.screenOn ? 'stop sharing' : 'share screen'}
          >
            {callSelf.screenOn ? <MonitorX className="size-4" /> : <MonitorUp className="size-4" />}
          </button>
          <button
            type="button"
            onClick={() => {
              if (active.state === 'ringing') cancelOutgoingCall()
              else hangupCall()
            }}
            className="grid place-items-center size-8 rounded-sm bg-red-500/90 text-white hover:bg-red-500 transition-colors"
            aria-label={active.state === 'ringing' ? 'cancel call' : 'leave call'}
          >
            <PhoneOff className="size-4" />
          </button>
        </div>
      )}
    </div>,
    document.body
  )
}

function LocalPreview() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [cam, setCam] = useState(false)
  const [screen, setScreen] = useState(false)

  useEffect(() => {
    const unsub = callEngine.onMedia((state) => {
      setCam(state.cameraOn)
      setScreen(state.screenOn)
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = callEngine.onPeers(() => {
      setStream(null)
    })
    return unsub
  }, [])

  useEffect(() => {
    const t = setInterval(() => {
      const s = callEngine.getLocalPreviewStream()
      if (s !== stream) setStream(s)
    }, 500)
    return () => clearInterval(t)
  }, [stream])

  useEffect(() => {
    if (videoRef.current && stream) {
      if (videoRef.current.srcObject !== stream) videoRef.current.srcObject = stream
      void videoRef.current.play().catch(() => {})
    }
  }, [stream])

  if (!cam && !screen) return null
  return (
    <div className="absolute bottom-24 right-4 w-44 aspect-video rounded-sm overflow-hidden border border-white/15 bg-black shadow-xl z-10">
      <video ref={videoRef} autoPlay playsInline muted className="size-full object-cover" aria-label="your camera preview" />
      {screen && !cam && (
        <span className="absolute bottom-1 left-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-sm bg-black/70">screen</span>
      )}
    </div>
  )
}

function CallButton({
  active,
  label,
  onClick,
  children,
}: {
  active?: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'grid place-items-center size-12 rounded-full border transition-colors',
        active
          ? 'bg-white text-black border-white hover:bg-white/90'
          : 'bg-app-raise text-foreground/85 border-white/10 hover:border-white/30 hover:text-foreground'
      )}
    >
      {children}
    </button>
  )
}
