'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { sounds } from '@/lib/client/sounds'
import {
  attachMediaHost,
  detachMediaHost,
  getMediaHost,
  subscribeMediaHost,
  type MediaHostState,
} from '@/lib/client/media-host'
import {
  subscribeYouTubeState,
  youTubeCommand,
  type YtSnapshot,
} from '@/lib/client/yt-registry'
import { isBlanked, subscribeBlanked, toggleBlanked } from '@/lib/client/media-blank'
import { useRealWaveform } from '@/lib/client/waveform-cache'
import { cn } from '@/lib/utils'
import { Eye, EyeOff, Pause, PictureInPicture2, Play, Volume, VolumeX } from 'lucide-react'

/** ---------------------------------------------------------------------------
 * The inline media surface: file videos, audio and voice messages play
 * INSIDE the message row with fully custom chrome (no native controls
 * anywhere). One <video> host element per source lives in a module registry
 * and is attached here while this surface is the visible one — playback
 * never restarts when it moves between this embed, the floating player, or
 * the parking lot.
 *
 * Every playable embed carries the same compact controls row: play/pause,
 * seek (scrubber or waveform), time readout, volume (icon + slider) and a
 * pop-out to the floating player. An eye button blanks the embed (something
 * you would rather not see but want to keep findable to delete).
 * ------------------------------------------------------------------------- */

/** mm:ss (or h:mm:ss past the hour) in tabular digits. */
export function mediaTime(total: number): string {
  if (!Number.isFinite(total) || total < 0) return '0:00'
  const s = Math.floor(total % 60)
  const m = Math.floor((total / 60) % 60)
  const h = Math.floor(total / 3600)
  const two = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}

/** Live playback state of a host source, or null before it exists. */
function useMediaState(mediaKey: string, src: string): MediaHostState | null {
  const [state, setState] = useState<MediaHostState | null>(null)
  useEffect(() => {
    getMediaHost(mediaKey, src)
    return subscribeMediaHost(mediaKey, setState)
  }, [mediaKey, src])
  return state
}

/** Live playback state of a tracked YouTube embed (registry-polled). */
export function useYouTubeState(videoId: string): YtSnapshot | null {
  const [snap, setSnap] = useState<YtSnapshot | null>(null)
  useEffect(() => {
    return subscribeYouTubeState(videoId, setSnap)
  }, [videoId])
  return snap
}

/** The container that physically holds the single host <video> element.
 *  Attaches only while THIS surface owns playback (not popped away, not
 *  handed to the floating player); otherwise the element stays wherever its
 *  current owner put it. */
function HostSurface({
  mediaKey,
  src,
  attach,
  hidden,
  className,
}: {
  mediaKey: string
  src: string
  attach: boolean
  /** audio sources: the element needs to exist and play, not be looked at */
  hidden?: boolean
  className?: string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!attach) return
    const c = ref.current
    if (!c) return
    getMediaHost(mediaKey, src)
    attachMediaHost(mediaKey, c)
    return () => detachMediaHost(mediaKey, c)
  }, [mediaKey, src, attach])
  return (
    <div
      ref={ref}
      className={cn(
        !attach && 'hidden',
        hidden && 'absolute w-px h-px overflow-hidden opacity-0 pointer-events-none',
        className
      )}
      aria-hidden={hidden || undefined}
    />
  )
}

/** Custom scrubber for host <video> sources: buffered + played bars, hover
 *  time bubble, drag to seek, arrow keys to nudge. No <input type=range> —
 *  this is chrome we own end to end. */
