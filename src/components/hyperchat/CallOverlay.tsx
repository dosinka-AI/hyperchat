'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useChatStore } from '@/lib/client/store'
import { sounds } from '@/lib/client/sounds'
import { callEngine, type CallMediaState } from '@/lib/client/call'
import { callPrefs, onCallPrefsChanged, setCallLayout, setCameraDeviceId, type CallLayout } from '@/lib/client/call-prefs'
import { audioPrefs, commitAudioPrefs, onAudioPrefsChanged } from '@/lib/client/audio-prefs'
import { isTypingTarget } from '@/lib/client/ptt'
import { useIsMobile } from '@/hooks/use-mobile'
import { Avatar } from './Avatar'
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
  MonitorPlay,
  PhoneIncoming,
  BellOff,
  Send,
  Minimize2,
  Maximize2,
  RotateCcw,
  Volume2,
  VolumeX,
  MoreHorizontal,
  LayoutGrid,
  Focus,
  Settings2,
  Keyboard,
  AudioLines,
  Expand,
  Eye,
  ServerOff,
  MessageSquare,
  UserRound,
  Circle,
  PhoneForwarded,
  Plus,
  DoorOpen,
  Ear,
  EarOff,
  X,
} from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { PttControls } from './PttControls'
import { VoiceSettingsDialog } from './VoiceSettings'
import { openContextMenu, type ContextMenuItem } from './ContextMenu'
import { baseConversationId, roomLabelOf, roomSlugOf } from '@/lib/client/call-space'
import { EdgeLightButton } from './EdgeLight'
import { GuestChatPanel, GuestChatSheet } from './GuestChatPanel'

/** The call system, Discord-style. Three surfaces over one engine:
 *
 *  - CallStage (desktop default): the inline call view embedded in the call's
 *    conversation. Avatar circles with speaking rings (audio) or video tiles
 *    (grid / speaker layouts) and the circular control bar, with chat still
 *    alive underneath.
 *  - CallOverlay (mobile default, desktop opt-in): the same stage as a
 *    fullscreen takeover.
 *  - CallDock: the strip under the top bar when you browse elsewhere.
 *
 *  All controls are circular buttons. The mic button carries a small gear at
 *  its bottom right that opens the audio & video device options; everything
 *  else is a plain toggle. Right-click any participant for profile, DM and
 *  volume options. Surfaces animate in and out; M / D / F are live shortcuts.
 *
 *  Hangup is personal: the call itself keeps running for everyone in it. */

/** The red REC marker: a pulsing dot in a red pill, shared by avatar
 *  badges, video tiles and the spectator strip. */
function RecBadge({ compact }: { compact?: boolean }) {
  return (
    <span
      className={cn(
        'flex items-center gap-1 rounded-full bg-red-500/90 text-white font-bold tracking-wide select-none',
        compact ? 'px-1 py-[1px] text-[9px]' : 'px-1.5 py-0.5 text-[10px]'
      )}
      title="this call is being recorded"
    >
      <span className="size-1.5 rounded-full bg-white animate-pulse" aria-hidden="true" />
      REC
    </span>
  )
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/** Keeps a surface mounted for a beat after `show` flips false so the exit
 *  animation can run its course before the unmount. State is adjusted
 *  during render (React's documented pattern for reacting to prop changes)
 *  so the transition never lags a frame. */
function useClosing(show: boolean, ms = 240): boolean {
  const [phase, setPhase] = useState<{ on: boolean; closing: boolean }>(() => ({ on: show, closing: false }))
  if (show !== phase.on) {
    setPhase(show ? { on: true, closing: false } : { on: false, closing: true })
  }
  useEffect(() => {
    if (!phase.closing) return
    const t = setTimeout(() => setPhase({ on: false, closing: false }), ms)
    return () => clearTimeout(t)
  }, [phase.closing, ms])
  return phase.on || phase.closing
}

/** Reactive media state straight off the engine (cached snapshots). */
function useCallMedia(): CallMediaState {
  return useSyncExternalStore(
    (cb) => callEngine.onMedia(cb),
    () => callEngine.getMediaState()
  )
}

/** Reactive call layout preference. */
function useCallLayout(): CallLayout {
  return useSyncExternalStore(
    (cb) => onCallPrefsChanged(cb),
    () => callPrefs.layout
  )
}

/** Live duration for the active call, ticking every second. */
function useCallElapsed(acceptedAt: number | null, callId: string | null): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!acceptedAt) return
    const tick = () => setElapsed(Date.now() - (acceptedAt ?? Date.now()))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [acceptedAt, callId])
  return elapsed
}

// ---------------------------------------------------------------------------
// participant right-click menu
// ---------------------------------------------------------------------------

/** Stream options a tile can add to the participant menu while it is
 *  actively showing video: theater mode, fit vs fill, element fullscreen. */
export type StreamMenuOpts = {
  isScreen: boolean
  fit: 'cover' | 'contain'
  onSetFit: (fit: 'cover' | 'contain') => void
  onTheater: () => void
  videoEl: HTMLVideoElement | null
}

/** Live volume row embedded in the right-click menu: writes the engine's
 *  per-person volume (0-200%, persisted) exactly like the tile controls. */
function ParticipantVolumeRow({ userId }: { userId: string }) {
  const [level, setLevel] = useState<CallLevel>(() => callEngine.getLevelState(userId))
  return (
    <div className="px-3 py-1.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-bold tracking-widest text-muted-foreground">volume</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">{level.volume}%</span>
      </div>
      <Slider
        value={[level.volume]}
        min={0}
        max={200}
        step={5}
        onValueChange={(v) => {
          callEngine.setRemoteVolume(userId, v[0] ?? 100)
          setLevel({ ...callEngine.getLevelState(userId) })
        }}
        aria-label="participant volume"
      />
    </div>
  )
}

/** Right-click on anyone in the call: their profile, a DM, and local volume
 *  controls over their audio (your own tile gets the profile only). Tiles
 *  actively showing video append the stream options (theater mode, fit vs
 *  fill, element fullscreen). */
function openParticipantMenu(
  e: React.MouseEvent,
  p: { userId: string; username: string; displayName: string | null },
  self: boolean,
  stream?: StreamMenuOpts
) {
  const name = p.displayName || p.username
  const state = useChatStore.getState()
  const items: ContextMenuItem[] = [
    {
      kind: 'item',
      label: 'view profile',
      icon: UserRound,
      onSelect: () => {
        sounds.play('lightTick')
        void state.openProfile(p.username)
      },
    },
  ]
  if (!self) {
    const level = callEngine.getLevelState(p.userId)
    items.push(
      {
        kind: 'item',
        label: 'message',
        icon: MessageSquare,
        onSelect: () => {
          sounds.play('midTick')
          void state.openDM(p.userId)
        },
      },
      { kind: 'separator' },
      { kind: 'node', render: () => <ParticipantVolumeRow userId={p.userId} /> },
      { kind: 'separator' },
      {
        kind: 'item',
        label: level.localMuted ? `listen to ${name} again` : `mute ${name} for you`,
        icon: level.localMuted ? Volume2 : VolumeX,
        onSelect: () => {
          sounds.play('lightTick')
          callEngine.setRemoteLocalMute(p.userId, !level.localMuted)
        },
      }
    )
    // whisper: route my mic to this person alone (everyone else stops
    // hearing me; they are told through the sidecar so their chip shows)
    if (state.activeCall || state.voiceConnected) {
      const whispering = state.callWhisperTarget?.userId === p.userId
      items.push({
        kind: 'item',
        label: whispering ? 'stop whispering' : `whisper to @${p.username}`,
        icon: whispering ? EarOff : Ear,
        onSelect: () => {
          sounds.play('lightTick')
          state.setCallWhisper(whispering ? null : p.userId)
        },
      })
    }
  }
  if (stream) {
    items.push(
      { kind: 'separator' },
      {
        kind: 'item',
        label: 'theater mode',
        icon: MonitorPlay,
        onSelect: () => {
          sounds.play('whoom')
          stream.onTheater()
        },
      },
      {
        kind: 'item',
        label: stream.fit === 'contain' ? 'fill window' : 'fit to window',
        icon: stream.fit === 'contain' ? Maximize2 : Minimize2,
        onSelect: () => {
          sounds.play('lightTick')
          stream.onSetFit(stream.fit === 'contain' ? 'cover' : 'contain')
        },
      },
      {
        kind: 'item',
        label: 'fullscreen stream',
        icon: Expand,
        onSelect: () => {
          sounds.play('lightTick')
          void stream.videoEl?.requestFullscreen?.().catch(() => {})
        },
      }
    )
  }
  openContextMenu(e, items, {
    title: name,
    subtitle: stream?.isScreen ? 'screen share' : `@${p.username}`,
  })
}

// ---------------------------------------------------------------------------
// weak-signal warning
// ---------------------------------------------------------------------------

/** The weak-signal warning: the slashed-server badge appears once the
 *  connection stats read poor twice in a row and clears the moment they
 *  recover. Purely informational; never blocks the call. */
function WeakSignalBadge() {
  const [poorStreak, setPoorStreak] = useState(0)
  useEffect(() => {
    const unsub = callEngine.onStats((s) => {
      setPoorStreak((n) => (s.quality === 'poor' ? n + 1 : 0))
    })
    return unsub
  }, [])
  if (poorStreak < 2) return null
  return (
    <span
      className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-amber-400/40 bg-amber-400/10 backdrop-blur text-[11px] font-semibold text-amber-300 fade-in pointer-events-none"
      role="status"
      aria-label="weak connection"
    >
      <ServerOff className="size-3.5" aria-hidden="true" />
      weak signal
    </span>
  )
}

// ---------------------------------------------------------------------------
// volume meter + per-tile controls
// ---------------------------------------------------------------------------

/** Five bars that dance with the participant's measured output level. */
function CallVolumeBars({ level, muted, speaking }: { level: number; muted: boolean; speaking: boolean }) {
  const bars = [0.55, 0.8, 1, 0.75, 0.5]
  return (
    <span className="flex items-end gap-[2px] h-2.5 shrink-0" aria-hidden="true">
      {bars.map((f, i) => {
        const h = muted || !speaking ? 30 : Math.max(30, Math.min(100, level * 115 * f + (i % 2 ? 8 : 0)))
        return (
          <span
            key={i}
            className={cn(
              'w-[2.5px] rounded-full transition-[height] duration-100 ease-out',
              muted ? 'bg-red-400/50' : speaking ? 'bg-hyper' : 'bg-white/25'
            )}
            style={{ height: `${h}%` }}
          />
        )
      })}
    </span>
  )
}

type CallLevel = { volume: number; localMuted: boolean }

/** Hover controls on a remote tile: per-person volume (0-200%, persisted)
 *  and local silence for just this person. */
