'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { cn } from '@/lib/utils'
import { sounds } from '@/lib/client/sounds'
import { releaseYouTubeEmbed, trackYouTubeEmbed, youTubeCommand } from '@/lib/client/yt-registry'
import {
  attachMediaHost,
  detachMediaHost,
  getMediaHost,
  subscribeMediaHost,
  type MediaHostState,
} from '@/lib/client/media-host'
import { MediaControlsBar, useYouTubeState } from './MediaSurface'
import { AudioLines, Minimize2, Music4, Pause, Pin, Play, X, Youtube } from 'lucide-react'

/** The floating mini media player. It exists for exactly one job: keeping
 *  ACTIVELY PLAYING media alive after you leave the room it lives in (or
 *  pop it out on purpose). The moment playback pauses, ends, or you come
 *  back to the source room, the panel vanishes and the inline embed in the
 *  message row becomes the surface again — the shared host element moves
 *  between them without ever restarting. A paused panel hides entirely but
 *  keeps its state: resuming happens back at the source embed.
 *
 *  File media plays through the registry's single <video> element (attached
 *  into the panel while it is the owner); YouTube keeps its nocookie iframe
 *  with its OWN native playbar (controls=1, enablejsapi for tracking) — no
 *  second Hyperion bar on top of YouTube's. Either way the panel carries the
 *  picture, not just an audio bar. */
export type MediaPlayerSource =
  | { kind: 'file'; url: string; mime: string; name: string; at: number; roomId: string | null; popped?: boolean }
  | { kind: 'youtube'; videoId: string; name: string; startAt: number; at: number; roomId: string | null; popped?: boolean }

export function MediaPlayer() {
  const player = useChatStore((s) => s.mediaPlayer)
  const closeMediaPlayer = useChatStore((s) => s.closeMediaPlayer)
  const currentRoom = useChatStore((s) => {
    if (s.friendsViewOpen || s.accountOpen) return null
    if (s.activeChannelId) return `channel:${s.activeChannelId}`
    if (s.activeConversationId) return `conversation:${s.activeConversationId}`
    return null
  })
  if (!player) return null
  return <MediaPlayerPanel key={player.at} player={player} currentRoom={currentRoom} onClose={closeMediaPlayer} />
}