function Scrubber({ mediaKey, state }: { mediaKey: string; state: MediaHostState }) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [dragTime, setDragTime] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)

  const duration = state.duration
  const usable = Number.isFinite(duration) && duration > 0
  const displayTime = dragTime ?? state.time

  const timeAt = useCallback(
    (clientX: number): number => {
      const track = trackRef.current
      if (!track || !usable) return 0
      const r = track.getBoundingClientRect()
      const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
      return frac * duration
    },
    [usable, duration]
  )

  function seek(t: number) {
    const el = getMediaHost(mediaKey, '')
    const track = trackRef.current
    if (!el || !track || !usable) return
    el.currentTime = Math.max(0, Math.min(duration, t))
  }

  function onPointerDown(e: React.PointerEvent) {
    if (!usable) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const t = timeAt(e.clientX)
    setDragTime(t)
    seek(t)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!usable) return
    setHover(timeAt(e.clientX))
    if (dragTime !== null) {
      const t = timeAt(e.clientX)
      setDragTime(t)
      seek(t)
    }
  }
  function onPointerUp() {
    setDragTime(null)
  }

  const playedPct = usable ? Math.min(100, (displayTime / duration) * 100) : 0
  const bufferedPct = usable ? Math.min(100, (state.buffered / duration) * 100) : 0

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="seek"
      aria-valuemin={0}
      aria-valuemax={usable ? Math.round(duration) : 0}
      aria-valuenow={usable ? Math.round(displayTime) : 0}
      aria-valuetext={`${mediaTime(displayTime)} of ${mediaTime(duration)}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onKeyDown={(e) => {
        if (!usable) return
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          seek(displayTime + (e.key === 'ArrowLeft' ? -5 : 5))
        } else if (e.key === 'Home') {
          seek(0)
        } else if (e.key === 'End') {
          seek(duration - 0.5)
        }
      }}
      className={cn(
        'group/scrub relative flex-1 min-w-0 h-4 flex items-center touch-none select-none',
        usable ? 'cursor-pointer' : 'cursor-default opacity-60'
      )}
    >
      {/* rail */}
      <div className="relative h-1 w-full rounded-sm bg-white/15 overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${bufferedPct}%` }} />
        <div className="absolute inset-y-0 left-0 bg-hyper" style={{ width: `${playedPct}%` }} />
      </div>
      {/* handle: rides the played edge, grows on hover/drag */}
      <div
        className={cn(
          'absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-2.5 rounded-full bg-white shadow transition-transform',
          'group-hover/scrub:scale-125',
          dragTime !== null ? 'scale-125' : 'scale-0 group-hover/scrub:scale-100'
        )}
        style={{ left: `${playedPct}%` }}
        aria-hidden="true"
      />
      {/* hover time bubble */}
      {hover !== null && dragTime === null && usable && (
        <div
          className="absolute -top-6 -translate-x-1/2 px-1.5 py-0.5 rounded-sm bg-black/90 border border-white/10 text-[10px] font-semibold tabular-nums text-white pointer-events-none"
          style={{ left: `${Math.max(4, Math.min(96, (hover / duration) * 100))}%` }}
        >
          {mediaTime(hover)}
        </div>
      )}
    </div>
  )
}

/** Volume button + flyout slider, styled to Hyperion (thin 4px track,
 *  hyper fill). Shared by every custom control bar. */
function VolumeControl({
  volume,
  muted,
  onToggleMute,
  onVolume,
}: {
  volume: number
  muted: boolean
  onToggleMute: () => void
  onVolume: (v: number) => void
}) {
  const [open, setOpen] = useState(false)
  const pct = Math.round(Math.max(0, Math.min(1, muted ? 0 : volume)) * 100)
  return (
    <div
      className="relative shrink-0"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onToggleMute()
        }}
        className="grid place-items-center size-7 rounded-sm text-foreground/80 hover:text-foreground hover:bg-white/10 transition-colors"
        aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
      >
        {muted || volume === 0 ? <VolumeX className="size-3.5" /> : <Volume className="size-3.5" />}
      </button>
      {open && (
        <div
          className="absolute right-0 bottom-full mb-1.5 p-2 rounded-sm border border-white/10 bg-app-raise shadow-xl"
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => onVolume(Number(e.target.value))}
            aria-label="Volume"
            className="hc-range w-20"
            style={{ '--hc-range-fill': `${pct}%` } as React.CSSProperties}
          />
        </div>
      )}
    </div>
  )
}

