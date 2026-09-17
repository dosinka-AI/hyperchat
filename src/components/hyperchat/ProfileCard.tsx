'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { getSocket } from '@/lib/client/socket'
import { apiClient, ApiError } from '@/lib/client/api'
import { formatJoinDate, initialsOf, lastOnlineLabel } from '@/lib/client/format'
import { sounds } from '@/lib/client/sounds'
import { PERM, hasPerm } from '@/lib/perm'
import { Avatar } from './Avatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AtSign, MessageSquare, Shield, Ban, Users, UserX, Clock, UserMinus, Tag, Settings2, Camera, ImagePlus } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { confirmDialog, promptDialog } from './ConfirmDialog'
import { awayForLabel } from './MessageList'
import { ProfileStyles } from './profile/ProfileStyles'
import { ProfilePostsTab } from './profile/ProfilePostsTab'
import { PostDetailOverlay } from './profile/PostDetailOverlay'
import { StoryTray } from './profile/StoryTray'
import { StoryViewerOverlay } from './profile/StoryViewerOverlay'
import { CreatePostOverlay } from './profile/CreatePostOverlay'
import { CreateStoryOverlay } from './profile/CreateStoryOverlay'
import { FollowListOverlay } from './profile/FollowListOverlay'
import type { ProfileFeedPost, ProfileShow, ProfileStoryGroup } from './profile/types'

const TIMEOUT_CHOICES: { minutes: number; label: string }[] = [
  { minutes: 1, label: 'for 1 minute' },
  { minutes: 5, label: 'for 5 minutes' },
  { minutes: 10, label: 'for 10 minutes' },
  { minutes: 60, label: 'for 1 hour' },
  { minutes: 1440, label: 'for 1 day' },
  { minutes: 10080, label: 'for 1 week' },
]

