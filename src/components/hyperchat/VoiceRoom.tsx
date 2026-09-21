'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useChatStore } from '@/lib/client/store'
import { voiceEngine } from '@/lib/client/voice'
import { roomLabelOf } from '@/lib/client/call-space'
import { callPrefs, onCallPrefsChanged, setCallLayout, type CallLayout } from '@/lib/client/call-prefs'
import { isTypingTarget } from '@/lib/client/ptt'
import { useIsMobile } from '@/hooks/use-mobile'
import type { ChannelSummary, ServerSummary, VoiceParticipantSummary } from '@/lib/types'
import { PERM, hasPerm } from '@/lib/perm'
import { Avatar } from './Avatar'
import { sounds } from '@/lib/client/sounds'
import { cn } from '@/lib/utils'
import { openContextMenu, type ContextMenuItem } from './ContextMenu'
import type { StreamMenuOpts } from './CallOverlay'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { Input } from '@/components/ui/input'
import {
  Circle,
  Crown,
  DoorOpen,
  AudioLines,
  Eye,
  EyeOff,
  Expand,
  Focus,
  HeadphoneOff,
  Headphones,
  LayoutGrid,
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  Minimize2,
  MonitorPlay,
  MonitorUp,
  MonitorX,
  Phone,
  PhoneForwarded,
  PhoneOff,
  Plus,
  RotateCcw,
  Upload,
  UserRound,
  UserPlus,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { PttControls } from './PttControls'
import { VoiceSettingsButton } from './VoiceSettings'
import { EdgeLightButton } from './EdgeLight'

// module-level constant: a selector that returns a fresh [] per call makes
// the snapshot look new on every render and trips React's infinite-update
// guard (this is what crashed voice channels whenever the mic was denied)
const NO_PARTICIPANTS: never[] = []

/** Live listening level for one participant, as the engine knows it. */
type Level = { volume: number; localMuted: boolean }

/** Reactive video layout preference, shared with the call surfaces: one
 *  grid-vs-speaker choice everywhere video tiles render. */
function useVoiceLayout(): CallLayout {
  return useSyncExternalStore(
    (cb) => onCallPrefsChanged(cb),
    () => callPrefs.layout
  )
}

/** Which channel the stage should follow: the call channel I am actually
 *  sitting in when my connection is "here" (the base channel or one of its
 *  synthetic call channels, ids "<channelId>~<slug>"), else the channel I
 *  am merely viewing. Pure, so it can run inside a store selector. */
function stageChannelOf(conn: { channelId: string } | null, activeChannelId: string | null): string | null {
  if (!conn || !activeChannelId) return activeChannelId
  const here = conn.channelId === activeChannelId || conn.channelId.startsWith(activeChannelId + '~')
  return here ? conn.channelId : activeChannelId
}

/** Five bars that dance with the participant's measured output level -
 * heights derive from the ~10Hz volume updates the store already pushes,
 * with a per-bar multiplier so the bars don't move in lockstep. */
function VolumeBars({ level, muted }: { level: number; muted: boolean }) {
  const bars = [0.55, 0.8, 1, 0.75, 0.5]
  return (
    <div className="flex items-end gap-[2.5px] h-3" aria-hidden="true">
      {bars.map((f, i) => {
        const h = muted ? 12 : Math.max(12, Math.min(100, level * 115 * f + (i % 2 ? 8 : 0)))
        return (
          <span
            key={i}
            className={cn('w-[3px] rounded-full transition-[height] duration-100 ease-out', muted ? 'bg-muted-foreground/40' : 'bg-hyper')}
            style={{ height: `${h}%` }}
          />
        )
      })}
    </div>
  )
}

/** One circular tile control: the shared shape for every per-person and
 *  stream action, so the common moves never need a right-click. Spreads
 *  the rest of its props (ref, data-state, aria) so it can also sit under
 *  a Radix PopoverTrigger asChild. */
type CircleButtonProps = {
  label: string
  onClick?: () => void
  children: ReactNode
  tone?: 'ghost' | 'hyper' | 'danger'
  size?: 6 | 7
} & Omit<ComponentProps<'button'>, 'onClick' | 'children'>

function CircleButton({ label, onClick, children, tone = 'ghost', size = 7, ...rest }: CircleButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      onClick={onClick}
      aria-label={rest['aria-label'] ?? label}
      title={rest.title ?? label}
      className={cn(
        'grid place-items-center rounded-full border backdrop-blur transition-all active:scale-90 shrink-0',
        size === 7 ? 'size-7' : 'size-6',
        tone === 'hyper' && 'border-hyper/50 bg-hyper/25 text-hyper hover:bg-hyper/35',
        tone === 'danger' && 'border-destructive/50 bg-destructive/25 text-destructive hover:bg-destructive/35',
        tone === 'ghost' && 'border-white/15 bg-black/60 text-white/80 hover:text-white hover:border-white/35'
      )}
    >
      {children}
    </button>
  )
}

/** Per-person audio as circles: the volume one opens the slider popover
 *  (0-200%, persisted), the other silences just this person for me. */
function TileVolumeControls({ userId, name, size = 7 }: { userId: string; name: string; size?: 6 | 7 }) {
  const [level, setLevel] = useState<Level>(() => voiceEngine.getLevelState(userId))
  const [open, setOpen] = useState(false)
  const iconSize = size === 7 ? 'size-3.5' : 'size-3'

  const setVolume = (v: number) => {
    voiceEngine.setRemoteVolume(userId, v)
    setLevel({ ...voiceEngine.getLevelState(userId) })
  }
  const toggleMute = () => {
    sounds.play('lightTick')
    voiceEngine.setRemoteLocalMute(userId, !level.localMuted)
    setLevel({ ...voiceEngine.getLevelState(userId) })
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <CircleButton
            label={`volume for ${name}, ${level.volume} percent`}
            onClick={() => sounds.play('lightTick')}
            tone={level.volume !== 100 ? 'hyper' : 'ghost'}
            size={size}
          >
            <Volume2 className={iconSize} aria-hidden="true" />
          </CircleButton>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-56 p-3 rounded-sm">
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
      <CircleButton
        label={level.localMuted ? `listen to ${name} again` : `silence ${name} for you`}
        onClick={toggleMute}
        tone={level.localMuted ? 'danger' : 'ghost'}
        size={size}
      >
        {level.localMuted ? <VolumeX className={iconSize} aria-hidden="true" /> : <Volume2 className={iconSize} aria-hidden="true" />}
      </CircleButton>
    </>
  )
}

/** Stream actions for a live video tile, as circles: open big (theater),
 *  fit vs fill, element fullscreen. The video element is read at click
 *  time so the freshest mount wins. */
function StreamControls({
  name,
  mode,
  onSetFit,
  onTheater,
  videoRef,
}: {
  name: string
  mode: 'cover' | 'contain'
  onSetFit: (fit: 'cover' | 'contain') => void
  onTheater: () => void
  videoRef: { current: HTMLVideoElement | null }
}) {
  return (
    <>
      <CircleButton
        label={`open ${name}'s stream big`}
        onClick={() => {
          sounds.play('whoom')
          onTheater()
        }}
      >
        <MonitorPlay className="size-3.5" aria-hidden="true" />
      </CircleButton>
      <CircleButton
        label={mode === 'contain' ? 'fill window' : 'fit to window'}
        onClick={() => {
          sounds.play('lightTick')
          onSetFit(mode === 'contain' ? 'cover' : 'contain')
        }}
      >
        {mode === 'contain' ? <Maximize2 className="size-3.5" aria-hidden="true" /> : <Minimize2 className="size-3.5" aria-hidden="true" />}
      </CircleButton>
      <CircleButton
        label="fullscreen"
        onClick={() => {
          sounds.play('lightTick')
          void videoRef.current?.requestFullscreen?.().catch(() => {})
        }}
      >
        <Expand className="size-3.5" aria-hidden="true" />
      </CircleButton>
    </>
  )
}

/** The red REC marker, shared with the call stage. */
function RecBadge() {
  return (
    <span
      className="flex items-center gap-1 rounded-full bg-red-500/90 text-white font-bold tracking-wide px-1.5 py-0.5 text-[10px] select-none"
      title="this channel is being recorded"
    >
      <span className="size-1.5 rounded-full bg-white animate-pulse" aria-hidden="true" />
      REC
    </span>
  )
}

/** The amber crown for the channel's priority speaker (voice-stage
 *  moderation): while that person transmits, every other participant's
 *  local output ducks so the crown always cuts through. Sits next to their
 *  name, matching the REC badge shape. */
function CrownBadge() {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full bg-amber-400/90 text-black p-0.5 select-none shrink-0"
      title="priority speaker"
    >
      <Crown className="size-3" aria-hidden="true" />
    </span>
  )
}

/** Compact header chip: who holds the priority-speaker crown right now, so
 *  everyone in the channel knows ducking is active. One line, subtle. */