/** The little player chrome under a host <video> element. */
export function MediaControlsBar({
  mediaKey,
  state,
  compact,
  onPopOut,
}: {
  mediaKey: string
  state: MediaHostState
  compact?: boolean
  onPopOut?: () => void
}) {
  function toggle() {
    const el = getMediaHost(mediaKey, '')
    if (!el) return
    sounds.play('lightTick')
    if (el.paused) {
      if (el.ended) el.currentTime = 0
      void el.play().catch(() => undefined)
    } else {
      el.pause()
    }
  }

  function setVolume(v: number) {
    const el = getMediaHost(mediaKey, '')
    if (!el) return
    el.volume = v
    if (v > 0 && el.muted) el.muted = false
  }

  const dur = Number.isFinite(state.duration) ? state.duration : 0

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-2 select-none bg-app-raise',
        compact ? 'py-1' : 'py-1.5'
      )}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          toggle()
        }}
        className="grid place-items-center size-7 shrink-0 rounded-sm text-foreground/90 hover:text-foreground hover:bg-white/10 transition-colors"
        aria-label={state.paused ? 'Play' : 'Pause'}
      >
        {state.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
      </button>
      <span className="text-[10px] font-semibold tabular-nums text-muted-foreground shrink-0" aria-hidden="true">
        {mediaTime(state.time)}
      </span>
      <Scrubber mediaKey={mediaKey} state={state} />
      <span className="text-[10px] font-semibold tabular-nums text-muted-foreground shrink-0" aria-hidden="true">
        {mediaTime(dur)}
      </span>
      <VolumeControl
        volume={state.volume}
        muted={state.muted}
        onToggleMute={() => {
          const el = getMediaHost(mediaKey, '')
          if (!el) return
          sounds.play('lightTick')
          el.muted = !el.muted
        }}
        onVolume={setVolume}
      />
      {onPopOut && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onPopOut()
          }}
          className="grid place-items-center size-7 shrink-0 rounded-sm text-foreground/80 hover:text-foreground hover:bg-white/10 transition-colors"
          aria-label="Open in mini player"
          title="mini player"
        >
          <PictureInPicture2 className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** ---------------------------------------------------------------------------
 *  YouTube control bars: the same compact chrome, driven through the
 *  iframe's enablejsapi postMessage channel and the registry's polled
 *  time/state instead of a DOM media element.
 * ------------------------------------------------------------------------- */