function MediaPlayerPanel({
  player,
  currentRoom,
  onClose,
}: {
  player: MediaPlayerSource
  currentRoom: string | null
  onClose: () => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const ytRef = useRef<HTMLIFrameElement | null>(null)
  const setMediaPopped = useChatStore((s) => s.setMediaPopped)
  const [collapsed, setCollapsed] = useState(false)
  const [title, setTitle] = useState<string | null>(null)
  /** file-media playback state straight off the host element */
  const [hostState, setHostState] = useState<MediaHostState | null>(null)

  const isYouTube = player.kind === 'youtube'
  const isFile = player.kind === 'file'
  const isVideo = isYouTube || (isFile && player.mime.startsWith('video/'))
  const displayName = isYouTube ? title ?? player.name : player.name

  /** the panel's right to exist: playback must be LIVE (actively playing,
   *  not paused, not finished) AND the user must not be standing in the room
   *  the media lives in (unless they deliberately popped it out). A paused
   *  or finished source hides the panel completely — playback state itself
   *  is preserved so the source embed resumes it. */
  const away = player.popped || player.roomId == null || player.roomId !== currentRoom

  const ytVideoId = player.kind === 'youtube' ? player.videoId : null
  const ytSnap = useYouTubeState(ytVideoId ?? '')
  const ytLive = ytSnap
    ? ytSnap.playerState === 1 || ytSnap.playerState === 3 || ytSnap.playerState === -1
    : true // no poll answer yet: assume live so the iframe gets a chance to start
  // collapsed header toggle state (the native playbar is unreachable at the
  // 2px collapsed height). Optimistic between polls: a click flips it now,
  // the next registry poll reconciles it with the player's real state.
  const [ytToggled, setYtToggled] = useState(false)
  const polledPlaying = ytSnap ? ytSnap.playerState === 1 || ytSnap.playerState === 3 : true
  const ytPlaying = ytToggled ? !polledPlaying : polledPlaying
  const live = isYouTube ? ytLive : !!hostState && !hostState.paused && !hostState.ended
  const visible = away && live

  // ---- file media: own the host element while the panel is the surface ----
  const fileUrl = player.kind === 'file' ? player.url : null
  const fileMime = player.kind === 'file' ? player.mime : null
  useEffect(() => {
    if (!fileUrl || !fileMime) return
    getMediaHost(fileUrl, fileUrl)
    const unsub = subscribeMediaHost(fileUrl, setHostState)
    return unsub
  }, [fileUrl, fileMime])

  useEffect(() => {
    if (!fileUrl || !visible) return
    const c = hostRef.current
    if (!c) return
    attachMediaHost(fileUrl, c)
    return () => detachMediaHost(fileUrl, c)
  }, [fileUrl, visible])

  // finished playback closes the player ONLY when the panel is the surface
  // keeping it alive (away). An inline embed that reaches its end keeps its
  // host element — the source card owns the ended/replay state itself.
  const fileEnded = !isYouTube && hostState?.ended === true
  const ytEnded = isYouTube && ytSnap?.playerState === 0
  useEffect(() => {
    if ((fileEnded || ytEnded) && away) onClose()
  }, [fileEnded, ytEnded, away, onClose])

  // pausing a POPPED file video gives the panel up entirely: the pop-out
  // existed to keep live playback alive, and a paused panel would leave the
  // inline card stuck on a "playing in the mini player" lie. Un-popping
  // returns the paused state (and the resume button) to the source embed.
  // (YouTube keeps its pop-out: its inline card is a thumbnail that resumes
  // at the last tracked second, which already reads correctly when paused.)
  const pausedPopped = isFile && (player.popped ?? false) && !!hostState && hostState.paused && !hostState.ended
  useEffect(() => {
    if (pausedPopped) setMediaPopped(false)
  }, [pausedPopped, setMediaPopped])

  // ---- youtube: point the registry at the panel's iframe so timestamps
  // survive handoffs; unmount parks a paused video (its last time stays
  // readable for the inline card that resumes it) ----
  const ytAt = player.kind === 'youtube' ? player.at : null
  useEffect(() => {
    if (!ytVideoId) return
    const el = visible ? ytRef.current : null
    if (el) trackYouTubeEmbed(ytVideoId, el)
    return () => {
      if (el) releaseYouTubeEmbed(ytVideoId, el)
    }
  }, [ytVideoId, ytAt, visible])

  // coming home: the inline embed takes over; the panel has no reason to
  // stay (the embed resumes at the last tracked timestamp)
  useEffect(() => {
    if (isYouTube && !away) onClose()
  }, [isYouTube, away, onClose])

  // youtube oembed title (CORS-open), async so it never fights the render
  useEffect(() => {
    if (!ytVideoId) return
    let alive = true
    const id = ytVideoId
    fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { title?: string } | null) => {
        if (alive && j?.title) setTitle(j.title)
      })
      .catch(() => {
        // offline or blocked: the generic label stays
      })
    return () => {
      alive = false
    }
  }, [ytVideoId])

  // ---- dragging via the header ----
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const raw = localStorage.getItem('hyperchat-player-pos')
      return raw ? (JSON.parse(raw) as { x: number; y: number }) : null
    } catch {
      return null
    }
  })
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // only drag from the header itself (not the buttons in it)
    if ((e.target as HTMLElement).closest('button')) return
    const panel = (e.currentTarget as HTMLElement).closest('[data-media-player]') as HTMLElement | null
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const w = 320
    const h = 90
    const x = Math.max(8, Math.min(e.clientX - d.dx, window.innerWidth - w - 8))
    const y = Math.max(8, Math.min(e.clientY - d.dy, window.innerHeight - h - 8))
    setPos({ x, y })
  }, [])
  const onPointerEnd = useCallback(() => {
    if (!dragRef.current) return
    dragRef.current = null
    setPos((p) => {
      if (p) {
        try {
          localStorage.setItem('hyperchat-player-pos', JSON.stringify(p))
        } catch {
          // private mode
        }
      }
      return p
    })
  }, [])

  if (!visible) return null

  const style: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y }
    : { right: 16, bottom: 'calc(1rem + env(safe-area-inset-bottom))' }

  const showVideo = isVideo && !collapsed

  return (
    <div
      data-media-player
      data-player-panel
      style={style}
      className="fixed z-[70] w-[min(320px,calc(100vw-2rem))] rounded-sm border border-border bg-app-raise shadow-2xl overflow-hidden select-none will-change-transform"
      role="region"
      aria-label="mini media player"
    >
      {/* header: drag handle + title + quick controls */}
      <div
        className={cn(
          'flex items-center gap-1.5 px-2 py-1.5 bg-app-raise border-b border-border/60 cursor-grab active:cursor-grabbing touch-none',
          collapsed && 'border-b-0'
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {player.popped ? (
          <Pin className="size-3 shrink-0 text-hyper" aria-hidden="true" />
        ) : isYouTube ? (
          <Youtube className="size-3.5 shrink-0 text-hyper" aria-hidden="true" />
        ) : (
          <AudioLines className="size-3.5 shrink-0 text-hyper" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground/90" title={displayName}>
          {displayName}
        </span>
        {isYouTube && collapsed && (
          // collapsed YouTube is audio-only: the native playbar lives in the
          // iframe the user cannot reach at this size, so the header keeps a
          // single play/pause toggle (postMessage) — no Hyperion play bar
          <button
            type="button"
            onClick={() => {
              sounds.play('lightTick')
              setYtToggled((v) => !v)
              youTubeCommand(ytRef.current, ytPlaying ? 'pauseVideo' : 'playVideo')
            }}
            className="grid place-items-center size-6 rounded-sm text-foreground/90 hover:text-foreground hover:bg-white/5 transition-colors"
            aria-label={ytPlaying ? 'Pause' : 'Play'}
            title={ytPlaying ? 'pause' : 'play'}
          >
            {ytPlaying ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </button>
        )}
        {isVideo && (
          <button
            type="button"
            onClick={() => {
              setCollapsed((c) => !c)
              sounds.play('lightTick')
            }}
            className="grid place-items-center size-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
            aria-label={collapsed ? 'Expand video' : 'Collapse to audio'}
            title={collapsed ? 'expand video' : 'collapse to audio'}
          >
            {collapsed ? <Music4 className="size-3.5" /> : <Minimize2 className="size-3.5" />}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            sounds.play('lightTick')
            onClose()
          }}
          className="grid place-items-center size-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
          aria-label="close player"
          title="close"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* the media itself: the panel carries the picture, not just a bar.
          YouTube runs with its own native controls — no custom bar below it */}
      {isYouTube ? (
        <div className="bg-black">
          <div className={cn('relative bg-black', collapsed ? 'h-2' : 'aspect-video')}>
            <iframe
              ref={ytRef}
              key={player.at}
              src={`https://www.youtube-nocookie.com/embed/${player.videoId}?autoplay=1&rel=0&controls=1&start=${player.startAt}&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
              title="video"
              className={cn('size-full absolute inset-0 border-0', collapsed && 'pointer-events-none')}
            />
          </div>
        </div>
      ) : (
        <div className="bg-black">
          {/* the shared host element lands here while the panel is live */}
          <div ref={hostRef} className={cn(showVideo ? 'block' : 'hidden')} />
          {hostState && (
            <MediaControlsBar mediaKey={fileUrl ?? ''} state={hostState} compact={collapsed} />
          )}
        </div>
      )}
    </div>
  )
}