function CallTileControls({ userId, name }: { userId: string; name: string }) {
  const [level, setLevel] = useState<CallLevel>(() => callEngine.getLevelState(userId))
  const [open, setOpen] = useState(false)

  const setVolume = (v: number) => {
    callEngine.setRemoteVolume(userId, v)
    setLevel({ ...callEngine.getLevelState(userId) })
  }
  const toggleMute = () => {
    sounds.play('lightTick')
    callEngine.setRemoteLocalMute(userId, !level.localMuted)
    setLevel({ ...callEngine.getLevelState(userId) })
  }

  return (
    <div className="flex items-center gap-1.5 opacity-0 group-hover/tile:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            onClick={() => sounds.play('lightTick')}
            className={cn(
              'h-7 px-2.5 rounded-full border border-white/10 bg-black/70 backdrop-blur text-[10px] font-semibold tabular-nums flex items-center gap-1.5 hover:border-white/25 transition-colors',
              level.volume !== 100 && 'text-hyper border-hyper/40'
            )}
            aria-label={`volume for ${name}, ${level.volume} percent`}
            title={`volume · ${level.volume}%`}
          >
            <Volume2 className="size-3" />
            {level.volume}%
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="center" className="w-56 p-3 rounded-sm">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[11px] font-bold tracking-tight truncate">{name}</span>
            <span className="text-[11px] text-muted-foreground tabular-nums">{level.volume}%</span>
          </div>
          <Slider
            value={[level.volume]}
            min={0}
            max={200}
            step={5}
            onValueChange={(v) => setVolume(v[0] ?? 100)}
            aria-label={`volume slider for ${name}`}
          />
          <div className="flex items-center justify-end mt-1">
            <button
              type="button"
              onClick={() => setVolume(100)}
              className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
            >
              <RotateCcw className="size-2.5" />
              reset
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <button
        type="button"
        onClick={toggleMute}
        className={cn(
          'grid place-items-center size-7 rounded-full call-btn border transition-colors',
          level.localMuted
            ? 'border-destructive/50 bg-destructive/20 text-destructive'
            : 'border-white/10 bg-black/70 backdrop-blur text-muted-foreground hover:text-foreground hover:border-white/25'
        )}
        aria-label={level.localMuted ? `unmute ${name} locally` : `mute ${name} locally`}
        title={level.localMuted ? `listen to ${name} again` : `silence ${name} for you`}
      >
        {level.localMuted ? <VolumeX className="size-3" /> : <Volume2 className="size-3" />}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// avatar stack (audio calls)
// ---------------------------------------------------------------------------

type StageAvatarSize = 'sm' | 'md' | 'lg' | 'mx' | 'lgx' | 'xl' | '2xl'

/** One circular avatar in the audio-call row: the ring lights (hyper accent)
 *  while this person speaks, a slash-mic badge marks their mute, the name
 *  sits underneath. Pops in with a staggered spring on mount; right-click
 *  opens their call options. */
function StageAvatar({
  userId,
  username,
  displayName,
  avatarUrl,
  avatarColor,
  muted,
  deafened,
  recording,
  size,
  compact,
  index,
  self,
}: {
  userId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  avatarColor: string
  muted: boolean
  deafened: boolean
  recording?: boolean
  size: StageAvatarSize
  compact?: boolean
  index: number
  self?: boolean
}) {
  const [activity, setActivity] = useState<{ speaking: boolean; volume: number }>({ speaking: false, volume: 0 })

  useEffect(() => {
    const unsub = callEngine.onActivity((uid, speaking, volume) => {
      if (uid !== userId) return
      setActivity((prev) => (prev.speaking === speaking && prev.volume === volume ? prev : { speaking, volume }))
    })
    return unsub
  }, [userId])

  const audible = activity.speaking && !muted
  const barsMuted = muted || deafened

  return (
    <div
      className="flex flex-col items-center gap-1.5 min-w-0 pop-in cursor-default"
      style={{ animationDelay: `${Math.min(index * 70, 420)}ms` }}
      onContextMenu={(e) => openParticipantMenu(e, { userId, username, displayName }, !!self)}
    >
      <span
        className={cn(
          'relative rounded-full transition-all duration-200 ease-out',
          compact ? 'p-1' : 'p-1.5',
          audible ? 'ring-[3px] ring-hyper hyper-glow' : 'ring-[3px] ring-transparent'
        )}
      >
        <Avatar
          name={username}
          color={avatarColor}
          url={avatarUrl}
          size={size}
          className={cn('transition-transform duration-200 ease-out', audible && 'scale-[1.04]')}
        />
        {muted && (
          <span className="absolute bottom-0 right-0 grid place-items-center size-5 rounded-full bg-app-raise ring-2 ring-app-chat">
            <MicOff className="size-2.5 text-destructive" aria-hidden="true" />
          </span>
        )}
        {recording && (
          <span className="absolute -top-1 -left-1" title="recording">
            <RecBadge compact />
          </span>
        )}
      </span>
      <div className="flex flex-col items-center gap-0.5 min-w-0">
        <p className={cn('font-semibold tracking-tight truncate max-w-24 sm:max-w-32', compact ? 'text-xs' : 'text-[13px]')}>
          {displayName || username}
        </p>
        <CallVolumeBars level={activity.volume} muted={barsMuted} speaking={audible} />
      </div>
    </div>
  )
}

/** The audio-call stage: everyone (including you) as a centered row of
 *  circular avatars with speaking rings. Inline keeps the row tight; the
 *  fullscreen takeover gives the avatars room to breathe. */
function CallAvatarStack({
  participants,
  me,
  callSelf,
  ringing,
  variant,
}: {
  participants: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string; muted: boolean; video: boolean; screen: boolean; deafened: boolean; recording?: boolean }[]
  me: { id: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string } | null
  callSelf: CallMediaState
  ringing: boolean
  variant: 'inline' | 'fullscreen'
}) {
  const others = participants.filter((p) => p.userId !== me?.id)
  const compact = variant === 'inline'
  // inline: 64px for a one-on-one, 56px in a crowd, in a slim strip; the
  // fullscreen takeover gets a size up so it still feels immersive
  const big: StageAvatarSize = compact ? 'lgx' : '2xl'
  const small: StageAvatarSize = compact ? 'mx' : 'xl'
  const size = participants.length <= 2 ? big : small
  let idx = 0
  return (
    <div className="h-full w-full grid place-items-center overflow-y-auto nice-scrollbar p-3">
      <div className={cn('flex flex-wrap items-center justify-center', compact ? 'gap-x-8 gap-y-5' : 'gap-x-12 gap-y-9')}>
        {ringing && others.length === 0 ? null : me && (
          <StageAvatar
            userId={me.id}
            username={me.username}
            displayName={me.displayName}
            avatarUrl={me.avatarUrl}
            avatarColor={me.avatarColor}
            muted={!callSelf.transmitting}
            deafened={callSelf.deafened}
            recording={callSelf.recording}
            size={size}
            compact={compact}
            index={idx++}
            self
          />
        )}
        {others.map((p) => (
          <StageAvatar
            key={p.userId}
            userId={p.userId}
            username={p.username}
            displayName={p.displayName}
            avatarUrl={p.avatarUrl}
            avatarColor={p.avatarColor}
            muted={p.muted}
            deafened={p.deafened}
            recording={p.recording}
            size={size}
            compact={compact}
            index={idx++}
          />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// video stage — grid and speaker layouts
// ---------------------------------------------------------------------------

/** One remote participant's video tile. Fills whatever cell the grid gives
 *  it; the video covers the tile so the mosaic stays clean at any size.
 *
 *  Two hardening details keep remote video from ever showing as a black
 *  tile: (1) the engine mutates the SAME MediaStream object when tracks
 *  arrive (stable identity), so a plain state copy would never re-render
 *  after the first one - the peers notification doubles as a re-render
 *  tick and the stream is read fresh on every pass; (2) the <video> mounts
 *  only once showVideo flips true, so its srcObject is attached through a
 *  callback ref that fires exactly when the element appears. The element
 *  stays muted: their voice plays through the engine's own audio chain,
 *  and a muted element can never be autoplay-blocked into a black frame. */
function RemoteTile({
  userId,
  username,
  displayName,
  avatarUrl,
  avatarColor,
  video,
  screen,
  muted,
  deafened,
  recording,
  fit,
  onSetFit,
  onTheater,
}: {
  userId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  avatarColor: string
  video: boolean
  screen: boolean
  muted: boolean
  deafened: boolean
  recording?: boolean
  fit: 'cover' | 'contain' | undefined
  onSetFit: (f: 'cover' | 'contain') => void
  onTheater: () => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [, setTick] = useState(0)
  const [activity, setActivity] = useState<{ speaking: boolean; volume: number }>({ speaking: false, volume: 0 })

  useEffect(() => {
    const unsub = callEngine.onPeers(() => setTick((t) => t + 1))
    return unsub
  }, [userId])

  useEffect(() => {
    const unsub = callEngine.onActivity((uid, speaking, volume) => {
      if (uid !== userId) return
      setActivity((prev) => (prev.speaking === speaking && prev.volume === volume ? prev : { speaking, volume }))
    })
    return unsub
  }, [userId])

  // read fresh per render: the identity never changes, the contents do
  const stream = callEngine.getPeerStream(userId)
  const showVideo = (video || screen) && !!stream && stream.getVideoTracks().length > 0
  const attach = (el: HTMLVideoElement | null) => {
    videoRef.current = el
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream
      void el.play().catch(() => {})
    }
  }

  const mode = fit ?? (screen ? 'contain' : 'cover')
  const audible = activity.speaking && !muted
  const barsMuted = muted || deafened

  return (
    <div
      onContextMenu={(e) =>
        openParticipantMenu(
          e,
          { userId, username, displayName },
          false,
          showVideo
            ? {
                isScreen: screen && !video,
                fit: mode,
                onSetFit,
                onTheater,
                videoEl: videoRef.current,
              }
            : undefined
        )
      }
      className={cn(
        'relative group/tile size-full min-w-0 min-h-0 bg-black rounded-md overflow-hidden border transition-colors duration-200',
        audible ? 'border-hyper/70' : 'border-white/10'
      )}
    >
      {showVideo ? (
        <video
          ref={attach}
          muted
          autoPlay
          playsInline
          className={cn('size-full', mode === 'contain' ? 'object-contain' : 'object-cover')}
          aria-label={`${displayName || username}${screen ? ' screen share' : ' camera'}`}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-2.5 py-6">
            <span className={cn('rounded-full transition-transform duration-200', audible && 'scale-105')}>
              <Avatar name={username} color={avatarColor} url={avatarUrl} size="mx" />
            </span>
            <p className="text-[13px] font-semibold">{displayName || username}</p>
            {screen ? (
              <p className="text-[11px] text-muted-foreground">starting screen share…</p>
            ) : (
              <CallVolumeBars level={activity.volume} muted={barsMuted} speaking={audible} />
            )}
          </div>
        </div>
      )}
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/70 backdrop-blur text-[11px] font-semibold">
        {muted && <MicOff className="size-3 text-red-400" aria-hidden="true" />}
        {screen && <MonitorUp className="size-3 text-hyper" aria-hidden="true" />}
        <span className="truncate max-w-36">{displayName || username}</span>
        {showVideo && <CallVolumeBars level={activity.volume} muted={barsMuted} speaking={audible} />}
      </div>
      <div className="absolute top-2 left-2 flex items-center gap-1.5">
        {recording && <RecBadge />}
      </div>
      <div className="absolute top-2 right-2">
        <CallTileControls userId={userId} name={displayName || username} />
      </div>
    </div>
  )
}

/** Your own camera/screen as a grid tile, mirroring the remote surface.
 *  While you share the screen, the other participants show up as the
 *  "watching" row - everyone in the call sees the share, Discord-style. */
function LocalVideoTile({
  me,
  callSelf,
  viewers,
  fit,
  onSetFit,
}: {
  me: { id?: string; username: string; displayName: string | null } | null
  callSelf: CallMediaState
  viewers: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }[]
  fit: 'cover' | 'contain' | undefined
  onSetFit: (f: 'cover' | 'contain') => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    const unsub = callEngine.onMedia(() => setTick((t) => t + 1))
    return unsub
  }, [])

  const stream = callEngine.getLocalPreviewStream()
  const live = !!stream && stream.getVideoTracks().length > 0
  const attach = (el: HTMLVideoElement | null) => {
    videoRef.current = el
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream
      void el.play().catch(() => {})
    }
  }
  const mode = fit ?? (callSelf.screenOn ? 'contain' : 'cover')

  return (
    <div
      onContextMenu={(e) =>
        openParticipantMenu(
          e,
          { userId: me?.id ?? 'self', username: me?.username ?? 'you', displayName: me?.displayName ?? null },
          true,
          live
            ? {
                isScreen: callSelf.screenOn,
                fit: mode,
                onSetFit,
                onTheater: () => {},
                videoEl: videoRef.current,
              }
            : undefined
        )
      }
      className="relative group/tile size-full min-w-0 min-h-0 bg-black rounded-md overflow-hidden border border-white/10"
    >
      {live ? (
        <video
          ref={attach}
          muted
          autoPlay
          playsInline
          className={cn('size-full', mode === 'contain' ? 'object-contain' : 'object-cover')}
          aria-label="your camera preview"
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <p className="text-[11px] text-muted-foreground">camera starting…</p>
        </div>
      )}
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/70 backdrop-blur text-[11px] font-semibold">
        {!callSelf.transmitting && <MicOff className="size-3 text-red-400" aria-hidden="true" />}
        <span className="truncate max-w-36 text-emerald-300">{(me?.displayName || me?.username || 'you') + ' (you)'}</span>
      </div>
      <div className="absolute top-2 left-2 flex items-center gap-1.5">
        {callSelf.recording && <RecBadge />}
        {callSelf.screenOn && !callSelf.cameraOn && (
          <span className="px-1.5 py-0.5 rounded-full bg-black/70 backdrop-blur text-[10px] font-semibold text-hyper">your screen</span>
        )}
      </div>
      {/* the watch row: everyone else in the call is seeing this share */}
      {callSelf.screenOn && viewers.length > 0 && (
        <div
          className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/70 backdrop-blur border border-white/10"
          title={`watching: ${viewers.map((v) => v.displayName ?? v.username).join(', ')}`}
        >
          <Eye className="size-3 text-hyper shrink-0" aria-hidden="true" />
          <span className="flex -space-x-1.5">
            {viewers.slice(0, 4).map((v) => (
              <span key={v.userId} className="rounded-full ring-1 ring-black/60">
                <Avatar name={v.username} color={v.avatarColor} url={v.avatarUrl} size="sm" />
              </span>
            ))}
          </span>
          {viewers.length > 4 && <span className="text-[10px] font-semibold text-muted-foreground">+{viewers.length - 4}</span>}
        </div>
      )}
    </div>
  )
}

/** Initial column guess before the container has been measured. */
function initialCols(count: number): number {
  return count <= 1 ? 1 : count <= 2 ? 2 : count <= 4 ? 2 : count <= 9 ? 3 : 4
}

/** The grid system: measure the stage, then pick the column count whose
 *  16:9 tiles have the largest area that fits. A ResizeObserver re-solves
 *  it whenever the stage (or the headcount) changes, so the mosaic always
 *  fills the space with proportioned tiles instead of stretching. */
function useOptimalGrid(count: number): {
  ref: (node: HTMLDivElement | null) => void
  grid: { cols: number; tileW: number; tileH: number } | null
} {
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const [grid, setGrid] = useState<{ cols: number; tileW: number; tileH: number } | null>(null)

  useEffect(() => {
    const el = nodeRef.current
    if (!el || count < 1) return
    const GAP = 8
    let raf = 0
    const compute = () => {
      raf = 0
      const W = el.clientWidth
      const H = el.clientHeight
      if (W < 60 || H < 60) return
      let best = { cols: initialCols(count), tileW: 0, tileH: 0 }
      let bestArea = -1
      for (let c = 1; c <= count; c++) {
        const rows = Math.ceil(count / c)
        const cellW = (W - GAP * (c - 1)) / c
        const cellH = (H - GAP * (rows - 1)) / rows
        // the tile keeps its 16:9 shape inside the cell
        const tileW = Math.min(cellW, cellH * (16 / 9))
        const tileH = tileW * (9 / 16)
        const area = tileW * tileH
        if (area > bestArea) {
          bestArea = area
          best = { cols: c, tileW: Math.floor(tileW), tileH: Math.floor(tileH) }
        }
      }
      setGrid((prev) =>
        prev && prev.cols === best.cols && Math.abs(prev.tileW - best.tileW) < 1 && Math.abs(prev.tileH - best.tileH) < 1
          ? prev
          : best
      )
    }
    const onResize = () => {
      if (!raf) raf = requestAnimationFrame(compute)
    }
    compute()
    const ro = new ResizeObserver(onResize)
    ro.observe(el)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [count])

  const ref = useCallback((node: HTMLDivElement | null) => {
    nodeRef.current = node
  }, [])
  return { ref, grid }
}

/** Remote + local video in the two Discord layouts. Speaker view tracks the
 *  current talker (falling back to the first video) for the big tile; a rail
 *  of 16:9 thumbnails keeps everyone visible. Grid view is the solved
 *  mosaic: proportioned tiles that always fit. */
function VideoStage({
  participants,
  me,
  callSelf,
  layout,
  tileFit,
  onSetTileFit,
  onTheater,
}: {
  participants: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string; muted: boolean; deafened: boolean; video: boolean; screen: boolean; recording?: boolean }[]
  me: { id: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string } | null
  callSelf: CallMediaState
  layout: CallLayout
  tileFit: Record<string, 'cover' | 'contain'>
  onSetTileFit: (userId: string, fit: 'cover' | 'contain') => void
  onTheater: (userId: string) => void
}) {
  const others = participants.filter((p) => p.userId !== me?.id && (p.video || p.screen))
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  // stable dep: the id set, not the filtered array identity, so the activity
  // subscription survives participant-list refreshes without thrashing
  const otherIdsKey = others.map((p) => p.userId).join(',')

  useEffect(() => {
    const ids = new Set(otherIdsKey ? otherIdsKey.split(',') : [])
    const unsub = callEngine.onActivity((uid, speaking) => {
      if (!speaking) return
      if (uid === me?.id) setSpeakingId('__local__')
      else if (ids.has(uid)) setSpeakingId(uid)
    })
    return unsub
  }, [me?.id, otherIdsKey])

  const tileFor = (p: (typeof others)[number]) => (
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
      deafened={p.deafened}
      recording={p.recording}
      fit={tileFit[p.userId]}
      onSetFit={(f) => onSetTileFit(p.userId, f)}
      onTheater={() => onTheater(p.userId)}
    />
  )

  const localTile = useMemo(
    () =>
      callSelf.cameraOn || callSelf.screenOn ? (
        <LocalVideoTile
          me={me}
          callSelf={callSelf}
          viewers={participants
            .filter((p) => p.userId !== me?.id)
            .map((p) => ({ userId: p.userId, username: p.username, displayName: p.displayName, avatarUrl: p.avatarUrl, avatarColor: p.avatarColor }))}
          fit={me ? tileFit[me.id] : undefined}
          onSetFit={(f) => me && onSetTileFit(me.id, f)}
        />
      ) : null,
    [callSelf.cameraOn, callSelf.screenOn, callSelf, me, participants, tileFit, onSetTileFit]
  )

  // the tiles and the solved grid are computed BEFORE any early return: the
  // hooks must run on every render regardless of which layout is active
  const tiles = [...others.map((p) => ({ key: p.userId, node: tileFor(p) }))]
  if (localTile) tiles.push({ key: '__local__', node: localTile })
  const count = tiles.length
  const { ref, grid } = useOptimalGrid(count)
  const rows = grid ? Math.ceil(count / grid.cols) : Math.ceil(count / initialCols(count))

  if (layout === 'speaker' && (others.length > 0 || localTile)) {
    const spotlightId = speakingId ?? others[0]?.userId ?? '__local__'
    const spotlight = others.find((p) => p.userId === spotlightId)
    const rail = others.filter((p) => p.userId !== spotlightId)
    return (
      <div className="size-full min-h-0 flex gap-2 p-2 sm:p-3">
        <div className="flex-1 min-w-0 min-h-0 flex flex-col gap-2">
          {spotlight ? (
            <div className="flex-1 min-h-0 tile-in">{tileFor(spotlight)}</div>
          ) : (
            <div className="flex-1 min-h-0 flex items-center justify-center tile-in">
              {localTile ?? <p className="text-xs text-muted-foreground">no video</p>}
            </div>
          )}
        </div>
        {(rail.length > 0 || (spotlight && localTile)) && (
          <div className="w-32 sm:w-44 shrink-0 flex flex-col gap-2 overflow-y-auto nice-scrollbar">
            {spotlight && localTile && <div className="relative w-full aspect-video tile-in">{localTile}</div>}
            {rail.map((p) => (
              <div key={p.userId} className="relative w-full aspect-video tile-in">
                {tileFor(p)}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // grid: solved mosaic with proportioned 16:9 tiles
  return (
    <div className="size-full min-h-0 p-2 sm:p-3 overflow-hidden">
      <div
        ref={ref}
        className="size-full grid gap-2 place-content-center place-items-center transition-[grid-template-columns,grid-template-rows] duration-200"
        style={
          grid
            ? {
                gridTemplateColumns: `repeat(${grid.cols}, ${grid.tileW}px)`,
                gridTemplateRows: `repeat(${rows}, ${grid.tileH}px)`,
              }
            : {
                gridTemplateColumns: `repeat(${initialCols(count)}, minmax(0, 1fr))`,
                gridAutoRows: '1fr',
              }
        }
      >
        {tiles.map((t, i) => (
          <div
            key={t.key}
            className={cn('min-w-0 min-h-0 tile-in', !grid && 'w-full h-full')}
            style={{ animationDelay: `${Math.min(i * 45, 270)}ms` }}
          >
            {t.node}
          </div>
        ))}
      </div>
    </div>
  )
}

function MenuItem({
  active,
  onClick,
  label,
  icon,
}: {
  active?: boolean
  onClick: () => void
  label: string
  icon?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-xs text-left transition-colors',
        active ? 'text-hyper bg-hyper/10' : 'text-foreground/85 hover:bg-accent hover:text-foreground'
      )}
      aria-current={active || undefined}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
      {active && <span className="ml-auto size-1.5 rounded-full bg-hyper shrink-0" aria-hidden="true" />}
    </button>
  )
}

/** The ellipsis menu: sound settings for calls, voice settings dialog, and
 *  the keyboard cheat sheet. */
function CallEllipsisMenu({
  onOpenVoiceSettings,
  onOpenShortcuts,
  buttonSize,
}: {
  onOpenVoiceSettings: () => void
  onOpenShortcuts: () => void
  buttonSize: string
}) {
  const [open, setOpen] = useState(false)
  const joinSoundsOn = sounds.getCategoryEnabled('join')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn('grid place-items-center rounded-full call-btn text-foreground/70 hover:text-foreground hover:bg-white/10 transition-colors', buttonSize)}
          aria-label="more call options"
          title="more"
        >
          <MoreHorizontal className="size-5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-56 p-2 rounded-sm">
        <label className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-sm hover:bg-accent cursor-pointer">
          <span className="flex items-center gap-2 text-xs font-medium">
            <AudioLines className="size-3.5" aria-hidden="true" />
            call sounds
          </span>
          <Switch
            checked={joinSoundsOn}
            onCheckedChange={(v) => {
              sounds.play('lightTick')
              sounds.setCategoryEnabled('join', v)
            }}
            aria-label="toggle call sounds"
          />
        </label>
        <MenuItem
          onClick={() => {
            setOpen(false)
            onOpenVoiceSettings()
          }}
          label="voice & video settings"
          icon={<Settings2 className="size-3.5" aria-hidden="true" />}
        />
        <MenuItem
          onClick={() => {
            setOpen(false)
            onOpenShortcuts()
          }}
          label="keyboard shortcuts"
          icon={<Keyboard className="size-3.5" aria-hidden="true" />}
        />
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// the control bar (circular buttons, Discord-style)
// ---------------------------------------------------------------------------

function BarControl({
  active,
  danger,
  label,
  onClick,
  buttonSize,
  children,
}: {
  active?: boolean
  danger?: boolean
  label: string
  onClick: () => void
  buttonSize: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        'grid place-items-center rounded-full call-btn',
        buttonSize,
        active
          ? danger
            ? 'bg-destructive text-white shadow-[0_0_18px_-6px_rgba(239,68,68,0.8)]'
            : 'bg-white text-black shadow-[0_0_16px_-6px_rgba(255,255,255,0.55)]'
          : 'bg-app-raise/90 text-foreground/80 ring-1 ring-white/10 hover:text-foreground hover:ring-white/25 hover:bg-app-raise'
      )}
    >
      {children}
    </button>
  )
}

/** lucide-react 0.525 ships no PhonePlus glyph, so the call UI composes
 *  one: a phone with a small emerald plus badge at its corner - the
 *  "ring someone in" marker on the add-to-call trigger, the channel-create
 *  submit and the incoming-call "ring into this call" action. */
function PhonePlusGlyph({ variant }: { variant: 'sm' | 'md' | 'lg' }) {
  const dims =
    variant === 'lg'
      ? { phone: 'size-6', badge: 'size-4 -right-1.5 -bottom-1', plus: 'size-2.5' }
      : variant === 'sm'
        ? { phone: 'size-3.5', badge: 'size-3 -right-1 -bottom-0.5', plus: 'size-1.5' }
        : { phone: 'size-5', badge: 'size-3.5 -right-1 -bottom-0.5', plus: 'size-2' }
  return (
    <span className="relative inline-flex" aria-hidden="true">
      <Phone className={dims.phone} />
      <span className={cn('absolute grid place-items-center rounded-full bg-emerald-400 text-black', dims.badge)}>
        <Plus className={dims.plus} strokeWidth={3} />
      </span>
    </span>
  )
}

/** The plus circle: add anyone to the call I'm in. The picker lists
 *  friends and this conversation's members who are not in the call yet -
 *  even people who cannot see the conversation's messages (a DM call adding
 *  a third person): they get the ring, join the call, and never see the
 *  chat. Offline targets are ringable too: they sit slightly dimmed with
 *  an "unlikely to answer" hint instead of being locked out. */
function AddToCallControl({ buttonSize }: { buttonSize: string }) {
  const [open, setOpen] = useState(false)
  const activeCall = useChatStore((s) => s.activeCall)
  const conversations = useChatStore((s) => s.conversations)
  const friends = useChatStore((s) => s.friends)
  const onlineUserIds = useChatStore((s) => s.onlineUserIds)
  const ringUserIntoCall = useChatStore((s) => s.ringUserIntoCall)
  const me = useChatStore((s) => s.me)

  if (!activeCall) return null
  const conversation = conversations.find((c) => c.id === baseConversationId(activeCall.conversationId))
  const inCall = new Set(activeCall.participants.map((p) => p.userId))
  const seen = new Set<string>()
  const candidates: { id: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string; online: boolean }[] = []
  const push = (u: { id: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }) => {
    if (u.id === me?.id || inCall.has(u.id) || seen.has(u.id)) return
    seen.add(u.id)
    candidates.push({ ...u, online: !!onlineUserIds[u.id] })
  }
  for (const p of conversation?.participants ?? []) {
    push({ id: p.id, username: p.username, displayName: p.displayName, avatarUrl: p.avatarUrl, avatarColor: p.avatarColor })
  }
  if (conversation?.otherUser) {
    push({ id: conversation.otherUser.id, username: conversation.otherUser.username, displayName: conversation.otherUser.displayName, avatarUrl: conversation.otherUser.avatarUrl, avatarColor: conversation.otherUser.avatarColor })
  }
  for (const f of friends) {
    push({ id: f.user.id, username: f.user.username, displayName: f.user.displayName, avatarUrl: f.user.avatarUrl, avatarColor: f.user.avatarColor })
  }
  const sorted = [...candidates].sort((a, b) => Number(b.online) - Number(a.online) || (a.displayName || a.username).localeCompare(b.displayName || b.username))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="add someone to the call"
          title="add to call"
          aria-haspopup="dialog"
          className={cn(
            'grid place-items-center rounded-full call-btn transition-colors',
            buttonSize,
            open ? 'bg-emerald-400/90 text-black shadow-[0_0_16px_-6px_rgba(16,185,129,0.7)]' : 'bg-app-raise/90 text-foreground/80 ring-1 ring-white/10 hover:text-foreground hover:ring-white/25 hover:bg-app-raise'
          )}
        >
          <PhonePlusGlyph variant="md" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-60 p-2 rounded-sm">
        <p className="px-1.5 pb-1.5 text-[10px] font-bold tracking-widest text-muted-foreground select-none">ring into this call</p>
        {sorted.length === 0 ? (
          <p className="px-1.5 py-3 text-xs text-muted-foreground">everyone you know is already in here</p>
        ) : (
          <div className="max-h-72 overflow-y-auto nice-scrollbar flex flex-col gap-0.5">
            {sorted.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => {
                  sounds.play('lightTick')
                  ringUserIntoCall(u.id)
                  setOpen(false)
                }}
                className={cn(
                  'w-full flex items-center gap-2.5 px-1.5 py-1.5 rounded-sm text-left transition-colors',
                  u.online ? 'hover:bg-accent' : 'opacity-60'
                )}
              >
                <Avatar name={u.username} color={u.avatarColor} url={u.avatarUrl} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold truncate">{u.displayName || u.username}</span>
                  <span className="block text-[10px] text-muted-foreground truncate">{u.online ? 'online' : 'offline · unlikely to answer'}</span>
                </span>
                <PhoneForwarded className="size-3.5 text-emerald-300 shrink-0" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Call channels while you're in the call: a group call can spin up named
 *  channel spaces hanging off the conversation ("channels for calls") and
 *  hop between them without leaving the call UI. The popover lists every
 *  live channel with its headcount and a join button (or an "in here" tag
 *  for the one you occupy); channels never ring anyone - they exist for
 *  members to see and join. Groups only: a DM has no room for side
 *  channels. */
function CallChannelsControl({ buttonSize }: { buttonSize: string }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const activeCall = useChatStore((s) => s.activeCall)
  const conversations = useChatStore((s) => s.conversations)
  const liveCalls = useChatStore((s) => s.liveCalls)
  const me = useChatStore((s) => s.me)
  const createCallRoom = useChatStore((s) => s.createCallRoom)
  const joinCall = useChatStore((s) => s.joinCall)

  const base = activeCall ? baseConversationId(activeCall.conversationId) : ''
  const conversation = conversations.find((c) => c.id === base)
  if (!activeCall || conversation?.kind !== 'GROUP') return null

  const channels = Object.values(liveCalls).filter(
    (c) => c.conversationId.startsWith(base + '~') && roomSlugOf(c.conversationId)
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="call channels"
          title="call channels"
          aria-haspopup="dialog"
          className={cn(
            'grid place-items-center rounded-full call-btn transition-colors',
            buttonSize,
            open ? 'bg-emerald-400/90 text-black shadow-[0_0_16px_-6px_rgba(16,185,129,0.7)]' : 'bg-app-raise/90 text-foreground/80 ring-1 ring-white/10 hover:text-foreground hover:ring-white/25 hover:bg-app-raise'
          )}
        >
          <DoorOpen className="size-5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-64 p-2 rounded-sm">
        <p className="px-1.5 pb-1.5 text-[10px] font-bold tracking-widest text-muted-foreground select-none">call channels</p>
        {channels.length === 0 ? (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">no call channels yet</p>
        ) : (
          <div className="flex flex-col gap-0.5 max-h-56 overflow-y-auto nice-scrollbar">
            {channels.map((c) => {
              const mine = activeCall.conversationId === c.conversationId
              const others = c.participants.filter((p) => p.userId !== me?.id)
              return (
                <div key={c.conversationId} className="flex items-center gap-2 px-1.5 py-1.5 rounded-sm hover:bg-accent transition-colors">
                  <span className="flex items-center -space-x-1.5 shrink-0" aria-hidden="true">
                    {others.slice(0, 3).map((p) => (
                      <span key={p.userId} className="rounded-full ring-1 ring-app-chat">
                        <Avatar name={p.username} color={p.avatarColor} url={p.avatarUrl} size="sm" />
                      </span>
                    ))}
                    {others.length === 0 && (
                      <span className="size-6 rounded-full bg-app-raise border border-white/10" aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold truncate">{roomLabelOf(c.conversationId)}</span>
                    <span className="block text-[10px] text-muted-foreground tabular-nums">{c.participants.length} in channel</span>
                  </span>
                  {mine ? (
                    <span className="shrink-0 text-[10px] font-bold text-muted-foreground pr-1">in here</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        sounds.play('callEnter')
                        void joinCall(c.conversationId)
                        setOpen(false)
                      }}
                      className="shrink-0 flex items-center gap-1 h-7 px-2 rounded-sm bg-emerald-500/90 text-white text-[11px] font-semibold hover:bg-emerald-500 active:scale-95 transition-all"
                      aria-label={`join channel ${roomLabelOf(c.conversationId)}`}
                    >
                      <Phone className="size-3" />
                      join
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <div className="mt-1.5 pt-1.5 border-t border-border">
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault()
              const trimmed = name.trim()
              if (!trimmed) return
              sounds.play('midTick')
              void createCallRoom(base, trimmed)
              setName('')
              setOpen(false)
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="new channel name…"
              maxLength={32}
              className="h-7 text-xs rounded-sm"
              aria-label="new channel name"
            />
            <button
              type="submit"
              disabled={!name.trim()}
              className="grid place-items-center size-7 rounded-sm bg-emerald-500/90 text-white hover:bg-emerald-500 disabled:opacity-40 transition-colors shrink-0"
              aria-label="create channel"
              title="create channel"
            >
              <PhonePlusGlyph variant="sm" />
            </button>
          </form>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** The whole control row, shared by the inline stage and the fullscreen
 *  takeover. Every button is a plain circle: mute, deafen, PTT, camera,
 *  screenshare, layout and fullscreen are toggles; the ellipsis circle
 *  gathers the rest; the red hangup circle anchors the right edge. */
function CallControlBar({
  callSelf,
  variant,
  onToggleCamera,
  onToggleScreen,
  onToggleMute,
  onToggleDeafen,
  onToggleRecording,
  onToggleFullscreen,
  onHangup,
  onOpenVoiceSettings,
  onOpenShortcuts,
  showVideoLayoutToggle,
}: {
  callSelf: CallMediaState
  variant: 'inline' | 'fullscreen'
  onToggleCamera: () => void
  onToggleScreen: () => void
  onToggleMute: () => void
  onToggleDeafen: () => void
  onToggleRecording: () => void
  onToggleFullscreen: () => void
  onHangup: () => void
  onOpenVoiceSettings: () => void
  onOpenShortcuts: () => void
  showVideoLayoutToggle: boolean
}) {
  const layout = useCallLayout()
  const anyVideo = callSelf.cameraOn || callSelf.screenOn
  // 44px circles in the fullscreen takeover (touch targets), 40px inline
  const btn = variant === 'fullscreen' ? 'size-11' : 'size-10'
  return (
    <div
      className={cn(
        'shrink-0 flex items-center justify-center flex-wrap gap-1.5 sm:gap-2 px-3 border-t border-white/10 bg-app-raise/60 backdrop-blur',
        variant === 'fullscreen' ? 'py-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))]' : 'py-2'
      )}
      role="toolbar"
      aria-label="call controls"
    >
      <BarControl
        active={!callSelf.transmitting}
        danger
        label={callSelf.muted ? 'unmute (m)' : callSelf.transmitting ? 'mute (m)' : 'push to talk: mic closed'}
        onClick={onToggleMute}
        buttonSize={btn}
      >
        {!callSelf.transmitting ? <MicOff className="size-5" /> : <Mic className="size-5" />}
      </BarControl>

      <BarControl active={callSelf.deafened} danger label={callSelf.deafened ? 'undeafen (d)' : 'deafen (d)'} onClick={onToggleDeafen} buttonSize={btn}>
        {callSelf.deafened ? <HeadphoneOff className="size-5" /> : <Headphones className="size-5" />}
      </BarControl>

      <PttControls iconSize="size-5" buttonClassName={cn('rounded-full call-btn', btn)} />

      <BarControl active={callSelf.cameraOn} label={callSelf.cameraOn ? 'camera off' : 'camera on'} onClick={onToggleCamera} buttonSize={btn}>
        {callSelf.cameraOn ? <Video className="size-5" /> : <VideoOff className="size-5" />}
      </BarControl>

      {/* ambient camera light (experimental): warm edge glow while the camera is on */}
      <EdgeLightButton className={btn} iconClass="size-5" />

      <BarControl active={callSelf.screenOn} label={callSelf.screenOn ? 'stop sharing' : 'share screen'} onClick={onToggleScreen} buttonSize={btn}>
        {callSelf.screenOn ? <MonitorX className="size-5" /> : <MonitorUp className="size-5" />}
      </BarControl>

      {/* the recorder: mixes everyone (your mic included) into one file,
          downloaded the moment it stops; the whole call hears the warning */}
      <BarControl
        active={callSelf.recording}
        danger
        label={callSelf.recording ? 'stop recording (downloads the file)' : 'record call'}
        onClick={onToggleRecording}
        buttonSize={btn}
      >
        <Circle className={cn('size-5', callSelf.recording && 'fill-current animate-pulse')} />
      </BarControl>

      {/* ring anyone into this call, friends included */}
      <AddToCallControl buttonSize={btn} />

      {/* call channels for this group call: hop between them mid-call */}
      <CallChannelsControl buttonSize={btn} />

      {showVideoLayoutToggle && (
        <BarControl
          active={layout === 'speaker'}
          label={layout === 'speaker' ? 'grid view' : 'speaker view'}
          buttonSize={btn}
          onClick={() => {
            sounds.play('lightTick')
            setCallLayout(layout === 'speaker' ? 'grid' : 'speaker')
          }}
        >
          {layout === 'speaker' ? <LayoutGrid className="size-5" /> : <Focus className="size-5" />}
        </BarControl>
      )}

      {variant === 'inline' && (
        <BarControl active={false} label="fullscreen (f)" onClick={onToggleFullscreen} buttonSize={btn}>
          <Maximize2 className="size-5" />
        </BarControl>
      )}
      {variant === 'fullscreen' && (
        <BarControl active={false} label="exit fullscreen (f)" onClick={onToggleFullscreen} buttonSize={btn}>
          <Minimize2 className="size-5" />
        </BarControl>
      )}

      <CallEllipsisMenu onOpenVoiceSettings={onOpenVoiceSettings} onOpenShortcuts={onOpenShortcuts} buttonSize={btn} />

      {/* the red hangup circle */}
      <button
        type="button"
        onClick={onHangup}
        className={cn(
          'grid place-items-center rounded-full call-btn bg-red-500/90 text-white hover:bg-red-500 ml-1 shadow-[0_0_20px_-6px_rgba(239,68,68,0.75)]',
          btn
        )}
        aria-label="leave call"
        title="leave call"
      >
        <PhoneOff className="size-5" />
      </button>

      {anyVideo && (
        <span className="sr-only" role="status">
          camera {callSelf.cameraOn ? 'on' : 'off'}, screen share {callSelf.screenOn ? 'on' : 'off'}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// the shared stage (inline + fullscreen)
// ---------------------------------------------------------------------------

type OtherMember = {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  avatarColor: string
}

/** The outgoing ring, before anyone has joined: online members are being
 *  rung (their avatars pulse), offline ones get the slashed-server tile
 *  that says they are not going to answer. Inline lays everything out as
 *  ONE horizontal band so the status line can never duck behind the
 *  control bar; the fullscreen takeover centers a roomy column. */
function RingingView({
  variant,
  title,
  members,
  onlineUserIds,
}: {
  variant: 'inline' | 'fullscreen'
  title: string
  members: OtherMember[]
  onlineUserIds: Record<string, boolean>
}) {
  const compact = variant === 'inline'
  const online = members.filter((m) => onlineUserIds[m.id])
  const offline = members.filter((m) => !onlineUserIds[m.id])
  const isDm = members.length === 1
  const nameOf = (m: OtherMember) => m.displayName || m.username

  const pulseAvatar = (m: OtherMember, size: StageAvatarSize, dim = false) => (
    <span className="relative rounded-full shrink-0">
      <span className={cn('absolute rounded-full border animate-ping', compact ? '-inset-1 border-white/20' : '-inset-2 border-white/20')} aria-hidden="true" />
      <Avatar name={m.username} color={m.avatarColor} url={m.avatarUrl} size={size} className={dim ? 'opacity-60 grayscale' : undefined} />
    </span>
  )

  const serverTile = (m: OtherMember, size: 'sm' | 'md') => (
    <span
      key={m.id}
      className={cn('flex flex-col items-center gap-1 shrink-0', compact ? 'max-w-16' : 'max-w-20')}
      title={`${nameOf(m)} is offline`}
    >
      <span
        className={cn(
          'grid place-items-center rounded-full bg-app-raise border border-white/10 text-muted-foreground',
          size === 'md' ? 'size-10' : 'size-8'
        )}
      >
        <ServerOff className={size === 'md' ? 'size-5' : 'size-4'} aria-hidden="true" />
      </span>
      <span className="text-[10px] text-muted-foreground/80 truncate w-full text-center">{nameOf(m)}</span>
    </span>
  )

  // one partner, reachable: the DM ring
  if (isDm && online.length > 0) {
    const m = members[0]
    return compact ? (
      <div className="flex items-center gap-4 px-4 min-w-0 fade-in">
        {pulseAvatar(m, 'mx')}
        <div className="min-w-0">
          <p className="text-sm font-bold tracking-tight truncate">{nameOf(m)}</p>
          <p className="text-xs text-muted-foreground">ringing…</p>
        </div>
      </div>
    ) : (
      <div className="flex flex-col items-center gap-3 p-4 fade-in">
        {pulseAvatar(m, '2xl')}
        <p className="text-base font-bold tracking-tight">{nameOf(m)}</p>
        <p className="text-xs text-muted-foreground">ringing…</p>
      </div>
    )
  }

  // one partner, offline: the unreachable view
  if (isDm) {
    const m = members[0]
    return compact ? (
      <div className="flex items-center gap-4 px-4 min-w-0 fade-in">
        <span className="relative shrink-0">
          <Avatar name={m.username} color={m.avatarColor} url={m.avatarUrl} size="mx" className="opacity-60 grayscale" />
          <span className="absolute -bottom-1 -right-1 grid place-items-center size-6 rounded-full bg-app-raise border border-white/15 text-muted-foreground">
            <ServerOff className="size-3.5" aria-hidden="true" />
          </span>
        </span>
        <div className="min-w-0">
          <p className="text-sm font-bold tracking-tight truncate">{nameOf(m)}</p>
          <p className="text-xs text-muted-foreground truncate">{nameOf(m)} is unreachable and is unlikely to answer…</p>
        </div>
      </div>
    ) : (
      <div className="flex flex-col items-center gap-3 p-4 fade-in">
        <span className="relative">
          <Avatar name={m.username} color={m.avatarColor} url={m.avatarUrl} size="2xl" className="opacity-60 grayscale" />
          <span className="absolute -bottom-1.5 -right-1.5 grid place-items-center size-9 rounded-full bg-app-raise border border-white/15 text-muted-foreground">
            <ServerOff className="size-5" aria-hidden="true" />
          </span>
        </span>
        <p className="text-base font-bold tracking-tight">{nameOf(m)}</p>
        <p className="text-xs text-muted-foreground">{nameOf(m)} is unreachable and is unlikely to answer…</p>
      </div>
    )
  }

  // a group: everyone online pulses as being rung, the offline ones sit
  // apart with the slashed-server tile
  const allOffline = online.length === 0
  const statusLine = allOffline
    ? `${title} is unreachable and is unlikely to answer…`
    : offline.length > 0
      ? `ringing ${online.map(nameOf).join(', ')}`
      : 'ringing…'

  return compact ? (
    <div className="flex items-center gap-3.5 px-4 min-w-0 w-full overflow-hidden fade-in">
      {!allOffline && (
        <span className="flex items-center gap-2.5 min-w-0 overflow-hidden shrink-0" aria-label="ringing">
          {online.slice(0, 4).map((m) => (
            <span key={m.id} className="shrink-0" title={nameOf(m)}>
              {pulseAvatar(m, 'md')}
            </span>
          ))}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold tracking-tight truncate">{title}</span>
        <span className="block text-xs text-muted-foreground truncate">{statusLine}</span>
      </span>
      {offline.length > 0 && (
        <span className="flex items-center gap-2 shrink-0 pl-3 border-l border-white/10" aria-label="offline members">
          {offline.slice(0, 4).map((m) => serverTile(m, 'sm'))}
          {offline.length > 4 && <span className="text-[10px] font-semibold text-muted-foreground">+{offline.length - 4}</span>}
        </span>
      )}
    </div>
  ) : (
    <div className="flex flex-col items-center gap-5 p-6 fade-in">
      {online.length > 0 && (
        <div className="flex flex-wrap items-start justify-center gap-x-7 gap-y-4 max-w-lg">
          {online.map((m) => (
            <span key={m.id} className="flex flex-col items-center gap-1.5">
              {pulseAvatar(m, 'xl')}
              <span className="text-[11px] font-semibold text-muted-foreground truncate max-w-20">{nameOf(m)}</span>
            </span>
          ))}
        </div>
      )}
      {offline.length > 0 && (
        <div className="flex flex-wrap items-start justify-center gap-x-4 gap-y-3 pt-4 border-t border-white/10 max-w-lg" aria-label="offline members">
          {offline.map((m) => serverTile(m, 'md'))}
        </div>
      )}
      <div className="text-center">
        <p className="text-sm font-bold tracking-tight">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{statusLine}</p>
      </div>
    </div>
  )
}

/** Theater mode: one remote stream letterboxed across the whole stage
 *  (contain-fit, black bars) without lifting the call into the browser
 *  fullscreen takeover. Esc or the chip brings the mosaic back. */
function TheaterSurface({ userId, label, onExit }: { userId: string; label: string; onExit: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [, setTick] = useState(0)
  useEffect(() => {
    const unsub = callEngine.onPeers(() => setTick((t) => t + 1))
    return unsub
  }, [userId])
  const stream = callEngine.getPeerStream(userId)
  const attach = (el: HTMLVideoElement | null) => {
    videoRef.current = el
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream
      void el.play().catch(() => {})
    }
  }
  return (
    <div className="absolute inset-0 bg-black view-in">
      {stream && stream.getVideoTracks().length > 0 ? (
        <video ref={attach} muted autoPlay playsInline className="size-full object-contain" aria-label={`${label} stream, theater mode`} />
      ) : (
        <div className="size-full grid place-items-center">
          <p className="text-xs text-muted-foreground">stream ended</p>
        </div>
      )}
      <button
        type="button"
        onClick={onExit}
        className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/70 backdrop-blur border border-white/15 text-[11px] font-semibold hover:border-white/35 transition-colors"
        aria-label="exit theater mode"
        title="exit theater (esc)"
      >
        <Minimize2 className="size-3.5" />
        {label} · exit theater
      </button>
    </div>
  )
}

/** Who is being rung in, as the whole call sees it: one chip per rung
 *  person pinned top-center of the stage, their avatar carrying the
 *  pinging ring. Self-hides when nobody is rung (or once they join); also
 *  stays hidden during the initial outgoing phase, which RingingView
 *  already owns. */
function RingingIntoCallStrip({ callId }: { callId: string }) {
  const ringing = useChatStore((s) => s.callRingingUsers[callId])
  const activeCall = useChatStore((s) => s.activeCall)
  const onlineUserIds = useChatStore((s) => s.onlineUserIds)
  const me = useChatStore((s) => s.me)

  // the outgoing ring renders its own view: no double display
  if (activeCall?.state === 'ringing' && activeCall.participants.length <= 1) return null
  const inCall = new Set(activeCall?.participants.map((p) => p.userId))
  const users = (ringing ?? []).filter((u) => !inCall.has(u.userId) && u.userId !== me?.id)
  if (users.length === 0) return null

  return (
    <div
      className="absolute top-2 left-1/2 -translate-x-1/2 z-10 pointer-events-none flex items-center gap-1.5 fade-in flex-wrap justify-center max-w-[90%]"
      aria-label="people being rung into this call"
    >
      {users.map((u) => {
        const online = !!onlineUserIds[u.userId]
        const name = u.displayName || u.username
        return (
          <span
            key={u.userId}
            title={`${name} is being rung into the call`}
            className="rounded-full bg-black/70 backdrop-blur border border-white/15 px-2 py-1 flex items-center gap-1.5"
          >
            <span className="relative rounded-full">
              <Avatar
                name={u.username}
                color={u.avatarColor}
                url={u.avatarUrl}
                size="sm"
                className={online ? undefined : 'opacity-60 grayscale'}
              />
              <span className="absolute inset-0 rounded-full border animate-ping border-emerald-300/40" aria-hidden="true" />
            </span>
            <span className="flex flex-col min-w-0">
              <span className="text-[10px] font-semibold truncate max-w-24">{name}</span>
              <span className={cn('text-[9px]', online ? 'text-emerald-300' : 'text-muted-foreground')}>
                {online ? 'being rung…' : 'unlikely to answer'}
              </span>
            </span>
          </span>
        )
      })}
    </div>
  )
}

/** Whisper-in-calls, floating over the stage bottom: the whisperer sees the
 *  private line they opened (with an end button, hyper accent), the target
 *  sees a subtle note that only they are being talked to. */
function WhisperChips() {
  const callWhisperTarget = useChatStore((s) => s.callWhisperTarget)
  const callWhisperedBy = useChatStore((s) => s.callWhisperedBy)
  const setCallWhisper = useChatStore((s) => s.setCallWhisper)
  if (!callWhisperTarget && !callWhisperedBy) return null
  return (
    <div
      className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-1.5 fade-in max-w-[94%]"
      aria-live="polite"
    >
      {callWhisperTarget && (
        <span
          className="flex items-center gap-1.5 min-h-9 pl-3 pr-1 rounded-full border border-hyper/50 bg-hyper/15 backdrop-blur text-[11px] font-semibold text-hyper"
          title={`only ${callWhisperTarget.username} hears you right now`}
        >
          <Ear className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">whispering to {callWhisperTarget.username}</span>
          <button
            type="button"
            onClick={() => {
              sounds.play('lightTick')
              setCallWhisper(null)
            }}
            className="grid place-items-center size-9 rounded-full hover:bg-hyper/20 transition-colors shrink-0"
            aria-label="stop whispering"
            title="stop whispering"
          >
            <X className="size-4" />
          </button>
        </span>
      )}
      {callWhisperedBy && (
        <span className="flex items-center gap-1.5 min-h-9 px-3 rounded-full border border-white/15 bg-black/60 backdrop-blur text-[11px] font-semibold text-foreground/80 pointer-events-none">
          <Ear className="size-3.5 shrink-0 text-hyper" aria-hidden="true" />
          <span className="truncate">
            {callWhisperedBy.displayName || callWhisperedBy.username} is whispering to you
          </span>
        </span>
      )}
    </div>
  )
}

/** Everything between "a call is live" and pixels: the stage content shared
 *  by the desktop inline view and the fullscreen takeover. variant controls
 *  the frame chrome (fullscreen carries a header with the back-to-chat
 *  control) and the proportions (avatar sizes, control sizing). All hooks
 *  run before the early return so the tree stays stable across call
 *  lifecycles. */
function CallStageContent({ variant }: { variant: 'inline' | 'fullscreen' }) {
  const activeCall = useChatStore((s) => s.activeCall)
  const me = useChatStore((s) => s.me)
  const conversations = useChatStore((s) => s.conversations)
  const onlineUserIds = useChatStore((s) => s.onlineUserIds)
  const socketUp = useChatStore((s) => s.connected)
  const toggleCallMute = useChatStore((s) => s.toggleCallMute)
  const toggleCallDeafen = useChatStore((s) => s.toggleCallDeafen)
  const toggleCallCamera = useChatStore((s) => s.toggleCallCamera)
  const toggleCallScreen = useChatStore((s) => s.toggleCallScreen)
  const toggleCallRecording = useChatStore((s) => s.toggleCallRecording)
  const cancelOutgoingCall = useChatStore((s) => s.cancelOutgoingCall)
  const hangupCall = useChatStore((s) => s.hangupCall)
  const setCallFullscreen = useChatStore((s) => s.setCallFullscreen)
  const { toast } = useToast()
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  /** theater mode: the participant whose stream owns the whole stage */
  const [theater, setTheater] = useState<string | null>(null)
  /** per-tile fit choice (cover / contain); unset falls back to the tile's
   *  default (screens letterbox, cameras fill) */
  const [tileFit, setTileFit] = useState<Record<string, 'cover' | 'contain'>>({})
  const media = useCallMedia()
  const layout = useCallLayout()
  const isMobile = useIsMobile()
  const elapsed = useCallElapsed(activeCall?.acceptedAt ?? null, activeCall?.callId ?? null)

  const active = activeCall
  const others = active ? active.participants.filter((p) => p.userId !== me?.id) : []
  const conversation = active ? conversations.find((c) => c.id === baseConversationId(active.conversationId)) : undefined
  const other = conversation?.otherUser ?? null
  // a room call carries the room's label beside the conversation title
  const roomLabel = active ? roomLabelOf(active.conversationId) : ''
  const title =
    (conversation?.name || other?.displayName || other?.username || others[0]?.displayName || others[0]?.username || 'call') +
    (roomLabel ? ` · ${roomLabel}` : '')
  const ringing = active?.state === 'ringing'
  const anyVideo = !!active && (media.cameraOn || media.screenOn || others.some((p) => p.video || p.screen))
  // who is on the other end of this call attempt: the DM partner, or for
  // groups the full member roster (otherUser only carries the FIRST other
  // participant, which would render a group ring as a 1:1)
  const otherMembers: OtherMember[] = conversation?.participants?.length
    ? conversation.participants
        .filter((p) => p.id !== me?.id)
        .map((p) => ({ id: p.id, username: p.username, displayName: p.displayName, avatarUrl: p.avatarUrl, avatarColor: p.avatarColor }))
    : other
      ? [{ id: other.id, username: other.username, displayName: other.displayName, avatarUrl: other.avatarUrl, avatarColor: other.avatarColor }]
      : []
  // theater mode only holds while its participant is still sending
  const theaterP = theater ? others.find((x) => x.userId === theater && (x.video || x.screen)) : undefined

  // M / D / F call shortcuts, Discord muscle memory, ignored while typing;
  // Esc folds theater mode back into the mosaic
  const shortcutsActive = !!active
  useEffect(() => {
    if (!shortcutsActive) return
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || isTypingTarget(e.target)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.code === 'KeyM') {
        e.preventDefault()
        toggleCallMute()
      } else if (e.code === 'KeyD') {
        e.preventDefault()
        toggleCallDeafen()
      } else if (e.code === 'KeyF' && !isMobile) {
        e.preventDefault()
        sounds.play('whoom')
        setCallFullscreen(variant === 'inline')
      } else if (e.code === 'Escape' && theater) {
        e.preventDefault()
        sounds.play('lightTick')
        setTheater(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcutsActive, toggleCallMute, toggleCallDeafen, setCallFullscreen, isMobile, variant, theater])

  // a new call resets the per-call viewing choices (state adjusted during
  // render: React's documented pattern for reacting to store changes
  // without lagging a frame, same as the stage's height snapshot below)
  const [lastCallId, setLastCallId] = useState<string | null>(activeCall?.callId ?? null)
  if ((activeCall?.callId ?? null) !== lastCallId) {
    setLastCallId(activeCall?.callId ?? null)
    setTheater(null)
    setTileFit({})
  }

  if (!active) return null

  const handleCamera = () => {
    void toggleCallCamera().catch(() => toast({ title: 'camera unavailable' }))
  }
  const handleScreen = () => {
    void toggleCallScreen().catch(() => toast({ title: 'screen share ended' }))
  }

  return (
    <div className={cn('flex flex-col min-h-0 min-w-0', variant === 'fullscreen' ? 'size-full' : 'h-full')} data-call-stage={variant}>
      {/* fullscreen frame chrome: title + connection warning + collapse */}
      {variant === 'fullscreen' && (
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/10 shrink-0">
          <PhoneIncoming className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold tracking-tight truncate">{title}</p>
            <p className="text-[11px] text-muted-foreground tabular-nums">
              {ringing ? 'calling…' : active.acceptedAt ? formatDuration(elapsed) : 'connecting…'}
              {others.length > 1 ? ` · ${active.participants.length} in call` : ''}
            </p>
          </div>
          {!socketUp && (
            <div className="hidden sm:flex items-center gap-2 h-9 px-3 rounded-sm border border-destructive/50 bg-destructive/15 shrink-0" role="status">
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive/70" />
                <span className="relative inline-flex size-2 rounded-full bg-destructive" />
              </span>
              <span className="text-[11px] font-semibold text-destructive">connection issue: reconnecting</span>
            </div>
          )}
          {!isMobile && (
            <button
              type="button"
              onClick={() => {
                sounds.play('whoom')
                setCallFullscreen(false)
              }}
              className="flex items-center gap-2 h-9 px-3.5 rounded-sm border font-semibold tracking-tight transition-all press-sm text-sm border-white/20 bg-app-raise/70 text-foreground hover:border-white/40 hover:bg-app-raise"
              aria-label="return the call to the conversation view"
              title="back to chat"
            >
              <Minimize2 className="size-4" />
              back to chat
            </button>
          )}
        </div>
      )}

      {/* the stage itself: keying on the layout re-mounts the video tree so
          grid/speaker switches land as a soft fade instead of a hard snap */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        {theaterP ? (
          <TheaterSurface userId={theaterP.userId} label={theaterP.displayName || theaterP.username} onExit={() => setTheater(null)} />
        ) : anyVideo ? (
          <div key={`video-${layout}`} className="absolute inset-0 view-in">
            <VideoStage
              participants={active.participants}
              me={me}
              callSelf={media}
              layout={layout}
              tileFit={tileFit}
              onSetTileFit={(uid, fit) => setTileFit((m) => (m[uid] === fit ? m : { ...m, [uid]: fit }))}
              onTheater={(uid) => setTheater(uid)}
            />
          </div>
        ) : ringing && others.length === 0 ? (
          <div className={cn('h-full w-full fade-in', variant === 'inline' ? 'flex items-center overflow-hidden' : 'grid place-items-center')}>
            <RingingView variant={variant} title={title} members={otherMembers} onlineUserIds={onlineUserIds} />
          </div>
        ) : (
          <CallAvatarStack participants={active.participants} me={me} callSelf={media} ringing={ringing} variant={variant} />
        )}

        {/* the live duration, floating quietly in the corner (the fullscreen
            header carries its own) */}
        {variant === 'inline' && active.acceptedAt && (
          <span className="absolute top-2 right-2 z-10 px-2 py-0.5 rounded-full bg-black/50 backdrop-blur text-[11px] font-semibold tabular-nums text-foreground/75 fade-in pointer-events-none">
            {formatDuration(elapsed)}
          </span>
        )}
        {/* weak-signal warning mid-call: only shows on a sustained poor read */}
        <WeakSignalBadge />
        {/* who is being rung in: the whole call sees their pinging chips */}
        <RingingIntoCallStrip callId={active.callId} />
        {/* whisper lines: my private mic route + anyone whispering to me */}
        <WhisperChips />
      </div>

      {/* controls */}
      <CallControlBar
        callSelf={media}
        variant={variant}
        onToggleMute={toggleCallMute}
        onToggleDeafen={toggleCallDeafen}
        onToggleCamera={handleCamera}
        onToggleScreen={handleScreen}
        onToggleRecording={toggleCallRecording}
        onToggleFullscreen={() => {
          sounds.play('whoom')
          setCallFullscreen(variant === 'inline')
        }}
        onHangup={() => {
          if (ringing) cancelOutgoingCall()
          else hangupCall()
        }}
        onOpenVoiceSettings={() => setVoiceSettingsOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        showVideoLayoutToggle={anyVideo}
      />

      <VoiceSettingsDialog open={voiceSettingsOpen} onOpenChange={setVoiceSettingsOpen} />
      <CallShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  )
}

/** The call's own shortcut sheet, the same format as the global one but
 *  scoped to live-call keys. */
function CallShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  )
  if (!open || !mounted) return null
  return createPortal(
    <div className="fixed inset-0 z-[110] bg-black/70 grid place-items-center p-4 fade-in" onClick={() => onOpenChange(false)}>
      <div
        role="dialog"
        aria-label="call keyboard shortcuts"
        className="whoosh-in glass w-[min(22rem,94vw)] rounded-sm border border-white/10 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <Keyboard className="size-4 text-muted-foreground" aria-hidden="true" />
          <p className="text-base font-bold tracking-tight">in this call</p>
        </div>
        <div className="space-y-1.5">
          {[
            { keys: 'M', label: 'mute / unmute' },
            { keys: 'D', label: 'deafen / undeafen' },
            { keys: 'F', label: 'fullscreen and back' },
          ].map((row) => (
            <div key={row.keys} className="flex items-center justify-between gap-3">
              <span className="text-sm text-foreground/90">{row.label}</span>
              <kbd className="inline-flex items-center justify-center min-w-6 h-6 px-1.5 rounded-sm border border-white/15 bg-app-raise text-[11px] font-semibold text-foreground/90 select-none">
                {row.keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}

// ---------------------------------------------------------------------------
// surfaces
// ---------------------------------------------------------------------------

/** The spectator band: a live call in the conversation I am NOT in. Sits
 *  where the inline stage would (a group chat, someone else's call): who is
 *  in it right now, their media flags (mute / camera / screen / REC), how
 *  long it has run, and the emerald join hop. One strip, no chrome. */
export function CallSpectatorStrip() {
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const friendsViewOpen = useChatStore((s) => s.friendsViewOpen)
  const live = useChatStore((s) => (s.activeConversationId ? s.liveCalls[s.activeConversationId] : undefined))
  const activeCall = useChatStore((s) => s.activeCall)
  const me = useChatStore((s) => s.me)
  const joinCall = useChatStore((s) => s.joinCall)
  const conversations = useChatStore((s) => s.conversations)
  const liveCalls = useChatStore((s) => s.liveCalls)
  const elapsed = useCallElapsed(live?.acceptedAt ?? null, live?.callId ?? null)

  const inThisCall = !!activeCall && baseConversationId(activeCall.conversationId) === activeConversationId
  const show = !!live && !!activeConversationId && !activeChannelId && !friendsViewOpen && !inThisCall
  const mounted = useClosing(show, 240)

  if (!mounted) return null
  const closing = !show

  // call channels hanging off this conversation: room spaces in the same
  // liveCalls record (the one I'm in, if any, is skipped - it's not here)
  const rooms = activeConversationId
    ? Object.values(liveCalls).filter(
        (c) =>
          c.conversationId.startsWith(activeConversationId + '~') &&
          roomSlugOf(c.conversationId) &&
          c.conversationId !== activeCall?.conversationId
      )
    : []

  const conversation = live ? conversations.find((c) => c.id === live.conversationId) : undefined
  const others = live ? live.participants.filter((p) => p.userId !== me?.id) : []
  const anyRecording = live?.participants.some((p) => p.recording) ?? false
  const anyVideo = live?.participants.some((p) => p.video || p.screen) ?? false

  return (
    <section
      className={cn(
        'shrink-0 border-b border-white/10 bg-app-raise/40 fade-in',
        closing ? 'stage-out' : 'stage-in'
      )}
      aria-label={closing ? undefined : 'ongoing call in this conversation'}
      aria-hidden={closing || undefined}
    >
      {closing || !live ? null : (
        <div className="flex items-center gap-3 px-3 sm:px-4 py-2 min-w-0 overflow-hidden">
          <span className="flex items-center -space-x-2 shrink-0" aria-hidden="true">
            {others.slice(0, 6).map((p) => (
              <span key={p.userId} className="relative rounded-full ring-2 ring-app-chat" title={`${p.displayName || p.username}${p.muted ? ' · muted' : ''}${p.recording ? ' · recording' : ''}`}>
                <Avatar name={p.username} color={p.avatarColor} url={p.avatarUrl} size="sm" />
                {p.muted && (
                  <span className="absolute -bottom-0.5 -right-0.5 grid place-items-center size-3.5 rounded-full bg-app-raise ring-2 ring-app-chat">
                    <MicOff className="size-2 text-destructive" aria-hidden="true" />
                  </span>
                )}
                {p.recording && (
                  <span className="absolute -top-1 -left-1 size-2.5 rounded-full bg-red-500 ring-2 ring-app-chat animate-pulse" aria-hidden="true" />
                )}
              </span>
            ))}
            {others.length === 0 && (
              <span className="size-7 rounded-full bg-app-raise border border-white/10" aria-hidden="true" />
            )}
          </span>

          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2 min-w-0">
              <span className="min-w-0 truncate text-[13px] font-semibold">
                {others.length > 0
                  ? `${others.map((p) => p.displayName || p.username).slice(0, 2).join(', ')}${others.length > 2 ? ` +${others.length - 2}` : ''}`
                  : conversation?.otherUser?.displayName || conversation?.otherUser?.username || conversation?.name || 'someone'}
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {live.state === 'ringing' ? 'calling…' : live.acceptedAt ? formatDuration(elapsed) : 'connecting…'}
              </span>
              {anyVideo && (
                <span className="shrink-0 hidden sm:inline text-[11px] text-muted-foreground">· video</span>
              )}
            </span>
            <span className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span className="tabular-nums">{live.participants.length} in call</span>
              {anyRecording && (
                <span className="flex items-center gap-1 text-red-400 font-semibold">
                  <span className="size-1.5 rounded-full bg-red-500 animate-pulse" aria-hidden="true" />
                  recording
                </span>
              )}
            </span>
          </span>

          <button
            type="button"
            onClick={() => {
              sounds.play('callEnter')
              void joinCall(live.conversationId)
            }}
            className="join-pulse flex items-center gap-1.5 h-8 px-3 rounded-sm bg-emerald-500/90 text-white text-xs font-semibold hover:bg-emerald-500 active:scale-95 transition-all shrink-0"
            aria-label="join the ongoing call"
            title="join call"
          >
            <Phone className="size-3.5" />
            join
          </button>
        </div>
      )}
      {/* the conversation's call channels, as compact join chips */}
      {closing || !live || rooms.length === 0 ? null : (
        <div className="border-t border-white/10 flex items-center gap-2 px-3 sm:px-4 py-1.5 overflow-x-auto nice-scrollbar">
          <span className="shrink-0 text-[9px] font-bold tracking-widest text-muted-foreground select-none">call channels</span>
          {rooms.map((r) => (
            <span
              key={r.conversationId}
              className="flex items-center gap-1.5 h-7 px-2 rounded-full border border-white/10 bg-app-raise/80 text-[11px] font-semibold shrink-0"
            >
              <span className="truncate max-w-28">{roomLabelOf(r.conversationId)}</span>
              <span className="text-[9px] text-muted-foreground tabular-nums shrink-0">{r.participants.length} in channel</span>
              <button
                type="button"
                onClick={() => {
                  sounds.play('callEnter')
                  void joinCall(r.conversationId)
                }}
                className="flex items-center gap-1 text-[10px] font-semibold text-emerald-300 hover:text-emerald-200 transition-colors shrink-0"
                aria-label={`join channel ${roomLabelOf(r.conversationId)}`}
              >
                <Phone className="size-3" aria-hidden="true" />
                join
              </button>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

const AUDIO_STAGE_H = 'h-[188px]'
const VIDEO_STAGE_H = 'h-[46%] min-h-[280px] max-h-[460px]'

/** The desktop default: the call stage inline in its conversation, with the
 *  chat still alive underneath. Audio calls sit in a slim strip; video calls
 *  claim a taller pane. Mounts with an unfold, folds away when the call
 *  ends (the closing frame keeps the last height so the fold reads smooth). */
export function CallStage() {
  const activeCall = useChatStore((s) => s.activeCall)
  const callFullscreen = useChatStore((s) => s.callFullscreen)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const friendsViewOpen = useChatStore((s) => s.friendsViewOpen)
  const isMobile = useIsMobile()
  const media = useCallMedia()

  const show =
    !!activeCall &&
    !callFullscreen &&
    !isMobile &&
    !friendsViewOpen &&
    !activeChannelId &&
    // a room call (convId~room) belongs to its owning conversation too
    baseConversationId(activeCall.conversationId) === activeConversationId

  const mounted = useClosing(show, 240)

  // snapshot the height while the call is live (state adjusted during
  // render, React's pattern for reacting to store changes without lagging
  // a frame) so the closing animation folds from the same shape even after
  // the call itself is gone
  const [snap, setSnap] = useState({ live: false, video: false })
  if (activeCall) {
    const hasVideo = media.cameraOn || media.screenOn || activeCall.participants.some((p) => p.video || p.screen)
    if (!snap.live || snap.video !== hasVideo) {
      setSnap({ live: true, video: hasVideo })
    }
  } else if (snap.live) {
    setSnap({ live: false, video: snap.video })
  }
  const heightClass = snap.video ? VIDEO_STAGE_H : AUDIO_STAGE_H

  if (!mounted) return null
  const closing = !show

  return (
    <section
      className={cn(
        'shrink-0 border-b border-white/10 bg-app-chat',
        heightClass,
        closing ? 'stage-out' : 'stage-in'
      )}
      aria-label={closing ? undefined : 'ongoing call'}
      aria-hidden={closing || undefined}
    >
      {closing || !activeCall ? (
        <div className="h-full grid place-items-center">
          {activeCall ? null : <p className="text-xs text-muted-foreground">call ended</p>}
        </div>
      ) : (
        <CallStageContent variant="inline" />
      )}
    </section>
  )
}

/** The fullscreen takeover: mobile default, desktop opt-in. Also owns the
 *  incoming-call ring modal (portal, always). Both animate out instead of
 *  blinking away: the takeover retreats with a whoosh, the ring fades. */
export function CallOverlay() {
  const incomingCall = useChatStore((s) => s.incomingCall)
  const activeCall = useChatStore((s) => s.activeCall)
  const voiceConnected = useChatStore((s) => s.voiceConnected)
  const callFullscreen = useChatStore((s) => s.callFullscreen)
  const isMobile = useIsMobile()
  const selectConversation = useChatStore((s) => s.selectConversation)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const acceptIncomingCall = useChatStore((s) => s.acceptIncomingCall)
  const declineIncomingCall = useChatStore((s) => s.declineIncomingCall)
  const letRingIncomingCall = useChatStore((s) => s.letRingIncomingCall)
  const ringUserIntoCall = useChatStore((s) => s.ringUserIntoCall)
  const ringUserIntoVoice = useChatStore((s) => s.ringUserIntoVoice)
  const [quickMessage, setQuickMessage] = useState('')
  const { toast } = useToast()

  // portals need the DOM: false during SSR, true on the client, without a
  // setState-in-effect render cascade
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  )

  const showFullscreenStage = !!activeCall && (isMobile || callFullscreen)
  const fullscreenMounted = useClosing(showFullscreenStage, 210)
  const ringMounted = useClosing(!!incomingCall, 190)
  // keep the last ring payload around (state adjusted during render) so the
  // modal can fade out after the call was answered or declined
  const [lastIncoming, setLastIncoming] = useState(incomingCall)
  if (incomingCall && incomingCall !== lastIncoming) {
    setLastIncoming(incomingCall)
  }
  const incoming = incomingCall ?? lastIncoming

  if (!mounted) return null

  // ---------- incoming ring ----------
  if (ringMounted && incoming) {
    const live = !!incomingCall
    const from = incoming.from
    // "in a call" covers both surfaces: a live DM/group call (other than
    // this very ring) and sitting in a server voice channel
    const inDmCall = !!activeCall && activeCall.callId !== incoming.callId
    const inVoiceChannel = !!voiceConnected
    async function sendQuickMessage() {
      const text = quickMessage.trim()
      const target = incomingCall
      if (!text || !target || target.voice) return
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
      <div
        className={cn('fixed inset-0 z-[90] bg-black/85 grid place-items-center p-4', live ? 'fade-in' : 'fade-out pointer-events-none')}
      >
        <div
          role="dialog"
          aria-label={`incoming call from ${from.displayName || from.username}`}
          className="whoosh-in glass w-[min(28rem,94vw)] rounded-sm border border-white/10 p-5 flex flex-col gap-4 shadow-2xl"
        >
          {/* avatar + name on the left, the call circles level with it on
              the right: accept/decline live beside the profile picture
              instead of sitting in a fat row underneath */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <div className="relative shrink-0">
              <span className="absolute -inset-2 rounded-full border border-white/20 animate-ping" aria-hidden="true" />
              <Avatar name={from.username} color={from.avatarColor} url={from.avatarUrl} size="mx" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-base font-bold tracking-tight truncate">{from.displayName || from.username}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {incoming.voice
                  ? `inviting you to #${incoming.voice.channelName}…`
                  : live && (inDmCall || inVoiceChannel)
                    ? `incoming ${incoming.video ? 'video' : 'voice'} call while you're in a call…`
                    : `incoming ${incoming.video ? 'video' : 'voice'} call…`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void acceptIncomingCall()}
                className="relative grid place-items-center size-11 rounded-full call-btn bg-emerald-500/90 text-white hover:bg-emerald-500 shadow-[0_0_20px_-6px_rgba(16,185,129,0.8)]"
                aria-label="accept call"
                title="accept"
              >
                <span className="absolute inline-flex size-11 rounded-full bg-emerald-400/30 animate-ping" aria-hidden="true" />
                <Phone className="size-5" />
              </button>
              <button
                type="button"
                onClick={() => void declineIncomingCall()}
                className="grid place-items-center size-11 rounded-full call-btn bg-red-500/90 text-white hover:bg-red-500 shadow-[0_0_20px_-6px_rgba(239,68,68,0.8)]"
                aria-label="decline call"
                title="decline"
              >
                <PhoneOff className="size-5" />
              </button>
              {/* already on a surface - a DM/group call or a server voice
                  channel: pull the caller over to THAT surface instead of
                  answering - declines this ring and rings them into it */}
              {live && (inDmCall || inVoiceChannel) && !incoming.voice && (
                <button
                  type="button"
                  onClick={() => {
                    sounds.play('lightTick')
                    void declineIncomingCall()
                    if (voiceConnected) {
                      // sitting in a server voice channel: ring the caller
                      // into that channel instead of a call mesh
                      ringUserIntoVoice(voiceConnected.channelId, voiceConnected.serverId, from.userId)
                    } else {
                      ringUserIntoCall(from.userId)
                    }
                  }}
                  className="grid place-items-center size-11 rounded-full call-btn bg-app-raise border border-emerald-400/40 text-emerald-300 hover:border-emerald-300"
                  aria-label="ring them into your current call"
                  title="ring into this call"
                >
                  <PhonePlusGlyph variant="sm" />
                </button>
              )}
              <button
                type="button"
                onClick={letRingIncomingCall}
                className="grid place-items-center size-11 rounded-full call-btn bg-app-raise border border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25"
                aria-label="dismiss and keep ringing on their end"
                title="keep ringing"
              >
                <BellOff className="size-4.5" />
              </button>
            </div>
          </div>

          {/* quick message: reply without taking the call (voice-channel
              invites have no conversation behind them) */}
          {!incoming.voice && (
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
          )}
        </div>
      </div>,
      document.body
    )
  }

  // ---------- fullscreen stage ----------
  if (!fullscreenMounted) return null
  // a cross-rung GUEST gets the send-only guest chat beside the stage (they
  // are not a participant of the conversation behind the call, so there is
  // no normal chat to inline — the panel carries their sends + receipts +
  // the honest banner). Desktop: a right column; mobile: a floating button
  // opens it as a sheet over the stage.
  const guestOf = activeCall?.guestOf ?? null
  return createPortal(
    <div
      className={cn(
        'fixed z-[90] inset-0 flex flex-col bg-app-chat',
        showFullscreenStage ? 'whoosh-in' : 'whoosh-out pointer-events-none'
      )}
      role="region"
      aria-label="call, fullscreen"
    >
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {activeCall ? (
            <CallStageContent variant="fullscreen" />
          ) : (
            <div className="size-full grid place-items-center">
              <p className="text-sm text-muted-foreground">call ended</p>
            </div>
          )}
        </div>
        {guestOf && <GuestChatPanel className="hidden w-[340px] shrink-0 md:flex" />}
      </div>
      {guestOf && <GuestChatSheet />}
    </div>,
    document.body
  )
}

// ---------------------------------------------------------------------------
// the dock
// ---------------------------------------------------------------------------

/** One avatar in the dock's audio-call stack: the ring lights while this
 *  person speaks. */
function DockAvatar({
  userId,
  username,
  avatarUrl,
  avatarColor,
  muted,
}: {
  userId: string
  username: string
  avatarUrl: string | null
  avatarColor: string
  muted: boolean
}) {
  const [speaking, setSpeaking] = useState(false)
  useEffect(() => {
    const unsub = callEngine.onActivity((uid, sp) => {
      if (uid !== userId) return
      setSpeaking((prev) => (prev === sp ? prev : sp))
    })
    return unsub
  }, [userId])

  return (
    <span
      className={cn(
        'relative rounded-full ring-2 transition-all duration-200',
        speaking && !muted ? 'ring-hyper' : 'ring-app-raise'
      )}
    >
      <Avatar name={username} color={avatarColor} url={avatarUrl} size="sm" />
      {muted && (
        <span className="absolute -bottom-0.5 -right-0.5 grid place-items-center size-3.5 rounded-full bg-app-raise ring-1 ring-white/25">
          <MicOff className="size-2 text-destructive" />
        </span>
      )}
    </span>
  )
}

/** A remote participant's video as a dock thumbnail. Same hardening as
 *  the stage tiles: peers notifications tick the re-render (tracks mutate
 *  the stream in place) and the element attaches through a callback ref,
 *  muted so autoplay can never leave it black. */
function DockRemoteThumb({
  userId,
  username,
  displayName,
}: {
  userId: string
  username: string
  displayName: string | null
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    const unsub = callEngine.onPeers(() => setTick((t) => t + 1))
    return unsub
  }, [userId])

  const stream = callEngine.getPeerStream(userId)
  const live = !!stream && stream.getVideoTracks().length > 0
  const attach = (el: HTMLVideoElement | null) => {
    videoRef.current = el
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream
      void el.play().catch(() => {})
    }
  }
  return (
    <div className="relative w-24 h-14 sm:w-36 sm:h-20 rounded-md overflow-hidden border border-white/15 bg-black shrink-0 tile-in">
      {live ? (
        <video ref={attach} muted autoPlay playsInline className="size-full object-cover" aria-label={`${displayName || username} video`} />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <p className="text-[10px] text-muted-foreground">connecting…</p>
        </div>
      )}
      <span className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded-full bg-black/70 backdrop-blur text-[10px] font-semibold truncate max-w-[85%]">
        {displayName || username}
      </span>
    </div>
  )
}

/** Your own camera/screen as a dock thumbnail. */
function DockLocalThumb() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    const unsub = callEngine.onMedia(() => setTick((t) => t + 1))
    return unsub
  }, [])

  const stream = callEngine.getLocalPreviewStream()
  if (!stream) return null
  const attach = (el: HTMLVideoElement | null) => {
    videoRef.current = el
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream
      void el.play().catch(() => {})
    }
  }
  return (
    <div className="relative w-24 h-14 sm:w-36 sm:h-20 rounded-md overflow-hidden border border-white/15 bg-black shrink-0 tile-in">
      <video ref={attach} muted autoPlay playsInline className="size-full object-cover" aria-label="your camera preview" />
      <span className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded-full bg-black/70 backdrop-blur text-[10px] font-semibold text-emerald-300">you</span>
    </div>
  )
}

/** The away-from-the-call strip, pinned under the top bar on desktop:
 *  live thumbnails (video calls) or the avatar stack (audio), the status
 *  line, and the circular control row. One click returns to the inline
 *  stage. Drops in from above and retracts when the call ends or you go
 *  back to it. */
export function CallDock() {
  const activeCall = useChatStore((s) => s.activeCall)
  const callFullscreen = useChatStore((s) => s.callFullscreen)
  const setCallFullscreen = useChatStore((s) => s.setCallFullscreen)
  const me = useChatStore((s) => s.me)
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const selectConversation = useChatStore((s) => s.selectConversation)
  const toggleCallMute = useChatStore((s) => s.toggleCallMute)
  const toggleCallDeafen = useChatStore((s) => s.toggleCallDeafen)
  const toggleCallCamera = useChatStore((s) => s.toggleCallCamera)
  const toggleCallScreen = useChatStore((s) => s.toggleCallScreen)
  const cancelOutgoingCall = useChatStore((s) => s.cancelOutgoingCall)
  const hangupCall = useChatStore((s) => s.hangupCall)
  const media = useCallMedia()
  const isMobile = useIsMobile()

  const active = activeCall
  // desktop only (mobile always runs the fullscreen overlay); hidden while
  // the fullscreen stage owns the screen; hidden at the call's own
  // conversation (a room call counts: its stage renders in the owner)
  const atCallLocation = !activeChannelId && baseConversationId(active?.conversationId ?? '') === activeConversationId
  const visible = !!active && !isMobile && !callFullscreen && !atCallLocation
  const dockMounted = useClosing(visible, 210)
  const elapsed = useCallElapsed(active?.acceptedAt ?? null, active?.callId ?? null)

  if (!dockMounted) return null
  if (!visible) {
    // retracting: silent when the call simply moved surfaces, a quiet
    // "call ended" beat when it actually ended
    return (
      <div className="dock-out w-full h-14 bg-app-raise/95 border-b border-white/10 shrink-0 grid place-items-center" aria-hidden="true">
        {active ? null : <p className="text-[11px] text-muted-foreground">call ended</p>}
      </div>
    )
  }
  if (!active) return null

  const others = active.participants.filter((p) => p.userId !== me?.id)
  const conversation = conversations.find((c) => c.id === baseConversationId(active.conversationId))
  const other = conversation?.otherUser ?? null
  const roomLabel = roomLabelOf(active.conversationId)
  const title =
    (conversation?.name || other?.displayName || other?.username || others[0]?.displayName || others[0]?.username || 'call') +
    (roomLabel ? ` · ${roomLabel}` : '')
  const ringing = active.state === 'ringing'
  const localVideo = media.cameraOn || media.screenOn
  const remoteVideo = others.some((p) => p.video || p.screen)
  const anyVideo = remoteVideo || localVideo
  const videoThumbs = others.filter((p) => p.video || p.screen)

  const returnToCall = () => {
    sounds.play('whoom')
    void selectConversation(baseConversationId(active.conversationId))
    setCallFullscreen(false)
  }

  return (
    <div className="dock-in w-full bg-app-raise/95 border-b border-white/10 shrink-0" role="region" aria-label="ongoing call">
      <div className={cn('flex items-center gap-3 px-3 w-full min-w-0', anyVideo ? 'py-2' : 'h-14')}>
        {/* the call at a glance: one click returns you to it */}
        <button
          type="button"
          onClick={returnToCall}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-sm px-2 -mx-2 py-1 hover:bg-white/[0.04] transition-colors text-left group"
          aria-label={`return to the call with ${title}`}
        >
          {anyVideo ? (
            <span className="flex items-center gap-2 min-w-0 overflow-hidden" aria-hidden="true">
              {videoThumbs.map((p) => (
                <DockRemoteThumb key={p.userId} userId={p.userId} username={p.username} displayName={p.displayName} />
              ))}
              {localVideo && <DockLocalThumb />}
            </span>
          ) : (
            <span className="flex items-center -space-x-2 shrink-0" aria-hidden="true">
              {me && (
                <DockAvatar
                  userId={me.id}
                  username={me.username}
                  avatarUrl={me.avatarUrl}
                  avatarColor={me.avatarColor}
                  muted={!media.transmitting}
                />
              )}
              {others.map((p) => (
                <DockAvatar
                  key={p.userId}
                  userId={p.userId}
                  username={p.username}
                  avatarUrl={p.avatarUrl}
                  avatarColor={p.avatarColor}
                  muted={p.muted}
                />
              ))}
              {others.length === 0 && other && (
                <span className="relative rounded-full ring-2 ring-app-raise">
                  <Avatar name={other.username} color={other.avatarColor} url={other.avatarUrl} size="sm" />
                  <span className="absolute inset-0 rounded-full ring-2 ring-white/20 animate-ping" aria-hidden="true" />
                </span>
              )}
            </span>
          )}

          <span className="min-w-0 flex-1">
            <span className="flex items-baseline gap-2 min-w-0">
              <span className="min-w-0 truncate text-[13px] font-semibold">{title}</span>
              {ringing && <span className="shrink-0 text-[11px] text-muted-foreground">ringing…</span>}
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {ringing || !active.acceptedAt ? '' : formatDuration(elapsed)}
              </span>
              {others.length > 1 && (
                <span className="shrink-0 hidden sm:inline text-[11px] text-muted-foreground">
                  {active.participants.length} in call
                </span>
              )}
            </span>
          </span>

          <span className="flex items-center gap-1.5 shrink-0 text-[11px] font-semibold text-emerald-300 group-hover:text-emerald-200 transition-colors">
            <span className="hidden sm:inline">return</span>
            <Maximize2 className="size-3.5" aria-hidden="true" />
          </span>
        </button>

        {/* controls: the compact circular row, docked */}
        <div className="flex items-center gap-1 shrink-0 pl-1 border-l border-white/10">
          <DockButton active={!media.transmitting} label={media.muted ? 'unmute' : 'mute'} onClick={toggleCallMute}>
            {!media.transmitting ? <MicOff className="size-4" /> : <Mic className="size-4" />}
          </DockButton>
          <DockButton active={media.deafened} label={media.deafened ? 'undeafen' : 'deafen'} onClick={toggleCallDeafen}>
            {media.deafened ? <HeadphoneOff className="size-4" /> : <Headphones className="size-4" />}
          </DockButton>
          <div className="hidden sm:flex items-center gap-1">
            <DockButton active={media.cameraOn} label={media.cameraOn ? 'camera off' : 'camera on'} onClick={() => void toggleCallCamera()}>
              {media.cameraOn ? <Video className="size-4" /> : <VideoOff className="size-4" />}
            </DockButton>
            <EdgeLightButton className="size-9" iconClass="size-4" />
            <DockButton active={media.screenOn} label={media.screenOn ? 'stop sharing' : 'share screen'} onClick={() => void toggleCallScreen()}>
              {media.screenOn ? <MonitorX className="size-4" /> : <MonitorUp className="size-4" />}
            </DockButton>
          </div>
          <button
            type="button"
            onClick={() => {
              sounds.play('whoom')
              setCallFullscreen(true)
            }}
            className="grid place-items-center size-9 rounded-full call-btn text-foreground/80 hover:text-foreground hover:bg-white/10"
            aria-label="fullscreen call"
            title="fullscreen"
          >
            <Maximize2 className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (ringing) cancelOutgoingCall()
              else hangupCall()
            }}
            className="grid place-items-center size-9 rounded-full call-btn bg-red-500/90 text-white hover:bg-red-500 shadow-[0_0_16px_-6px_rgba(239,68,68,0.7)]"
            aria-label={ringing ? 'cancel call' : 'leave call'}
            title={ringing ? 'cancel' : 'leave call'}
          >
            <PhoneOff className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

/** Dock-sized control: the compact circular icon buttons on the call strip. */
function DockButton({
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
      aria-pressed={active}
      className={cn(
        'grid place-items-center size-9 rounded-full call-btn',
        active
          ? 'bg-white text-black'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent'
      )}
    >
      {children}
    </button>
  )
}