/** seek through the registry-tracked iframe; drag previews, release commits */
function YouTubeScrubber({
  snapshot,
  onSeek,
}: {
  snapshot: YtSnapshot
  onSeek: (t: number) => void
}) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [dragTime, setDragTime] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)

  const duration = snapshot.duration
  const usable = duration > 0
  const displayTime = dragTime ?? snapshot.time

  const timeAt = useCallback(
    (clientX: number): number => {
      const track = trackRef.current
      if (!track || !usable) return 0
      const r = track.getBoundingClientRect()
      const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
      return frac * duration
    },
    [usable, duration]
  )

  function onPointerDown(e: React.PointerEvent) {
    if (!usable) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const t = timeAt(e.clientX)
    setDragTime(t)
    onSeek(t)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!usable) return
    setHover(timeAt(e.clientX))
    if (dragTime !== null) setDragTime(timeAt(e.clientX))
  }
  function onPointerUp() {
    if (dragTime !== null) onSeek(dragTime)
    setDragTime(null)
  }

  const playedPct = usable ? Math.min(100, (displayTime / duration) * 100) : 0

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="seek"
      aria-valuemin={0}
      aria-valuemax={usable ? Math.round(duration) : 0}
      aria-valuenow={usable ? Math.round(displayTime) : 0}
      aria-valuetext={`${mediaTime(displayTime)} of ${mediaTime(duration)}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onKeyDown={(e) => {
        if (!usable) return
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          onSeek(displayTime + (e.key === 'ArrowLeft' ? -5 : 5))
        } else if (e.key === 'Home') {
          onSeek(0)
        } else if (e.key === 'End') {
          onSeek(Math.max(0, duration - 0.5))
        }
      }}
      className={cn(
        'group/scrub relative flex-1 min-w-0 h-4 flex items-center touch-none select-none',
        usable ? 'cursor-pointer' : 'cursor-default opacity-60'
      )}
    >
      <div className="relative h-1 w-full rounded-sm bg-white/15 overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-hyper" style={{ width: `${playedPct}%` }} />
      </div>
      <div
        className={cn(
          'absolute top-1/2 -translate-y-1/2 -translate-x-1/2 size-2.5 rounded-full bg-white shadow transition-transform',
          'group-hover/scrub:scale-125',
          dragTime !== null ? 'scale-125' : 'scale-0 group-hover/scrub:scale-100'
        )}
        style={{ left: `${playedPct}%` }}
        aria-hidden="true"
      />
      {hover !== null && dragTime === null && usable && (
        <div
          className="absolute -top-6 -translate-x-1/2 px-1.5 py-0.5 rounded-sm bg-black/90 border border-white/10 text-[10px] font-semibold tabular-nums text-white pointer-events-none"
          style={{ left: `${Math.max(4, Math.min(96, (hover / duration) * 100))}%` }}
        >
          {mediaTime(hover)}
        </div>
      )}
    </div>
  )
}

/** Compact controls row for a playing YouTube embed (inline card or the
 *  floating player). play/pause, seek, time, volume, pop-out — all through
 *  postMessage so the iframe itself stays chrome-free. */
export function YouTubeControlsBar({
  videoId,
  iframeRef,
  compact,
  onPopOut,
}: {
  videoId: string
  iframeRef: React.RefObject<HTMLIFrameElement | null>
  compact?: boolean
  onPopOut?: () => void
}) {
  const snapshot = useYouTubeState(videoId)
  const [ytMuted, setYtMuted] = useState(false)
  const [ytVolume, setYtVolume] = useState(1)

  const playing = snapshot?.playerState === 1 || snapshot?.playerState === 3
  const time = snapshot?.time ?? 0
  const duration = snapshot?.duration ?? 0

  function toggle() {
    sounds.play('lightTick')
    youTubeCommand(iframeRef.current, playing ? 'pauseVideo' : 'playVideo')
  }

  function seek(t: number) {
    const clamped = Math.max(0, Math.floor(t))
    youTubeCommand(iframeRef.current, 'seekTo', [clamped, true])
  }

  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-2 select-none bg-app-raise border-t border-white/[0.06]',
        compact ? 'py-1' : 'py-1.5'
      )}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          toggle()
        }}
        className="grid place-items-center size-7 shrink-0 rounded-sm text-foreground/90 hover:text-foreground hover:bg-white/10 transition-colors"
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </button>
      <span className="text-[10px] font-semibold tabular-nums text-muted-foreground shrink-0" aria-hidden="true">
        {mediaTime(time)}
      </span>
      <YouTubeScrubber snapshot={{ time, playerState: snapshot?.playerState ?? -1, duration }} onSeek={seek} />
      <span className="text-[10px] font-semibold tabular-nums text-muted-foreground shrink-0" aria-hidden="true">
        {mediaTime(duration)}
      </span>
      <VolumeControl
        volume={ytVolume}
        muted={ytMuted}
        onToggleMute={() => {
          sounds.play('lightTick')
          youTubeCommand(iframeRef.current, ytMuted ? 'unMute' : 'mute')
          setYtMuted((m) => !m)
        }}
        onVolume={(v) => {
          setYtVolume(v)
          youTubeCommand(iframeRef.current, 'setVolume', [Math.round(v * 100)])
          if (v > 0 && ytMuted) {
            youTubeCommand(iframeRef.current, 'unMute')
            setYtMuted(false)
          }
        }}
      />
      {onPopOut && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onPopOut()
          }}
          className="grid place-items-center size-7 shrink-0 rounded-sm text-foreground/80 hover:text-foreground hover:bg-white/10 transition-colors"
          aria-label="Open in mini player"
          title="mini player"
        >
          <PictureInPicture2 className="size-3.5" />
        </button>
      )}
    </div>
  )
}

/** ---------------------------------------------------------------------------
 *  Waveforms: voice messages and audio files share one bar strip — heights
 *  from the attachment's waveform data (or a deterministic fingerprint),
 *  bars before the playhead in hyper, after in muted, and the bars around
 *  the playhead breathe while it plays. Click or drag to seek.
 * ------------------------------------------------------------------------- */

function WaveformBars({
  bars,
  progress,
  live,
  duration,
  onSeek,
  className,
}: {
  bars: number[]
  /** 0..1 played fraction */
  progress: number
  /** true while actively playing (drives the pulse) */
  live: boolean
  duration: number
  onSeek: (t: number) => void
  className?: string
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [dragFrac, setDragFrac] = useState<number | null>(null)

  const usable = Number.isFinite(duration) && duration > 0
  const frac = dragFrac ?? Math.max(0, Math.min(1, progress))
  const playedIndex = Math.floor(frac * bars.length)

  const fracAt = useCallback((clientX: number): number => {
    const el = ref.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
  }, [])

  function onPointerDown(e: React.PointerEvent) {
    if (!usable) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const f = fracAt(e.clientX)
    setDragFrac(f)
    onSeek(f * duration)
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!usable || dragFrac === null) return
    const f = fracAt(e.clientX)
    setDragFrac(f)
    onSeek(f * duration)
  }
  function onPointerUp() {
    setDragFrac(null)
  }

  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="seek"
      aria-valuemin={0}
      aria-valuemax={usable ? Math.round(duration) : 0}
      aria-valuenow={usable ? Math.round(frac * duration) : 0}
      aria-valuetext={`${mediaTime(frac * duration)} of ${mediaTime(duration)}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={(e) => {
        if (!usable) return
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          onSeek((frac + (e.key === 'ArrowLeft' ? -5 : 5) / Math.max(1, duration)) * duration)
        }
      }}
      className={cn(
        'flex items-end gap-[2px] h-6 min-w-0 flex-1 select-none touch-none',
        usable ? 'cursor-pointer' : 'cursor-default',
        className
      )}
    >
      {bars.map((h, i) => {
        const height = 22 + Math.round(Math.max(0, Math.min(1, h)) * 78)
        const played = i < playedIndex
        const atHead = live && Math.abs(i - playedIndex) <= 1
        return (
          <span
            key={i}
            className={cn(
              'w-[3px] rounded-full transition-colors',
              played ? 'bg-hyper' : 'bg-white/25',
              atHead && 'hc-wave-live'
            )}
            style={{ height: `${height}%` }}
            aria-hidden="true"
          />
        )
      })}
    </div>
  )
}

