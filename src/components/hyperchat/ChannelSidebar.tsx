'use client'

import { useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/lib/client/store'
import { relativeTime } from '@/lib/client/format'
import { Avatar } from './Avatar'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Hash, ChevronDown, UserPlus, MessageSquarePlus, LogOut, Plus, AtSign, Settings, X, FolderPlus, BellOff, Bell, UserCheck, UserX, Clock, Lock, Pin, Bookmark, CalendarClock, Circle, Minus, Moon, EyeOff, Focus, Pencil, Users, UserRound, Check, GripVertical, Trash2, Search, Volume2, MessagesSquare, PhoneOff, Mic, MicOff, Headphones, HeadphoneOff } from 'lucide-react'
import { sounds } from '@/lib/client/sounds'
import { PERM } from '@/lib/perm'
import type { ChannelSummary, ConversationSummary, FriendSummary, UserPresenceChoice } from '@/lib/types'
import { openContextMenu } from './ContextMenu'
import { awayForLabel } from './MessageList'
import { confirmDialog, promptDialog } from './ConfirmDialog'
import { ApiError } from '@/lib/client/api'
import { useToast } from '@/hooks/use-toast'

/** Sortable wrapper for a channel row: a hover grip is the only drag
 *  handle, so clicks and the mute button behave exactly as before. */
function SortableChannelRow({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.65 : 1,
        zIndex: isDragging ? 30 : undefined,
        position: 'relative',
      }}
    >
      <button
        className="absolute -left-0.5 top-1/2 -translate-y-1/2 p-1 rounded-sm text-muted-foreground/60 hover:text-foreground cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity z-10 touch-none"
        {...attributes}
        {...listeners}
        aria-label="drag to reorder channel"
        title="drag to reorder"
      >
        <GripVertical className="size-3" />
      </button>
      {children}
    </div>
  )
}

/** One channel group (a category, or the uncategorized block) as its own
 *  drag-and-drop context: channels reorder within their group, never across. */
function SortableChannelGroup({
  channels,
  canSort,
  onReorder,
  render,
}: {
  channels: ChannelSummary[]
  canSort: boolean
  onReorder: (fromId: string, toIndex: number) => void
  render: (c: ChannelSummary) => React.ReactNode
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const ids = useMemo(() => channels.map((c) => c.id), [channels])
  if (!canSort || channels.length < 2) {
    return <>{channels.map(render)}</>
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) return
        const to = ids.indexOf(String(over.id))
        if (to === -1) return
        onReorder(String(active.id), to)
      }}
    >
      <SortableContext items={ids}>
        {channels.map((c) => (
          <SortableChannelRow key={c.id} id={c.id}>
            {render(c)}
          </SortableChannelRow>
        ))}
      </SortableContext>
    </DndContext>
  )
}

/** Sortable category header row: the drag grip reorders whole categories.
 *  Lives inside SortableCategoryArea's shared DndContext. */
function SortableCategoryHeader({ id, canSort, children }: { id: string; canSort: boolean; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !canSort })
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.65 : 1,
        zIndex: isDragging ? 30 : undefined,
        position: 'relative',
      }}
      className="flex items-center justify-between px-2 pb-1.5"
    >
      <div className="flex items-center min-w-0 flex-1">
        {canSort && (
          <button
            className="p-0.5 mr-0.5 rounded-sm text-muted-foreground/50 hover:text-foreground cursor-grab active:cursor-grabbing focus-visible:opacity-100 opacity-0 hover:opacity-100 transition-opacity shrink-0 touch-none"
            {...attributes}
            {...listeners}
            aria-label="drag to reorder category"
            title="drag to reorder"
          >
            <GripVertical className="size-3" />
          </button>
        )}
        {children}
      </div>
    </div>
  )
}

/** Shared drag context for every category block: dragging one header onto
 *  another reorders the whole categories. */
function SortableCategoryArea({
  categoryIds,
  canSort,
  onReorder,
  children,
}: {
  categoryIds: string[]
  canSort: boolean
  onReorder: (fromId: string, toId: string) => void
  children: React.ReactNode
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  if (!canSort || categoryIds.length < 2) return <>{children}</>
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={({ active, over }) => {
        if (!over || active.id === over.id) return
        if (!categoryIds.includes(String(over.id))) return
        onReorder(String(active.id), String(over.id))
      }}
    >
      <SortableContext items={categoryIds}>{children}</SortableContext>
    </DndContext>
  )
}

type ChannelSidebarProps = {
  onInvite: () => void
  onCreateChannel: (categoryId?: string) => void
  onCreateCategory: () => void
  onFindUser: () => void
  /** opens the all-dms-and-groups message search */
  onOpenSidebarSearch: () => void
  onServerSettings: () => void
  onNavigated: () => void
}