function VoicePriorityChip({ channelId }: { channelId: string }) {
  const priorityUserId = useChatStore((s) => s.voicePriority[channelId])
  const participants = useChatStore((s) => s.voiceParticipants[channelId])
  if (!priorityUserId) return null
  const p = (participants ?? []).find((x) => x.userId === priorityUserId)
  if (!p) return null
  const name = p.displayName || p.username
  return (
    <span
      className="flex items-center gap-1 min-w-0 h-5 px-1.5 rounded-full border border-amber-400/40 bg-amber-400/15 text-amber-300 text-[10px] font-semibold shrink-0"
      title={`priority speaker: everyone else is ducked while ${name} talks`}
    >
      <Crown className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate max-w-32">crown: {name}</span>
    </span>
  )
}

/** The "being rung" strip: when someone rings a member into this channel,
 *  everyone looking at the stage sees their pinging chip until they answer,
 *  decline or the ring times out. Members already in the channel are
 *  filtered out; offline members stay listed (unlikely to answer), because
 *  ringing them is allowed too. */
function VoiceRingingStrip({ channelId }: { channelId: string }) {
  const ringing = useChatStore((s) => s.voiceRingingUsers[channelId])
  const participants = useChatStore((s) => s.voiceParticipants[channelId])
  const onlineUserIds = useChatStore((s) => s.onlineUserIds)

  if (!ringing || ringing.length === 0) return null
  const here = new Set((participants ?? []).map((p) => p.userId))
  const waiting = ringing.filter((u) => !here.has(u.userId))
  if (waiting.length === 0) return null

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center justify-center gap-2 flex-wrap max-w-full px-4 pointer-events-none">
      {waiting.map((u) => {
        const online = !!onlineUserIds[u.userId]
        const name = u.displayName || u.username
        return (
          <div
            key={u.userId}
            title={`${name} is being rung into the channel`}
            className="flex items-center gap-2 rounded-full bg-black/70 backdrop-blur border border-white/15 px-2 py-1 pointer-events-auto"
          >
            <span className="relative shrink-0">
              <Avatar
                name={u.username}
                color={u.avatarColor}
                url={u.avatarUrl}
                size="sm"
                className={cn(online ? '' : 'grayscale')}
              />
              <span className="absolute inset-0 rounded-full border animate-ping border-emerald-300/40" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-[10px] font-semibold truncate max-w-24">{name}</span>
              <span className={cn('block text-[9px] font-semibold truncate', online ? 'text-emerald-300' : 'text-muted-foreground')}>
                {online ? 'being rung…' : 'unlikely to answer'}
              </span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Your own camera/screen as one mosaic tile. The stream is read fresh on
 *  every render (the engine swaps its identity when camera and screen trade
 *  places or the device restarts) and the onPeers notification doubles as
 *  the re-render tick; the inline callback ref re-fires on each of those
 *  renders, so srcObject follows the live stream without freezing on the
 *  old one. The element stays muted: no double audio, no autoplay blocks.
 *  While sharing the screen, the Eye chip shows the live audience. Clicking
 *  it opens your own stream big (theater), same as remote tiles. */
function LocalVoiceVideoTile({
  me,
  self,
  speaking,
  watchers,
  fill,
  fit,
  isPriority,
  onSetFit,
  onTheater,
}: {
  me: { id?: string; username: string; displayName: string | null } | null
  self: { recording: boolean; cameraOn: boolean; screenOn: boolean }
  speaking: boolean
  watchers: { userId: string; displayName: string | null; username: string }[]
  fill?: boolean
  fit?: 'cover' | 'contain'
  /** I hold the priority-speaker crown in this channel */
  isPriority?: boolean
  onSetFit: (fit: 'cover' | 'contain') => void
  onTheater: () => void
}) {
  const [, setTick] = useState(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const unsub = voiceEngine.onPeers(() => setTick((t) => t + 1))
    return unsub
  }, [])

  // read fresh per render: the identity swaps between camera and screen
  const stream = voiceEngine.getLocalPreviewStream()
  const live = !!stream && stream.getVideoTracks().length > 0
  const attach = (el: HTMLVideoElement | null) => {
    videoRef.current = el
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream
      void el.play().catch(() => {})
    }
  }
  const watcherNames = watchers.map((w) => w.displayName || w.username)
  const mode = fit ?? 'contain'
  // stream opts are built at event time so the ref is read in the handler,
  // never during render
  const streamOpts = (): StreamMenuOpts => ({ isScreen: self.screenOn, fit: mode, onSetFit, onTheater, videoEl: videoRef.current })

  return (
    <div
      onContextMenu={(e) =>
        openVoiceParticipantMenu(
          e,
          { userId: me?.id ?? '', username: me?.username ?? 'you', displayName: me?.displayName ?? null, screen: self.screenOn },
          true,
          false,
          live ? streamOpts() : undefined
        )
      }
      onClick={live ? (e) => { if (e.button === 0) onTheater() } : undefined}
      className={cn(
        'relative group/tile min-w-0 bg-black rounded-md overflow-hidden border transition-[border-color,box-shadow] duration-200',
        fill ? 'size-full' : 'aspect-video',
        live && 'cursor-zoom-in',
        speaking ? 'border-emerald-400/80 shadow-[0_0_20px_-4px_rgba(52,211,153,0.55)]' : 'border-white/10'
      )}
    >
      {live ? (
        <video
          ref={attach}
          muted
          autoPlay
          playsInline
          className={cn('size-full', mode === 'contain' ? 'object-contain' : 'object-cover')}
          aria-label={self.screenOn ? 'your screen share' : 'your camera preview'}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <p className="text-[11px] text-muted-foreground">
            {self.screenOn ? 'starting screen share…' : 'camera starting…'}
          </p>
        </div>
      )}
      {/* clicks on the floating chips must not open theater */}
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/70 backdrop-blur text-[11px] font-semibold" onClick={(e) => e.stopPropagation()}>
        <span className="truncate max-w-36 text-emerald-300">{(me?.displayName || me?.username || 'you') + ' (you)'}</span>
        {isPriority && <CrownBadge />}
      </div>
      <div className="absolute top-2 left-2 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        {self.recording && <RecBadge />}
        {self.screenOn && !self.cameraOn && (
          <span className="px-1.5 py-0.5 rounded-full bg-black/70 backdrop-blur text-[10px] font-semibold text-hyper">your screen</span>
        )}
        {self.screenOn && (
          <span
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-black/70 backdrop-blur text-[10px] font-semibold',
              watchers.length > 0 ? 'text-emerald-300' : 'text-muted-foreground'
            )}
            title={
              watcherNames.length > 0
                ? `watching: ${watcherNames.join(', ')}`
                : 'nobody is watching your screen yet'
            }
          >
            <Eye className="size-3" aria-hidden="true" />
            {watchers.length === 0 ? 'no viewers' : `${watchers.length} ${watchers.length === 1 ? 'viewer' : 'viewers'}`}
          </span>
        )}
        {speaking && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-black/70 backdrop-blur text-[10px] font-semibold text-emerald-300 speaking-soft">
            <Volume2 className="size-3" aria-hidden="true" />
            speaking
          </span>
        )}
      </div>
      {/* stream options as hover circles: open big, fit vs fill, fullscreen.
          clicks here never open theater */}
      <div
        className="absolute top-2 right-2 flex items-center gap-1.5 opacity-0 group-hover/tile:opacity-100 focus-within:opacity-100 max-sm:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        <StreamControls
          name={me?.displayName || me?.username || 'you'}
          mode={mode}
          onSetFit={onSetFit}
          onTheater={onTheater}
          videoRef={videoRef}
        />
      </div>
    </div>
  )
}

/** One remote participant's video tile: their camera, or their screen —
 *  but a screen share is OPT-IN: until I click "watch", the tile stays a
 *  click-to-view card (and the share's audio stays silent in the engine);
 *  clicking that card watches it AND opens it big in one move.
 *  Same hardening as the call stage: the stream is read fresh per render,
 *  onPeers ticks the re-render, and the muted <video> mounts only once a
 *  live video track exists - before that the tile shows their avatar with
 *  a starting note instead of a black rectangle. Clicking a live tile
 *  opens it big (theater mode); `fill` drops the 16:9 crop so the speaker
 *  view spotlight can letterbox properly. */
