'use client'

import { useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { sounds } from '@/lib/client/sounds'
import { ApiError } from '@/lib/client/api'
import { Avatar } from './Avatar'
import { MiniProfilePopover } from './MiniProfile'
import { awayForLabel } from './MessageList'
import { lastOnlineLabel } from '@/lib/client/format'
import { openContextMenu } from './ContextMenu'
import { callMenuItems } from './callMenu'
import { Crown, MessageSquare, Minus, Plus, UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/hooks/use-toast'
import type { VisiblePresence } from '@/lib/types'

type Member = {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  avatarColor: string
}

/** Server-like member column for group conversations: participants with
 *  presence and an owner crown. The owner can right-click any non-owner row
 *  to kick, and owns the limit stepper in the footer (5 <-> 50). */
export function GroupMemberList({
  conversationId,
  onOpenProfile,
}: {
  conversationId: string
  onOpenProfile?: () => void
}) {
  const me = useChatStore((s) => s.me)
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === conversationId))
  const onlineUserIds = useChatStore((s) => s.onlineUserIds)
  const presenceStatuses = useChatStore((s) => s.presenceStatuses)
  const awaySince = useChatStore((s) => s.awaySince)
  const lastSeen = useChatStore((s) => s.lastSeen)
  const openProfile = useChatStore((s) => s.openProfile)
  const openDM = useChatStore((s) => s.openDM)
  const kickGroupMember = useChatStore((s) => s.kickGroupMember)
  const setGroupLimit = useChatStore((s) => s.setGroupLimit)
  const { toast } = useToast()
  const [limitBusy, setLimitBusy] = useState(false)
  // medium mini profile card: one avatar click, one card at a time (the
  // same popover the server member column uses, so bios and banners open
  // from group lists too)
  const [mini, setMini] = useState<{ username: string; rect: DOMRect } | null>(null)

  if (!conversation || conversation.kind !== 'GROUP') return null

  const members: Member[] = conversation.participants ?? []
  const ownerId = conversation.ownerId ?? null
  const iAmOwner = !!me && ownerId === me.id
  const cap = conversation.limitRaised ? 50 : 5

  const statusOf = (id: string): VisiblePresence =>
    onlineUserIds[id] ? (presenceStatuses[id] as VisiblePresence) ?? 'online' : 'offline'

  // owner pinned first, then whoever is online, then offline
  const sorted = [...members].sort((a, b) => {
    const rank = (m: Member) => (m.id === ownerId ? 0 : onlineUserIds[m.id] ? 1 : 2)
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    return (a.displayName || a.username).localeCompare(b.displayName || b.username)
  })

  const viewProfile = (username: string) => {
    sounds.play('lightTick')
    void openProfile(username)
    onOpenProfile?.()
  }

  function memberContext(e: React.MouseEvent, member: Member) {
    openContextMenu(
      e,
      [
        { kind: 'item', label: 'profile', icon: UserRound, onSelect: () => viewProfile(member.username) },
        ...(member.id !== me?.id
          ? [
              ...callMenuItems(member),
              {
                kind: 'item' as const,
                label: 'message',
                icon: MessageSquare,
                onSelect: () => {
                  sounds.play('midTick')
                  void openDM(member.id)
                  onOpenProfile?.()
                },
              },
              ...(iAmOwner && member.id !== ownerId
                ? [
                    {
                      kind: 'item' as const,
                      label: 'kick',
                      danger: true,
                      onSelect: () => {
                        sounds.play('midTick')
                        void kickGroupMember(conversationId, member.id)
                      },
                    },
                  ]
                : []),
            ]
          : []),
      ],
      { title: member.displayName || member.username, subtitle: `@${member.username}` }
    )
  }

  /** Avatar click: the medium profile card anchored to the avatar; a second
   *  click on the same avatar toggles it closed. */
  function openMini(e: React.MouseEvent, member: Member) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMini((cur) => (cur && cur.username === member.username ? null : { username: member.username, rect }))
  }

  async function stepLimit(raised: boolean) {
    if (limitBusy) return
    if (!raised && members.length > 5) {
      sounds.play('error')
      toast({ title: 'too many members' })
      return
    }
    setLimitBusy(true)
    try {
      await setGroupLimit(conversationId, raised)
      sounds.play('lightTick')
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not change the limit',
        description: err instanceof ApiError ? err.message : 'Try again.',
      })
    } finally {
      setLimitBusy(false)
    }
  }

  return (
    <aside
      className="w-full h-full bg-app-sidebar border-l border-white/10 flex flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] md:pt-0 md:pb-0"
      aria-label="group members"
    >
      <div className="flex-1 overflow-y-auto scroll-thin px-2 py-3">
        <div className="px-2 pb-2 text-[11px] font-bold tracking-widest truncate">
          members
          <span className="text-muted-foreground/70 font-semibold"> · {members.length}</span>
        </div>
        <div className="space-y-0.5">
          {sorted.map((m) => {
            const status = statusOf(m.id)
            const awayStamp = status === 'idle' ? awaySince[m.id] : undefined
            const lastSeenIso = status === 'offline' ? lastSeen[m.id] : undefined
            return (
              <button
                key={m.id}
                onClick={() => viewProfile(m.username)}
                onContextMenu={(e) => memberContext(e, m)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-2 py-1.5 rounded-sm text-sm transition-colors text-left',
                  status !== 'offline'
                    ? 'text-foreground/90 hover:bg-app-raise/60 hover:text-foreground'
                    : 'text-muted-foreground/70 hover:bg-app-raise/60 hover:text-foreground/80'
                )}
                title={`View ${m.username}'s profile`}
              >
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation()
                    openMini(e, m)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      e.stopPropagation()
                      openMini(e as unknown as React.MouseEvent, m)
                    }
                  }}
                  className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-hyper/70 cursor-pointer"
                  aria-label={`${m.username}: open mini profile`}
                >
                  <Avatar
                    name={m.username}
                    color={m.avatarColor}
                    url={m.avatarUrl}
                    size="sm"
                    status={status}
                    showDot
                    className={mini?.username === m.username ? 'ring-2 ring-hyper/70 rounded-full' : undefined}
                  />
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="flex items-center gap-1.5">
                    <span className={cn('truncate font-medium', status === 'idle' && 'opacity-75')}>
                      {m.displayName || m.username}
                    </span>
                    {m.id === ownerId && (
                      <Crown className="size-3.5 text-white/80 shrink-0" aria-label="group owner" />
                    )}
                    {m.id === me?.id && <span className="text-[10px] text-muted-foreground shrink-0">you</span>}
                  </span>
                  {status === 'idle' && awayStamp && (
                    <span className="block truncate text-xs text-idle/90 mt-0.5">away {awayForLabel(awayStamp)}</span>
                  )}
                  {status === 'offline' && lastSeenIso && (
                    <span className="block truncate text-xs text-muted-foreground/70 mt-0.5">
                      last online {lastOnlineLabel(lastSeenIso)}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
        {members.length === 0 && (
          <p className="px-2 py-4 text-xs text-muted-foreground">no members to show yet.</p>
        )}
      </div>

      {iAmOwner && (
        <div className="px-2 py-2 border-t border-white/10 flex items-center gap-1">
          <span className="flex-1 px-1 text-[11px] font-bold tracking-widest text-muted-foreground">
            limit
          </span>
          <button
            onClick={() => void stepLimit(false)}
            disabled={limitBusy || cap <= 5}
            className="size-8 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-30"
            aria-label="lower the member limit"
            title="lower the member limit"
          >
            <Minus className="size-3.5" />
          </button>
          <span className="w-7 text-center text-xs font-semibold tabular-nums" aria-live="polite">
            {cap}
          </span>
          <button
            onClick={() => void stepLimit(true)}
            disabled={limitBusy || cap >= 50}
            className="size-8 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-30"
            aria-label="raise the member limit"
            title="raise the member limit"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
      )}
      {mini && (
        <MiniProfilePopover
          key={mini.username}
          username={mini.username}
          anchorRect={mini.rect}
          onClose={() => setMini(null)}
        />
      )}
    </aside>
  )
}
