'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useChatStore } from '@/lib/client/store'
import { apiClient } from '@/lib/client/api'
import { lastOnlineLabel } from '@/lib/client/format'
import { Avatar } from './Avatar'
import type { PublicUser } from '@/lib/types'

const CARD_W = 256

/** The medium-small profile card: one click on an avatar anywhere opens
 *  this compact preview; clicking the avatar inside it opens the full
 *  profile card. Controlled by the parent, rendered through a portal,
 *  anchored to the element that spawned it. Give it a key on username so
 *  switching people remounts it with a clean fetch. */
export function MiniProfilePopover({
  username,
  anchorRect,
  onClose,
}: {
  username: string
  anchorRect: DOMRect
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [profile, setProfile] = useState<{ user: PublicUser; mutualServers: { id: string; name: string; iconUrl: string | null }[] } | null>(null)
  const [failed, setFailed] = useState(false)

  const onlineUserIds = useChatStore((s) => s.onlineUserIds)
  const presenceStatuses = useChatStore((s) => s.presenceStatuses)
  const lastSeen = useChatStore((s) => s.lastSeen)

  // fetch the profile fresh every time the card opens for someone
  useEffect(() => {
    let alive = true
    void apiClient
      .userProfile(username)
      .then((res) => {
        if (alive) setProfile(res)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [username])

  // live snapshot: any store surface holding this user is patched by the
  // global user:profile broadcast (or a local optimistic apply), so the
  // card repaints the moment they change something - no refetch. The
  // returned reference only moves when a patch actually lands on them.
  const liveId = profile?.user.id
  const live = useChatStore((s): PublicUser | null => {
    if (!liveId) return null
    if (s.me?.id === liveId) return s.me
    if (s.profileUser?.id === liveId) return s.profileUser
    for (const c of s.conversations) {
      if (c.otherUser?.id === liveId) return c.otherUser
      const p = c.participants?.find((x) => x.id === liveId)
      if (p) return p
    }
    for (const list of Object.values(s.serverMembers)) {
      const m = list.find((x) => x.id === liveId)
      if (m) return m
    }
    const friend = s.friends.find((x) => x.user.id === liveId)
    if (friend) return friend.user
    for (const state of Object.values(s.rooms)) {
      const author = state.messages.find((m) => m.author.id === liveId)?.author
      if (author) return author
    }
    return null
  })

  // fetched fields the patch surfaces may not carry (pronouns, ...) stay
  // from the fetch; everything the broadcast knows wins
  const user = useMemo(() => {
    if (!profile) return null
    if (!live || live.id !== profile.user.id) return profile.user
    return {
      ...profile.user,
      username: live.username,
      displayName: live.displayName,
      avatarUrl: live.avatarUrl,
      avatarColor: live.avatarColor,
      bio: live.bio,
      customStatus: live.customStatus,
      bannerColor: live.bannerColor,
      bannerUrl: live.bannerUrl,
      pronouns: live.pronouns ?? profile.user.pronouns,
    }
  }, [profile, live])

  // close on outside click (ignoring the anchor: its own click toggles),
  // Escape, and any scroll or resize
  useEffect(() => {
    const inAnchor = (x: number, y: number) =>
      x >= anchorRect.left && x <= anchorRect.right && y >= anchorRect.top && y <= anchorRect.bottom
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && ref.current.contains(e.target as Node)) return
      if (inAnchor(e.clientX, e.clientY)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onAnyScroll = () => onClose()
    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onAnyScroll, { capture: true })
    window.addEventListener('resize', onAnyScroll)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true })
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onAnyScroll, { capture: true })
      window.removeEventListener('resize', onAnyScroll)
    }
  }, [anchorRect, onClose])

  // place below the anchor (above when it would clip), clamped sideways.
  // Runs after every render: the card grows when the profile lands, so the
  // measured height has to be re-read before the browser paints.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const h = el.offsetHeight
    let left = anchorRect.left
    left = Math.max(8, Math.min(left, window.innerWidth - CARD_W - 8))
    let top = anchorRect.bottom + 6
    if (top + h > window.innerHeight - 8) {
      top = Math.max(8, anchorRect.top - h - 6)
    }
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  })

  if (typeof document === 'undefined') return null

  const status = user
    ? onlineUserIds[user.id]
      ? (presenceStatuses[user.id] as 'online' | 'idle' | 'busy' | 'dnd' | undefined) ?? 'online'
      : 'offline'
    : 'offline'
  const lastSeenIso = user && status === 'offline' ? lastSeen[user.id] : undefined

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[95] w-64 bg-app-sidebar border border-white/10 rounded-sm shadow-2xl overflow-hidden menu-in"
      role="dialog"
      aria-label={`${username} mini profile`}
    >
      {/* banner + avatar breaking the bottom edge, status bubble beside it */}
      <div className="relative">
        <div
          className="h-14 relative overflow-hidden border-b border-white/10"
          style={
            !user?.bannerUrl && user?.bannerColor
              ? { backgroundColor: user.bannerColor }
              : !user?.bannerUrl
                ? { backgroundColor: '#1c1c1c' }
                : undefined
          }
        >
          {user?.bannerUrl && (
            <img src={user.bannerUrl} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            useChatStore.getState().openProfile(username)
            onClose()
          }}
          className="absolute left-3 top-[34px] z-10 rounded-full ring-2 ring-app-sidebar transition-transform duration-200 hover:scale-[1.06] focus-visible:scale-[1.06]"
          aria-label={`Open ${username}'s profile`}
          title="open profile"
        >
          <Avatar
            name={username}
            color={user?.avatarColor}
            url={user?.avatarUrl}
            size="lg"
            status={status}
            showDot
          />
        </button>
        {user?.customStatus && (
          <div className="absolute left-[3.75rem] top-[40px] z-10 max-w-[calc(100%-4.5rem)] fade-in">
            <div className="status-bubble border border-white/10 bg-app-raise px-2 py-1 text-[10px] text-foreground/90 break-words leading-snug whitespace-pre-wrap">
              {user.customStatus}
            </div>
          </div>
        )}
      </div>

      <div className="pt-6 px-3 pb-3 min-h-[52px]">
        {user ? (
          <>
            <p className="text-sm font-bold tracking-tight truncate">
              {user.displayName || user.username}
            </p>
            <p className="text-[11px] text-muted-foreground truncate">
              @{user.username}
              {user.pronouns && <span className="text-muted-foreground/80"> · {user.pronouns}</span>}
            </p>
            {status === 'offline' && lastSeenIso && (
              <p className="mt-1 text-[10px] text-muted-foreground truncate">
                last online {lastOnlineLabel(lastSeenIso)}
              </p>
            )}
            {user.bio && (
              <p className="mt-1.5 text-[11px] text-foreground/80 leading-snug line-clamp-2 break-words whitespace-pre-wrap">
                {user.bio}
              </p>
            )}
          </>
        ) : failed ? (
          <p className="py-2 text-xs text-muted-foreground">profile unavailable</p>
        ) : (
          <p className="py-2 text-xs text-muted-foreground">@{username}</p>
        )}
      </div>
    </div>,
    document.body
  )
}