function RemoteVoiceVideoTile({
  p,
  watching,
  fill,
  fit,
  isPriority,
  onSetFit,
  onTheater,
  compact,
}: {
  p: VoiceParticipantSummary
  watching: boolean
  fill?: boolean
  fit?: 'cover' | 'contain'
  /** this participant holds the priority-speaker crown */
  isPriority?: boolean
  onSetFit: (fit: 'cover' | 'contain') => void
  onTheater: () => void
  /** rail thumbnails: volume + unwatch circles only, no stream trio */
  compact?: boolean
}) {
  const [, setTick] = useState(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const watchScreen = useChatStore((s) => s.watchScreen)
  const unwatchScreen = useChatStore((s) => s.unwatchScreen)

  useEffect(() => {
    const unsub = voiceEngine.onPeers(() => setTick((t) => t + 1))
    return unsub
  }, [p.userId])

  // read fresh per render: the engine mutates the SAME MediaStream object
  // when tracks arrive (stable identity), the contents do not
  const stream = voiceEngine.getPeerStream(p.userId)
  // a share I have not opted into stays hidden (screen wins the m-line, so
  // there is no camera to fall back to while it runs)
  const screenGated = p.screen && !watching
  const showVideo = !screenGated && (p.video || p.screen) && !!stream && stream.getVideoTracks().length > 0
  const attach = (el: HTMLVideoElement | null) => {
    videoRef.current = el
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream
      void el.play().catch(() => {})
    }
  }
  const mode = fit ?? 'contain'

  const name = p.displayName || p.username
  const barsMuted = p.muted || p.deafened
  // their screen share's second audio m-line, live from the engine (the
  // onPeers tick above re-reads it as tracks arrive)
  const shareHasSound = p.screen && voiceEngine.getPeerScreenAudio(p.userId)
  // stream opts are built at event time so the ref is read in the handler,
  // never during render
  const streamOpts = (): StreamMenuOpts => ({ isScreen: p.screen && !p.video, fit: mode, onSetFit, onTheater, videoEl: videoRef.current })

  // not watching their share: the whole card is one click that watches
  // AND opens the share big (theater). the share's audio stays silent in
  // the engine until this opt-in happens.
  if (screenGated) {
    const watchBig = () => {
      sounds.play('midTick')
      watchScreen(p.userId)
      onTheater()
    }
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={watchBig}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            watchBig()
          }
        }}
        onContextMenu={(e) => openVoiceParticipantMenu(e, p, false, false)}
        className="group/tile aspect-video min-w-0 bg-app-raise rounded-md overflow-hidden border border-hyper/30 flex flex-col items-center justify-center gap-2.5 p-3 relative transition-all cursor-pointer hover:border-hyper/60 hover:bg-hyper/5 active:scale-[0.99]"
        aria-label={`watch ${name}'s screen share`}
        title={`watch ${name}'s screen share`}
      >
        <div className="relative">
          <Avatar name={p.username} color={p.avatarColor} url={p.avatarUrl} size="md" />
          <span className="absolute -top-1.5 -right-1.5 grid place-items-center size-5 rounded-full bg-hyper/20 ring-2 ring-app-raise">
            <MonitorUp className="size-3 text-hyper" aria-hidden="true" />
          </span>
        </div>
        <p className="text-[11px] font-semibold text-center truncate max-w-full">
          {name} <span className="text-muted-foreground font-normal">is sharing their screen</span>
        </p>
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-hyper">
          <Eye className="size-3.5" aria-hidden="true" />
          click to watch
        </span>
        <div className="absolute bottom-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/40 backdrop-blur text-[11px] font-semibold pointer-events-none">
          {(p.muted || p.deafened) && <MicOff className="size-3 text-red-400" aria-hidden="true" />}
          <span className="truncate max-w-36">{name}</span>
          {isPriority && <CrownBadge />}
          <VolumeBars level={p.volume} muted={barsMuted} />
        </div>
        {p.recording && <div className="absolute top-2 left-2"><RecBadge /></div>}
      </div>
    )
  }

  return (
    <div
      onContextMenu={(e) => openVoiceParticipantMenu(e, p, false, watching, showVideo ? streamOpts() : undefined)}
      onClick={showVideo ? (e) => { if (e.button === 0) onTheater() } : undefined}
      className={cn(
        'relative group/tile min-w-0 bg-black rounded-md overflow-hidden border transition-[border-color,box-shadow] duration-200',
        fill ? 'size-full' : 'aspect-video',
        showVideo && 'cursor-zoom-in',
        p.speaking
          ? 'border-emerald-400/80 shadow-[0_0_20px_-4px_rgba(52,211,153,0.55)]'
          : 'border-white/10'
      )}
    >
      {showVideo ? (
        <video
          ref={attach}
          muted
          autoPlay
          playsInline
          className={cn('size-full', mode === 'contain' ? 'object-contain' : 'object-cover')}
          aria-label={`${name}${p.screen ? ' screen share' : ' camera'}`}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <div className="flex flex-col items-center gap-2 py-4">
            <Avatar name={p.username} color={p.avatarColor} url={p.avatarUrl} size="lg" />
            <p className="text-[11px] text-muted-foreground">{p.screen ? 'starting screen share…' : 'connecting…'}</p>
          </div>
        </div>
      )}
      <div className="absolute bottom-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/70 backdrop-blur text-[11px] font-semibold">
        {(p.muted || p.deafened) && <MicOff className="size-3 text-red-400" aria-hidden="true" />}
        <span className="truncate max-w-36">{name}</span>
        {isPriority && <CrownBadge />}
        <VolumeBars level={p.volume} muted={barsMuted} />
      </div>
      <div className="absolute top-2 left-2 flex items-center gap-1.5">
        {p.recording && <RecBadge />}
        {p.screen && !p.video && (
          <span className="px-1.5 py-0.5 rounded-full bg-black/70 backdrop-blur text-[10px] font-semibold text-hyper">{name}'s screen</span>
        )}
        {shareHasSound && (
          <span
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-black/70 backdrop-blur text-[10px] font-semibold text-emerald-300"
            title="this screen share carries sound"
          >
            <Volume2 className="size-3" aria-hidden="true" />
            sound
          </span>
        )}
      </div>
      {/* hover circles: stop watching, per-person volume and silence, open
          big, fit vs fill, fullscreen. clicks here never open theater */}
      <div
        className="absolute top-2 right-2 flex items-center gap-1.5 opacity-0 group-hover/tile:opacity-100 focus-within:opacity-100 max-sm:opacity-100 transition-opacity"
        onClick={(e) => e.stopPropagation()}
      >
        {p.screen && (
          <CircleButton
            label={`stop watching ${name}'s screen`}
            onClick={() => {
              sounds.play('lightTick')
              unwatchScreen(p.userId)
            }}
            size={compact ? 6 : 7}
          >
            <EyeOff className={compact ? 'size-3' : 'size-3.5'} aria-hidden="true" />
          </CircleButton>
        )}
        <TileVolumeControls userId={p.userId} name={name} size={compact ? 6 : 7} />
        {!compact && <StreamControls name={name} mode={mode} onSetFit={onSetFit} onTheater={onTheater} videoRef={videoRef} />}
      </div>
    </div>
  )
}

/** The plus circle: ring anyone on this server into the channel I am
 *  sitting in - the base voice channel, or the call channel I hopped into
 *  (rings land where I am). Offline members are ringable too; they just
 *  show as unlikely to answer. */
