'use client'

import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/lib/client/store'
import { sounds } from '@/lib/client/sounds'
import { Avatar } from './Avatar'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Hash, Menu, Users, Pin, Search, AtSign, Pencil, Check, X, Lock, Gauge, Settings2, Trash2, UserRound, UserPlus, LogOut, ArrowLeft, Keyboard, Image as ImageIcon, ImageOff, Phone, Video } from 'lucide-react'
import { RainbowSparkFilled } from './SummarizeDialog'
import { awayForLabel } from './MessageList'
import { PERM } from '@/lib/perm'
import { confirmDialog, promptDialog } from './ConfirmDialog'
import { ApiError } from '@/lib/client/api'
import { useToast } from '@/hooks/use-toast'
import type { ConversationSummary } from '@/lib/types'

type ChatHeaderProps = {
  onToggleSidebar: () => void
  onToggleMembers: () => void
  membersOpen: boolean
  membersAvailable: boolean
  onOpenSearch: () => void
  onOpenSummary: () => void
  onOpenGroupSettings: () => void
  onOpenPins: () => void
  onOpenChannelSettings: () => void
  onOpenPurge: () => void
  onOpenShortcuts: () => void
  dmProfileOpen?: boolean
  onToggleDmProfile?: () => void
}

export function ChatHeader({
  onToggleSidebar,
  onToggleMembers,
  membersOpen,
  membersAvailable,
  onOpenSearch,
  onOpenSummary,
  onOpenGroupSettings,
  onOpenPins,
  onOpenChannelSettings,
  onOpenPurge,
  onOpenShortcuts,
  dmProfileOpen,
  onToggleDmProfile,
}: ChatHeaderProps) {
  const me = useChatStore((s) => s.me)
  const servers = useChatStore((s) => s.servers)
  const activeServerId = useChatStore((s) => s.activeServerId)
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)
  const serverMembers = useChatStore((s) => s.serverMembers)
  const onlineUserIds = useChatStore((s) => s.onlineUserIds)
  const presenceStatuses = useChatStore((s) => s.presenceStatuses)
  const awaySince = useChatStore((s) => s.awaySince)
  const updateChannel = useChatStore((s) => s.updateChannel)
  const openProfile = useChatStore((s) => s.openProfile)

  const channel = activeChannelId
    ? servers.flatMap((s) => s.channels).find((c) => c.id === activeChannelId) ?? null
    : null
  const server = servers.find((s) => s.id === activeServerId) ?? null
  const myPerms = server?.myPerms ?? 0
  const canManage = (myPerms & (PERM.ADMINISTRATOR | PERM.MANAGE_MESSAGES)) !== 0
  const canManageChannels = (myPerms & (PERM.ADMINISTRATOR | PERM.MANAGE_CHANNELS)) !== 0
  const conversation = conversations.find((c) => c.id === activeConversationId) ?? null
  const isGroup = conversation?.kind === 'GROUP'

  const [editingTopic, setEditingTopic] = useState(false)
  const [topicDraft, setTopicDraft] = useState('')

  // switching rooms cancels an in-progress topic edit (render-phase adjust)
  const [prevRoom, setPrevRoom] = useState(activeChannelId ?? activeConversationId ?? '')
  const roomKey = activeChannelId ?? activeConversationId ?? ''
  if (roomKey !== prevRoom) {
    setPrevRoom(roomKey)
    setEditingTopic(false)
  }

  if (!channel && !conversation) {
    return (
      <header className="h-12 shrink-0 flex items-center px-3 border-b border-white/10 bg-app-sidebar/40 gap-2">
        <button
          onClick={onToggleSidebar}
          className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent md:hidden"
          aria-label="toggle channel list"
        >
          <Menu className="size-5" />
        </button>
        <span className="text-sm font-semibold tracking-tight">Home</span>
        <div className="ml-auto flex items-center">
        </div>
      </header>
    )
  }

  return (
    <header className="h-12 shrink-0 flex items-center px-3 border-b border-white/10 bg-app-sidebar/40 gap-2">
      <button
        onClick={onToggleSidebar}
        className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent md:hidden"
        aria-label="toggle channel list"
      >
        <Menu className="size-5" />
      </button>

      {channel ? (
        <>
          <Hash className="size-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-bold tracking-tight truncate">{channel.name}</span>
          {channel.private && <Lock className="size-3 text-muted-foreground shrink-0" aria-label="private channel" />}
          {channel.locked && (
            <span className="flex items-center" title="locked: only moderators can post">
              <Lock className="size-3 text-hyper shrink-0" aria-label="locked channel" />
            </span>
          )}
          {channel.slowmodeSeconds > 0 && (
            <span
              className="hidden sm:flex items-center gap-0.5 text-[11px] text-muted-foreground shrink-0"
              title={`Slowmode: ${channel.slowmodeSeconds >= 60 ? `${Math.floor(channel.slowmodeSeconds / 60)}m${channel.slowmodeSeconds % 60 ? ` ${channel.slowmodeSeconds % 60}s` : ''}` : `${channel.slowmodeSeconds}s`}`}
            >
              <Gauge className="size-3" />
              {channel.slowmodeSeconds >= 60 ? `${Math.floor(channel.slowmodeSeconds / 60)}m` : `${channel.slowmodeSeconds}s`}
            </span>
          )}

          {editingTopic ? (
            <div className="flex-1 flex items-center gap-1.5 min-w-0 px-2 border-l border-white/10 ml-2 pl-3">
              <input
                autoFocus
                value={topicDraft}
                onChange={(e) => setTopicDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void updateChannel(channel.id, { topic: topicDraft })
                    setEditingTopic(false)
                  } else if (e.key === 'Escape') {
                    setEditingTopic(false)
                  }
                }}
                className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                placeholder="Set a topic"
                maxLength={120}
                aria-label="channel topic"
              />
              <button
                onClick={() => {
                  void updateChannel(channel.id, { topic: topicDraft })
                  setEditingTopic(false)
                }}
                className="p-1 rounded-sm text-muted-foreground hover:text-foreground"
                aria-label="save topic"
              >
                <Check className="size-3.5" />
              </button>
              <button
                onClick={() => setEditingTopic(false)}
                className="p-1 rounded-sm text-muted-foreground hover:text-foreground"
                aria-label="cancel topic edit"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ) : channel.topic ? (
            <button
              className="hidden sm:flex items-center gap-1.5 min-w-0 ml-2 pl-3 border-l border-white/10 text-xs text-muted-foreground hover:text-foreground transition-colors text-left"
              onClick={() => {
                if (canManage) {
                  setTopicDraft(channel.topic ?? '')
                  setEditingTopic(true)
                }
              }}
              title={canManage ? 'Click to edit the topic' : channel.topic}
            >
              <span className="truncate">{channel.topic}</span>
              {canManage && <Pencil className="size-3 shrink-0 opacity-60" />}
            </button>
          ) : canManage ? (
            <button
              className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-foreground ml-2 pl-3 border-l border-white/10 transition-colors"
              onClick={() => {
                setTopicDraft('')
                setEditingTopic(true)
              }}
            >
              <Pencil className="size-3" />
              add topic
            </button>
          ) : null}

          <div className="ml-auto flex items-center gap-1 shrink-0">
            <span className="hidden md:flex items-center gap-1 text-xs text-muted-foreground px-1.5" title="members">
              <Users className="size-3.5" />
              {serverMembers[activeServerId ?? '']?.length ?? server?.memberCount ?? 0}
            </span>
            {canManage && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 rounded-sm"
                onClick={() => {
                  sounds.play('lightTick')
                  onOpenPurge()
                }}
                aria-label="purge recent messages"
                title="purge recent messages"
              >
                <Trash2 className="size-4" />
              </Button>
            )}
            {canManageChannels && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 rounded-sm"
                onClick={() => {
                  sounds.play('lightTick')
                  onOpenChannelSettings()
                }}
                aria-label="channel settings"
                title="channel settings"
              >
                <Settings2 className="size-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 rounded-sm relative"
              onClick={() => {
                sounds.play('lightTick')
                onOpenPins()
              }}
              aria-label="pinned messages"
              title="pinned messages"
            >
              <Pin className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 rounded-sm"
              onClick={() => {
                sounds.play('lightTick')
                onOpenSearch()
              }}
              aria-label="search messages"
              title="search messages"
            >
              <Search className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 rounded-sm"
              onClick={() => {
                sounds.play('lightTick')
                onOpenSummary()
              }}
              aria-label="summarize recent messages"
              title="summarize recent messages"
            >
              <RainbowSparkFilled className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 rounded-sm"
              onClick={() => {
                sounds.play('lightTick')
                onOpenShortcuts()
              }}
              aria-label="keyboard shortcuts"
              title="keyboard shortcuts"
            >
              <Keyboard className="size-4" />
            </Button>
            {membersAvailable && (
              <Button
                variant={membersOpen ? 'secondary' : 'ghost'}
                size="sm"
                className="h-8 px-2 rounded-sm"
                onClick={onToggleMembers}
                aria-label="toggle member list"
                title="toggle member list"
              >
                <Users className="size-4" />
              </Button>
            )}
          </div>
        </>
      ) : isGroup && conversation ? (
        <>
          <GroupHeaderIdentity conversation={conversation} />
          <span className="hidden md:flex items-center gap-1 text-xs text-muted-foreground shrink-0">
            <Users className="size-3.5" />
            {(conversation.participants ?? []).length}
          </span>

          <div className="ml-auto flex items-center gap-1 shrink-0">
            <QuickAddMembers conversation={conversation} />
            <DmCallButtons conversationId={conversation.id} />
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 rounded-sm"
              onClick={() => {
                sounds.play('lightTick')
                onOpenGroupSettings()
              }}
              aria-label="group settings"
              title="group settings"
            >
              <Settings2 className="size-4" />
            </Button>
            {membersAvailable && (
              <Button
                variant={membersOpen ? 'secondary' : 'ghost'}
                size="sm"
                className="h-8 px-2 rounded-sm"
                onClick={onToggleMembers}
                aria-label="toggle member list"
                title="toggle member list"
              >
                <Users className="size-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 rounded-sm relative"
              onClick={() => {
                sounds.play('lightTick')
                onOpenPins()
              }}
              aria-label="pinned messages"
              title="pinned messages"
            >
              <Pin className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 rounded-sm"
              onClick={() => {
                sounds.play('lightTick')
                onOpenSearch()
              }}
              aria-label="search messages"
              title="search messages"
            >
              <Search className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 rounded-sm"
              onClick={() => {
                sounds.play('lightTick')
                onOpenSummary()
              }}
              aria-label="summarize recent messages"
              title="summarize recent messages"
            >
              <RainbowSparkFilled className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 rounded-sm"
              onClick={() => {
                sounds.play('lightTick')
                onOpenShortcuts()
              }}
              aria-label="keyboard shortcuts"
              title="keyboard shortcuts"
            >
              <Keyboard className="size-4" />
            </Button>
          </div>
        </>
      ) : conversation ? (
        <>
          <Avatar
            name={conversation.otherUser.username}
            color={conversation.otherUser.avatarColor}
            url={conversation.otherUser.avatarUrl}
            size="sm"
            status={onlineUserIds[conversation.otherUser.id] ? presenceStatuses[conversation.otherUser.id] ?? 'online' : 'offline'}
            showDot
          />
          <button
            className="text-sm font-bold tracking-tight truncate hover:underline underline-offset-2"
            onClick={() => void openProfile(conversation.otherUser.username)}
          >
            {conversation.otherUser.displayName || conversation.otherUser.username}
          </button>
          {conversation.otherUser.customStatus && (
            <span className="hidden md:block text-xs text-foreground/70 truncate max-w-48" title={conversation.otherUser.customStatus}>
              {conversation.otherUser.customStatus}
            </span>
          )}
          {(() => {
            const otherStatus = onlineUserIds[conversation.otherUser.id]
              ? presenceStatuses[conversation.otherUser.id] ?? 'online'
              : 'offline'
            const awayStamp = otherStatus === 'idle' ? awaySince[conversation.otherUser.id] : undefined
            return (
              <span
                className={cn(
                  'text-[11px] shrink-0 flex items-center gap-1',
                  otherStatus === 'online' && 'text-online',
                  otherStatus === 'idle' && 'text-idle',
                  otherStatus === 'busy' && 'text-busy',
                  otherStatus === 'dnd' && 'text-dnd',
                  otherStatus === 'offline' && 'text-muted-foreground'
                )}
              >
                {otherStatus === 'idle'
                  ? `away${awayStamp ? ` ${awayForLabel(awayStamp)}` : ''}`
                  : otherStatus === 'busy'
                    ? 'busy'
                    : otherStatus === 'dnd'
                      ? 'do not disturb'
                      : otherStatus === 'online'
                        ? 'online'
                        : 'offline'}
              </span>
            )
          })()}

          <div className="ml-auto flex items-center gap-1 shrink-0">
            <DmGroupStart conversation={conversation} />
            <DmCallButtons conversationId={conversation.id} />
            {onToggleDmProfile && (
              <Button
                variant="ghost"
                size="sm"
                className={cn('h-8 px-2 rounded-sm', dmProfileOpen && 'text-hyper')}
                onClick={() => {
                  sounds.play('lightTick')
                  onToggleDmProfile()
                }}
                aria-label="toggle profile panel"
                title="profile panel"
              >
                <UserRound className="size-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 rounded-sm relative"
              onClick={() => {
                sounds.play('lightTick')
                onOpenPins()
              }}
              aria-label="pinned messages"
              title="pinned messages"
            >
              <Pin className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 rounded-sm"
              onClick={() => {
                sounds.play('lightTick')
                onOpenSearch()
              }}
              aria-label="search messages"
              title="search messages"
            >
              <Search className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 rounded-sm"
              onClick={() => {
                sounds.play('lightTick')
                onOpenSummary()
              }}
              aria-label="summarize recent messages"
              title="summarize recent messages"
            >
              <RainbowSparkFilled className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 rounded-sm"
              onClick={() => {
                sounds.play('lightTick')
                onOpenShortcuts()
              }}
              aria-label="keyboard shortcuts"
              title="keyboard shortcuts"
            >
              <Keyboard className="size-4" />
            </Button>
          </div>
        </>
      ) : null}

      {!channel && !conversation && <AtSign className="size-4 text-muted-foreground" />}
      {!me && null}
    </header>
  )
}

/** Stacked member avatars + group name; clicking opens the members popover
 *  with the add-member flow and the leave action. */
function GroupHeaderIdentity({ conversation }: { conversation: ConversationSummary }) {
  const me = useChatStore((s) => s.me)
  const [open, setOpen] = useState(false)

  const members = conversation.participants ?? []
  const others = members.filter((p) => p.id !== me?.id)
  const shown = (others.length > 0 ? others : members).slice(0, 3)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex items-center gap-2 min-w-0 rounded-sm px-1 py-0.5 -mx-1 hover:bg-accent/60 transition-colors"
          aria-label={`Group ${conversation.name ?? ''}: view members, add someone, or leave`}
          title="group members"
        >
          <span className="flex items-center shrink-0" aria-hidden="true">
            {conversation.iconUrl ? (
              <img
                src={conversation.iconUrl}
                alt=""
                className="size-6 rounded-full object-cover ring-2 ring-app-sidebar/40"
                draggable={false}
              />
            ) : shown.length > 0 ? (
              shown.map((p, i) => (
                <span key={p.id} className={cn('rounded-full ring-2 ring-app-sidebar/40', i > 0 && '-ml-2')}>
                  <Avatar name={p.username} color={p.avatarColor} url={p.avatarUrl} size="sm" />
                </span>
              ))
            ) : (
              <span className="size-6 rounded-full bg-app-raise grid place-items-center">
                <Users className="size-3.5 text-muted-foreground" />
              </span>
            )}
          </span>
          <span className="text-sm font-bold tracking-tight truncate">{conversation.name ?? 'Group'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 rounded-sm p-0">
        <GroupMembersPanel conversation={conversation} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

/** Conversation call buttons: voice + video. Works for DMs and group chats. */
function DmCallButtons({ conversationId }: { conversationId: string }) {
  const startCall = useChatStore((s) => s.startCall)
  const activeCall = useChatStore((s) => s.activeCall)
  const incomingCall = useChatStore((s) => s.incomingCall)
  const busy = !!activeCall || !!incomingCall
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2 rounded-sm disabled:opacity-40"
        disabled={busy}
        onClick={() => {
          sounds.play('lightTick')
          void startCall(conversationId, false)
        }}
        aria-label="start a voice call"
        title="voice call"
      >
        <Phone className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2 rounded-sm disabled:opacity-40"
        disabled={busy}
        onClick={() => {
          sounds.play('lightTick')
          void startCall(conversationId, true)
        }}
        aria-label="start a video call"
        title="video call"
      >
        <Video className="size-4" />
      </Button>
    </>
  )
}

/** DM-header shortcut: the add-members icon lives in one-on-one chats too.
 *  Opening it starts a group with you and the partner already selected —
 *  add at least one more friend, name it, create. */
function DmGroupStart({ conversation }: { conversation: ConversationSummary }) {
  const me = useChatStore((s) => s.me)
  const friends = useChatStore((s) => s.friends)
  const createGroup = useChatStore((s) => s.createGroup)
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const partner = conversation.otherUser
  const candidates = friends.filter((f) => f.user.id !== partner.id)
  // the group carries you + partner + up to 3 more (4 others max)
  const memberIds = [partner.id, ...picked]
  const enough = picked.length >= 1 && memberIds.length <= 4
  const pickedNames = picked.map(
    (id) => friends.find((f) => f.user.id === id)?.user.displayName || friends.find((f) => f.user.id === id)?.user.username || ''
  )
  const suggested = [partner.displayName || partner.username, ...pickedNames].filter(Boolean).join(', ')

  function toggle(id: string) {
    sounds.play('lightTick')
    setPicked((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : list.length >= 3 ? list : [...list, id]
    )
  }

  async function handleCreate() {
    if (!enough || busy) return
    setBusy(true)
    const finalName = (name.trim() || suggested).slice(0, 60)
    try {
      await createGroup(finalName, memberIds)
      toast({ title: 'group created', description: `${finalName} is ready.` })
      setOpen(false)
      setPicked([])
      setName('')
    } catch (err) {
      sounds.play('error')
      toast({ title: 'could not create the group', description: err instanceof ApiError ? err.message : 'Try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 rounded-sm"
          onClick={() => sounds.play('lightTick')}
          aria-label="start a group with this person"
          title="start a group"
        >
          <UserPlus className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 rounded-sm p-0">
        <div className="px-3 py-2 flex items-center gap-1.5 border-b border-border">
          <Users className="size-3 text-muted-foreground" aria-hidden="true" />
          <span className="text-[10px] font-bold tracking-widest text-muted-foreground">start a group</span>
        </div>
        <div className="p-3 space-y-2.5">
          <div className="space-y-1">
            {[
              { id: me?.id ?? '', label: 'you', locked: true },
              { id: partner.id, label: partner.displayName || partner.username, locked: true },
            ].map((row) => (
              <div
                key={row.id}
                className="flex items-center gap-2.5 px-2 py-1.5 rounded-sm bg-app-raise/60 text-sm"
                aria-label={`${row.label} is already in the group`}
              >
                <Check className="size-3.5 text-hyper shrink-0" aria-hidden="true" />
                <span className="min-w-0 truncate">{row.label}</span>
              </div>
            ))}
          </div>

          {candidates.length === 0 ? (
            <p className="rounded-sm border border-white/10 bg-app-raise px-2.5 py-2 text-[11px] text-muted-foreground">
              add a friend first, then come back to pull them in.
            </p>
          ) : (
            <div
              className="max-h-44 overflow-y-auto scroll-thin rounded-sm border border-white/10 divide-y divide-white/5"
              role="group"
              aria-label="friends to add"
            >
              {candidates.map((friend) => {
                const on = picked.includes(friend.user.id)
                return (
                  <button
                    key={friend.friendshipId}
                    onClick={() => toggle(friend.user.id)}
                    className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left hover:bg-app-raise/60 transition-colors"
                    aria-pressed={on}
                    aria-label={`Add ${friend.user.username} to the group`}
                  >
                    <Avatar name={friend.user.username} color={friend.user.avatarColor} url={friend.user.avatarUrl} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {friend.user.displayName || friend.user.username}
                    </span>
                    <span
                      className={cn(
                        'size-4 shrink-0 rounded-sm border grid place-items-center transition-colors',
                        on ? 'bg-hyper border-hyper' : 'border-white/20'
                      )}
                      aria-hidden="true"
                    >
                      {on && <Check className="size-3 text-white" />}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          <div className="space-y-1">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={suggested.slice(0, 40) || 'group name'}
              maxLength={60}
              className="h-8 text-[13px]"
              aria-label="group name"
              onKeyDown={(e) => e.key === 'Enter' && enough && void handleCreate()}
            />
          </div>

          <Button
            size="sm"
            className="w-full rounded-sm"
            disabled={!enough || busy}
            onClick={() => void handleCreate()}
          >
            {busy ? 'creating' : picked.length === 0 ? 'add one more friend' : `create with ${memberIds.length + 1}`}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Header shortcut for groups: the add-member picker opened straight
 *  away, backed by the same members panel (and its limit notice). */
function QuickAddMembers({ conversation }: { conversation: ConversationSummary }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 rounded-sm"
          onClick={() => sounds.play('lightTick')}
          aria-label="add friends"
          title="add friends"
        >
          <UserPlus className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 rounded-sm p-0">
        <GroupMembersPanel conversation={conversation} onDone={() => setOpen(false)} initialMode="add" />
      </PopoverContent>
    </Popover>
  )
}

/** The popover body: member list, add-member picker, rename and leave. */
function GroupMembersPanel({
  conversation,
  onDone,
  initialMode = 'members',
}: {
  conversation: ConversationSummary
  onDone: () => void
  initialMode?: 'members' | 'add'
}) {
  const me = useChatStore((s) => s.me)
  const friends = useChatStore((s) => s.friends)
  const onlineUserIds = useChatStore((s) => s.onlineUserIds)
  const presenceStatuses = useChatStore((s) => s.presenceStatuses)
  const addGroupMember = useChatStore((s) => s.addGroupMember)
  const setGroupLimit = useChatStore((s) => s.setGroupLimit)
  const leaveGroup = useChatStore((s) => s.leaveGroup)
  const renameGroup = useChatStore((s) => s.renameGroup)
  const setGroupPhoto = useChatStore((s) => s.setGroupPhoto)
  const openProfile = useChatStore((s) => s.openProfile)
  const { toast } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)

  async function handlePhoto(file: File | undefined) {
    if (!file) return
    try {
      await setGroupPhoto(conversation.id, file)
      sounds.play('midTick')
      toast({ title: 'group photo set' })
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not set the photo',
        description: err instanceof ApiError ? err.message : 'try again',
      })
    }
  }

  const [mode, setMode] = useState<'members' | 'add'>(initialMode)
  const [busyId, setBusyId] = useState<string | null>(null)
  // the limit notice only appears after an add bounced off it
  const [limitHit, setLimitHit] = useState(false)

  const members = conversation.participants ?? []
  const memberIds = new Set(members.map((p) => p.id))
  const addable = friends.filter((f) => !memberIds.has(f.user.id))
  const count = members.length
  const iAmOwner = !!me && conversation.ownerId === me.id

  /** One click add; hitting the limit shows the inline notice (owners get
   *  the raise action right in it). */
  async function addMember(userId: string) {
    if (busyId) return
    setBusyId(userId)
    try {
      await addGroupMember(conversation.id, userId)
      sounds.play('midTick')
      setLimitHit(false)
      toast({ title: 'member added' })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'limit') {
        sounds.play('error')
        setLimitHit(true)
        return
      }
      sounds.play('error')
      toast({ title: 'could not add member', description: err instanceof ApiError ? err.message : 'Try again.' })
    } finally {
      setBusyId(null)
    }
  }

  /** Owner's way past the limit notice: raise, clear, retry the add. */
  async function raiseLimit() {
    if (busyId) return
    setBusyId('limit')
    try {
      await setGroupLimit(conversation.id, true)
      sounds.play('midTick')
      setLimitHit(false)
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not raise the limit',
        description: err instanceof ApiError ? err.message : 'Try again.',
      })
    } finally {
      setBusyId(null)
    }
  }

  async function handleLeave() {
    const go = await confirmDialog({
      title: `Leave ${conversation.name ?? 'this group'}?`,
      body: 'You stop receiving its messages. Rejoin needs an invite from a member.',
      tone: 'danger',
      confirmLabel: 'Leave group',
    })
    if (!go) return
    try {
      await leaveGroup(conversation.id)
      sounds.play('midTick')
      toast({ title: 'left the group' })
      onDone()
    } catch {
      toast({ title: 'could not leave' })
    }
  }

  async function handleRename() {
    const name = await promptDialog({
      title: 'rename group',
      placeholder: 'Group name',
      initial: conversation.name ?? '',
      maxLength: 60,
      confirmLabel: 'Save name',
    })
    if (!name || name.trim().length < 2) return
    try {
      await renameGroup(conversation.id, name.trim())
      sounds.play('midTick')
      toast({ title: 'group renamed' })
    } catch {
      toast({ title: 'could not rename' })
    }
  }

  if (mode === 'add') {
    return (
      <div>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <button
            onClick={() => {
              sounds.play('lightTick')
              setMode('members')
            }}
            className="p-1 -m-1 rounded-sm text-muted-foreground hover:text-foreground"
            aria-label="back to members"
          >
            <ArrowLeft className="size-3.5" />
          </button>
          <p className="text-[13px] font-bold">add member</p>
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
            {count} member{count === 1 ? '' : 's'}
          </span>
        </div>
        <div className="max-h-72 overflow-y-auto scroll-thin py-1">
          {addable.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              Everyone you know is already in this group.
            </p>
          ) : (
            addable.map((f) => {
              const status = onlineUserIds[f.user.id]
                ? presenceStatuses[f.user.id] ?? 'online'
                : 'offline'
              return (
                <button
                  key={f.user.id}
                  onClick={() => void addMember(f.user.id)}
                  disabled={busyId === f.user.id}
                  className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-accent transition-colors disabled:opacity-50"
                  aria-label={`Add ${f.user.username} to the group`}
                >
                  <Avatar
                    name={f.user.username}
                    color={f.user.avatarColor}
                    url={f.user.avatarUrl}
                    size="sm"
                    status={status}
                    showDot
                  />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[13px] font-medium">
                      {f.user.displayName || f.user.username}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">@{f.user.username}</span>
                  </span>
                  <UserPlus className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              )
            })
          )}
        </div>
        {limitHit && (
          <div className="px-3 py-2.5 border-t border-border fade-in">
            <p className="text-[13px] text-foreground/90">group is full</p>
            {iAmOwner && !conversation.limitRaised && (
              <button
                onClick={() => void raiseLimit()}
                disabled={busyId === 'limit'}
                className="mt-1 text-[13px] text-hyper hover:underline disabled:opacity-50"
              >
                raise to 50
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="px-3 py-2 border-b border-border">
        <p className="text-[13px] font-bold truncate">{conversation.name ?? 'Group'}</p>
        <p className="text-[11px] text-muted-foreground">
          {count} member{count === 1 ? '' : 's'}
          {conversation.ownerId === me?.id ? ' · you own this group' : null}
        </p>
      </div>
      <div className="max-h-72 overflow-y-auto scroll-thin py-1">
        {members.map((p) => {
          const status = onlineUserIds[p.id] ? presenceStatuses[p.id] ?? 'online' : 'offline'
          return (
            <button
              key={p.id}
              onClick={() => {
                if (p.id === me?.id) return
                sounds.play('lightTick')
                void openProfile(p.username)
                onDone()
              }}
              className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-accent transition-colors"
              aria-label={`View ${p.username}'s profile`}
            >
              <Avatar name={p.username} color={p.avatarColor} url={p.avatarUrl} size="sm" status={status} showDot />
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-[13px] font-medium">
                  {p.displayName || p.username}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {p.id === me?.id ? 'you' : `@${p.username}`}
                </span>
              </span>
            </button>
          )
        })}
      </div>
      <div className="border-t border-border py-1">
        <button
          onClick={() => {
            sounds.play('lightTick')
            setMode('add')
          }}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-hyper hover:bg-hyper/10 transition-colors"
          aria-label="add member to the group"
        >
          <UserPlus className="size-3.5 shrink-0" />
          add member
        </button>
        <button
          onClick={() => {
            sounds.play('lightTick')
            fileRef.current?.click()
          }}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-foreground/85 hover:bg-accent transition-colors"
          aria-label="set a group photo"
        >
          <ImageIcon className="size-3.5 shrink-0 opacity-70" />
          group photo
        </button>
        {conversation.iconUrl && (
          <button
            onClick={() => {
              sounds.play('lightTick')
              void setGroupPhoto(conversation.id, null).then(() => toast({ title: 'photo removed' }))
            }}
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-foreground/85 hover:bg-accent transition-colors"
            aria-label="remove the group photo"
          >
            <ImageOff className="size-3.5 shrink-0 opacity-70" />
            remove photo
          </button>
        )}
        <button
          onClick={() => void handleRename()}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-foreground/85 hover:bg-accent transition-colors"
          aria-label="rename the group"
        >
          <Pencil className="size-3.5 shrink-0 opacity-70" />
          rename group
        </button>
        <button
          onClick={() => void handleLeave()}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-destructive hover:bg-destructive/10 transition-colors"
          aria-label="leave the group"
        >
          <LogOut className="size-3.5 shrink-0" />
          leave group
        </button>
      </div>
      {/* the hidden picker behind the group photo button */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void handlePhoto(e.target.files?.[0])
          e.target.value = ''
        }}
      />
    </div>
  )
}