/** "Custom..." timeout entry: expands into a minutes input + apply button. */
function CustomTimeoutItem({ onApply }: { onApply: (minutes: number) => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const minutes = (() => {
    const n = Number(value)
    return Number.isFinite(n) && n >= 1 && n <= 10080 ? Math.round(n) : null
  })()
  if (!editing) {
    return (
      <DropdownMenuItem onClick={() => setEditing(true)}>
        <Settings2 className="size-3.5" />
        Custom...
      </DropdownMenuItem>
    )
  }
  return (
    <div className="px-2 py-1.5 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <input
        type="number"
        min={1}
        max={10080}
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="minutes"
        aria-label="custom timeout minutes"
        className="w-20 bg-app-raise border border-white/10 rounded-sm px-1.5 py-1 text-xs outline-none focus:border-hyper/60"
      />
      <button
        disabled={minutes === null}
        onClick={() => {
          if (minutes !== null) {
            onApply(minutes)
            setEditing(false)
            setValue('')
          }
        }}
        className="px-2 py-1 text-[11px] font-semibold rounded-sm border border-hyper/50 text-hyper hover:bg-hyper/10 transition-colors disabled:opacity-40"
      >
        apply
      </button>
    </div>
  )
}

type BodyProps = {
  onClose: () => void
}

/**
 * The profile card. The original single-purpose card grew into an
 * Instagram-style profile: banner + story-ringed avatar header, stats row,
 * follow, a posts grid with a detail view and comments, a story tray and
 * viewer on the own profile — with every moderation action preserved under
 * the "about" tab. The body below is keyed by username so every profile
 * opens fresh.
 */
export function ProfileCard() {
  const profileOpen = useChatStore((s) => s.profileOpen)
  const profileUser = useChatStore((s) => s.profileUser)
  const closeProfile = useChatStore((s) => s.closeProfile)
  const me = useChatStore((s) => s.me)
  const blockedUserIds = useChatStore((s) => s.blockedUserIds)

  const [avatarLightbox, setAvatarLightbox] = useState(false)

  if (!profileUser) return null

  const blocked = !!blockedUserIds[profileUser.id]

  return (
    <>
      <ProfileStyles />
      <Dialog open={profileOpen} onOpenChange={(open) => !open && closeProfile()}>
        <DialogContent className="w-[min(38rem,94vw)] max-w-none sm:max-w-none p-0 border-border bg-app-sidebar overflow-hidden rounded-sm dialog-in" aria-describedby={undefined}>
          <DialogTitle className="sr-only">{profileUser.displayName || profileUser.username} profile</DialogTitle>
          <ProfileCardBody key={profileUser.username} onClose={closeProfile} onAvatarLightbox={() => setAvatarLightbox(true)} isBlocked={blocked} />
        </DialogContent>
      </Dialog>

      {/* avatar lightbox: big and square, edge to edge */}
      <Dialog open={avatarLightbox} onOpenChange={setAvatarLightbox}>
        <DialogContent
          className="w-screen h-dvh max-w-none sm:max-w-none p-0 rounded-none border-0 bg-black/95 gap-0 overflow-hidden data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100"
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">{profileUser.displayName || profileUser.username} profile picture</DialogTitle>
          <div className="grid h-full w-full place-items-center">
            {profileUser.avatarUrl ? (
              <img
                src={profileUser.avatarUrl}
                alt={`${profileUser.username} profile picture`}
                className="max-h-[min(88vh,88vw)] max-w-[min(88vw,88vh)] aspect-square object-cover select-none"
                draggable={false}
              />
            ) : (
              <div
                className="size-[min(60vh,60vw)] rounded-full grid place-items-center font-bold text-[min(18vh,18vw)] select-none"
                style={{ backgroundColor: profileUser.avatarColor, color: '#fff' }}
                aria-hidden="true"
              >
                {initialsOf(profileUser.username)}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ProfileCardBody({ onClose, onAvatarLightbox, isBlocked }: BodyProps & { onAvatarLightbox: () => void; isBlocked: boolean }) {
  const profileUser = useChatStore((s) => s.profileUser)
  const openDM = useChatStore((s) => s.openDM)
  const me = useChatStore((s) => s.me)
  const onlineUserIds = useChatStore((s) => s.onlineUserIds)
  const presenceStatuses = useChatStore((s) => s.presenceStatuses)
  const awaySince = useChatStore((s) => s.awaySince)
  const lastSeen = useChatStore((s) => s.lastSeen)
  const blockUser = useChatStore((s) => s.blockUser)
  const unblockUser = useChatStore((s) => s.unblockUser)
  const activeServerId = useChatStore((s) => s.activeServerId)
  const servers = useChatStore((s) => s.servers)
  const serverMembers = useChatStore((s) => s.serverMembers)
  const serverRoles = useChatStore((s) => s.serverRoles)
  const timeoutMember = useChatStore((s) => s.timeoutMember)
  const kickMember = useChatStore((s) => s.kickMember)
  const banMember = useChatStore((s) => s.banMember)
  const setMemberCustomRole = useChatStore((s) => s.setMemberCustomRole)
  const setMemberNickname = useChatStore((s) => s.setMemberNickname)
  const { toast } = useToast()

  const [nickDraft, setNickDraft] = useState<string | null>(null)
  const [tab, setTab] = useState<'posts' | 'about'>('posts')
  const [show, setShow] = useState<ProfileShow | null>(null)
  const [posts, setPosts] = useState<ProfileFeedPost[]>([])
  const [postsNextOffset, setPostsNextOffset] = useState<number | null>(null)
  const [postsLoading, setPostsLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [storyGroups, setStoryGroups] = useState<ProfileStoryGroup[]>([])
  const [viewer, setViewer] = useState<{ groups: ProfileStoryGroup[]; group: number; story: number } | null>(null)
  const [openPostId, setOpenPostId] = useState<string | null>(null)
  const [createPostOpen, setCreatePostOpen] = useState(false)
  const [createStoryOpen, setCreateStoryOpen] = useState(false)
  const [followList, setFollowList] = useState<'followers' | 'following' | null>(null)
  const [followBusy, setFollowBusy] = useState(false)

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const username = profileUser?.username ?? ''

  const isSelf = !!profileUser && profileUser.id === me?.id

  const loadShow = useCallback(async () => {
    if (!username) return
    try {
      const res = await apiClient.profileShow(username)
      setShow((cur) => (cur && cur.user.username !== username ? cur : res))
    } catch {
      /* profile extension is best-effort; the card still renders */
    }
  }, [username])

  const loadPosts = useCallback(
    async (offset: number, replace: boolean) => {
      if (!username) return
      try {
        const res = await apiClient.profilePosts(username, offset)
        setPosts((cur) => (replace ? res.posts : [...cur, ...res.posts]))
        setPostsNextOffset(res.nextOffset)
      } catch {
        if (replace) setPosts([])
        setPostsNextOffset(null)
      } finally {
        setPostsLoading(false)
        setLoadingMore(false)
      }
    },
    [username]
  )

  const loadStoryFeed = useCallback(async () => {
    try {
      const res = await apiClient.storyFeed()
      setStoryGroups(res.groups)
    } catch {
      /* tray is best-effort */
    }
  }, [])

  // initial load for this profile (the body remounts per username)
  useEffect(() => {
    void loadShow()
    void loadPosts(0, true)
    if (isSelf) void loadStoryFeed()
  }, [loadShow, loadPosts, loadStoryFeed, isSelf])

  // light poll while the card is open: stats + story state stay honest
  useEffect(() => {
    const t = setInterval(() => {
      void loadShow()
      if (isSelf) void loadStoryFeed()
    }, 15000)
    return () => clearInterval(t)
  }, [loadShow, loadStoryFeed, isSelf])

  // live refresh: the api routes broadcast profile:refresh through the
  // realtime service; react when it concerns the open profile or my tray
  useEffect(() => {
    const sock = getSocket()
    if (!sock) return
    const handler = (data: unknown) => {
      const eventUsername =
        data && typeof data === 'object' && typeof (data as { username?: unknown }).username === 'string'
          ? (data as { username: string }).username
          : null
      if (eventUsername && eventUsername === username) {
        void loadShow()
        void loadPosts(0, true)
      }
      if (isSelf) void loadStoryFeed()
    }
    sock.on('profile:refresh', handler)
    return () => {
      sock.off('profile:refresh', handler)
    }
  }, [username, isSelf, loadShow, loadPosts, loadStoryFeed])

  if (!profileUser) return null

  const online = !!onlineUserIds[profileUser.id]
  const visibleStatus = online ? presenceStatuses[profileUser.id] ?? 'online' : 'offline'
  const awayStamp = online && visibleStatus === 'idle' ? awaySince[profileUser.id] : undefined
  const lastSeenIso = !online ? lastSeen[profileUser.id] : undefined
  const mutualServers = (profileUser as { mutualServers?: { id: string; name: string; iconUrl: string | null }[] }).mutualServers ?? []

  // moderation context: the profile must belong to a member of the server I am viewing
  const server = activeServerId ? servers.find((s) => s.id === activeServerId) : null
  const myPerms = server?.myPerms ?? 0
  const theirMembership = activeServerId
    ? (serverMembers[activeServerId] ?? []).find((m) => m.id === profileUser.id) ?? null
    : null
  const roles = activeServerId ? serverRoles[activeServerId] ?? [] : []
  const isServerOwner = server?.ownerId === profileUser.id

  const canTimeout = !isSelf && !!theirMembership && !isServerOwner && hasPerm(myPerms, PERM.TIMEOUT_MEMBERS) &&
    (server?.myRole === 'OWNER' || theirMembership.role !== 'ADMIN')
  const canKick = !isSelf && !!theirMembership && !isServerOwner && hasPerm(myPerms, PERM.KICK_MEMBERS) &&
    (server?.myRole === 'OWNER' || theirMembership.role !== 'ADMIN')
  const canBan = !isSelf && !!theirMembership && !isServerOwner && hasPerm(myPerms, PERM.BAN_MEMBERS) &&
    (server?.myRole === 'OWNER' || theirMembership.role !== 'ADMIN')
  const canAssignRole = !isSelf && !!theirMembership && !isServerOwner && hasPerm(myPerms, PERM.MANAGE_ROLES)
  const canNick = !!theirMembership && (isSelf || (!isServerOwner && hasPerm(myPerms, PERM.MANAGE_NICKNAMES)))
  const timedOut = theirMembership?.timeoutUntil
    ? new Date(theirMembership.timeoutUntil).getTime() > Date.now()
    : false
  const anyModTools = canTimeout || canKick || canBan || canAssignRole || canNick

  async function modAction(label: string, fn: () => Promise<void>) {
    try {
      await fn()
      sounds.play('midTick')
      toast({ title: label })
    } catch (err) {
      sounds.play('error')
      toast({ title: 'action failed', description: err instanceof ApiError ? err.message : 'Try again.' })
    }
  }

  async function toggleFollow() {
    if (!show || followBusy) return
    const next = !show.isFollowing
    setFollowBusy(true)
    setShow({
      ...show,
      isFollowing: next,
      stats: { ...show.stats, followers: Math.max(0, show.stats.followers + (next ? 1 : -1)) },
    })
    try {
      const res = next ? await apiClient.followUser(username) : await apiClient.unfollowUser(username)
      setShow((cur) =>
        cur ? { ...cur, isFollowing: res.following, stats: { ...cur.stats, followers: res.followersCount } } : cur
      )
      sounds.play('midTick')
    } catch (err) {
      setShow((cur) =>
        cur
          ? {
              ...cur,
              isFollowing: !next,
              stats: { ...cur.stats, followers: Math.max(0, cur.stats.followers - (next ? 1 : -1)) },
            }
          : cur
      )
      toast({ title: 'action failed', description: err instanceof ApiError ? err.message : 'Try again.' })
    } finally {
      setFollowBusy(false)
    }
  }

  function openAvatarStories() {
    if (!show || !show.hasActiveStory || show.stories.length === 0 || !profileUser) return
    const group: ProfileStoryGroup = {
      user: {
        id: profileUser.id,
        username: profileUser.username,
        displayName: profileUser.displayName,
        avatarUrl: profileUser.avatarUrl,
        avatarColor: profileUser.avatarColor,
      },
      // stories arrive newest-first; the viewer plays them oldest-first
      stories: [...show.stories].reverse(),
      allViewed: show.stories.every((s) => s.viewed),
      latestAt: show.stories[0]?.createdAt ?? new Date().toISOString(),
    }
    setViewer({ groups: [group], group: 0, story: 0 })
  }

  function openStoryGroup(groupIndex: number) {
    const groups = storyGroups.map((g) => ({ ...g, stories: [...g.stories].reverse() }))
    const g = groups[groupIndex]
    if (!g) return
    const firstUnwatched = g.stories.findIndex((s) => !s.viewed)
    setViewer({ groups, group: groupIndex, story: firstUnwatched >= 0 ? firstUnwatched : 0 })
  }

  function handleWatched(userId: string, storyId: string) {
    setShow((cur) => {
      if (!cur || cur.user.id !== userId) return cur
      const stories = cur.stories.map((s) => (s.id === storyId ? { ...s, viewed: true } : s))
      return { ...cur, stories, hasUnwatchedStory: stories.some((s) => !s.viewed) }
    })
    setStoryGroups((cur) =>
      cur.map((g) => {
        if (g.user.id !== userId) return g
        const stories = g.stories.map((s) => (s.id === storyId ? { ...s, viewed: true } : s))
        return { ...g, stories, allViewed: stories.every((s) => s.viewed) }
      })
    )
  }

  function handleTabKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const next = tab === 'posts' ? 'about' : 'posts'
    setTab(next)
    tabRefs.current[next === 'posts' ? 0 : 1]?.focus()
  }

  const stats = show?.stats
  const hasActiveStory = show?.hasActiveStory ?? false
  const hasUnwatchedStory = show?.hasUnwatchedStory ?? false

  return (
    <>
      <div className="max-h-[85vh] overflow-y-auto scroll-thin">
        {/* profile head: thick solid-color banner, avatar breaking the bottom
         * edge on its own layer (never clipped, never behind the border).
         * A story ring wraps the avatar when one is live: bright while
         * unwatched stories remain, gray once everything has been seen. */}
        <div className="relative">
          <div
            className="h-36 relative overflow-hidden border-b border-white/10"
            style={
              !profileUser.bannerUrl && profileUser.bannerColor
                ? { backgroundColor: profileUser.bannerColor }
                : !profileUser.bannerUrl
                  ? { backgroundColor: '#1c1c1c' }
                  : undefined
            }
          >
            {profileUser.bannerUrl && (
              <img src={profileUser.bannerUrl} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />
            )}
          </div>
          <button
            type="button"
            className={cn(
              'absolute left-5 top-[82px] z-10 transition-transform duration-200 hover:scale-[1.03] focus-visible:scale-[1.03]',
              hasActiveStory ? 'rounded-full p-[3px]' : 'rounded-full ring-4 ring-app-sidebar',
              hasActiveStory && (hasUnwatchedStory ? 'bg-white/85' : 'bg-white/15')
            )}
            onClick={() => (hasActiveStory ? openAvatarStories() : onAvatarLightbox())}
            aria-label={hasActiveStory ? `view ${profileUser.username} stories` : 'view profile picture'}
            title={hasActiveStory ? `view ${profileUser.username} stories` : 'view profile picture'}
          >
            <Avatar
              name={profileUser.username}
              color={profileUser.avatarColor}
              url={profileUser.avatarUrl}
              size="2xl"
              status={visibleStatus}
              showDot
            />
            {hasActiveStory && hasUnwatchedStory && (
              <span className="absolute top-0.5 right-0.5 size-2.5 bg-hyper" aria-hidden="true" />
            )}
          </button>
          {/* custom status as a speech bubble growing out of the avatar */}
          {profileUser.customStatus && (
            <div className="absolute left-36 top-[92px] z-10 max-w-[calc(100%-10.5rem)] fade-in">
              <div className="status-bubble border border-white/10 bg-app-raise px-3 py-1.5 text-xs text-foreground/90 break-words leading-snug whitespace-pre-wrap">
                {profileUser.customStatus}
              </div>
            </div>
          )}
        </div>

        <div className="pt-14 px-5 pb-5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-base font-bold tracking-tight truncate">
                {theirMembership?.nickname || profileUser.displayName || profileUser.username}
              </h3>
              <p className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                <AtSign className="size-3 shrink-0" />
                {profileUser.username}
                {profileUser.pronouns && (
                  <span className="text-muted-foreground/80">· {profileUser.pronouns}</span>
                )}
              </p>
              {/* status line: away time other people can see */}
              <p className="mt-1 text-[11px] flex items-center gap-1.5">
                <span
                  className={cn(
                    'size-2 rounded-full shrink-0',
                    visibleStatus === 'online' && 'bg-online',
                    visibleStatus === 'idle' && 'bg-idle',
                    visibleStatus === 'busy' && 'bg-busy',
                    visibleStatus === 'dnd' && 'bg-dnd',
                    visibleStatus === 'offline' && 'bg-offline'
                  )}
                  aria-hidden="true"
                />
                <span className={cn(
                  'font-semibold',
                  visibleStatus === 'online' && 'text-online',
                  visibleStatus === 'idle' && 'text-idle',
                  visibleStatus === 'busy' && 'text-busy',
                  visibleStatus === 'dnd' && 'text-dnd',
                  visibleStatus === 'offline' && 'text-muted-foreground'
                )}>
                  {visibleStatus === 'idle'
                    ? 'Away'
                    : visibleStatus === 'busy'
                      ? 'Busy'
                      : visibleStatus === 'dnd'
                        ? 'Do not disturb'
                        : visibleStatus === 'online'
                          ? 'Online'
                          : 'Offline'}
                </span>
                {awayStamp && <span className="text-muted-foreground">{awayForLabel(awayStamp)}</span>}
                {!online && lastSeenIso && (
                  <span className="text-muted-foreground truncate">last online {lastOnlineLabel(lastSeenIso)}</span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {profileUser.role === 'ADMIN' && (
                <span
                  className="flex items-center gap-1 text-[10px] font-bold tracking-wider text-hyper bg-hyper/10 border border-hyper/40 px-1.5 py-0.5 rounded-sm"
                  title="administers the entire HyperChat platform, beyond any single server"
                >
                  <Shield className="size-3" />
                  HYPERCHAT ADMIN
                </span>
              )}
              {isServerOwner && (
                <span
                  className="flex items-center gap-1 text-[10px] font-bold tracking-wider text-foreground bg-app-raise border border-white/20 px-1.5 py-0.5 rounded-sm"
                  title="owns this server"
                >
                  SERVER OWNER
                </span>
              )}
              {theirMembership?.roleName && (
                <span
                  className="flex items-center gap-1 text-[10px] font-bold tracking-wider bg-app-raise border border-white/15 px-1.5 py-0.5 rounded-sm truncate max-w-28"
                  style={theirMembership.roleColor ? { color: theirMembership.roleColor } : undefined}
                >
                  {theirMembership.roleName.toUpperCase()}
                </span>
              )}
              {timedOut && (
                <span className="flex items-center gap-1 text-[10px] font-bold tracking-wider text-destructive bg-app-raise border border-destructive/40 px-1.5 py-0.5 rounded-sm">
                  <Clock className="size-3" />
                  TIMED OUT
                </span>
              )}
            </div>
          </div>

          {profileUser.bio && (
            <p className="mt-3 text-sm text-foreground/90 leading-relaxed break-words whitespace-pre-wrap">{profileUser.bio}</p>
          )}

          <div className="mt-3 text-[11px] text-muted-foreground">
            {profileUser.createdAt ? `Hyperion member since ${formatJoinDate(profileUser.createdAt)}` : null}
          </div>

          {/* stats row: posts / followers / following, tappable */}
          {stats ? (
            <div
              className="mt-4 grid grid-cols-3 border border-white/10 rounded-sm divide-x divide-white/10 overflow-hidden"
              role="group"
              aria-label="profile stats"
            >
              <button
                type="button"
                onClick={() => setTab('posts')}
                className="py-2.5 hover:bg-app-raise transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hyper/70"
                aria-label={`${stats.posts} posts`}
              >
                <span className="block text-base font-bold tabular-nums">{stats.posts}</span>
                <span className="block text-[10px] font-bold tracking-widest text-muted-foreground">posts</span>
              </button>
              <button
                type="button"
                onClick={() => setFollowList('followers')}
                className="py-2.5 hover:bg-app-raise transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hyper/70"
                aria-label={`${stats.followers} followers`}
              >
                <span className="block text-base font-bold tabular-nums">{stats.followers}</span>
                <span className="block text-[10px] font-bold tracking-widest text-muted-foreground">followers</span>
              </button>
              <button
                type="button"
                onClick={() => setFollowList('following')}
                className="py-2.5 hover:bg-app-raise transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hyper/70"
                aria-label={`${stats.following} following`}
              >
                <span className="block text-base font-bold tabular-nums">{stats.following}</span>
                <span className="block text-[10px] font-bold tracking-widest text-muted-foreground">following</span>
              </button>
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-3 border border-white/10 rounded-sm divide-x divide-white/10 overflow-hidden" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="py-2.5 bg-white/[0.03]">
                  <div className="mx-auto w-8 h-4 bg-white/10" />
                  <div className="mx-auto mt-1 w-10 h-2 bg-white/5" />
                </div>
              ))}
            </div>
          )}

          {/* action row: follow + message (or, on the own profile, edit +
           * create affordances) */}
          {!isSelf ? (
            <div className="mt-3 flex gap-1.5">
              {!isBlocked && (
                <Button
                  variant={show?.isFollowing ? 'secondary' : 'default'}
                  className="flex-1 rounded-sm justify-center press"
                  onClick={() => void toggleFollow()}
                  disabled={followBusy || !show}
                  aria-pressed={show?.isFollowing ?? false}
                >
                  {show?.isFollowing ? 'following' : 'follow'}
                </Button>
              )}
              {!isBlocked && (
                <Button
                  variant="secondary"
                  className="flex-1 rounded-sm justify-center press"
                  onClick={() => {
                    sounds.play('midTick')
                    void openDM(profileUser.id)
                    onClose()
                  }}
                >
                  <MessageSquare className="size-4" />
                  message
                </Button>
              )}
            </div>
          ) : (
            <div className="mt-3 flex gap-1.5">
              <Button
                variant="secondary"
                className="flex-1 rounded-sm justify-center press"
                onClick={() => {
                  useChatStore.getState().setProfileEditorOpen(true)
                  onClose()
                }}
              >
                Edit your profile
              </Button>
              <Button
                variant="secondary"
                size="icon"
                className="rounded-sm shrink-0"
                onClick={() => setCreateStoryOpen(true)}
                aria-label="new story"
                title="new story"
              >
                <Camera className="size-4" />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                className="rounded-sm shrink-0"
                onClick={() => setCreatePostOpen(true)}
                aria-label="new post"
                title="new post"
              >
                <ImagePlus className="size-4" />
              </Button>
            </div>
          )}

          {/* tabs: posts grid + about */}
          <div
            role="tablist"
            aria-label="profile sections"
            className="mt-4 flex border-b border-white/10"
            onKeyDown={handleTabKeyDown}
          >
            {(['posts', 'about'] as const).map((t, idx) => (
              <button
                key={t}
                ref={(el) => {
                  tabRefs.current[idx] = el
                }}
                type="button"
                role="tab"
                id={`profile-tab-${t}`}
                aria-selected={tab === t}
                aria-controls={`profile-panel-${t}`}
                tabIndex={tab === t ? 0 : -1}
                onClick={() => setTab(t)}
                className={cn(
                  'flex-1 h-10 text-xs font-bold tracking-widest transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hyper/70',
                  tab === t ? 'text-foreground border-b-2 border-foreground -mb-px' : 'text-muted-foreground hover:text-foreground/80'
                )}
              >
                {t}
              </button>
            ))}
          </div>

          {tab === 'posts' ? (
            <div role="tabpanel" id="profile-panel-posts" aria-labelledby="profile-tab-posts" className="pt-4">
              {isSelf && (
                <div className="mb-4">
                  <StoryTray groups={storyGroups} meId={me?.id ?? null} onCreate={() => setCreateStoryOpen(true)} onOpen={openStoryGroup} />
                </div>
              )}
              <ProfilePostsTab
                isSelf={isSelf}
                posts={posts}
                nextOffset={postsNextOffset}
                loading={postsLoading}
                loadingMore={loadingMore}
                onLoadMore={() => {
                  setLoadingMore(true)
                  void loadPosts(postsNextOffset ?? 0, false)
                }}
                onOpenPost={(id) => setOpenPostId(id)}
                onCreate={() => setCreatePostOpen(true)}
              />
            </div>
          ) : (
            <div role="tabpanel" id="profile-panel-about" aria-labelledby="profile-tab-about" className="pt-4">
              {/* about: everything profile-and-moderation lives here */}

              {mutualServers.length > 0 && (
                <div>
                  <p className="text-[10px] font-bold tracking-widest text-muted-foreground flex items-center gap-1">
                    <Users className="size-3" />
                    mutual servers
                  </p>
                  <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                    {mutualServers.map((s) => (
                      <span
                        key={s.id}
                        title={s.name}
                        className="size-7 rounded-sm overflow-hidden border border-white/10 grid place-items-center bg-app-raise"
                      >
                        {s.iconUrl ? (
                          <img src={s.iconUrl} alt={s.name} className="size-full object-cover" draggable={false} />
                        ) : (
                          <span className="text-[9px] font-bold text-muted-foreground">
                            {s.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {theirMembership && server && (
                <div className="mt-3 text-[11px] text-muted-foreground">
                  {server.name} member since {formatJoinDate(theirMembership.joinedAt)}
                </div>
              )}

              {/* moderator tools */}
              {anyModTools && (
                <div className="mt-3 border border-white/10 rounded-sm overflow-hidden">
                  <div className="px-3 py-2 bg-app-raise/60 text-[10px] font-bold tracking-widest text-muted-foreground flex items-center justify-between">
                    <span>moderator tools{server ? ` · ${server.name}` : ''}</span>
                    {canNick && nickDraft === null && theirMembership && (
                      <button
                        className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors font-semibold"
                        onClick={() => setNickDraft(theirMembership.nickname ?? '')}
                        aria-label="edit nickname"
                        title="edit nickname"
                      >
                        <Tag className="size-3" />
                        nickname
                      </button>
                    )}
                  </div>

                  {nickDraft !== null && (
                    <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2">
                      <input
                        autoFocus
                        value={nickDraft}
                        onChange={(e) => setNickDraft(e.target.value)}
                        maxLength={32}
                        placeholder="no nickname"
                        className="flex-1 bg-app-raise border border-white/10 rounded-sm px-2 py-1 text-sm outline-none focus:border-hyper/50"
                        aria-label="nickname"
                      />
                      <Button
                        size="sm"
                        className="rounded-sm h-7 px-2"
                        onClick={() => {
                          const value = nickDraft.trim() || null
                          setNickDraft(null)
                          void modAction('Nickname updated', () =>
                            setMemberNickname(activeServerId!, profileUser.id, value)
                          )
                        }}
                      >
                        Save
                      </Button>
                      <button
                        className="text-xs text-muted-foreground hover:text-foreground px-1"
                        onClick={() => setNickDraft(null)}
                      >
                        cancel
                      </button>
                    </div>
                  )}

                  <div className="flex items-center flex-wrap gap-1 p-2">
                    {canTimeout && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="outline" size="sm" className="rounded-sm h-7 px-2 text-xs">
                            <Clock className="size-3.5" />
                            Timeout
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="rounded-sm w-44">
                          {TIMEOUT_CHOICES.map((c) => (
                            <DropdownMenuItem
                              key={c.minutes}
                              onClick={() =>
                                void modAction(`Timed out ${c.label.toLowerCase()}`, () =>
                                  timeoutMember(activeServerId!, profileUser.id, c.minutes)
                                )
                              }
                            >
                              <Clock className="size-3.5" />
                              {c.label}
                            </DropdownMenuItem>
                          ))}
                          <CustomTimeoutItem
                            onApply={(mins) =>
                              void modAction(`Timed out for ${mins} minutes`, () =>
                                timeoutMember(activeServerId!, profileUser.id, mins)
                              )
                            }
                          />
                          {timedOut && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() =>
                                  void modAction('Timeout removed', () =>
                                    timeoutMember(activeServerId!, profileUser.id, null)
                                  )
                                }
                              >
                                <Clock className="size-3.5" />
                                Remove timeout
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}

                    {canAssignRole && roles.length > 0 && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="outline" size="sm" className="rounded-sm h-7 px-2 text-xs">
                            <Tag className="size-3.5" />
                            Role
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="rounded-sm w-44">
                          <DropdownMenuItem
                            onClick={() =>
                              void modAction('Role cleared', () =>
                                setMemberCustomRole(activeServerId!, profileUser.id, null)
                              )
                            }
                          >
                            <span className="size-2.5 rounded-sm bg-white/20" aria-hidden="true" />
                            No custom role
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {roles.map((r) => (
                            <DropdownMenuItem
                              key={r.id}
                              onClick={() =>
                                void modAction(`Role set to ${r.name}`, () =>
                                  setMemberCustomRole(activeServerId!, profileUser.id, r.id)
                                )
                              }
                            >
                              <span className="size-2.5 rounded-sm shrink-0" style={{ background: r.color }} aria-hidden="true" />
                              <span className="truncate">{r.name}</span>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}

                    {canKick && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-sm h-7 px-2 text-xs text-destructive hover:text-destructive"
                        onClick={async () => {
                          const reason = await promptDialog({
                            title: `Kick ${profileUser.username}?`,
                            body: 'They can rejoin with an invite. Add a reason for the audit log.',
                            tone: 'warning',
                            placeholder: 'Reason (optional)',
                            optional: true,
                            confirmLabel: 'Kick',
                          })
                          if (reason === null) return
                          void modAction('Member kicked', () => kickMember(activeServerId!, profileUser.id, reason || undefined))
                          onClose()
                        }}
                      >
                        <UserMinus className="size-3.5" />
                        Kick
                      </Button>
                    )}

                    {canBan && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-sm h-7 px-2 text-xs text-destructive hover:text-destructive"
                        onClick={async () => {
                          const reason = await promptDialog({
                            title: `Ban ${profileUser.username} permanently?`,
                            body: 'They cannot rejoin unless unbanned. Add a reason for the audit log.',
                            tone: 'danger',
                            placeholder: 'Reason (optional)',
                            optional: true,
                            confirmLabel: 'Ban',
                          })
                          if (reason === null) return
                          void modAction('Member banned', () => banMember(activeServerId!, profileUser.id, reason || undefined))
                          onClose()
                        }}
                      >
                        <Ban className="size-3.5" />
                        Ban
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {!isSelf && (
                <Button
                  variant={isBlocked ? 'outline' : 'ghost'}
                  className={isBlocked ? 'w-full mt-4 rounded-sm justify-center' : 'w-full mt-4 rounded-sm justify-center text-muted-foreground hover:text-destructive'}
                  onClick={async () => {
                    if (isBlocked) {
                      void unblockUser(profileUser.id)
                      return
                    }
                    sounds.play('error')
                    const yes = await confirmDialog({
                      title: `Block ${profileUser.username}?`,
                      body: 'You will stop receiving direct messages from each other, and their messages will collapse for you.',
                      tone: 'danger',
                      confirmLabel: 'Block',
                    })
                    if (!yes) return
                    void blockUser(profileUser.username)
                    toast({ title: 'blocked', description: `@${profileUser.username} can no longer message you.` })
                  }}
                >
                  {isBlocked ? <UserX className="size-4" /> : <Ban className="size-4" />}
                  {isBlocked ? `unblock @${profileUser.username}` : `Block @${profileUser.username}`}
                </Button>
              )}

              {isSelf && (
                <Button
                  variant="outline"
                  className="w-full mt-4 rounded-sm justify-center"
                  onClick={() => {
                    useChatStore.getState().setProfileEditorOpen(true)
                    onClose()
                  }}
                >
                  Edit your profile
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* overlays stacked over the card */}
      {openPostId && (
        <PostDetailOverlay
          postId={openPostId}
          meId={me?.id ?? null}
          onClose={() => setOpenPostId(null)}
          onDeleted={() => {
            void loadShow()
            void loadPosts(0, true)
          }}
          onOpenProfile={(u) => void useChatStore.getState().openProfile(u)}
        />
      )}

      {viewer && (
        <StoryViewerOverlay
          groups={viewer.groups}
          startGroup={viewer.group}
          startStory={viewer.story}
          meId={me?.id ?? null}
          onClose={() => setViewer(null)}
          onWatched={handleWatched}
          onOpenAvatar={onAvatarLightbox}
        />
      )}

      {createPostOpen && (
        <CreatePostOverlay
          onClose={() => setCreatePostOpen(false)}
          onCreated={() => {
            void loadShow()
            void loadPosts(0, true)
          }}
        />
      )}

      {createStoryOpen && (
        <CreateStoryOverlay
          onClose={() => setCreateStoryOpen(false)}
          onCreated={() => {
            void loadShow()
            void loadStoryFeed()
          }}
        />
      )}

      {followList && (
        <FollowListOverlay
          username={username}
          list={followList}
          onClose={() => setFollowList(null)}
          onOpenProfile={(u) => void useChatStore.getState().openProfile(u)}
        />
      )}
    </>
  )
}