function RingIntoChannelControl({ channelId, serverId }: { channelId: string; serverId: string }) {
  const [open, setOpen] = useState(false)
  const me = useChatStore((s) => s.me)
  const servers = useChatStore((s) => s.servers)
  const serverMembers = useChatStore((s) => s.serverMembers[serverId])
  const voiceParticipants = useChatStore((s) => s.voiceParticipants[channelId])
  const onlineUserIds = useChatStore((s) => s.onlineUserIds)
  const ringUserIntoVoice = useChatStore((s) => s.ringUserIntoVoice)

  const server = servers.find((s) => s.id === serverId)
  // the id may be a synthetic call channel (<base>~<slug>): its label is
  // the room's own name, the owning channel hangs off the base id
  const baseId = channelId.split('~')[0]
  const channel = server?.channels.find((c) => c.id === baseId)
  const targetLabel = channelId.includes('~') ? roomLabelOf(channelId) || 'call channel' : channel?.name ?? 'channel'
  const here = new Set((voiceParticipants ?? []).map((p) => p.userId))
  const candidates = (serverMembers ?? [])
    .filter((m) => m.id !== me?.id && !here.has(m.id))
    .sort(
      (a, b) =>
        Number(!!onlineUserIds[b.id]) - Number(!!onlineUserIds[a.id]) ||
        (a.displayName || a.username).localeCompare(b.displayName || b.username)
    )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="ring someone into this channel"
          title="ring into channel"
          className={cn(
            'p-1.5 rounded-sm transition-colors',
            open ? 'bg-emerald-400/20 text-emerald-300' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
          )}
        >
          <UserPlus className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-60 p-2 rounded-sm">
        <p className="px-1.5 pb-1.5 text-[10px] font-bold tracking-widest text-muted-foreground select-none">
          ring into {targetLabel}
        </p>
        {candidates.length === 0 ? (
          <p className="px-1.5 py-3 text-xs text-muted-foreground">nobody else on this server</p>
        ) : (
          <div className="max-h-72 overflow-y-auto nice-scrollbar flex flex-col gap-0.5">
            {candidates.map((m) => {
              const online = !!onlineUserIds[m.id]
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    sounds.play('lightTick')
                    ringUserIntoVoice(channelId, serverId, m.id)
                    setOpen(false)
                  }}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-1.5 py-1.5 rounded-sm text-left transition-colors hover:bg-accent',
                    !online && 'opacity-60'
                  )}
                >
                  <Avatar name={m.username} color={m.avatarColor} url={m.avatarUrl} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold truncate">{m.displayName || m.username}</span>
                    <span className="block text-[10px] text-muted-foreground truncate">
                      {online ? 'online' : 'offline · unlikely to answer'}
                    </span>
                  </span>
                  <PhoneForwarded className="size-3.5 text-emerald-300 shrink-0" aria-hidden="true" />
                </button>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** lucide-react 0.525 ships no PhonePlus glyph, so the call UI composes
 *  one (same as CallOverlay): a phone with a small emerald plus badge at
 *  its corner - here it marks the call-channel create submit. */
function PhonePlusGlyph() {
  return (
    <span className="relative inline-flex" aria-hidden="true">
      <Phone className="size-3.5" />
      <span className="absolute -right-1 -bottom-0.5 grid place-items-center size-3 rounded-full bg-emerald-400 text-black">
        <Plus className="size-1.5" strokeWidth={3} />
      </span>
    </span>
  )
}

/** Call channels for a server voice channel: named side spaces
 *  ("<channelId>~<slug>") members spin up while hanging out - listed with
 *  their headcount and a hop-in button, plus a way back to the main
 *  channel when sitting in one. Admins can disable creating them per
 *  server; joining the ones that already exist stays allowed. */
function VoiceCallChannelsControl({
  channelId,
  serverId,
  disabled,
}: {
  channelId: string
  serverId: string
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const me = useChatStore((s) => s.me)
  const voiceConnected = useChatStore((s) => s.voiceConnected)
  const voiceParticipants = useChatStore((s) => s.voiceParticipants)
  const createVoiceCallChannel = useChatStore((s) => s.createVoiceCallChannel)
  const switchVoiceSpace = useChatStore((s) => s.switchVoiceSpace)

  const rooms = Object.entries(voiceParticipants).filter(
    ([id, list]) => id.startsWith(channelId + '~') && list.length > 0
  )
  // sitting in one of the call channels: offer the way back to the main one
  const inCallChannel = !!voiceConnected && voiceConnected.channelId !== channelId

  const hopTo = (target: string) => {
    sounds.play('callEnter')
    // the switch keeps camera/screen/mute alive across the hop
    void switchVoiceSpace(target, serverId)
    setOpen(false)
  }

  const create = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    sounds.play('midTick')
    void createVoiceCallChannel(channelId, serverId, trimmed)
    setName('')
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="call channels"
          title="call channels"
          className={cn(
            'p-1.5 rounded-sm transition-colors',
            open ? 'bg-emerald-400/20 text-emerald-300' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
          )}
        >
          <DoorOpen className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-64 p-2 rounded-sm">
        <p className="px-1.5 pb-1.5 text-[10px] font-bold tracking-widest text-muted-foreground select-none">
          call channels
        </p>
        {inCallChannel && (
          <div className="flex items-center gap-2 px-1.5 py-1.5 rounded-sm hover:bg-accent transition-colors">
            <span className="size-6 rounded-full bg-app-raise border border-white/10 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold truncate">main channel</span>
              <span className="block text-[10px] text-muted-foreground tabular-nums">
                {voiceParticipants[channelId]?.length ?? 0} in channel
              </span>
            </span>
            <button
              type="button"
              onClick={() => hopTo(channelId)}
              className="shrink-0 flex items-center gap-1 h-7 px-2 rounded-sm bg-emerald-500/90 text-white text-[11px] font-semibold hover:bg-emerald-500 active:scale-95 transition-all"
              aria-label="join the main channel"
            >
              <Phone className="size-3" />
              join
            </button>
          </div>
        )}
        {rooms.length === 0 ? (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">no call channels yet</p>
        ) : (
          <div className="flex flex-col gap-0.5 max-h-56 overflow-y-auto nice-scrollbar">
            {rooms.map(([id, list]) => {
              const mine = voiceConnected?.channelId === id
              const others = list.filter((p) => p.userId !== me?.id)
              const label = roomLabelOf(id)
              return (
                <div key={id} className="flex items-center gap-2 px-1.5 py-1.5 rounded-sm hover:bg-accent transition-colors">
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
                    <span className="block text-[13px] font-semibold truncate">{label}</span>
                    <span className="block text-[10px] text-muted-foreground tabular-nums">{list.length} in channel</span>
                  </span>
                  {mine ? (
                    <span className="shrink-0 text-[10px] font-bold text-emerald-300 pr-1">in here</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => hopTo(id)}
                      className="shrink-0 flex items-center gap-1 h-7 px-2 rounded-sm bg-emerald-500/90 text-white text-[11px] font-semibold hover:bg-emerald-500 active:scale-95 transition-all"
                      aria-label={`join channel ${label}`}
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
          {disabled ? (
            <p className="px-1.5 py-1.5 text-[10px] text-muted-foreground">call channels are disabled by admins</p>
          ) : (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault()
                create()
              }}
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="new channel name…"
                maxLength={32}
                className="h-7 text-xs rounded-sm"
                aria-label="new call channel name"
              />
              <button
                type="submit"
                disabled={!name.trim()}
                className="grid place-items-center size-7 rounded-sm bg-emerald-500/90 text-white hover:bg-emerald-500 disabled:opacity-40 transition-colors shrink-0"
                aria-label="create call channel"
                title="create call channel"
              >
                <PhonePlusGlyph />
              </button>
            </form>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Live volume row for the right-click menu: writes the voice engine's
 *  per-person volume (0-200%, persisted) exactly like the tile controls. */
function VoiceVolumeRow({ userId }: { userId: string }) {
  const [level, setLevel] = useState(() => voiceEngine.getLevelState(userId))
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
          voiceEngine.setRemoteVolume(userId, v[0] ?? 100)
          setLevel({ ...voiceEngine.getLevelState(userId) })
        }}
        aria-label="participant volume"
      />
    </div>
  )
}

/** Right-click on anyone in the channel: their profile, a DM, their screen
 *  share (watch / stop watching) and local volume controls over their audio.
 *  Your own tile gets the profile only, like the call stage. Tiles actively
 *  showing video append the same stream options the call stage has: theater
 *  mode, fit vs fill, element fullscreen. */
function openVoiceParticipantMenu(
  e: React.MouseEvent,
  p: { userId: string; username: string; displayName: string | null; screen: boolean },
  self: boolean,
  watching: boolean,
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
    if (p.screen) {
      items.push(
        { kind: 'separator' },
        watching
          ? {
              kind: 'item',
              label: `stop watching ${name}'s screen`,
              icon: EyeOff,
              onSelect: () => {
                sounds.play('lightTick')
                state.unwatchScreen(p.userId)
              },
            }
          : {
              kind: 'item',
              label: `watch ${name}'s screen`,
              icon: Eye,
              accent: true,
              onSelect: () => {
                sounds.play('midTick')
                state.watchScreen(p.userId)
              },
            }
      )
    }
    const level = voiceEngine.getLevelState(p.userId)
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
      { kind: 'node', render: () => <VoiceVolumeRow userId={p.userId} /> },
      { kind: 'separator' },
      {
        kind: 'item',
        label: level.localMuted ? `listen to ${name} again` : `mute ${name} for you`,
        icon: level.localMuted ? Volume2 : VolumeX,
        onSelect: () => {
          sounds.play('lightTick')
          voiceEngine.setRemoteLocalMute(p.userId, !level.localMuted)
        },
      }
    )
  }
  // stream options while video is live: the same trio the call stage offers
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
  // voice-stage moderation: managers may crown one participant as the
  // priority speaker; while that person transmits, everyone else's local
  // output ducks so the crown always cuts through (own tile included - a
  // moderator can crown themselves for an announcement)
  const conn = state.voiceConnected
  if (conn) {
    const perms = state.servers.find((s) => s.id === conn.serverId)?.myPerms
    if (perms !== undefined && hasPerm(perms, PERM.MANAGE_SERVER)) {
      const crowned = state.voicePriority[conn.channelId] === p.userId
      items.push(
        { kind: 'separator' },
        {
          kind: 'item',
          label: crowned ? 'remove priority speaker' : 'make priority speaker',
          icon: Crown,
          onSelect: () => {
            sounds.play('midTick')
            state.setPrioritySpeaker(crowned ? null : p.userId)
          },
        }
      )
    }
  }
  openContextMenu(e, items, {
    title: name,
    subtitle: stream?.isScreen ? 'screen share' : self ? 'you' : p.screen ? 'sharing their screen' : undefined,
  })
}

/** The server's soundboard: sound files this server's admins uploaded.
 *  Anyone in the channel plays them into the outbound voice mix (everyone
 *  hears it, the sender gets the local monitor); admins add and remove
 *  sounds right here. The list loads on first open and refreshes live
 *  through the soundboard:update socket event. */
function SoundboardControl({ serverId, canManage }: { serverId: string; canManage: boolean }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<File | null>(null)
  const [name, setName] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const list = useChatStore((s) => s.soundboards[serverId])
  const refreshSoundboard = useChatStore((s) => s.refreshSoundboard)
  const playVoiceSound = useChatStore((s) => s.playVoiceSound)
  const addSoundboardSound = useChatStore((s) => s.addSoundboardSound)
  const removeSoundboardSound = useChatStore((s) => s.removeSoundboardSound)

  // first open loads the server's list (a live update refetches it after)
  useEffect(() => {
    if (open && list === undefined) void refreshSoundboard(serverId)
  }, [open, list, serverId, refreshSoundboard])

  const pickFile = (file: File | null) => {
    setPicked(file)
    // the name field follows the file until the admin edits it by hand
    setName((prev) => (prev && picked ? prev : file ? file.name.replace(/\.[^.]+$/, '').slice(0, 32) : prev))
  }

  const upload = async () => {
    if (!picked || !name.trim() || busy) return
    setBusy(true)
    const ok = await addSoundboardSound(serverId, picked, name.trim())
    setBusy(false)
    if (ok) {
      setPicked(null)
      setName('')
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="p-1.5 rounded-sm transition-colors text-muted-foreground hover:text-foreground hover:bg-accent"
          aria-label="soundboard"
          title="soundboard"
        >
          <AudioLines className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-64 p-2 rounded-sm">
        <p className="px-1.5 pb-1.5 text-[10px] font-bold tracking-widest text-muted-foreground select-none">
          soundboard
        </p>
        {list === undefined ? (
          <div className="px-1.5 py-3 flex flex-col gap-1.5 items-center">
            <span className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin" aria-hidden="true" />
            <p className="text-[11px] text-muted-foreground">loading sounds…</p>
          </div>
        ) : list.length === 0 ? (
          <p className="px-1.5 py-3 text-xs text-muted-foreground">no sounds yet</p>
        ) : (
          <div className="flex flex-col gap-0.5 max-h-64 overflow-y-auto nice-scrollbar">
            {list.map((s) => (
              <div key={s.id} className="group/row flex items-center gap-2 px-1.5 py-1.5 rounded-sm hover:bg-accent transition-colors">
                <button
                  type="button"
                  onClick={() => {
                    void playVoiceSound(serverId, s.id)
                  }}
                  className="min-w-0 flex-1 flex items-center gap-2 text-left"
                  aria-label={`play ${s.name}`}
                  title={`play ${s.name}`}
                >
                  <span className="grid place-items-center size-6 rounded-sm bg-app-raise border border-white/10 shrink-0 text-hyper">
                    <AudioLines className="size-3" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold truncate">{s.name}</span>
                    <span className="block text-[10px] text-muted-foreground tabular-nums">
                      {(s.size / 1024).toFixed(0)} KB · {s.mime.split('/')[1] ?? 'audio'}
                    </span>
                  </span>
                </button>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => {
                      sounds.play('lightTick')
                      void removeSoundboardSound(serverId, s.id)
                    }}
                    className="shrink-0 grid place-items-center size-6 rounded-sm text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10 transition-colors"
                    aria-label={`remove ${s.name}`}
                    title="remove sound"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {canManage && (
          <div className="mt-1.5 pt-1.5 border-t border-border flex flex-col gap-1.5">
            <div className="flex items-center gap-1">
              <input
                ref={fileRef}
                type="file"
                accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac,.opus"
                className="sr-only"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                aria-label="pick a sound file"
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-1.5 h-7 px-2 rounded-sm bg-app-raise border border-white/10 hover:border-white/25 text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors truncate max-w-[130px]"
                aria-label="pick an audio file to upload"
                title="pick an audio file (mp3, wav, ogg… up to 2 MB)"
              >
                <Upload className="size-3 shrink-0" />
                <span className="truncate">{picked ? picked.name : 'pick audio file'}</span>
              </button>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="name…"
                maxLength={32}
                className="h-7 text-xs rounded-sm flex-1 min-w-0"
                aria-label="sound name"
              />
              <button
                type="button"
                disabled={!picked || !name.trim() || busy}
                onClick={() => void upload()}
                className="grid place-items-center size-7 rounded-sm bg-emerald-500/90 text-white hover:bg-emerald-500 disabled:opacity-40 transition-colors shrink-0"
                aria-label="upload sound"
                title="add to the server's soundboard"
              >
                {busy ? <span className="size-3 rounded-full border-2 border-white/40 border-t-white animate-spin" /> : <Plus className="size-3.5" />}
              </button>
            </div>
            <p className="px-1.5 text-[10px] text-muted-foreground">mp3 / wav / ogg · up to 2 MB</p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}


/** Theater mode: one stream across the whole voice stage without lifting
 *  the room into the browser fullscreen takeover. Works for a remote
 *  participant (by id) or your own camera/screen (my id). Fit vs fill,
 *  fullscreen and exit sit as circles top-right; Esc still folds it back. */
function VoiceTheaterSurface({
  userId,
  label,
  onExit,
  fit,
  onSetFit,
}: {
  userId: string
  label: string
  onExit: () => void
  fit: 'cover' | 'contain'
  onSetFit: (fit: 'cover' | 'contain') => void
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [, setTick] = useState(0)
  const me = useChatStore((s) => s.me)

  useEffect(() => {
    const unsub = voiceEngine.onPeers(() => setTick((t) => t + 1))
    return unsub
  }, [userId])

  const stream = userId === me?.id ? voiceEngine.getLocalPreviewStream() : voiceEngine.getPeerStream(userId)
  const attach = (el: HTMLVideoElement | null) => {
    videoRef.current = el
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream
      void el.play().catch(() => {})
    }
  }
  const fullscreen = () => {
    sounds.play('lightTick')
    void videoRef.current?.requestFullscreen?.().catch(() => {})
  }

  return (
    <div className="absolute inset-0 bg-black view-in">
      {stream && stream.getVideoTracks().length > 0 ? (
        <video
          ref={attach}
          muted
          autoPlay
          playsInline
          onDoubleClick={fullscreen}
          className={cn('size-full', fit === 'contain' ? 'object-contain' : 'object-cover')}
          aria-label={`${label} stream, theater mode`}
        />
      ) : (
        <div className="size-full grid place-items-center">
          <p className="text-xs text-muted-foreground">stream ended</p>
        </div>
      )}
      <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/70 backdrop-blur border border-white/15 text-[11px] font-semibold pointer-events-none">
        <MonitorPlay className="size-3.5 text-hyper" aria-hidden="true" />
        {label}
      </div>
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1.5">
        <CircleButton
          label={fit === 'contain' ? 'fill window' : 'fit to window'}
          onClick={() => {
            sounds.play('lightTick')
            onSetFit(fit === 'contain' ? 'cover' : 'contain')
          }}
        >
          {fit === 'contain' ? <Maximize2 className="size-3.5" aria-hidden="true" /> : <Minimize2 className="size-3.5" aria-hidden="true" />}
        </CircleButton>
        <CircleButton label="fullscreen" onClick={fullscreen}>
          <Expand className="size-3.5" aria-hidden="true" />
        </CircleButton>
        <CircleButton
          label="exit theater (esc)"
          onClick={() => {
            sounds.play('lightTick')
            onExit()
          }}
        >
          <X className="size-3.5" aria-hidden="true" />
        </CircleButton>
      </div>
    </div>
  )
}

/** The in-call control row, shared by the inline top bar and the fullscreen
 *  takeover's bottom bar: mute, deafen, camera, screen, PTT, record,
 *  soundboard, ring, call channels, the video layout toggle, fullscreen and
 *  leave. Inline keeps the compact icon buttons; the fullscreen variant
 *  grows every button into a 44px touch circle through a descendant
 *  selector (portal-ed popover contents are unaffected). */
function VoiceControlRow({
  channelId,
  connChannelId,
  server,
  variant,
  showLayoutToggle,
  onToggleFullscreen,
}: {
  /** the base voice channel the view is on (call channels hang off it) */
  channelId: string
  /** the channel I am actually sitting in (rings land where I am) */
  connChannelId: string
  server: ServerSummary | null
  variant: 'inline' | 'fullscreen'
  showLayoutToggle: boolean
  onToggleFullscreen: () => void
}) {
  const voiceSelf = useChatStore((s) => s.voiceSelf)
  const leaveVoice = useChatStore((s) => s.leaveVoice)
  const toggleVoiceMute = useChatStore((s) => s.toggleVoiceMute)
  const toggleVoiceDeafen = useChatStore((s) => s.toggleVoiceDeafen)
  const toggleVoiceRecording = useChatStore((s) => s.toggleVoiceRecording)
  const toggleVoiceCamera = useChatStore((s) => s.toggleVoiceCamera)
  const toggleVoiceScreen = useChatStore((s) => s.toggleVoiceScreen)
  const layout = useVoiceLayout()
  const canManage = !!server && (server.myPerms & (PERM.ADMINISTRATOR | PERM.MANAGE_SERVER)) !== 0

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1',
        variant === 'fullscreen'
          ? 'justify-center [&_button]:size-11 [&_button]:min-w-11 [&_button]:p-0 [&_button]:grid [&_button]:place-items-center [&_button]:rounded-full'
          : 'justify-end'
      )}
      role="toolbar"
      aria-label="voice controls"
    >
      <button
        onClick={() => {
          sounds.play('lightTick')
          toggleVoiceMute()
        }}
        className={cn(
          'p-1.5 rounded-sm transition-colors',
          !voiceSelf.transmitting ? 'bg-destructive/20 text-destructive' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        )}
        aria-label={voiceSelf.muted ? 'unmute (m)' : voiceSelf.transmitting ? 'mute (m)' : 'push to talk: mic closed'}
        title={
          voiceSelf.muted
            ? 'unmute'
            : voiceSelf.pttEnabled
              ? voiceSelf.pttActive
                ? 'transmitting'
                : 'push to talk: mic closed until you hold the key'
              : 'mute'
        }
      >
        {!voiceSelf.transmitting ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      </button>
      <button
        onClick={() => {
          sounds.play('lightTick')
          toggleVoiceDeafen()
        }}
        className={cn(
          'p-1.5 rounded-sm transition-colors',
          voiceSelf.deafened ? 'bg-destructive/20 text-destructive' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        )}
        aria-label={voiceSelf.deafened ? 'undeafen (d)' : 'deafen (d)'}
        title={voiceSelf.deafened ? 'undeafen' : 'deafen'}
      >
        {voiceSelf.deafened ? <HeadphoneOff className="size-4" /> : <Headphones className="size-4" />}
      </button>
      {/* camera on/off: turns the voice channel into a video room */}
      <button
        onClick={() => {
          sounds.play('lightTick')
          void toggleVoiceCamera()
        }}
        className={cn(
          'p-1.5 rounded-sm transition-colors',
          voiceSelf.cameraOn ? 'bg-white text-black' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        )}
        aria-label={voiceSelf.cameraOn ? 'camera on' : 'camera off'}
        title="camera"
      >
        {voiceSelf.cameraOn ? <Video className="size-4" /> : <VideoOff className="size-4" />}
      </button>
      {/* ambient camera light (experimental): warm edge glow while the camera is on */}
      <EdgeLightButton className="p-1.5 rounded-sm" iconClass="size-4" />
      {/* screen share: your screen with its sound */}
      <button
        onClick={() => {
          sounds.play('lightTick')
          void toggleVoiceScreen()
        }}
        className={cn(
          'p-1.5 rounded-sm transition-colors',
          voiceSelf.screenOn ? 'bg-white text-black' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        )}
        aria-label={voiceSelf.screenOn ? 'stop sharing' : 'share screen'}
        title={voiceSelf.screenOn ? 'stop sharing' : 'share screen'}
      >
        {voiceSelf.screenOn ? <MonitorUp className="size-4" /> : <MonitorX className="size-4" />}
      </button>
      <PttControls />
      {/* the recorder: mixes the whole channel into one file,
          downloaded on stop; the channel hears the warning */}
      <button
        onClick={() => {
          sounds.play(voiceSelf.recording ? 'lightTick' : 'midTick')
          toggleVoiceRecording()
        }}
        className={cn(
          'p-1.5 rounded-sm transition-colors',
          voiceSelf.recording ? 'bg-red-500/25 text-red-400 hover:bg-red-500/35' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        )}
        aria-label={voiceSelf.recording ? 'stop recording (downloads the file)' : 'record channel'}
        title={voiceSelf.recording ? 'stop recording' : 'record channel'}
      >
        <Circle className={cn('size-4', voiceSelf.recording && 'fill-current animate-pulse')} />
      </button>
      {/* the soundboard: this server's admin-uploaded sounds, played
          into the channel mix */}
      {server && <SoundboardControl serverId={server.id} canManage={canManage} />}
      {/* ring anyone on the server into the channel I am sitting in
          (the call channel when I hopped into one) */}
      {server && <RingIntoChannelControl channelId={connChannelId} serverId={server.id} />}
      {/* call channels: named side spaces hanging off this voice channel */}
      {server && <VoiceCallChannelsControl channelId={channelId} serverId={server.id} disabled={server.callChannelsEnabled === false} />}
      {/* grid vs speaker view, same preference the call stage uses */}
      {showLayoutToggle && (
        <button
          onClick={() => {
            sounds.play('lightTick')
            setCallLayout(layout === 'speaker' ? 'grid' : 'speaker')
          }}
          className={cn(
            'p-1.5 rounded-sm transition-colors',
            layout === 'speaker' ? 'bg-white text-black' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
          )}
          aria-label={layout === 'speaker' ? 'grid view' : 'speaker view'}
          title={layout === 'speaker' ? 'grid view' : 'speaker view'}
        >
          {layout === 'speaker' ? <LayoutGrid className="size-4" /> : <Focus className="size-4" />}
        </button>
      )}
      {/* the stage takeover, mirroring the call overlay */}
      {variant === 'inline' ? (
        <button
          onClick={onToggleFullscreen}
          className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="fullscreen (f)"
          title="fullscreen (f)"
        >
          <Maximize2 className="size-4" />
        </button>
      ) : (
        <button
          onClick={onToggleFullscreen}
          className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="exit fullscreen (f)"
          title="exit fullscreen (f)"
        >
          <Minimize2 className="size-4" />
        </button>
      )}
      <button
        onClick={() => {
          sounds.play('lightTick')
          leaveVoice()
        }}
        className={cn(
          'p-1.5 rounded-sm transition-colors',
          variant === 'fullscreen'
            ? 'bg-red-500/90 text-white hover:bg-red-500 shadow-[0_0_20px_-6px_rgba(239,68,68,0.75)] ml-1'
            : 'bg-destructive/15 text-destructive hover:bg-destructive/25'
        )}
        aria-label="leave voice"
        title="leave voice"
      >
        <PhoneOff className="size-4" />
      </button>
    </div>
  )
}

/** Everything between "connected to a voice channel" and pixels, shared by
 *  the inline surface and the fullscreen takeover: the stage (theater mode,
 *  grid / speaker mosaics, avatar cards, the join CTA) plus the chrome
 *  around it (top bar inline, header + bottom control bar fullscreen).
 *  Theater / per-tile fit live here per variant, exactly like the call
 *  stage's two instances. */
function VoiceStageContent({
  channel,
  server,
  variant,
}: {
  channel: ChannelSummary
  server: ServerSummary | null
  variant: 'inline' | 'fullscreen'
}) {
  const me = useChatStore((s) => s.me)
  const voiceConnected = useChatStore((s) => s.voiceConnected)
  const voiceSelf = useChatStore((s) => s.voiceSelf)
  const voiceUnavailable = useChatStore((s) => s.voiceUnavailable)
  const socketUp = useChatStore((s) => s.connected)
  const joinVoice = useChatStore((s) => s.joinVoice)
  const toggleVoiceMute = useChatStore((s) => s.toggleVoiceMute)
  const toggleVoiceDeafen = useChatStore((s) => s.toggleVoiceDeafen)
  const setVoiceFullscreen = useChatStore((s) => s.setVoiceFullscreen)
  const watchingScreens = useChatStore((s) => s.watchingScreens)
  const myScreenWatchers = useChatStore((s) => s.myScreenWatchers)
  const isMobile = useIsMobile()
  const layout = useVoiceLayout()
  /** theater mode: the participant whose stream owns the whole stage */
  const [theater, setTheater] = useState<string | null>(null)
  /** per-tile fit choice (cover / contain); unset letterboxes */
  const [tileFit, setTileFit] = useState<Record<string, 'cover' | 'contain'>>({})
  // the stage list follows the channel I am actually sitting in (my call
  // channel when I hopped into one); resolved inside the selector so other
  // channels' state churn never re-renders this surface
  const participants = useChatStore((s) => {
    const stage = stageChannelOf(s.voiceConnected, channel.id)
    return stage ? s.voiceParticipants[stage] ?? NO_PARTICIPANTS : NO_PARTICIPANTS
  })
  // who holds the priority-speaker crown on this stage (same selector
  // pattern: follows the channel I am sitting in)
  const priorityUserId = useChatStore((s) => {
    const stage = stageChannelOf(s.voiceConnected, channel.id)
    return stage ? s.voicePriority[stage] : undefined
  })

  const conn = voiceConnected
  // connected "here" = the base channel OR any of its call channels
  const connectedHere = !!conn && (conn.channelId === channel.id || conn.channelId.startsWith(channel.id + '~'))
  const stageChannelId = stageChannelOf(conn, channel.id) ?? channel.id
  const callLabel = connectedHere && conn && conn.channelId !== channel.id ? roomLabelOf(conn.channelId) : ''
  const anyVideo = voiceSelf.cameraOn || voiceSelf.screenOn || participants.some((p) => p.video || p.screen)

  // a new stage resets the per-stage viewing choices (state adjusted during
  // render: React's documented pattern, same as the call stage)
  const [lastStage, setLastStage] = useState(stageChannelId)
  if (stageChannelId !== lastStage) {
    setLastStage(stageChannelId)
    setTheater(null)
    setTileFit({})
  }

  // M / D / F call-style shortcuts while sitting in this channel; Esc folds
  // theater mode back into the mosaic. Ignored while typing.
  useEffect(() => {
    if (!connectedHere) return
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || isTypingTarget(e.target)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.code === 'KeyM') {
        e.preventDefault()
        toggleVoiceMute()
      } else if (e.code === 'KeyD') {
        e.preventDefault()
        toggleVoiceDeafen()
      } else if (e.code === 'KeyF' && !isMobile) {
        e.preventDefault()
        sounds.play('whoom')
        setVoiceFullscreen(variant === 'inline')
      } else if (e.code === 'Escape' && theater) {
        e.preventDefault()
        sounds.play('lightTick')
        setTheater(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [connectedHere, toggleVoiceMute, toggleVoiceDeafen, setVoiceFullscreen, isMobile, variant, theater])

  // theater only holds while its stream is still live
  const theaterSelf = theater === me?.id && (voiceSelf.cameraOn || voiceSelf.screenOn)
  const theaterRemote = theater && theater !== me?.id ? participants.find((x) => x.userId === theater && (x.video || x.screen)) : undefined
  const theaterLive = !!theater && (theaterSelf || !!theaterRemote)
  const theaterLabel =
    theater === me?.id
      ? (me?.displayName || me?.username || 'you') + (voiceSelf.screenOn && !voiceSelf.cameraOn ? "'s screen" : '')
      : theaterRemote
        ? (theaterRemote.displayName || theaterRemote.username) + (theaterRemote.screen && !theaterRemote.video ? "'s screen" : '')
        : ''

  const onSetTileFit = useCallback((userId: string, fit: 'cover' | 'contain') => {
    setTileFit((m) => (m[userId] === fit ? m : { ...m, [userId]: fit }))
  }, [])

  const localTile =
    voiceSelf.cameraOn || voiceSelf.screenOn ? (
      <LocalVoiceVideoTile
        me={me}
        self={voiceSelf}
        speaking={participants.find((p) => p.userId === me?.id)?.speaking ?? false}
        watchers={myScreenWatchers}
        fit={me ? tileFit[me.id] : undefined}
        isPriority={!!me && priorityUserId === me.id}
        onSetFit={(f) => me && onSetTileFit(me.id, f)}
        onTheater={() => me && setTheater(me.id)}
      />
    ) : null

  const remoteTile = (p: VoiceParticipantSummary, fill = false, compact = false) => (
    <RemoteVoiceVideoTile
      key={`${p.userId}:${p.sessionId}`}
      p={p}
      watching={watchingScreens.includes(p.userId)}
      fill={fill}
      fit={tileFit[p.userId]}
      isPriority={priorityUserId === p.userId}
      onSetFit={(f) => onSetTileFit(p.userId, f)}
      onTheater={() => setTheater(p.userId)}
      compact={compact}
    />
  )

  const connectionBanner = !socketUp && (
    <div className="max-w-3xl mx-auto mb-4 flex items-center gap-2 rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2">
      <span className="relative flex size-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive/70" />
        <span className="relative inline-flex size-2 rounded-full bg-destructive" />
      </span>
      <span className="text-[12px] font-semibold text-destructive">connection issue: reconnecting, voice will resume</span>
    </div>
  )

  // the video surface in both layouts; tiles + audio-only cards are computed
  // once so grid and speaker share them
  const remoteVideo = participants.filter((p) => p.userId !== me?.id && (p.video || p.screen))
  const audioOnly = participants.filter((p) => !p.video && !p.screen)

  const videoSurface =
    layout === 'speaker' && (remoteVideo.length > 0 || localTile) ? (
      (() => {
        // spotlight follows the talker (falling back to the first video),
        // everyone else rides the thumbnail rail
        const speaker = participants.find((p) => p.speaking && (p.video || p.screen))
        const spotlightRemote = speaker && speaker.userId !== me?.id ? speaker : remoteVideo[0]
        const spotlightLocal = !spotlightRemote && localTile ? localTile : null
        const rail = remoteVideo.filter((p) => p !== spotlightRemote)
        return (
          <div className="flex-1 min-h-0 flex gap-2 p-2 sm:p-3">
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
              <div className="flex-1 min-h-0 grid place-items-center">
                {spotlightRemote ? (
                  <div className="size-full tile-in">{remoteTile(spotlightRemote, true)}</div>
                ) : (
                  <div className="size-full tile-in">{spotlightLocal}</div>
                )}
              </div>
              {audioOnly.length > 0 && (
                <div className="shrink-0 flex items-center justify-center gap-2 flex-wrap px-2 pb-1 pt-2">
                  {audioOnly.map((p) => {
                    const isSelf = p.userId === me?.id
                    const name = p.displayName || p.username
                    return (
                      <div
                        key={`${p.userId}:${p.sessionId}`}
                        onContextMenu={(e) => openVoiceParticipantMenu(e, p, isSelf, false)}
                        className="group/chip flex items-center gap-1.5 pl-1.5 pr-2 py-1 rounded-full bg-app-raise border border-white/10"
                        title={name}
                      >
                        <span className="relative shrink-0">
                          <Avatar name={p.username} color={p.avatarColor} url={p.avatarUrl} size="sm" />
                          {(p.muted || p.deafened) && (
                            <span className="absolute -bottom-0.5 -right-0.5 grid place-items-center size-3.5 rounded-full bg-black ring-1 ring-app-raise">
                              {p.deafened ? <HeadphoneOff className="size-2 text-destructive" aria-hidden="true" /> : <MicOff className="size-2 text-destructive" aria-hidden="true" />}
                            </span>
                          )}
                        </span>
                        <span className="flex items-center gap-1 min-w-0">
                          <span className="text-[11px] font-semibold truncate max-w-24">
                            {name}
                            {isSelf && <span className="text-muted-foreground/70"> · you</span>}
                          </span>
                          {priorityUserId === p.userId && <CrownBadge />}
                        </span>
                        <VolumeBars level={p.volume} muted={p.muted || p.deafened} />
                        {!isSelf && (
                          <span className="flex items-center gap-1 opacity-0 group-hover/chip:opacity-100 focus-within:opacity-100 max-sm:opacity-100 transition-opacity">
                            <TileVolumeControls userId={p.userId} name={name} size={6} />
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
            {(rail.length > 0 || (spotlightRemote && localTile)) && (
              <div className="w-32 sm:w-44 shrink-0 flex flex-col gap-2 overflow-y-auto nice-scrollbar">
                {spotlightRemote && localTile && <div className="relative w-full aspect-video tile-in">{localTile}</div>}
                {rail.map((p) => (
                  <div key={`${p.userId}:${p.sessionId}`} className="w-full aspect-video tile-in">
                    {remoteTile(p, false, true)}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })()
    ) : (
      <div className="flex-1 overflow-y-auto scroll-thin p-4">
        {connectionBanner}
        {/* the video mosaic: local + remote video tiles, and the
            audio-only members as compact cards so nobody vanishes
            the moment someone shares */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 max-w-5xl mx-auto">
          {localTile}
          {remoteVideo.map((p) => remoteTile(p))}
          {audioOnly.map((p) => {
            const isSelf = p.userId === me?.id
            const name = p.displayName || p.username
            return (
              <div
                key={`${p.userId}:${p.sessionId}`}
                onContextMenu={(e) => openVoiceParticipantMenu(e, p, isSelf, false)}
                className="group/tile aspect-video min-w-0 bg-app-raise border border-white/10 rounded-md overflow-hidden flex items-center gap-3 px-4 hover:border-white/25 transition-colors"
              >
                <span className="relative shrink-0">
                  <span className={cn('block rounded-full transition-transform duration-100', p.speaking && 'ring-2 ring-white scale-[1.05]')}>
                    <Avatar name={p.username} color={p.avatarColor} url={p.avatarUrl} size="md" />
                  </span>
                  {(p.muted || p.deafened) && (
                    <span className="absolute -bottom-0.5 -right-0.5 grid place-items-center size-4 rounded-full bg-black ring-2 ring-app-raise">
                      {p.deafened ? <HeadphoneOff className="size-2.5 text-destructive" aria-hidden="true" /> : <MicOff className="size-2.5 text-destructive" aria-hidden="true" />}
                    </span>
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[11px] font-semibold tracking-tight truncate max-w-full">
                      {name}
                      {isSelf && <span className="text-muted-foreground/70"> · you</span>}
                    </span>
                    {priorityUserId === p.userId && <CrownBadge />}
                  </span>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <VolumeBars level={p.volume} muted={p.muted || p.deafened} />
                  </div>
                </div>
                {!isSelf && (
                  <span className="shrink-0 flex items-center gap-1 opacity-0 group-hover/tile:opacity-100 focus-within:opacity-100 max-sm:opacity-100 transition-opacity">
                    <TileVolumeControls userId={p.userId} name={name} size={6} />
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    )

  return (
    <div className={cn('flex flex-col min-h-0 min-w-0 flex-1', variant === 'fullscreen' && 'size-full')} data-voice-stage={variant}>
      {/* fullscreen chrome: channel identity + connection warning + collapse */}
      {variant === 'fullscreen' && (
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/10 shrink-0">
          <Volume2 className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold tracking-tight truncate">
              {channel.name}
              {callLabel && <span className="text-muted-foreground font-semibold"> · {callLabel}</span>}
            </p>
            <div className="flex items-center gap-1.5">
              <p className="text-[11px] text-muted-foreground tabular-nums">{participants.length} in channel</p>
              <VoicePriorityChip channelId={stageChannelId} />
            </div>
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
          <button
            type="button"
            onClick={() => {
              sounds.play('whoom')
              setVoiceFullscreen(false)
            }}
            className="flex items-center gap-2 h-9 px-3.5 rounded-sm border font-semibold tracking-tight transition-all press-sm text-sm border-white/20 bg-app-raise/70 text-foreground hover:border-white/40 hover:bg-app-raise"
            aria-label="exit fullscreen"
            title="exit fullscreen (f)"
          >
            <Minimize2 className="size-4" />
            exit fullscreen
          </button>
        </div>
      )}

      {/* inline top bar: channel identity + in-call controls. Wraps on narrow
          screens (the control row moves under the channel name, every
          control stays reachable) and the buttons grow for touch there. */}
      {variant === 'inline' && (
        <div className="min-h-12 px-3 py-1.5 sm:h-12 sm:py-0 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Volume2 className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
            <span className="font-bold text-sm tracking-tight truncate">
              {channel.name}
              {callLabel && <span className="text-muted-foreground font-semibold"> · {callLabel}</span>}
            </span>
            <span className="text-[10px] font-semibold text-muted-foreground tabular-nums shrink-0">{participants.length}</span>
            <VoicePriorityChip channelId={stageChannelId} />
          </div>
          {/* right side: audio settings (always available), and the in-call
              control row once connected. The descendant selector grows every
              button for touch on small screens (portal-ed popovers are
              unaffected - only inline row buttons match). */}
          <div className="flex flex-wrap items-center justify-end gap-1.5 max-w-full [&_button]:p-2.5 sm:[&_button]:p-1.5">
            <VoiceSettingsButton />
            {connectedHere && conn && (
              <VoiceControlRow
                channelId={channel.id}
                connChannelId={conn.channelId}
                server={server}
                variant="inline"
                showLayoutToggle={anyVideo}
                onToggleFullscreen={() => setVoiceFullscreen(true)}
              />
            )}
          </div>
        </div>
      )}

      {/* ---- the stage: one full-width pane ---- */}
      <div className="flex-1 min-h-0 flex flex-col relative">
        <VoiceRingingStrip channelId={stageChannelId} />
        {voiceUnavailable ? (
          <div className="flex-1 grid place-items-center px-6">
            <p className="text-sm text-muted-foreground">voice unavailable in this build</p>
          </div>
        ) : connectedHere ? (
          theaterLive ? (
            <VoiceTheaterSurface
              userId={theater as string}
              label={theaterLabel}
              onExit={() => setTheater(null)}
              fit={theater ? tileFit[theater] ?? 'contain' : 'contain'}
              onSetFit={(f) => theater && onSetTileFit(theater, f)}
            />
          ) : anyVideo ? (
            videoSurface
          ) : (
            <div className="flex-1 overflow-y-auto scroll-thin p-6">
              {connectionBanner}
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 max-w-4xl mx-auto">
                {participants.map((p) => {
                  const isSelf = p.userId === me?.id
                  const isDeafened = p.deafened
                  const isMuted = p.muted
                  const name = p.displayName || p.username
                  return (
                    <div
                      key={`${p.userId}:${p.sessionId}`}
                      onContextMenu={(e) => openVoiceParticipantMenu(e, p, isSelf, false)}
                      className={cn(
                        'group/tile bg-app-raise border border-white/10 rounded-md p-4 flex items-center gap-4 transition-all',
                        p.speaking && 'border-white/30 speaking-tile'
                      )}
                    >
                      <div className="relative shrink-0">
                        <div className={cn('rounded-full transition-transform duration-100', p.speaking && 'ring-2 ring-white scale-[1.06]')}>
                          <Avatar name={p.username} color={p.avatarColor} url={p.avatarUrl} size="lg" />
                        </div>
                        {(isMuted || isDeafened) && (
                          <span className="absolute -bottom-0.5 -right-0.5 grid place-items-center size-5 rounded-full bg-black ring-2 ring-app-raise">
                            {isDeafened ? <HeadphoneOff className="size-3 text-destructive" aria-hidden="true" /> : <MicOff className="size-3 text-destructive" aria-hidden="true" />}
                          </span>
                        )}
                        {p.recording && (
                          <span className="absolute -top-1.5 -left-1.5" title="recording">
                            <RecBadge />
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[13px] font-semibold tracking-tight truncate">
                            {name}
                            {isSelf && <span className="text-muted-foreground/70"> · you</span>}
                          </span>
                          {priorityUserId === p.userId && <CrownBadge />}
                        </div>
                        {/* the live level meter moves with actual audio; the
                            status caption rides beside it */}
                        <div className="mt-1.5 flex items-center gap-2 min-w-0">
                          <VolumeBars level={p.volume} muted={isMuted || isDeafened} />
                          <span
                            className={cn(
                              'text-[10px] font-semibold truncate',
                              p.recording ? 'text-red-400' : p.speaking && !isMuted && !isDeafened ? 'text-hyper' : 'text-muted-foreground'
                            )}
                          >
                            {p.recording ? 'recording' : isDeafened ? 'deafened' : isMuted ? 'muted' : p.speaking ? 'speaking' : '·'}
                          </span>
                        </div>
                      </div>
                      {/* per-person volume + local silence as circles level
                          with the avatar (never for self) */}
                      {!isSelf && (
                        <div className="shrink-0 flex items-center gap-1.5">
                          <TileVolumeControls userId={p.userId} name={name} />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        ) : (
          <div className="flex-1 grid place-items-center p-6">
            <div className="flex flex-col items-center gap-4 max-w-sm text-center">
              <div className="relative">
                <span className="absolute -inset-3 rounded-full border border-hyper/30" aria-hidden="true" />
                <div className="grid place-items-center size-16 rounded-full bg-hyper/15 border border-hyper/40">
                  <Volume2 className="size-7 text-hyper" />
                </div>
              </div>
              <div>
                <p className="text-sm font-bold tracking-tight">{channel.name}</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {participants.length > 0
                    ? `${participants.length} ${participants.length === 1 ? 'person is' : 'people are'} in here.`
                    : 'nobody is here yet. be the first voice.'}
                </p>
              </div>
              {participants.length > 0 && (
                <div className="flex items-center -space-x-2">
                  {participants.slice(0, 5).map((p) => (
                    <Avatar
                      key={p.userId}
                      name={p.username}
                      color={p.avatarColor}
                      url={p.avatarUrl}
                      size="sm"
                      className="ring-2 ring-app-chat"
                    />
                  ))}
                </div>
              )}
              <button
                onClick={() => void joinVoice(channel.id, server?.id ?? '')}
                className="join-pulse flex items-center gap-2 px-4 py-2.5 rounded-sm bg-hyper text-white text-sm font-semibold hover:bg-hyper/90 active:scale-95 transition-all"
              >
                <Volume2 className="size-4" />
                join voice
              </button>
            </div>
          </div>
        )}
      </div>

      {/* fullscreen bottom bar: the same control row as circles */}
      {variant === 'fullscreen' && connectedHere && conn && (
        <div className="shrink-0 px-3 py-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] border-t border-white/10 bg-app-raise/60 backdrop-blur flex justify-center">
          <VoiceControlRow
            channelId={channel.id}
            connChannelId={conn.channelId}
            server={server}
            variant="fullscreen"
            showLayoutToggle={anyVideo}
            onToggleFullscreen={() => setVoiceFullscreen(false)}
          />
        </div>
      )}
    </div>
  )
}

/** The voice channel surface: one full-width stage of live participant
 *  tiles - avatar cards, a video mosaic (grid or speaker view) once anyone
 *  turns on a camera or shares a screen, theater mode for opening one
 *  stream big, and a fullscreen takeover carrying the same controls.
 *  Server voice channels carry no text chat: talking (and seeing) is the
 *  whole point. */
export function VoiceRoom() {
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const servers = useChatStore((s) => s.servers)
  const voiceConnected = useChatStore((s) => s.voiceConnected)
  const voiceFullscreen = useChatStore((s) => s.voiceFullscreen)
  const setVoiceFullscreen = useChatStore((s) => s.setVoiceFullscreen)

  // portals need the DOM: false during SSR, true on the client, without a
  // setState-in-effect render cascade
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  )

  const channel = servers.flatMap((s) => s.channels).find((c) => c.id === activeChannelId) ?? null
  const server = servers.find((s) => s.channels.some((c) => c.id === activeChannelId)) ?? null
  if (!channel || !activeChannelId) return null

  const conn = voiceConnected
  const connectedHere = !!conn && (conn.channelId === activeChannelId || conn.channelId.startsWith(activeChannelId + '~'))

  // the takeover only makes sense while actually sitting in this channel:
  // a stale flag (leftover from another view) folds back to inline
  if (voiceFullscreen && !connectedHere) setVoiceFullscreen(false)

  if (mounted && voiceFullscreen && connectedHere && conn) {
    return createPortal(
      <div className="fixed inset-0 z-[90] flex flex-col bg-app-chat whoosh-in" role="region" aria-label="voice channel, fullscreen">
        <VoiceStageContent channel={channel} server={server} variant="fullscreen" />
      </div>,
      document.body
    )
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-app-chat">
      <VoiceStageContent channel={channel} server={server} variant="inline" />
    </div>
  )
}