export function ChannelSidebar({
  onInvite,
  onCreateChannel,
  onCreateCategory,
  onFindUser,
  onOpenSidebarSearch,
  onServerSettings,
  onNavigated,
}: ChannelSidebarProps) {
  const me = useChatStore((s) => s.me)
  const servers = useChatStore((s) => s.servers)
  const activeServerId = useChatStore((s) => s.activeServerId)
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const conversations = useChatStore((s) => s.conversations)
  const onlineUserIds = useChatStore((s) => s.onlineUserIds)
  const presenceStatuses = useChatStore((s) => s.presenceStatuses)
  const awaySince = useChatStore((s) => s.awaySince)
  const channelUnread = useChatStore((s) => s.channelUnread)
  const connected = useChatStore((s) => s.connected)
  const selectChannel = useChatStore((s) => s.selectChannel)
  const selectConversation = useChatStore((s) => s.selectConversation)
  const leaveServer = useChatStore((s) => s.leaveServer)
  const deleteServer = useChatStore((s) => s.deleteServer)
  const hideConversation = useChatStore((s) => s.hideConversation)
  const pinConversation = useChatStore((s) => s.pinConversation)
  const doLogout = useChatStore((s) => s.doLogout)
  const setAccountOpen = useChatStore((s) => s.setAccountOpen)
  const openProfile = useChatStore((s) => s.openProfile)
  const friends = useChatStore((s) => s.friends)
  const incomingRequests = useChatStore((s) => s.incomingRequests)
  const acceptFriendRequest = useChatStore((s) => s.acceptFriendRequest)
  const removeFriendship = useChatStore((s) => s.removeFriendship)
  const openDM = useChatStore((s) => s.openDM)
  const renameGroup = useChatStore((s) => s.renameGroup)
  const leaveGroup = useChatStore((s) => s.leaveGroup)
  const addGroupMember = useChatStore((s) => s.addGroupMember)
  const markRead = useChatStore((s) => s.markRead)
  const { toast } = useToast()
  const mutedScopes = useChatStore((s) => s.mutedScopes)
  const toggleMute = useChatStore((s) => s.toggleMute)
  const channelMentions = useChatStore((s) => s.channelMentions)
  const setMyPresence = useChatStore((s) => s.setMyPresence)
  const updateProfile = useChatStore((s) => s.updateProfile)
  const setProfileEditorOpen = useChatStore((s) => s.setProfileEditorOpen)
  const reorderChannels = useChatStore((s) => s.reorderChannels)
  const reorderCategories = useChatStore((s) => s.reorderCategories)
  const renameCategory = useChatStore((s) => s.renameCategory)
  const deleteCategory = useChatStore((s) => s.deleteCategory)
  const voiceConnected = useChatStore((s) => s.voiceConnected)
  const voiceSelf = useChatStore((s) => s.voiceSelf)
  const voiceParticipants = useChatStore((s) => s.voiceParticipants)
  const joinVoice = useChatStore((s) => s.joinVoice)
  const leaveVoice = useChatStore((s) => s.leaveVoice)
  const toggleVoiceMute = useChatStore((s) => s.toggleVoiceMute)
  const toggleVoiceDeafen = useChatStore((s) => s.toggleVoiceDeafen)
  const selectServer = useChatStore((s) => s.selectServer)

  // user panel popover: open state + status quote draft
  const [panelOpen, setPanelOpen] = useState(false)
  const [statusDraft, setStatusDraft] = useState('')
  // while the quote input is focused, nothing may re-seed the draft (a
  // store refresh mid-typing used to wipe it). state, not a ref, so the
  // render-phase seed below can read it legally
  const [statusFocused, setStatusFocused] = useState(false)

  // seed the quote draft from the live profile each time the popover opens
  // (render-phase adjust, the same pattern the message list uses)
  const [panelSeed, setPanelSeed] = useState<string | null>(null)
  if (panelOpen && panelSeed === null && !statusFocused) {
    const v = me?.customStatus ?? ''
    setPanelSeed(v)
    setStatusDraft(v)
  } else if (!panelOpen && panelSeed !== null) {
    setPanelSeed(null)
  }

  /** Save the status quote straight from the panel popover. */
  async function saveStatusQuote() {
    if (!me) return
    const next = statusDraft.trim() || null
    if (next === (me.customStatus ?? null)) return
    try {
      await updateProfile({ customStatus: next })
      sounds.play('lightTick')
    } catch {
      sounds.play('error')
      toast({ title: 'could not save status' })
    }
  }
  const bookmarks = useChatStore((s) => s.bookmarks)
  const scheduled = useChatStore((s) => s.scheduled)
  const setSavedOpen = useChatStore((s) => s.setSavedOpen)
  const setScheduledOpen = useChatStore((s) => s.setScheduledOpen)
  const reminders = useChatStore((s) => s.reminders)

  // combined MESSAGES list: friends who are not yet a conversation ride
  // below the real conversations, which order themselves pinned-first
  const conversationalUserIds = useMemo(
    () =>
      new Set(
        conversations.flatMap((c) =>
          c.kind === 'GROUP' ? (c.participants ?? []).map((p) => p.id) : [c.otherUser.id]
        )
      ),
    [conversations]
  )
  const friendsWithoutDm = useMemo(
    () => friends.filter((f) => !conversationalUserIds.has(f.user.id)),
    [friends, conversationalUserIds]
  )
  const sortedConversations = useMemo(
    () =>
      [...conversations].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        const at = (c: ConversationSummary) =>
          c.lastMessage ? new Date(c.lastMessage.createdAt).getTime() : 0
        return at(b) - at(a)
      }),
    [conversations]
  )

  const server = servers.find((s) => s.id === activeServerId) ?? null
  const myPerms = server?.myPerms ?? 0
  const canManage = (myPerms & (PERM.ADMINISTRATOR | PERM.MANAGE_CHANNELS)) !== 0
  const serverMuted = server ? !!mutedScopes[`server:${server.id}`] : false

  const uncategorized = server?.channels.filter((c) => !c.categoryId && c.type !== 'voice') ?? []
  const voiceChannels = server?.channels.filter((c) => c.type === 'voice') ?? []
  const voiceServer = voiceConnected ? servers.find((s) => s.id === voiceConnected.serverId) : null
  const voiceChannel = voiceConnected
    ? voiceServer?.channels.find((c) => c.id === voiceConnected.channelId) ?? null
    : null
  const categories = server?.categories ?? []

  const dmUnreadTotal = conversations.reduce((acc, c) => acc + c.unreadCount, 0)

  /** Add a member to a group; hitting the limit shows the fact (the owner
   *  raises it from the member list or the header popover). Shared by the
   *  sidebar context menu flows. */
  async function tryAddGroupMember(conversationId: string, userId: string) {
    try {
      await addGroupMember(conversationId, userId)
      sounds.play('midTick')
      toast({ title: 'member added' })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'limit') {
        sounds.play('error')
        toast({ title: 'group is full' })
        return
      }
      sounds.play('error')
      toast({ title: 'could not add member', description: err instanceof ApiError ? err.message : 'Try again.' })
    }
  }

  /** Second-level menu: pick one of my servers, its invite link lands in
   *  the composer of this conversation (and the clipboard). The exact
   *  "hyperchat.gg/<code>" text is what the invite embed renderer matches. */
  function openInviteServersMenu(e: React.MouseEvent, conversationId: string) {
    const state = useChatStore.getState()
    openContextMenu(
      e,
      [
        {
          kind: 'label',
          label: servers.length > 0 ? 'invite to which server?' : 'join a server first',
        },
        ...servers.map((s) => ({
          label: s.name,
          icon: Users,
          onSelect: () => {
            const link = `hyperchat.gg/${s.inviteCode}`
            sounds.play('midTick')
            void state.selectConversation(conversationId)
            state.requestInsert(`conversation:${conversationId}`, link)
            navigator.clipboard?.writeText(link).catch(() => {})
            toast({ title: 'invite link ready to send' })
            onNavigated()
          },
        })),
      ],
      { title: 'invite to server', subtitle: 'invite code goes to the chat' }
    )
  }

  /** Right-click menu for a DM row in the MESSAGES list. */
  function openDmContextMenu(e: React.MouseEvent, c: ConversationSummary) {
    openContextMenu(
      e,
      [
        {
          label: 'profile',
          icon: UserRound,
          onSelect: () => {
            sounds.play('lightTick')
            void openProfile(c.otherUser.username)
          },
        },
        {
          label: 'invite to server',
          icon: UserPlus,
          onSelect: () => openInviteServersMenu(e, c.id),
        },
        {
          label: 'mark read',
          icon: Check,
          onSelect: () => {
            sounds.play('lightTick')
            void markRead(`conversation:${c.id}`)
          },
        },
        {
          label: c.pinned ? 'unpin' : 'pin',
          icon: Pin,
          onSelect: () => {
            sounds.play('lightTick')
            void pinConversation(c.id)
          },
        },
        {
          label: 'hide',
          icon: EyeOff,
          onSelect: () => {
            sounds.play('lightTick')
            void hideConversation(c.id)
          },
        },
      ],
      { title: c.otherUser.displayName || c.otherUser.username, subtitle: `@${c.otherUser.username}` }
    )
  }

  /** Right-click menu for a group row in the MESSAGES list. */
  function openGroupContextMenu(e: React.MouseEvent, c: ConversationSummary) {
    const memberIds = (c.participants ?? []).map((p) => p.id)
    const addable = friends.filter((f) => !memberIds.includes(f.user.id))
    openContextMenu(
      e,
      [
        {
          label: 'add member',
          icon: UserPlus,
          onSelect: () =>
            openContextMenu(
              e,
              [
                {
                  kind: 'label',
                  label:
                    addable.length > 0
                      ? `${addable.length} friend${addable.length === 1 ? '' : 's'} available`
                      : 'no friends left to add',
                },
                ...addable.map((f) => ({
                  label: f.user.displayName || f.user.username,
                  onSelect: () => void tryAddGroupMember(c.id, f.user.id),
                })),
              ],
              { title: c.name ?? 'Group', subtitle: 'add member' }
            ),
        },
        {
          label: 'invite to server',
          icon: Users,
          onSelect: () => openInviteServersMenu(e, c.id),
        },
        {
          label: 'rename group',
          icon: Pencil,
          onSelect: () => {
            void (async () => {
              const name = await promptDialog({
                title: 'rename group',
                placeholder: 'Group name',
                initial: c.name ?? '',
                maxLength: 60,
                confirmLabel: 'Save name',
              })
              if (name && name.trim().length >= 2) {
                try {
                  await renameGroup(c.id, name.trim())
                  sounds.play('midTick')
                  toast({ title: 'group renamed' })
                } catch {
                  toast({ title: 'could not rename' })
                }
              }
            })()
          },
        },
        {
          label: c.pinned ? 'Unpin group' : 'Pin group',
          icon: Pin,
          onSelect: () => {
            sounds.play('lightTick')
            void pinConversation(c.id)
          },
        },
        {
          label: 'close group',
          icon: X,
          onSelect: () => {
            sounds.play('lightTick')
            void hideConversation(c.id)
          },
        },
        { kind: 'separator' },
        {
          label: 'leave group',
          icon: LogOut,
          danger: true,
          onSelect: () => {
            void (async () => {
              const go = await confirmDialog({
                title: `Leave ${c.name ?? 'this group'}?`,
                body: 'You stop receiving its messages. Rejoin needs an invite from a member.',
                tone: 'danger',
                confirmLabel: 'Leave group',
              })
              if (go) {
                try {
                  await leaveGroup(c.id)
                  sounds.play('midTick')
                  toast({ title: 'left the group' })
                } catch {
                  toast({ title: 'could not leave' })
                }
              }
            })()
          },
        },
      ],
      { title: c.name ?? 'Group', subtitle: `${memberIds.length} members` }
    )
  }

  /** category drag: swap positions, then persist the full order */
  function handleCategoryReorder(fromId: string, toId: string) {
    if (!server) return
    const ids = [...server.categories].sort((a, b) => a.position - b.position).map((c) => c.id)
    const from = ids.indexOf(fromId)
    const to = ids.indexOf(toId)
    if (from === -1 || to === -1) return
    ;[ids[from], ids[to]] = [ids[to], ids[from]]
    sounds.play('midTick')
    void reorderCategories(server.id, ids)
  }

  /** drag-and-drop reorder inside one category (or the uncategorized block):
   *  rebuilds the full server order by splicing the group back into the
   *  global position slots it already occupies. */
  function handleGroupReorder(categoryId: string | null, fromId: string, toIndex: number) {
    if (!server) return
    const global = [...server.channels].sort((a, b) => a.position - b.position)
    const group = global.filter((c) => (c.categoryId ?? null) === categoryId)
    const fromIndex = group.findIndex((c) => c.id === fromId)
    if (fromIndex === -1 || toIndex < 0 || toIndex >= group.length) return
    const moved = group.splice(fromIndex, 1)[0]
    group.splice(toIndex, 0, moved)
    const slots = global
      .map((c, i) => ((c.categoryId ?? null) === categoryId ? i : -1))
      .filter((i) => i >= 0)
    const next = [...global]
    slots.forEach((slot, k) => {
      if (k < group.length) next[slot] = group[k]
    })
    sounds.play('midTick')
    void reorderChannels(server.id, next.map((c) => c.id))
  }

  /** one channel row, shared by the uncategorized and categorized lists */
  const renderChannel = (channel: ChannelSummary) => {
    const active = channel.id === activeChannelId
    const unread = channelUnread[channel.id] ?? 0
    const mentions = channelMentions[channel.id] ?? 0
    const muted = !!mutedScopes[`channel:${channel.id}`] || serverMuted
    return (
      <div
        key={channel.id}
        className={cn(
          'group relative flex items-center rounded-sm transition-colors',
          active ? 'bg-app-raise' : 'hover:bg-app-raise/60'
        )}
      >
        <button
          onClick={() => {
            void selectChannel(channel.id)
            onNavigated()
          }}
          className={cn(
            'flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded-sm text-sm min-w-0 transition-colors',
            active
              ? 'text-foreground font-semibold'
              : mentions > 0
                ? 'text-hyper font-bold'
                : unread > 0
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground'
          )}
          aria-current={active ? 'page' : undefined}
        >
          {channel.private ? (
            <Lock className={cn('size-4 shrink-0', unread > 0 ? 'opacity-100' : 'opacity-60')} aria-hidden="true" />
          ) : channel.type === 'forum' ? (
            <MessagesSquare className={cn('size-4 shrink-0', unread > 0 ? 'opacity-100' : 'opacity-60')} aria-hidden="true" />
          ) : (
            <Hash className={cn('size-4 shrink-0', unread > 0 ? 'opacity-100' : 'opacity-60')} />
          )}
          <span className="truncate flex-1 text-left">{channel.name}</span>
          {channel.locked && !active && (
            <Lock className="size-3 shrink-0 text-hyper/80" aria-label="locked" />
          )}
          {muted && !active && (
            <BellOff className="size-3 shrink-0 text-muted-foreground/70" aria-label="muted" />
          )}
          {unread > 0 && !active && (
            <span
              className={cn(
                'shrink-0 min-w-4 h-4 px-1 text-[9px] font-bold grid place-items-center rounded-sm',
                mentions > 0
                  ? 'bg-hyper text-white mention-badge'
                  : muted
                    ? 'bg-app-raise text-muted-foreground border border-white/15'
                    : 'bg-white text-black'
              )}
            >
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
        <button
          onClick={() => {
            sounds.play('lightTick')
            void toggleMute(`channel:${channel.id}`)
          }}
          className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-sm text-muted-foreground hover:text-foreground bg-app-chat/80 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
          aria-label={muted ? `Unmute ${channel.name}` : `Mute ${channel.name}`}
          title={muted ? 'Unmute channel' : 'Mute channel'}
        >
          {muted ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
        </button>
      </div>
    )
  }

  /** a voice channel row: clicking joins the call (mic permission), shows
   *  live participant avatars while people are connected */
  const renderVoiceChannel = (channel: ChannelSummary) => {
    const active = channel.id === activeChannelId
    const live = voiceParticipants[channel.id] ?? []
    const shown = live.slice(0, 3)
    const overflow = live.length - shown.length
    const connectedHere = voiceConnected?.channelId === channel.id
    return (
      <div
        key={channel.id}
        className={cn(
          'group relative flex items-center rounded-sm transition-colors',
          active ? 'bg-app-raise' : 'hover:bg-app-raise/60'
        )}
      >
        <button
          onClick={() => {
            if (!server) return
            void selectChannel(channel.id)
            if (!connectedHere) void joinVoice(channel.id, server.id)
            onNavigated()
          }}
          className={cn(
            'flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded-sm text-sm min-w-0 transition-colors',
            active ? 'text-foreground font-semibold' : 'text-muted-foreground hover:text-foreground'
          )}
          aria-current={active ? 'page' : undefined}
        >
          {channel.private ? (
            <Lock className="size-4 shrink-0 opacity-60" aria-hidden="true" />
          ) : (
            <Volume2 className="size-4 shrink-0 opacity-60" aria-hidden="true" />
          )}
          <span className="truncate flex-1 text-left">{channel.name}</span>
          {live.length > 0 && (
            <span className="shrink-0 flex items-center -space-x-1.5">
              {shown.map((p) => (
                <span key={p.userId} className="rounded-full ring-2 ring-app-sidebar">
                  <Avatar name={p.username} color={p.avatarColor} url={p.avatarUrl} size="sm" />
                </span>
              ))}
              {overflow > 0 && (
                <span className="size-6 rounded-full ring-2 ring-app-sidebar bg-app-raise grid place-items-center text-[9px] font-bold text-muted-foreground">
                  +{overflow}
                </span>
              )}
            </span>
          )}
        </button>
      </div>
    )
  }

  return (
    <div className="w-full h-full bg-app-sidebar flex flex-col border-r border-white/10">
      {server ? (
        <>
          <div className="h-12 px-3 flex items-center border-b border-white/10 shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex-1 flex items-center gap-1.5 min-w-0 text-left rounded-sm px-2 py-1.5 hover:bg-accent transition-colors">
                  <span className="font-bold text-sm truncate flex-1 tracking-tight">{server.name}</span>
                  <ChevronDown className="size-4 text-muted-foreground shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-52 rounded-sm">
                <DropdownMenuItem onClick={onInvite}>
                  <UserPlus className="size-4" />
                  Invite people
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onCreateChannel()}>
                  <Plus className="size-4" />
                  Create channel
                </DropdownMenuItem>
                {canManage && (
                  <DropdownMenuItem onClick={onCreateCategory}>
                    <FolderPlus className="size-4" />
                    Create category
                  </DropdownMenuItem>
                )}
                {canManage && (
                  <DropdownMenuItem onClick={onServerSettings}>
                    <Settings className="size-4" />
                    Server settings
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    sounds.play('lightTick')
                    void toggleMute(`server:${server.id}`)
                  }}
                >
                  {serverMuted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
                  {serverMuted ? 'Unmute server' : 'Mute server'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {server.myRole === 'OWNER' ? (
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => {
                      void (async () => {
                        if (await confirmDialog({
                          title: `Delete ${server.name}?`,
                          body: 'The server, its channels and every message in them will be gone for good. This cannot be undone.',
                          tone: 'danger',
                          confirmLabel: 'Delete server',
                        })) {
                          void deleteServer(server.id)
                          onNavigated()
                        }
                      })()
                    }}
                  >
                    <LogOut className="size-4" />
                    Delete server
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => {
                      void leaveServer(server.id)
                      onNavigated()
                    }}
                  >
                    <LogOut className="size-4" />
                    Leave server
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="flex-1 overflow-y-auto scroll-thin px-2 py-3">
            {voiceChannels.length > 0 && (
              <div className="mb-3">
                <div className="flex items-center justify-between px-2 pb-1.5">
                  <span className="text-[11px] font-bold tracking-widest text-muted-foreground">voice</span>
                  {canManage && (
                    <button
                      onClick={() => onCreateChannel()}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      aria-label="create a voice channel"
                    >
                      <Plus className="size-4" />
                    </button>
                  )}
                </div>
                <div className="space-y-0.5">{voiceChannels.map(renderVoiceChannel)}</div>
              </div>
            )}

            {uncategorized.length > 0 && (
              <>
                {categories.length === 0 && (
                  <div className="flex items-center justify-between px-2 pb-2">
                    <span className="text-[11px] font-bold tracking-widest text-muted-foreground">
                      text channels
                    </span>
                    {canManage && (
                      <button
                        onClick={() => onCreateChannel()}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                        aria-label="create a channel"
                      >
                        <Plus className="size-4" />
                      </button>
                    )}
                  </div>
                )}
                <div className="space-y-0.5">
                  <SortableChannelGroup
                    channels={uncategorized}
                    canSort={canManage}
                    onReorder={(fromId, to) => handleGroupReorder(null, fromId, to)}
                    render={renderChannel}
                  />
                </div>
              </>
            )}

            <SortableCategoryArea
              categoryIds={categories.map((c) => c.id)}
              canSort={canManage}
              onReorder={handleCategoryReorder}
            >
              {categories.map((category) => {
                const channels = server.channels.filter((c) => c.categoryId === category.id && c.type !== 'voice')
                if (channels.length === 0 && !canManage) return null
                return (
                  <div key={category.id} className="mt-4">
                    <SortableCategoryHeader id={category.id} canSort={canManage}>
                      <button
                        className="flex-1 min-w-0 text-left"
                        onContextMenu={(e) => {
                          if (!canManage) return
                          e.preventDefault()
                          openContextMenu(
                            e,
                            [
                              {
                                kind: 'item',
                                label: 'rename category',
                                icon: Pencil,
                                onSelect: () => {
                                  void (async () => {
                                    const next = await promptDialog({
                                      title: 'rename category',
                                      body: '',
                                      placeholder: category.name,
                                      initial: category.name,
                                      confirmLabel: 'rename',
                                    })
                                    const clean = (next ?? '').trim()
                                    if (clean && clean !== category.name) {
                                      try {
                                        await renameCategory(server.id, category.id, clean.slice(0, 32))
                                        sounds.play('midTick')
                                      } catch {
                                        sounds.play('error')
                                        toast({ title: 'could not rename' })
                                      }
                                    }
                                  })()
                                },
                              },
                              {
                                kind: 'item',
                                label: 'create channel',
                                icon: Plus,
                                onSelect: () => onCreateChannel(category.id),
                              },
                              { kind: 'separator' },
                              {
                                kind: 'item',
                                label: 'delete category',
                                icon: Trash2,
                                danger: true,
                                onSelect: () => {
                                  void (async () => {
                                    const yes = await confirmDialog({
                                      title: `Delete ${category.name}?`,
                                      body: 'Its channels move to the channel list above.',
                                      tone: 'danger',
                                      confirmLabel: 'Delete category',
                                    })
                                    if (!yes) return
                                    try {
                                      await deleteCategory(server.id, category.id)
                                      sounds.play('urgent')
                                    } catch {
                                      sounds.play('error')
                                      toast({ title: 'could not delete' })
                                    }
                                  })()
                                },
                              },
                            ],
                            { title: category.name, subtitle: `${channels.length} channel${channels.length === 1 ? '' : 's'}` }
                          )
                        }}
                      >
                        <span className="text-[11px] font-bold tracking-widest text-muted-foreground truncate block w-full">
                          {category.name}
                        </span>
                      </button>
                      {canManage && (
                        <button
                          onClick={() => onCreateChannel(category.id)}
                          className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                          aria-label={`Create a channel in ${category.name}`}
                        >
                          <Plus className="size-4" />
                        </button>
                      )}
                    </SortableCategoryHeader>
                    <div className="space-y-0.5">
                      <SortableChannelGroup
                        channels={server.channels.filter((c) => c.categoryId === category.id && c.type !== 'voice')}
                        canSort={canManage}
                        onReorder={(fromId, to) => handleGroupReorder(category.id, fromId, to)}
                        render={renderChannel}
                      />
                      {server.channels.filter((c) => c.categoryId === category.id && c.type !== 'voice').length === 0 && (
                        <p className="px-2 py-1 text-[11px] text-muted-foreground">no channels yet.</p>
                      )}
                    </div>
                  </div>
                )
              })}
            </SortableCategoryArea>
          </div>
        </>
      ) : (
        <>
          <div className="h-12 px-3 flex items-center justify-between border-b border-white/10 shrink-0">
            <span className="font-bold text-sm px-2 tracking-tight">direct messages</span>
            <div className="flex items-center gap-1">
              {dmUnreadTotal > 0 && (
                <span className="px-1.5 h-5 min-w-5 bg-hyper text-[10px] font-bold text-white grid place-items-center rounded-sm">
                  {dmUnreadTotal > 99 ? '99+' : dmUnreadTotal}
                </span>
              )}
              {/* the sidebar search: scans every dm and group chat */}
              <button
                onClick={() => {
                  sounds.play('lightTick')
                  onOpenSidebarSearch()
                }}
                className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-app-raise/60 transition-colors"
                aria-label="search all dms and groups"
                title="search all dms and groups"
              >
                <Search className="size-4" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto scroll-thin px-2 py-3">
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start mb-2 rounded-sm"
              onClick={onFindUser}
            >
              <MessageSquarePlus className="size-4" />
              find a conversation
            </Button>

            {/* personal tools: saved messages + scheduled queue + reminders */}
            <div className="space-y-0.5 mb-2">
              <button
                onClick={() => {
                  sounds.play('lightTick')
                  setSavedOpen(true)
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground hover:bg-app-raise/60 transition-colors"
                aria-label="saved messages"
              >
                <Bookmark className="size-4 shrink-0 opacity-70" />
                <span className="flex-1 text-left">saved messages</span>
                {bookmarks.length > 0 && (
                  <span className="text-[10px] font-bold tabular-nums text-hyper">{bookmarks.length}</span>
                )}
              </button>
              <button
                onClick={() => {
                  sounds.play('lightTick')
                  setScheduledOpen(true)
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground hover:bg-app-raise/60 transition-colors"
                aria-label="scheduled messages"
              >
                <CalendarClock className="size-4 shrink-0 opacity-70" />
                <span className="flex-1 text-left">scheduled</span>
                {scheduled.length > 0 && (
                  <span className="text-[10px] font-bold tabular-nums text-hyper">{scheduled.length}</span>
                )}
              </button>
              {reminders.length > 0 && (
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm text-muted-foreground">
                  <Clock className="size-4 shrink-0 opacity-70" />
                  <span className="flex-1 text-left">{reminders.length} reminder{reminders.length === 1 ? '' : 's'} set</span>
                </div>
              )}
            </div>

            <div className="px-2 pb-2 pt-1 text-[11px] font-bold tracking-widest text-muted-foreground flex items-center gap-1.5">
              messages
              {conversations.length + friendsWithoutDm.length > 0 && (
                <span className="text-[9px] text-muted-foreground/70 font-semibold">
                  {conversations.length + friendsWithoutDm.length}
                </span>
              )}
            </div>

            <div className="space-y-0.5">
              {incomingRequests.map((req) => (
                <FriendRequestRow key={req.friendshipId} req={req} onAccept={acceptFriendRequest} onDecline={removeFriendship} />
              ))}

              {friendsWithoutDm.map((friend) => {
                const online = !!onlineUserIds[friend.user.id]
                const friendStatus = online
                  ? presenceStatuses[friend.user.id] ?? 'online'
                  : 'offline'
                const away = online && friendStatus === 'idle' ? awaySince[friend.user.id] : undefined
                return (
                  <div
                    key={friend.friendshipId}
                    className={cn(
                      'group relative flex items-center rounded-sm transition-colors',
                      'hover:bg-app-raise/60'
                    )}
                  >
                    <button
                      onClick={() => {
                        void openDM(friend.user.id)
                        onNavigated()
                      }}
                      className="flex-1 flex items-center gap-2.5 px-2 py-1.5 rounded-sm text-sm min-w-0 text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Avatar
                        name={friend.user.username}
                        color={friend.user.avatarColor}
                        url={friend.user.avatarUrl}
                        size="sm"
                        status={friendStatus}
                        showDot
                      />
                      <span className="min-w-0 flex-1 text-left leading-tight">
                        <span className="block truncate">{friend.user.displayName || friend.user.username}</span>
                        {friend.user.customStatus && online ? (
                          <span className="block truncate text-[11px] text-foreground/70">{friend.user.customStatus}</span>
                        ) : away ? (
                          <span className="block truncate text-[11px] text-idle/90">away {awayForLabel(away)}</span>
                        ) : null}
                      </span>
                    </button>
                    <button
                      onClick={() => void removeFriendship(friend.friendshipId)}
                      className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-sm text-muted-foreground hover:text-destructive bg-app-chat/80 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                      aria-label={`Remove ${friend.user.username} as a friend`}
                      title="remove friend"
                    >
                      <UserX className="size-3.5" />
                    </button>
                  </div>
                )
              })}

              {conversations.length === 0 && friendsWithoutDm.length === 0 && incomingRequests.length === 0 && (
                <p className="px-2 py-2 text-xs text-muted-foreground">
                  No messages yet.
                </p>
              )}
              {sortedConversations.map((c) => {
                const active = c.id === activeConversationId

                // ---- group rows: stacked member avatars + name + count chip ----
                if (c.kind === 'GROUP') {
                  const members = c.participants ?? []
                  const others = members.filter((p) => p.id !== me?.id)
                  const shown = (others.length > 0 ? others : members).slice(0, 3)
                  const count = members.length
                  const lastAuthor =
                    c.lastMessage?.authorId === me?.id
                      ? 'You'
                      : members.find((p) => p.id === c.lastMessage?.authorId)?.displayName ||
                        (c.lastMessage ? c.otherUser.displayName || c.otherUser.username : '')
                  return (
                    <div
                      key={c.id}
                      className={cn(
                        'group relative flex items-center rounded-sm transition-colors',
                        active ? 'bg-app-raise' : 'hover:bg-app-raise/60'
                      )}
                      onContextMenu={(e) => openGroupContextMenu(e, c)}
                    >
                      <button
                        onClick={() => {
                          void selectConversation(c.id)
                          onNavigated()
                        }}
                        className={cn(
                          'flex-1 flex items-center gap-2.5 px-2 py-1.5 rounded-sm text-sm min-w-0 transition-colors',
                          active
                            ? 'text-foreground font-semibold'
                            : c.unreadCount > 0
                              ? 'text-foreground font-medium'
                              : 'text-muted-foreground hover:text-foreground'
                        )}
                        aria-current={active ? 'page' : undefined}
                        aria-label={`Group ${c.name ?? ''}, ${count} members`}
                      >
                        <span className="flex items-center shrink-0" aria-hidden="true">
                          {c.iconUrl ? (
                            <img
                              src={c.iconUrl}
                              alt=""
                              className="size-6 rounded-full object-cover ring-2 ring-app-sidebar"
                              draggable={false}
                            />
                          ) : shown.length > 0 ? (
                            shown.map((p, i) => (
                              <span
                                key={p.id}
                                className={cn(
                                  'rounded-full ring-2 ring-app-sidebar',
                                  i > 0 && '-ml-2.5'
                                )}
                              >
                                <Avatar name={p.username} color={p.avatarColor} url={p.avatarUrl} size="sm" />
                              </span>
                            ))
                          ) : (
                            <span className="size-6 rounded-full bg-app-raise grid place-items-center">
                              <Users className="size-3.5 text-muted-foreground" />
                            </span>
                          )}
                        </span>
                        <span className="min-w-0 flex-1 text-left leading-tight">
                          <span className="flex items-center gap-1">
                            {c.pinned && <Pin className="size-3 shrink-0 text-muted-foreground/80" aria-label="pinned" />}
                            <span className="truncate">{c.name ?? 'Group'}</span>
                            <span
                              className="shrink-0 flex items-center gap-0.5 text-[10px] font-bold tabular-nums text-muted-foreground/80"
                              title={`${count} members`}
                            >
                              <Users className="size-2.5" />
                              {count}
                            </span>
                          </span>
                          {c.lastMessage && !active && (
                            <span className="block truncate text-[11px] text-muted-foreground/80">
                              {lastAuthor ? `${lastAuthor}: ` : ''}
                              {c.lastMessage.content ?? 'image'}
                            </span>
                          )}
                        </span>
                        {c.unreadCount > 0 && !active && (
                          <span className="shrink-0 min-w-4 h-4 px-1 bg-hyper text-[9px] font-bold text-white grid place-items-center rounded-sm">
                            {c.unreadCount > 99 ? '99+' : c.unreadCount}
                          </span>
                        )}
                        {c.unreadCount === 0 && c.lastMessage && !c.pinned && (
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {relativeTime(c.lastMessage.createdAt)}
                          </span>
                        )}
                      </button>
                      <button
                        onClick={() => {
                          sounds.play('lightTick')
                          void pinConversation(c.id)
                        }}
                        className={cn(
                          'absolute right-7 top-1/2 -translate-y-1/2 p-1 rounded-sm bg-app-chat/80 transition-opacity',
                          c.pinned
                            ? 'text-hyper opacity-100'
                            : 'text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                        )}
                        aria-label={c.pinned ? `Unpin group ${c.name ?? ''}` : `Pin group ${c.name ?? ''}`}
                        title={c.pinned ? 'Unpin conversation' : 'Pin conversation'}
                      >
                        <Pin className="size-3.5" />
                      </button>
                      <button
                        onClick={() => void hideConversation(c.id)}
                        className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-sm text-muted-foreground hover:text-destructive bg-app-chat/80 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                        aria-label={`Close group ${c.name ?? ''}`}
                        title="close group"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  )
                }

                // ---- DM rows stay exactly as they are ----
                const online = !!onlineUserIds[c.otherUser.id]
                return (
                  <div
                    key={c.id}
                    className={cn(
                      'group relative flex items-center rounded-sm transition-colors',
                      active ? 'bg-app-raise' : 'hover:bg-app-raise/60'
                    )}
                    onContextMenu={(e) => openDmContextMenu(e, c)}
                  >
                    <button
                      onClick={() => {
                        void selectConversation(c.id)
                        onNavigated()
                      }}
                      className={cn(
                        'flex-1 flex items-center gap-2.5 px-2 py-1.5 rounded-sm text-sm min-w-0 transition-colors',
                        active
                          ? 'text-foreground font-semibold'
                          : c.unreadCount > 0
                            ? 'text-foreground font-medium'
                            : 'text-muted-foreground hover:text-foreground'
                      )}
                      aria-current={active ? 'page' : undefined}
                    >
                      <Avatar
                        name={c.otherUser.username}
                        color={c.otherUser.avatarColor}
                        url={c.otherUser.avatarUrl}
                        size="sm"
                        status={online ? presenceStatuses[c.otherUser.id] ?? 'online' : 'offline'}
                        showDot
                      />
                      <span className="min-w-0 flex-1 text-left leading-tight">
                        <span className="flex items-center gap-1">
                          {c.pinned && <Pin className="size-3 shrink-0 text-muted-foreground/80" aria-label="pinned" />}
                          <span className="truncate">{c.otherUser.displayName || c.otherUser.username}</span>
                        </span>
                        {c.lastMessage && !active && (
                          <span className="block truncate text-[11px] text-muted-foreground/80">
                            {(c.lastMessage.authorId === c.otherUser.id ? '' : 'You: ') +
                              (c.lastMessage.content ?? 'image')}
                          </span>
                        )}
                      </span>
                      {c.unreadCount > 0 && !active && (
                        <span className="shrink-0 min-w-4 h-4 px-1 bg-hyper text-[9px] font-bold text-white grid place-items-center rounded-sm">
                          {c.unreadCount > 99 ? '99+' : c.unreadCount}
                        </span>
                      )}
                      {c.unreadCount === 0 && c.lastMessage && !c.pinned && (
                        <span className="text-[10px] text-muted-foreground shrink-0 opacity-100 transition-opacity duration-150 group-hover:opacity-0">
                          {relativeTime(c.lastMessage.createdAt)}
                        </span>
                      )}
                    </button>
                    <button
                      onClick={() => {
                        sounds.play('lightTick')
                        void pinConversation(c.id)
                      }}
                      className={cn(
                        'absolute right-7 top-1/2 -translate-y-1/2 p-1 rounded-sm bg-app-chat/80 transition-opacity',
                        c.pinned
                          ? 'text-hyper opacity-100'
                          : 'text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                      )}
                      aria-label={c.pinned ? `Unpin ${c.otherUser.username}` : `Pin ${c.otherUser.username}`}
                      title={c.pinned ? 'Unpin conversation' : 'Pin conversation'}
                    >
                      <Pin className="size-3.5" />
                    </button>
                    <button
                      onClick={() => void hideConversation(c.id)}
                      className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-sm text-muted-foreground hover:text-destructive bg-app-chat/80 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                      aria-label={`Close conversation with ${c.otherUser.username}`}
                      title="close conversation"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}

      {/* live voice connection: clicking jumps back to the channel */}
      {voiceConnected && voiceChannel && (
        <div className="px-2 pt-2 shrink-0">
          <div className="bg-app-raise border border-white/10 rounded-sm p-2">
            <button
              onClick={() => {
                void selectServer(voiceConnected.serverId)
                void selectChannel(voiceConnected.channelId)
                onNavigated()
              }}
              className="w-full flex items-center gap-2 text-left"
              aria-label={`return to ${voiceChannel.name}`}
            >
              <Volume2 className="size-3.5 text-hyper shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-semibold tracking-tight">{voiceChannel.name}</span>
                <span className="block truncate text-[10px] text-muted-foreground">{voiceServer?.name}</span>
              </span>
            </button>
            <div className="flex items-center gap-0.5 mt-1.5">
              <button
                onClick={() => {
                  sounds.play('lightTick')
                  toggleVoiceMute()
                }}
                className={cn(
                  'flex-1 p-1.5 rounded-sm grid place-items-center transition-colors',
                  voiceSelf.muted ? 'bg-destructive/20 text-destructive' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                )}
                aria-label={voiceSelf.muted ? 'unmute' : 'mute'}
                title={voiceSelf.muted ? 'unmute' : 'mute'}
              >
                {voiceSelf.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              </button>
              <button
                onClick={() => {
                  sounds.play('lightTick')
                  toggleVoiceDeafen()
                }}
                className={cn(
                  'flex-1 p-1.5 rounded-sm grid place-items-center transition-colors',
                  voiceSelf.deafened ? 'bg-destructive/20 text-destructive' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                )}
                aria-label={voiceSelf.deafened ? 'undeafen' : 'deafen'}
                title={voiceSelf.deafened ? 'undeafen' : 'deafen'}
              >
                {voiceSelf.deafened ? <HeadphoneOff className="size-4" /> : <Headphones className="size-4" />}
              </button>
              <button
                onClick={() => {
                  sounds.play('lightTick')
                  leaveVoice()
                }}
                className="flex-1 p-1.5 rounded-sm grid place-items-center text-destructive hover:bg-destructive/15 transition-colors"
                aria-label="disconnect"
                title="disconnect"
              >
                <PhoneOff className="size-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* user panel: the whole area opens a medium preview of your own
          profile card, with the status dropdown and status quote inline */}
      <div className="h-[56px] bg-app-rail/50 px-2 flex items-center gap-2 border-t border-white/10 shrink-0">
        {me && (
          <>
            <Popover
              open={panelOpen}
              onOpenChange={(next) => {
                setPanelOpen(next)
                if (next) {
                  if (!statusFocused) setStatusDraft(me.customStatus ?? '')
                } else if (statusFocused || statusDraft.trim() !== (me.customStatus ?? '')) {
                  // closing the panel commits whatever was typed: blur can
                  // miss when the input unmounts, so the draft would be lost
                  void saveStatusQuote()
                }
              }}
            >
              <PopoverTrigger asChild>
                <button
                  className="flex items-center gap-2 flex-1 min-w-0 h-full px-1.5 -mx-1.5 rounded-sm hover:bg-white/[0.04] active:bg-white/[0.07] transition-colors text-left"
                  aria-label="your profile and status"
                >
                  <Avatar
                    name={me.username}
                    color={me.avatarColor}
                    url={me.avatarUrl}
                    size="sm"
                    status={connected ? (me.presence === 'invisible' ? 'offline' : me.presence) : 'offline'}
                    showDot
                  />
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="text-[13px] font-semibold truncate">{me.displayName || me.username}</p>
                    <p className="text-[11px] truncate flex items-center gap-1">
                      {me.customStatus ? (
                        <span className="text-foreground/75 truncate">{me.customStatus}</span>
                      ) : (
                        <span className="text-muted-foreground">
                          {presenceLabel(me.presence, connected)}
                        </span>
                      )}
                    </p>
                  </div>
                  <Settings className="size-4 text-muted-foreground shrink-0 opacity-60" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="start"
                className="w-[21rem] p-0 rounded-sm border border-white/10 bg-app-sidebar overflow-hidden shadow-xl"
                aria-describedby={undefined}
              >
                {/* mini profile preview: the same card proportions the other
                    profile views use, so this one finally matches them */}
                <div className="relative">
                  <div
                    className="h-20 relative overflow-hidden"
                    style={
                      !me.bannerUrl && me.bannerColor
                        ? { backgroundColor: me.bannerColor }
                        : !me.bannerUrl
                          ? { backgroundColor: '#1c1c1c' }
                          : undefined
                    }
                  >
                    {me.bannerUrl && (
                      <img src={me.bannerUrl} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />
                    )}
                  </div>
                  <div className="absolute left-3.5 top-[52px] rounded-full ring-2 ring-app-sidebar">
                    <Avatar
                      name={me.username}
                      color={me.avatarColor}
                      url={me.avatarUrl}
                      size="mx"
                      status={connected ? (me.presence === 'invisible' ? 'offline' : me.presence) : 'offline'}
                      showDot
                    />
                  </div>
                  <div className="absolute left-[4.5rem] top-[58px] w-[calc(100%-5.25rem)]">
                    <input
                      value={statusDraft}
                      onChange={(e) => setStatusDraft(e.target.value)}
                      onFocus={() => setStatusFocused(true)}
                      onBlur={() => {
                        setStatusFocused(false)
                        if (statusDraft.trim() !== (me.customStatus ?? '')) void saveStatusQuote()
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveStatusQuote()
                      }}
                      placeholder="what are you thinking?"
                      maxLength={80}
                      aria-label="your status quote"
                      className={cn(
                        'status-bubble border px-2.5 py-1.5 text-[11px] outline-none w-full transition-colors placeholder:text-muted-foreground/60',
                        statusDraft.trim()
                          ? 'border-white/10 bg-app-raise text-foreground/90 focus:border-hyper/50'
                          : 'border-dashed border-white/15 bg-app-raise/60 text-foreground/80 focus:border-hyper/40'
                      )}
                    />
                  </div>
                </div>
                <div className="pt-8 px-3.5 pb-3.5 space-y-2.5">
                  <div>
                    <p className="text-[15px] font-bold tracking-tight truncate">{me.displayName || me.username}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      @{me.username}
                      {me.pronouns && <span className="text-muted-foreground/80"> · {me.pronouns}</span>}
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      sounds.play('lightTick')
                      void openProfile(me.username)
                      setPanelOpen(false)
                    }}
                    className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-sm border border-white/10 text-xs font-semibold hover:border-white/25 hover:bg-app-raise/60 transition-colors"
                  >
                    <UserRound className="size-3.5" />
                    view profile
                  </button>
                  {me.bio && (
                    <p className="text-[11.5px] text-foreground/75 leading-snug line-clamp-2 break-words">{me.bio}</p>
                  )}

                  {/* status dropdown */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-sm border border-white/10 bg-app-raise text-xs hover:border-white/25 transition-colors"
                        aria-label="change your status"
                      >
                        <StatusGlyph status={me.presence} />
                        <span className="flex-1 text-left">
                          {connected ? presenceChoiceLabel(me.presence) : 'reconnecting'}
                        </span>
                        <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="top" align="start" className="w-52 rounded-sm">
                      <DropdownMenuItem
                        onClick={() => {
                          sounds.play('lightTick')
                          void setMyPresence('online')
                        }}
                        className="gap-2 py-1.5"
                      >
                        <span className="size-2.5 rounded-full bg-online shrink-0 status-breathe" />
                        <span className="flex-1">Online</span>
                        {me.presence === 'online' && <span className="text-[10px] text-muted-foreground">current</span>}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          sounds.play('lightTick')
                          void setMyPresence('idle')
                        }}
                        className="gap-2 py-1.5"
                      >
                        <span className="relative size-2.5 rounded-full bg-idle shrink-0">
                          <span className="absolute -top-[30%] -right-[25%] w-[70%] h-[70%] rounded-full bg-popover" />
                        </span>
                        <span className="flex-1">Away / Idle</span>
                        {me.presence === 'idle' && <span className="text-[10px] text-muted-foreground">current</span>}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          sounds.play('lightTick')
                          void setMyPresence('busy')
                        }}
                        className="gap-2 py-1.5"
                      >
                        <span className="relative size-2.5 rounded-full bg-busy shrink-0">
                          <span className="absolute left-1/2 bottom-1/2 w-[1.5px] h-[32%] -translate-x-1/2 bg-white/95 rounded-full" />
                          <span className="absolute top-1/2 left-1/2 w-[32%] h-[1.5px] -translate-y-1/2 bg-white/95 rounded-full" />
                        </span>
                        <span className="flex-1">Busy</span>
                        {me.presence === 'busy' && <span className="text-[10px] text-muted-foreground">current</span>}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          sounds.play('lightTick')
                          void setMyPresence('dnd')
                        }}
                        className="gap-2 py-1.5"
                      >
                        <span className="relative size-2.5 rounded-full bg-dnd shrink-0 grid place-items-center">
                          <span className="w-[55%] h-[2px] rounded-full bg-popover" />
                        </span>
                        <span className="flex-1">do not disturb</span>
                        {me.presence === 'dnd' && <span className="text-[10px] text-muted-foreground">current</span>}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          sounds.play('lightTick')
                          void setMyPresence('invisible')
                        }}
                        className="gap-2 py-1.5"
                      >
                        <span className="size-2.5 rounded-full bg-offline shrink-0" />
                        <span className="flex-1">Invisible</span>
                        {me.presence === 'invisible' && <span className="text-[10px] text-muted-foreground">current</span>}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {/* actions */}
                  <div className="flex gap-1.5 pt-0.5">
                    <button
                      onClick={() => {
                        sounds.play('midTick')
                        setProfileEditorOpen(true)
                        setPanelOpen(false)
                      }}
                      className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-sm border border-white/10 text-xs font-semibold hover:border-white/25 transition-colors"
                    >
                      <Pencil className="size-3.5" />
                      Edit profile
                    </button>
                    <button
                      onClick={() => {
                        sounds.play('midTick')
                        setAccountOpen(true)
                        setPanelOpen(false)
                      }}
                      className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-sm border border-white/10 text-xs font-semibold hover:border-white/25 transition-colors"
                    >
                      <Settings className="size-3.5" />
                      Settings
                    </button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            <button
              onClick={() => void doLogout()}
              className="p-2 rounded-sm text-muted-foreground hover:text-destructive hover:bg-accent transition-colors shrink-0"
              aria-label="sign out"
              title="sign out"
            >
              <LogOut className="size-4" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/** Small presence dot for the status dropdown trigger. */
function StatusGlyph({ status }: { status: UserPresenceChoice }) {
  return (
    <span className="relative size-2.5 shrink-0" aria-hidden="true">
      {status === 'online' && <span className="absolute inset-0 rounded-full bg-online status-breathe" />}
      {status === 'idle' && (
        <>
          <span className="absolute inset-0 rounded-full bg-idle" />
          <span className="absolute -top-[30%] -right-[25%] w-[70%] h-[70%] rounded-full bg-popover" />
        </>
      )}
      {status === 'busy' && (
        <>
          <span className="absolute inset-0 rounded-full bg-busy" />
          <span className="absolute left-1/2 bottom-1/2 w-[1.5px] h-[32%] -translate-x-1/2 bg-white/95 rounded-full" />
          <span className="absolute top-1/2 left-1/2 w-[32%] h-[1.5px] -translate-y-1/2 bg-white/95 rounded-full" />
        </>
      )}
      {status === 'dnd' && (
        <span className="absolute inset-0 rounded-full bg-dnd grid place-items-center">
          <span className="w-[55%] h-[2px] rounded-full bg-popover" />
        </span>
      )}
      {status === 'invisible' && <span className="absolute inset-0 rounded-full bg-offline" />}
    </span>
  )
}

/** Proper-case labels for the status dropdown. */
function presenceChoiceLabel(status: UserPresenceChoice): string {
  switch (status) {
    case 'idle':
      return 'Away / Idle'
    case 'busy':
      return 'Busy'
    case 'dnd':
      return 'Do not disturb'
    case 'invisible':
      return 'Invisible'
    default:
      return 'Online'
  }
}

/** Label under the name: manual status wins over connection state. */
function presenceLabel(presence: UserPresenceChoice | undefined, connected: boolean): string {
  if (!connected) return 'reconnecting'
  switch (presence) {
    case 'idle':
      return 'away'
    case 'busy':
      return 'busy'
    case 'dnd':
      return 'do not disturb'
    case 'invisible':
      return 'invisible'
    default:
      return 'online'
  }
}

/** Pending incoming friend request with accept / decline actions. */
function FriendRequestRow({
  req,
  onAccept,
  onDecline,
}: {
  req: FriendSummary
  onAccept: (id: string) => Promise<void>
  onDecline: (id: string) => Promise<void>
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-app-raise/60 transition-colors">
      <Avatar
        name={req.user.username}
        color={req.user.avatarColor}
        url={req.user.avatarUrl}
        size="sm"
      />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="text-[13px] font-medium truncate text-foreground">
          {req.user.displayName || req.user.username}
        </p>
        <p className="text-[10px] text-muted-foreground flex items-center gap-0.5">
          <Clock className="size-2.5" />
          wants to be friends
        </p>
      </div>
      <button
        onClick={() => {
          sounds.play('midTick')
          void onAccept(req.friendshipId)
        }}
        className="p-1.5 rounded-sm text-hyper hover:bg-hyper/15 transition-colors"
        aria-label={`Accept ${req.user.username}'s friend request`}
        title="accept"
      >
        <UserCheck className="size-4" />
      </button>
      <button
        onClick={() => {
          sounds.play('lightTick')
          void onDecline(req.friendshipId)
        }}
        className="p-1.5 rounded-sm text-muted-foreground hover:text-destructive hover:bg-accent transition-colors"
        aria-label={`Decline ${req.user.username}'s friend request`}
        title="decline"
      >
        <UserX className="size-4" />
      </button>
    </div>
  )
}