/** Neutral placeholder for a blanked embed: nothing of the media renders
 *  (not even a poster frame) — just a quiet card. Click anywhere on it to
 *  reveal again. */
export function HiddenMediaCard({ url, kindLabel }: { url: string; kindLabel: string }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation()
        sounds.play('lightTick')
        toggleBlanked(url)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.stopPropagation()
          e.preventDefault()
          sounds.play('lightTick')
          toggleBlanked(url)
        }
      }}
      className="mt-1.5 max-w-md rounded-sm border border-white/10 bg-app-raise px-3 py-2.5 flex items-center gap-2.5 cursor-pointer hover:border-white/25 transition-colors"
      aria-label={`Reveal hidden ${kindLabel}`}
      title="reveal"
    >
      <EyeOff className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="flex-1 min-w-0 text-xs text-muted-foreground truncate">
        {`${kindLabel} hidden: click to reveal`}
      </span>
      <Eye className="size-3.5 text-muted-foreground" aria-hidden="true" />
    </div>
  )
}

/** The little eye button that blanks an embed. Appears on hover (the embed
 *  card carries the matching `group/embed` / `group/voice` class) and on
 *  keyboard focus; keyboard-pressed it still reveals on the blanked card. */
export function HideEmbedButton({
  url,
  blanked,
  className,
  group = 'embed',
}: {
  url: string
  blanked: boolean
  className?: string
  /** which hover-group the parent card uses */
  group?: 'embed' | 'voice'
}) {
  const reveal = group === 'voice' ? 'group-hover/voice:opacity-100' : 'group-hover/embed:opacity-100'
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        sounds.play('lightTick')
        toggleBlanked(url)
      }}
      className={cn(
        'absolute z-10 grid place-items-center size-6 rounded-sm bg-black/70 text-white/70 hover:text-white hover:bg-black transition-[color,background-color,opacity] duration-150',
        'opacity-0 focus-visible:opacity-100',
        reveal,
        className ?? 'top-1.5 right-1.5'
      )}
      aria-label={blanked ? 'Reveal media' : 'Hide media'}
      title={blanked ? 'reveal' : 'hide (keep the message, lose the visuals)'}
    >
      {blanked ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
    </button>
  )
}

