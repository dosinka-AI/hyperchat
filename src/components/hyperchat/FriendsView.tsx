'use client'

import { useEffect, useMemo, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { apiClient, ApiError } from '@/lib/client/api'
import { sounds } from '@/lib/client/sounds'
import { Avatar } from './Avatar'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import { UserPlus, X, Check, MessageSquare, Ban, Search, Users, MoreHorizontal, Tag, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FriendSummary, PublicUser } from '@/lib/types'
import { awayForLabel } from './MessageList'
import { lastOnlineLabel } from '@/lib/client/format'
import { openContextMenu } from './ContextMenu'
import { promptDialog } from './ConfirmDialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Tab = 'online' | 'all' | 'pending' | 'blocked'

/** Temporary friendship presets: hours -> label. */
const TEMP_HOUR_CHOICES: { hours: number; label: string }[] = [
  { hours: 24, label: '24h' },
  { hours: 72, label: '72h' },
  { hours: 168, label: '7d' },
]

/** "23h left" / "3d left" for a temporary friendship's expiry stamp. */
function timeLeftLabel(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (ms <= 0) return 'expiring now'
  if (ms < 3_600_000) return `${Math.max(1, Math.ceil(ms / 60_000))}m left`
  const hours = Math.ceil(ms / 3_600_000)
  if (hours < 48) return `${hours}h left`
  return `${Math.ceil(hours / 24)}d left`
}

/** The quiet amber chip that marks an auto-expiring friendship. */
function TempChip({ expiresAt }: { expiresAt: string }) {
  return (
    <span
      className="flex items-center gap-0.5 text-[10px] font-semibold text-idle/90 border border-idle/25 bg-idle/10 rounded-sm px-1.5 py-0.5 shrink-0"
      title="temporary friendship"
    >
      <Clock className="size-2.5" aria-hidden="true" />
      {timeLeftLabel(expiresAt)}
    </span>
  )
}

/** The dedicated friends page: one surface for every relationship, with an
 *  add-friend bar and the full blocked list. */
export function FriendsView() {
  const me = useChatStore((s) => s.me)
  const friends = useChatStore((s) => s.friends)
  const incomingRequests = useChatStore((s) => s.incomingRequests)
  const onlineUserIds = useChatStore((s) => s.onlineUserIds)
  const presenceStatuses = useChatStore((s) => s.presenceStatuses)
  const awaySince = useChatStore((s) => s.awaySince)
  const lastSeen = useChatStore((s) => s.lastSeen)
  const acceptFriendRequest = useChatStore((s) => s.acceptFriendRequest)
  const removeFriendship = useChatStore((s) => s.removeFriendship)
  const sendFriendRequest = useChatStore((s) => s.sendFriendRequest)
  const setFriendNickname = useChatStore((s) => s.setFriendNickname)
  const setFriendTemporary = useChatStore((s) => s.setFriendTemporary)
  const openDM = useChatStore((s) => s.openDM)
  const refreshFriends = useChatStore((s) => s.refreshFriends)
  const createGroup = useChatStore((s) => s.createGroup)
  const { toast } = useToast()

  const [tab, setTab] = useState<Tab>('online')
  const [addName, setAddName] = useState('')
  const [adding, setAdding] = useState(false)
  const [addTemporary, setAddTemporary] = useState(false)
  const [addHours, setAddHours] = useState(24)
  const [blocked, setBlocked] = useState<PublicUser[]>([])
  const [groupOpen, setGroupOpen] = useState(false)

  // one tick a minute keeps "23h left" chips honest
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (tab === 'blocked') {
      void apiClient
        .blockedUsers()
        .then((res) => setBlocked(res.blocked))
        .catch(() => setBlocked([]))
    }
  }, [tab])

  const online = useMemo(
    () => friends.filter((f) => !!onlineUserIds[f.user.id]),
    [friends, onlineUserIds]
  )

  // the temporary-duration control only exists for people who actually use
  // temporary friendships; everyone else never sees the row at all
  const hasTemporaryFriends = useMemo(
    () => friends.some((f) => f.expiresAt) || incomingRequests.some((r) => r.expiresAt),
    [friends, incomingRequests]
  )

  const counts = {
    online: online.length,
    all: friends.length,
    pending: incomingRequests.length,
    blocked: blocked.length,
  }

  async function addFriend() {
    const username = addName.trim().replace(/^@/, '')
    if (!username || adding) return
    setAdding(true)
    try {
      await sendFriendRequest(username, addTemporary ? addHours : undefined)
      sounds.play('lightTick')
      setAddName('')
      toast({
        title: 'request sent',
        ...(addTemporary
          ? {
              description: `temporary · ends after ${
                TEMP_HOUR_CHOICES.find((c) => c.hours === addHours)?.label ?? `${addHours}h`
              }`,
            }
          : {}),
      })
      void refreshFriends()
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not send request',
        description: err instanceof ApiError ? err.message : 'Try again.',
      })
    } finally {
      setAdding(false)
    }
  }

  /** Kebab or right-click on a friend: nickname, temporary window, remove. */
  function friendMenu(e: React.MouseEvent, friend: FriendSummary) {
    const title = friend.nickname || friend.user.displayName || friend.user.username
    openContextMenu(
      e,
      [
        {
          label: 'set nickname',
          icon: Tag,
          onSelect: () => {
            void (async () => {
              const nick = await promptDialog({
                title: `set nickname for ${friend.user.username}`,
                placeholder: 'nickname',
                initial: friend.nickname ?? '',
                maxLength: 32,
                confirmLabel: 'save',
              })
              if (nick && nick.trim()) {
                sounds.play('midTick')
                void setFriendNickname(friend.friendshipId, nick.trim().slice(0, 32))
              }
            })()
          },
        },
        ...(friend.nickname
          ? [
              {
                label: 'remove nickname',
                icon: X,
                onSelect: () => {
                  sounds.play('lightTick')
                  void setFriendNickname(friend.friendshipId, '')
                },
              },
            ]
          : []),
        { kind: 'separator' },
        ...(!friend.expiresAt
          ? [
              {
                label: 'make temporary',
                icon: Clock,
                onSelect: () =>
                  openContextMenu(
                    e,
                    [
                      { kind: 'label', label: 'friendship ends after' },
                      ...TEMP_HOUR_CHOICES.map((c) => ({
                        label: c.label,
                        icon: Clock,
                        onSelect: () => {
                          sounds.play('lightTick')
                          void setFriendTemporary(friend.friendshipId, true, c.hours)
                        },
                      })),
                    ],
                    { title, subtitle: `@${friend.user.username}` }
                  ),
              },
            ]
          : [
              {
                label: 'make permanent',
                icon: Tag,
                onSelect: () => {
                  sounds.play('lightTick')
                  void setFriendTemporary(friend.friendshipId, false)
                },
              },
            ]),
        { kind: 'separator' },
        {
          label: 'remove friend',
          icon: X,
          danger: true,
          onSelect: () => {
            sounds.play('lightTick')
            void removeFriendship(friend.friendshipId)
          },
        },
      ],
      { title, subtitle: `@${friend.user.username}` }
    )
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-app-chat view-in">
      {/* header */}
      <div className="h-12 shrink-0 border-b border-white/10 flex items-center gap-3 px-4">
        <span className="text-sm font-bold tracking-tight">Friends</span>
        <div className="flex items-center gap-1.5 ml-auto">
          <Button
            size="sm"
            variant="outline"
            className="rounded-sm press"
            onClick={() => {
              sounds.play('lightTick')
              setGroupOpen(true)
            }}
            aria-label="create a group"
            title="create a group"
          >
            <Users className="size-3.5" />
            <span className="hidden sm:inline">new group</span>
          </Button>
          <div className="relative hidden sm:block">
            <Search className="size-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addFriend()
              }}
              placeholder="add by username"
              aria-label="add a friend by username"
              className="w-44 bg-app-raise border border-white/10 rounded-sm pl-7 pr-2 py-1.5 text-xs outline-none focus:border-hyper/60 placeholder:text-muted-foreground"
            />
          </div>
          <Button size="sm" className="rounded-sm press" disabled={!addName.trim() || adding} onClick={() => void addFriend()}>
            {adding ? <Spinner /> : <UserPlus className="size-3.5" />}
            <span className="hidden sm:inline">send request</span>
          </Button>
        </div>
      </div>

      {/* friendship duration: hidden until a temporary friendship exists
          (permanent is the default; the kebab menu can flip friends later) */}
      {(hasTemporaryFriends || addTemporary) && (
        <div className="px-4 pt-3 pb-1 flex flex-wrap items-center gap-2 shrink-0 fade-in">
        <div
          className="flex items-center rounded-sm border border-white/10 bg-app-raise p-0.5"
          role="group"
          aria-label="friendship duration"
        >
          {([
            { key: false, label: 'permanent' },
            { key: true, label: 'temporary' },
          ] as const).map((option) => (
            <button
              key={option.label}
              onClick={() => {
                sounds.play('lightTick')
                setAddTemporary(option.key)
              }}
              className={cn(
                'px-2.5 py-1 text-[11px] font-semibold rounded-sm transition-colors',
                addTemporary === option.key
                  ? 'bg-hyper/20 text-hyper'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              aria-pressed={addTemporary === option.key}
            >
              {option.label}
            </button>
          ))}
        </div>
        {addTemporary && (
          <div className="flex items-center gap-1.5 fade-in" role="group" aria-label="temporary duration">
            {TEMP_HOUR_CHOICES.map((c) => (
              <button
                key={c.hours}
                onClick={() => {
                  sounds.play('lightTick')
                  setAddHours(c.hours)
                }}
                className={cn(
                  'px-2.5 py-1 text-[11px] font-semibold rounded-sm border transition-colors',
                  addHours === c.hours
                    ? 'bg-hyper/20 border-hyper/60 text-hyper'
                    : 'border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25'
                )}
                aria-pressed={addHours === c.hours}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        </div>
      )}

      {/* tabs */}
      <div className="px-4 pt-2 pb-1 flex items-center gap-1.5 shrink-0">
        {(['online', 'all', 'pending', 'blocked'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'px-3 py-1.5 text-xs font-semibold rounded-sm border transition-colors',
              tab === t
                ? 'bg-hyper/20 border-hyper/60 text-hyper'
                : 'border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25'
            )}
            aria-pressed={tab === t}
          >
            {t}
            {counts[t] > 0 && (
              <span className={cn('ml-1.5 tabular-nums', tab === t ? 'text-hyper' : 'text-muted-foreground/70')}>
                {counts[t]}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* list */}
      <div className="flex-1 overflow-y-auto scroll-thin px-4 pb-6">
        <div className="max-w-2xl mx-auto space-y-0.5 pt-2">
          {tab === 'online' && online.length === 0 && <Empty text="no friends online right now." />}
          {tab === 'all' && friends.length === 0 && <Empty text="no friends yet." />}
          {tab === 'pending' && incomingRequests.length === 0 && <Empty text="no pending requests." />}
          {tab === 'blocked' && blocked.length === 0 && <Empty text="no blocked users." />}

          {(tab === 'online' ? online : tab === 'all' ? friends : []).map((friend) => {
            const isOnline = !!onlineUserIds[friend.user.id]
            const status = isOnline ? presenceStatuses[friend.user.id] ?? 'online' : 'offline'
            const away = isOnline && status === 'idle' ? awaySince[friend.user.id] : undefined
            const lastSeenIso = !isOnline ? lastSeen[friend.user.id] : undefined
            return (
              <div
                key={friend.friendshipId}
                className="group flex items-center gap-3 px-3 py-2.5 rounded-sm hover:bg-app-raise/60 transition-colors item-in"
                onContextMenu={(e) => friendMenu(e, friend)}
              >
                <button
                  className="flex items-center gap-3 flex-1 min-w-0 text-left"
                  onClick={() => void openDM(friend.user.id)}
                  aria-label={`Message ${friend.user.username}`}
                >
                  <Avatar
                    name={friend.user.username}
                    color={friend.user.avatarColor}
                    url={friend.user.avatarUrl}
                    size="md"
                    status={status}
                    showDot
                  />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block text-sm font-semibold truncate group-hover:underline underline-offset-2">
                      {friend.nickname || friend.user.displayName || friend.user.username}
                    </span>
                    {friend.nickname ? (
                      <span className="block text-[11px] text-muted-foreground truncate">
                        @{friend.user.username}
                      </span>
                    ) : friend.user.customStatus ? (
                      <span className="block text-xs text-muted-foreground truncate">{friend.user.customStatus}</span>
                    ) : away ? (
                      <span className="block text-xs text-idle/90">away {awayForLabel(away)}</span>
                    ) : status === 'offline' ? (
                      <span className="block text-xs text-muted-foreground truncate">
                        {lastSeenIso ? `last online ${lastOnlineLabel(lastSeenIso)}` : 'offline'}
                      </span>
                    ) : (
                      <span className="block text-xs text-muted-foreground">{status}</span>
                    )}
                  </span>
                </button>
                {friend.expiresAt && <TempChip expiresAt={friend.expiresAt} />}
                <div className="flex items-center gap-1 shrink-0">
                  <IconAction label="message" onClick={() => void openDM(friend.user.id)}>
                    <MessageSquare className="size-4" />
                  </IconAction>
                  <IconAction
                    label="more options"
                    onClick={(e) => friendMenu(e, friend)}
                  >
                    <MoreHorizontal className="size-4" />
                  </IconAction>
                  <IconAction label="remove friend" danger onClick={() => void removeFriendship(friend.friendshipId)}>
                    <X className="size-4" />
                  </IconAction>
                </div>
              </div>
            )
          })}

          {tab === 'pending' &&
            incomingRequests.map((req) => (
              <div
                key={req.friendshipId}
                className="flex items-center gap-3 px-3 py-2.5 rounded-sm hover:bg-app-raise/60 transition-colors item-in"
              >
                <Avatar name={req.user.username} color={req.user.avatarColor} url={req.user.avatarUrl} size="md" />
                <div className="flex-1 min-w-0 leading-tight">
                  <p className="text-sm font-semibold truncate">{req.user.displayName || req.user.username}</p>
                  <p className="text-xs text-hyper">wants to be friends</p>
                </div>
                {req.expiresAt && <TempChip expiresAt={req.expiresAt} />}
                <div className="flex items-center gap-1 shrink-0">
                  <IconAction label="accept" onClick={() => void acceptFriendRequest(req.friendshipId)}>
                    <Check className="size-4" />
                  </IconAction>
                  <IconAction label="ignore" danger onClick={() => void removeFriendship(req.friendshipId)}>
                    <X className="size-4" />
                  </IconAction>
                </div>
              </div>
            ))}

          {tab === 'blocked' &&
            blocked.map((user) => (
              <div
                key={user.id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-sm hover:bg-app-raise/60 transition-colors item-in"
              >
                <Avatar name={user.username} color={user.avatarColor} url={user.avatarUrl} size="md" />
                <div className="flex-1 min-w-0 leading-tight">
                  <p className="text-sm font-semibold truncate">{user.displayName || user.username}</p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Ban className="size-3" /> blocked
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-sm"
                    onClick={() => {
                      void apiClient
                        .unblockUser(user.id)
                        .then(() => {
                          setBlocked((list) => list.filter((u) => u.id !== user.id))
                          sounds.play('lightTick')
                        })
                        .catch(() => toast({ title: 'could not unblock' }))
                    }}
                  >
                    unblock
                  </Button>
                </div>
              </div>
            ))}

          {/* the add bar on narrow screens lives in the header; me row for context */}
          {me && tab === 'all' && friends.length > 0 && null}
        </div>
      </div>

      <NewGroupDialog open={groupOpen} onOpenChange={setGroupOpen} createGroup={createGroup} />
    </div>
  )
}

/** Pick 2-4 friends, name it, done: the creator owns the group. */
function NewGroupDialog({
  open,
  onOpenChange,
  createGroup,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  createGroup: (name: string, memberIds: string[]) => Promise<void>
}) {
  const friends = useChatStore((s) => s.friends)
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const cleanName = name.trim()
  const enough = picked.length >= 2 && picked.length <= 4 && cleanName.length >= 2

  function toggle(userId: string) {
    sounds.play('lightTick')
    setError(null)
    setPicked((list) =>
      list.includes(userId)
        ? list.filter((id) => id !== userId)
        : list.length >= 4
          ? list
          : [...list, userId]
    )
  }

  async function handleCreate() {
    if (!enough || busy) return
    setBusy(true)
    setError(null)
    try {
      await createGroup(cleanName.slice(0, 60), picked)
      sounds.play('midTick')
      toast({
        title: 'group created',
        description: `${cleanName} is ready.`,
      })
      onOpenChange(false)
      setName('')
      setPicked([])
    } catch (err) {
      sounds.play('error')
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md rounded-sm">
        <DialogHeader>
          <DialogTitle>create a group</DialogTitle>
          <DialogDescription>
            Pick 2 to 4 friends to start the group.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="group-name">group name</Label>
            <div className="flex items-center gap-2">
              <Users className="size-4 text-muted-foreground shrink-0" />
              <Input
                id="group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="weekend plans, the squad"
                maxLength={60}
                onKeyDown={(e) => e.key === 'Enter' && enough && void handleCreate()}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Members</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {picked.length}/4 selected
              </span>
            </div>
            {friends.length < 2 ? (
              <p className="rounded-sm border border-white/10 bg-app-raise px-3 py-4 text-sm text-muted-foreground">
                You need at least 2 friends to start a group. Add a few people
                first, then come back.
              </p>
            ) : (
              <div
                className="max-h-64 overflow-y-auto scroll-thin rounded-sm border border-white/10 divide-y divide-white/5"
                role="group"
                aria-label="friends to add"
              >
                {friends.map((friend) => {
                  const on = picked.includes(friend.user.id)
                  return (
                    <button
                      key={friend.friendshipId}
                      onClick={() => toggle(friend.user.id)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-app-raise/60 transition-colors"
                      aria-pressed={on}
                      aria-label={`Add ${friend.user.username} to the group`}
                    >
                      <Avatar
                        name={friend.user.username}
                        color={friend.user.avatarColor}
                        url={friend.user.avatarUrl}
                        size="sm"
                      />
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="block truncate text-sm font-medium">
                          {friend.user.displayName || friend.user.username}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          @{friend.user.username}
                        </span>
                      </span>
                      <span
                        className={cn(
                          'size-5 shrink-0 rounded-sm border grid place-items-center transition-colors',
                          on
                            ? 'bg-hyper border-hyper text-white'
                            : 'border-white/20 text-transparent'
                        )}
                        aria-hidden="true"
                      >
                        <Check className="size-3.5" />
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button
            className="w-full rounded-sm"
            disabled={busy || !enough}
            onClick={() => void handleCreate()}
          >
            {busy && <Spinner />}
            Create group
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="py-16 text-center">
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  )
}

function IconAction({
  label,
  onClick,
  danger,
  children,
}: {
  label: string
  onClick: (e: React.MouseEvent) => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={(e) => {
        sounds.play('lightTick')
        onClick(e)
      }}
      className={cn(
        'p-2 rounded-sm transition-colors',
        danger
          ? 'text-muted-foreground hover:text-destructive hover:bg-destructive/10'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent'
      )}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  )
}
