'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Avatar } from '@/components/hyperchat/Avatar'
import { relativeTime } from '@/lib/client/format'
import { apiClient } from '@/lib/client/api'
import { cn } from '@/lib/utils'
import type { ProfileStoryGroup } from './types'

const STORY_MS = 5000

type Props = {
  groups: ProfileStoryGroup[]
  /** index of the group (and story) the viewer opens on */
  startGroup: number
  startStory?: number
  meId: string | null
  onClose: () => void
  /** fired once per story the caller actually watched */
  onWatched: (userId: string, storyId: string) => void
  /** the story header avatar opens the big profile picture */
  onOpenAvatar: () => void
}

/** Thin progress bar for the current story. Mounted fresh per story (keyed
 *  upstream) so each one starts its own 5s clock; holding the screen pauses
 *  it. With motion turned off the bar sits full instead of sliding. */
function StoryProgressBar({ paused, onComplete }: { paused: boolean; onComplete: () => void }) {
  const [progress, setProgress] = useState(0)
  const pausedRef = useRef(false)
  const completeRef = useRef(onComplete)
  const motionOff = useMemo(
    () => typeof document !== 'undefined' && document.documentElement.dataset.motion === 'off',
    []
  )

  useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  useEffect(() => {
    completeRef.current = onComplete
  }, [onComplete])

  useEffect(() => {
    let raf = 0
    let elapsed = 0
    let last = performance.now()
    let done = false
    const tick = (now: number) => {
      const dt = now - last
      last = now
      if (!pausedRef.current) elapsed += dt
      const p = Math.min(1, elapsed / STORY_MS)
      setProgress(p)
      if (p >= 1) {
        if (!done) {
          done = true
          completeRef.current()
        }
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="h-[2px] w-full bg-white/25 overflow-hidden">
      <div
        className="h-full bg-white"
        style={motionOff ? { width: '100%' } : { width: `${Math.round(progress * 100)}%` }}
      />
    </div>
  )
}

/** Fullscreen story viewer: one sequence per user, thin progress bars at
 *  the top, 5s auto-advance, tap left/right to navigate, hold to pause.
 *  Watched markers persist server-side; the ring grays out once every
 *  story of a sequence has been watched. */
export function StoryViewerOverlay({ groups, startGroup, startStory = 0, meId, onClose, onWatched, onOpenAvatar }: Props) {
  const [gi, setGi] = useState(() => Math.min(Math.max(startGroup, 0), Math.max(groups.length - 1, 0)))
  const [si, setSi] = useState(startStory)
  const [paused, setPaused] = useState(false)

  const group = groups[gi]
  const story = group?.stories[si]

  const goNext = () => {
    const curGroup = groups[gi]
    if (curGroup && si + 1 < curGroup.stories.length) {
      setSi(si + 1)
      return
    }
    if (gi + 1 < groups.length) {
      setGi(gi + 1)
      setSi(0)
      return
    }
    onClose()
  }

  const goPrev = () => {
    if (si > 0) {
      setSi(si - 1)
      return
    }
    if (gi > 0) {
      const prevGroup = groups[gi - 1]
      setGi(gi - 1)
      setSi(Math.max(prevGroup.stories.length - 1, 0))
    }
  }

  // persist the watched marker exactly once per story
  useEffect(() => {
    if (!group || !story) return
    if (group.user.id === meId) return
    void apiClient
      .viewStory(story.id)
      .then(() => onWatched(group.user.id, story.id))
      .catch(() => {
        /* the ring simply stays unwatched; the next open retries */
      })
  }, [group, story, meId, onWatched])

  if (!group || !story) return null

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="w-screen h-dvh max-w-none sm:max-w-none p-0 rounded-none border-0 bg-black gap-0 overflow-hidden"
        aria-describedby={undefined}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') {
            e.preventDefault()
            goNext()
          } else if (e.key === 'ArrowLeft') {
            e.preventDefault()
            goPrev()
          }
        }}
      >
        <DialogTitle className="sr-only">
          {group.user.displayName || group.user.username} stories
        </DialogTitle>

        <div
          className="relative size-full select-none"
          onPointerDown={() => setPaused(true)}
          onPointerUp={() => setPaused(false)}
          onPointerLeave={() => setPaused(false)}
        >
          {/* header: progress bars + author + close */}
          <div className="absolute top-0 inset-x-0 z-20 p-3 sm:p-4 bg-gradient-to-b from-black/80 to-transparent">
            <div className="flex gap-1" aria-hidden="true">
              {group.stories.map((s, idx) =>
                idx === si ? (
                  <StoryProgressBar key={s.id} paused={paused} onComplete={goNext} />
                ) : (
                  <div key={s.id} className="h-[2px] flex-1 bg-white/25 overflow-hidden">
                    {idx < si ? <div className="h-full w-full bg-white" /> : null}
                  </div>
                )
              )}
            </div>
            <div className="mt-3 flex items-center gap-2.5">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenAvatar()
                  onClose()
                }}
                className="rounded-full transition-transform duration-200 hover:scale-[1.05]"
                aria-label="view profile picture"
                title="view profile picture"
              >
                <Avatar name={group.user.username} color={group.user.avatarColor} url={group.user.avatarUrl} size="md" />
              </button>
              <div className="min-w-0">
                <p className="text-sm font-bold truncate">{group.user.displayName || group.user.username}</p>
                <p className="text-[11px] text-white/60">{relativeTime(story.createdAt)}</p>
              </div>
              <div className="flex-1" />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose()
                }}
                className="p-2 text-white/70 hover:text-white transition-colors"
                aria-label="close stories"
                title="close stories"
              >
                <X className="size-5" />
              </button>
            </div>
          </div>

          {/* the story itself, edge to edge */}
          <img
            key={story.id}
            src={story.imageUrl}
            alt={`${group.user.username} story`}
            className="absolute inset-0 size-full object-contain hc-fade-in"
            draggable={false}
          />

          {/* tap zones: right = next, left = previous */}
          <button
            type="button"
            className="absolute inset-y-0 right-0 w-[32%] z-10 cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              goNext()
            }}
            aria-label="next story"
          />
          <button
            type="button"
            className="absolute inset-y-0 left-0 w-[32%] z-10 cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              goPrev()
            }}
            aria-label="previous story"
          />

          <span className="sr-only" role="status">
            story {si + 1} of {group.stories.length}
            {paused ? ', paused' : ''}
          </span>

          {paused && (
            <div
              className={cn(
                'absolute bottom-4 left-1/2 -translate-x-1/2 z-20 text-[10px] font-bold tracking-widest text-white/70 bg-black/60 border border-white/10 px-2 py-1 rounded-sm'
              )}
            >
              paused
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