/** Which room the user is standing in (null on friends/account views). */
function useCurrentRoom(): string | null {
  return useChatStore((s) => {
    if (s.friendsViewOpen || s.accountOpen) return null
    if (s.activeChannelId) return `channel:${s.activeChannelId}`
    if (s.activeConversationId) return `conversation:${s.activeConversationId}`
    return null
  })
}

/** File media embed: the attachment's own little player. Video shows the
 *  frame + controls in place; audio and voice render a compact waveform row
 *  with the element hidden. Playback lives in the shared host element, so
 *  leaving the room mid-play hands it to the floating player and coming
 *  back restores this surface at the exact position. */
export function FileMediaEmbed({
  url,
  mime,
  name,
  size,
  room,
  kind,
  duration,
  waveform,
  variant = 'file',
}: {
  url: string
  mime: string
  name: string
  size?: number
  /** room the embed lives in; the active player stamps it on play. Url
   *  embeds (no attachment row) let the store resolve the current room. */
  room?: string
  /** attachment payload extras from the voice-message contract */
  kind?: string
  duration?: number
  waveform?: number[]
  variant?: 'file' | 'voice'
}) {
  const isVideo = mime.startsWith('video/')
  const isVoice = variant === 'voice' || kind === 'voice'
  const openMediaPlayer = useChatStore((s) => s.openMediaPlayer)
  const setMediaPopped = useChatStore((s) => s.setMediaPopped)
  const player = useChatStore((s) => s.mediaPlayer)
  const currentRoom = useCurrentRoom()
  // real peaks for every audio surface: recorded levels ride on voice
  // attachments, anything else decodes the actual file on mount
  const voiceBars = useRealWaveform(url, isVoice ? waveform : undefined, 36)
  const audioBars = useRealWaveform(url, isVoice ? undefined : waveform, 40)

  const state = useMediaState(url, url)
  const active = player?.kind === 'file' && player.url === url
  const popped = active && (player.popped ?? false)
  /** playback belongs HERE while the source room is open and not popped;
   *  otherwise the floating player owns the element */
  const owns = active ? player.roomId === currentRoom && !popped : true

  // blanking: every playable embed can be hidden (and revealed) locally
  const [blanked, setBlanked] = useState(() => isBlanked(url))
  useEffect(() => {
    const sync = () => setBlanked(isBlanked(url))
    sync()
    return subscribeBlanked(sync)
  }, [url])

  if (blanked) {
    return <HiddenMediaCard url={url} kindLabel={isVoice ? 'voice message' : isVideo ? 'video' : 'audio'} />
  }

  function play() {
    sounds.play('lightTick')
    openMediaPlayer(url, mime, name, room)
    const el = getMediaHost(url, url)
    if (el) {
      if (el.ended) el.currentTime = 0
      void el.play().catch(() => undefined)
    }
  }

  function toggle() {
    const el = getMediaHost(url, url)
    if (!el) return
    sounds.play('lightTick')
    if (el.paused) {
      // resume always routes through the store so the surface handoff
      // (room switches, pop-outs) knows playback is live again
      play()
    } else {
      el.pause()
    }
  }

  function seekTo(t: number) {
    const el = getMediaHost(url, url)
    if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return
    el.currentTime = Math.max(0, Math.min(el.duration, t))
  }

  /** live duration falls back to the attachment's declared duration until
   *  the element's metadata lands */
  const knownDuration = state && Number.isFinite(state.duration) && state.duration > 0 ? state.duration : (typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : 0)
  const playing = !!state && !state.paused && !state.ended
  const progress = knownDuration > 0 && state ? Math.max(0, Math.min(1, state.time / knownDuration)) : 0

  /** hand playback to the floating player (and take it back) */
  function popOut() {
    sounds.play('lightTick')
    setMediaPopped(true)
  }

  // ---- voice variant: circular button + waveform + duration ----
  if (isVoice) {
    const bars = voiceBars
    return (
      <div className="mt-1.5 max-w-sm rounded-sm border border-white/10 bg-app-raise overflow-hidden relative group/voice">
        <HostSurface mediaKey={url} src={url} attach={owns} hidden />
        <div className="flex items-center gap-2.5 px-2.5 py-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              if (state) toggle()
              else play()
            }}
            className="grid place-items-center size-8 shrink-0 rounded-full bg-hyper text-white hover:bg-hyper/85 transition-colors"
            aria-label={playing ? 'Pause voice message' : 'Play voice message'}
          >
            {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5 translate-x-0.5" />}
          </button>
          <WaveformBars
            bars={bars}
            progress={progress}
            live={playing}
            duration={knownDuration}
            onSeek={seekTo}
          />
          <span className="text-[11px] font-semibold tabular-nums text-muted-foreground shrink-0" title={name}>
            {playing && state ? mediaTime(state.time) : mediaTime(knownDuration)}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              popOut()
            }}
            className={cn(
              'grid place-items-center size-6 shrink-0 rounded-sm text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors',
              !owns && 'hidden'
            )}
            aria-label="Open in mini player"
            title="mini player"
          >
            <PictureInPicture2 className="size-3.5" />
          </button>
        </div>
        <HideEmbedButton url={url} blanked={blanked} group="voice" className="top-1 right-1" />
      </div>
    )
  }

  // ---- audio file: header row + waveform scrubber + controls ----
  if (!isVideo) {
    const bars = audioBars
    return (
      <div className="mt-1.5 max-w-md rounded-sm border border-white/10 bg-app-raise overflow-hidden relative group/embed">
        <HostSurface mediaKey={url} src={url} attach={owns} hidden />
        <HideEmbedButton url={url} blanked={blanked} />
        <div className="flex items-center gap-2 px-2 py-1 border-b border-white/[0.06]">
          <span className="text-[11px] font-semibold text-hyper shrink-0" aria-hidden="true">
            audio
          </span>
          <span className="flex-1 min-w-0 truncate text-xs font-medium" title={name}>
            {name}
          </span>
          {typeof size === 'number' && size > 0 && (
            <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">
              {(size / 1024 / 1024).toFixed(1)} mb
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 px-2 py-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              if (state) toggle()
              else play()
            }}
            className="grid place-items-center size-7 shrink-0 rounded-sm text-foreground/90 hover:text-foreground hover:bg-white/10 transition-colors"
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </button>
          <WaveformBars
            bars={bars}
            progress={progress}
            live={playing}
            duration={knownDuration}
            onSeek={seekTo}
          />
          <span className="text-[10px] font-semibold tabular-nums text-muted-foreground shrink-0" aria-hidden="true">
            {state ? `${mediaTime(state.time)} / ${mediaTime(knownDuration)}` : mediaTime(knownDuration)}
          </span>
          {state && (
            <VolumeControl
              volume={state.volume}
              muted={state.muted}
              onToggleMute={() => {
                const el = getMediaHost(url, url)
                if (!el) return
                sounds.play('lightTick')
                el.muted = !el.muted
              }}
              onVolume={(v) => {
                const el = getMediaHost(url, url)
                if (!el) return
                el.volume = v
                if (v > 0 && el.muted) el.muted = false
              }}
            />
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              if (owns) popOut()
            }}
            className={cn(
              'grid place-items-center size-7 shrink-0 rounded-sm text-foreground/80 hover:text-foreground hover:bg-white/10 transition-colors',
              !owns && 'hidden'
            )}
            aria-label="Open in mini player"
            title="mini player"
          >
            <PictureInPicture2 className="size-3.5" />
          </button>
        </div>
      </div>
    )
  }

  // ---- video: the frame in place + the little player ----
  if (popped) {
    // playback handed to the floating player: this surface waits. (a PAUSED
    // pop-out auto-unpops — see MediaPlayer — so this card never lies about
    // something playing)
    return (
      <div className="mt-1.5 max-w-md rounded-sm border border-white/10 bg-app-raise px-3 py-2.5 flex items-center gap-2.5">
        <PictureInPicture2 className="size-4 shrink-0 text-hyper" aria-hidden="true" />
        <span className="flex-1 min-w-0 text-xs text-muted-foreground truncate">
          playing in the mini player
        </span>
        <button
          type="button"
          onClick={() => {
            sounds.play('lightTick')
            setMediaPopped(false)
          }}
          className="rounded-sm px-1.5 py-1 text-[11px] font-semibold text-foreground/70 hover:text-foreground hover:bg-accent transition-colors"
          aria-label="Bring video back inline"
          title="back here"
        >
          bring it back
        </button>
      </div>
    )
  }

  const controls = state ? (
    <MediaControlsBar
      mediaKey={url}
      state={state}
      compact={false}
      onPopOut={
        owns
          ? () => {
              popOut()
            }
          : undefined
      }
    />
  ) : null

  return (
    <div className="mt-1.5 max-w-md rounded-sm border border-white/10 overflow-hidden bg-app-raise group/embed relative">
      <HideEmbedButton url={url} blanked={blanked} />
      <HostSurface
        mediaKey={url}
        src={url}
        attach={owns}
        className="relative bg-black min-h-[7.5rem]"
      />
      {/* the frame itself is a play button while untouched or finished */}
      {(!state?.ready || (state?.paused && (state.time < 0.1 || state.ended))) && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            play()
          }}
          className="absolute inset-0 grid place-items-center cursor-pointer"
          aria-label={`Play ${name}`}
        >
          {!state?.ready ? (
            <span className="size-8 rounded-full border border-white/20 border-t-white animate-spin" aria-hidden="true" />
          ) : (
            <span className="grid place-items-center size-12 rounded-full bg-black/70 border border-white/20 transition-transform group-hover/embed:scale-105">
              <Play className="size-5 fill-white text-white translate-x-0.5" />
            </span>
          )}
        </button>
      )}
      {controls}
    </div>
  )
}

/** Direct video URLs pasted into a message (not attachments) get the same
 *  custom inline player. */
export function UrlVideoEmbed({ url }: { url: string }) {
  // same surface as the file video embed without attachment metadata; the
  // room resolves to wherever the user stands when play is clicked
  return <FileMediaEmbed url={url} mime="video/mp4" name="video" variant="file" />
}
