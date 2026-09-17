'use client'

import { useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { sounds } from '@/lib/client/sounds'
import { Avatar } from './Avatar'
import { MiniProfilePopover } from './MiniProfile'
import { AtSign, ChevronDown, ChevronRight, Crown, Shield, ShieldCheck, Clock, MessageSquare, UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RoleSummary, ServerMemberSummary, VisiblePresence } from '@/lib/types'
import { openContextMenu } from './ContextMenu'
import { awayForLabel } from './MessageList'
import { lastOnlineLabel } from '@/lib/client/format'

function timeoutLeftOf(timeoutUntil: string | null): number {
  if (!timeoutUntil) return 0
  return Math.max(0, new Date(timeoutUntil).getTime() - Date.now())
}

function formatTimeout(ms: number): string {
  const mins = Math.ceil(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.ceil(mins / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.ceil(hours / 24)}d`
}

function MemberRow({
  member,
  status,
  awayStamp,
  lastSeenStamp,
  meId,
  onOpenProfile,
  onContext,
  onAvatarClick,
  miniOpen,
}: {
  member: ServerMemberSummary
  status: VisiblePresence
  awayStamp?: number
  lastSeenStamp?: string
  meId: string | null
  onOpenProfile: (username: string) => void
  onContext: (e: React.MouseEvent, member: ServerMemberSummary) => void
  onAvatarClick: (e: React.MouseEvent, member: ServerMemberSummary) => void
  miniOpen: boolean
}) {
  const isSelf = member.id === meId
  const timedOut = timeoutLeftOf(member.timeoutUntil) > 0
  const nameColor =
    member.role === 'OWNER' ? '#ffffff' : member.roleColor ?? undefined
  const online = status !== 'offline'
  return (
    <button
      onClick={() => onOpenProfile(member.username)}
      onContextMenu={(e) => onContext(e, member)}
      className={cn(
        'w-full flex items-center gap-2.5 px-2 py-1.5 rounded-sm text-sm transition-colors text-left',
        online
          ? 'text-foreground/90 hover:bg-app-raise/60 hover:text-foreground'
          : 'text-muted-foreground/70 hover:bg-app-raise/60 hover:text-foreground/80'
      )}
      title={`View ${member.username}'s profile`}
    >
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation()
          onAvatarClick(e, member)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            onAvatarClick(e as unknown as React.MouseEvent, member)
          }
        }}
        className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-hyper/70 cursor-pointer"
        aria-label={`${member.username}: open mini profile`}
      >
        <Avatar
          name={member.username}
          color={member.avatarColor}
          url={member.avatarUrl}
          size="sm"
          status={status}
          showDot
          className={miniOpen ? 'ring-2 ring-hyper/70 rounded-full' : undefined}
        />
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="flex items-center gap-1.5">
          <span
            className={cn('truncate font-medium', status === 'idle' && 'opacity-75')}
            style={nameColor ? { color: nameColor } : undefined}
          >
            {member.nickname || member.displayName || member.username}
          </span>
          {member.role === 'OWNER' && <Crown className="size-3.5 text-white/80 shrink-0" aria-label="server owner" />}
          {member.role === 'ADMIN' && <Shield className="size-3.5 text-muted-foreground shrink-0" aria-label="server admin" />}
          {member.siteAdmin && <ShieldCheck className="size-3.5 text-hyper shrink-0" aria-label="HyperChat admin" />}
          {timedOut && (
            <span
              className="flex items-center gap-0.5 text-[10px] text-destructive shrink-0"
              title={`Timed out, ${formatTimeout(timeoutLeftOf(member.timeoutUntil))} left`}
            >
              <Clock className="size-3" />
              {formatTimeout(timeoutLeftOf(member.timeoutUntil))}
            </span>
          )}
          {isSelf && <span className="text-[10px] text-muted-foreground shrink-0">you</span>}
        </span>
        {online && member.customStatus && (
          <span className="block text-xs text-foreground/75 mt-0.5 whitespace-pre-wrap break-words line-clamp-2">
            {member.customStatus}
          </span>
        )}
        {online && !member.customStatus && awayStamp && (
          <span className="block truncate text-xs text-idle/90 mt-0.5">away {awayForLabel(awayStamp)}</span>
        )}
        {!online && lastSeenStamp && (
          <span className="block truncate text-xs text-muted-foreground/80 mt-0.5">
            last online {lastOnlineLabel(lastSeenStamp)}
          </span>
        )}
      </span>
    </button>
  )
}

type Section = { key: string; title: string; color?: string; members: ServerMemberSummary[]; dimmed?: boolean }

/** Rows rendered per section before the "Show all" expander kicks in. */
const SECTION_LIMIT = 60

export function MemberList({ onOpenProfile }: { onOpenProfile?: () => void }) {
  const me = useChatStore((s) => s.me)
  const activeServerId = useChatStore((s) => s.activeServerId)
  const serverMembers = useChatStore((s) => s.serverMembers)
  const serverRoles = useChatStore((s) => s.serverRoles)
  const onlineUserIds = useChatStore((s) => s.onlineUserIds)
  const presenceStatuses = useChatStore((s) => s.presenceStatuses)
  const awaySince = useChatStore((s) => s.awaySince)
  const lastSeen = useChatStore((s) => s.lastSeen)
  const openProfile = useChatStore((s) => s.openProfile)
  const openDM = useChatStore((s) => s.openDM)
  const drafts = useChatStore((s) => s.drafts)
  const setDraft = useChatStore((s) => s.setDraft)

  // medium mini profile card: one avatar click, one card at a time
  const [mini, setMini] = useState<{ username: string; rect: DOMRect } | null>(null)

  // windowing state: per-section "Show all" + the offline collapse
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [offlineOpen, setOfflineOpen] = useState(false)
  const [prevServerId, setPrevServerId] = useState(activeServerId)
  if (prevServerId !== activeServerId) {
    setPrevServerId(activeServerId)
    setExpanded({})
    setOfflineOpen(false)
  }

  const members: ServerMemberSummary[] = activeServerId
    ? (serverMembers[activeServerId] as ServerMemberSummary[]) ?? []
    : []
  const roles: RoleSummary[] = activeServerId ? (serverRoles[activeServerId] as RoleSummary[]) ?? [] : []

  const statusOf = (id: string): VisiblePresence =>
    onlineUserIds[id] ? (presenceStatuses[id] as VisiblePresence) ?? 'online' : 'offline'
  const viewProfile = (username: string) => {
    sounds.play('lightTick')
    void openProfile(username)
    onOpenProfile?.()
  }

  /** Avatar click: the medium profile card, anchored to the avatar. A second
   *  click on the same avatar (or the avatar inside the card) goes further. */
  function openMini(e: React.MouseEvent, member: ServerMemberSummary) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMini((cur) =>
      cur && cur.username === member.username ? null : { username: member.username, rect }
    )
  }

  /** Right-click on a member: profile, DM, or pre-fill a mention in the composer. */
  function memberContext(e: React.MouseEvent, member: ServerMemberSummary) {
    const roomKey = useChatStore
      .getState()
    void roomKey
    const state = useChatStore.getState()
    const room = state.activeChannelId ? `channel:${state.activeChannelId}` : null
    openContextMenu(
      e,
      [
        { kind: 'item', label: 'view profile', icon: UserRound, onSelect: () => viewProfile(member.username) },
        ...(member.id !== me?.id
          ? [
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
              ...(room
                ? [
                    {
                      kind: 'item' as const,
                      label: `Mention @${member.username}`,
                      icon: AtSign,
                      onSelect: () => {
                        // seed the live composer: update the store draft AND
                        // the textarea itself (drafts only restore on room
                        // switch, so the box needs a direct nudge)
                        const ta = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="message input"]')
                        const current = ta?.value ?? drafts[room] ?? ''
                        const seed = current
                          ? `${current.replace(/\s+$/, '')} @${member.username} `
                          : `@${member.username} `
                        setDraft(room, seed)
                        if (ta) {
                          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
                          setter?.call(ta, seed)
                          ta.dispatchEvent(new Event('input', { bubbles: true }))
                          ta.focus()
                          const pos = seed.length
                          requestAnimationFrame(() => ta.setSelectionRange(pos, pos))
                        }
                        sounds.play('lightTick')
                      },
                    },
                  ]
                : []),
            ]
          : []),
      ],
      { title: member.nickname || member.displayName || member.username, subtitle: `@${member.username}` }
    )
  }

  // build sections: owner, each custom role (top position first), then plain online/offline
  const sections: Section[] = []
  const owner = members.filter((m) => m.role === 'OWNER')
  if (owner.length > 0) sections.push({ key: 'owner', title: 'owner', members: owner })

  const byRoleId = new Map<string, ServerMemberSummary[]>()
  const plainMembers: ServerMemberSummary[] = []
  for (const m of members) {
    if (m.role === 'OWNER') continue
    if (m.roleId) {
      const list = byRoleId.get(m.roleId) ?? []
      list.push(m)
      byRoleId.set(m.roleId, list)
    } else {
      plainMembers.push(m)
    }
  }

  for (const role of [...roles].sort((a, b) => b.position - a.position)) {
    const list = byRoleId.get(role.id) ?? []
    if (list.length === 0) continue
    sections.push({ key: role.id, title: role.name.toLowerCase(), color: role.color, members: list })
    byRoleId.delete(role.id)
  }
  // members holding a role that was deleted mid-session fall back to the plain list
  for (const list of byRoleId.values()) plainMembers.push(...list)

  const online = plainMembers.filter((m) => !!onlineUserIds[m.id])
  const offline = plainMembers.filter((m) => !onlineUserIds[m.id])
  if (online.length > 0) sections.push({ key: 'online', title: 'online', members: online })
  if (offline.length > 0) sections.push({ key: 'offline', title: 'offline', members: offline, dimmed: true })

  const onlineCount = members.filter((m) => !!onlineUserIds[m.id]).length
  // big servers: the offline block starts collapsed behind its header
  const offlineCollapsible = members.length > 30

  return (
    <aside
      className="w-full h-full bg-app-sidebar border-l border-white/10 flex flex-col"
      aria-label="server members"
    >
      <div className="flex-1 overflow-y-auto scroll-thin px-2 py-3">
        {sections.map((section) => {
          const collapsible = offlineCollapsible && section.key === 'offline'
          const sectionOpen = !collapsible || offlineOpen
          const shown = expanded[section.key] ? section.members : section.members.slice(0, SECTION_LIMIT)
          return (
            <div key={section.key} className="pt-4 first:pt-0">
              {collapsible ? (
                <button
                  onClick={() => {
                    sounds.play('lightTick')
                    setOfflineOpen(!offlineOpen)
                  }}
                  className="w-full flex items-center gap-1 px-2 pb-2 text-[11px] font-bold tracking-widest truncate text-left hover:text-foreground/80 transition-colors"
                  style={section.color ? { color: section.color } : undefined}
                  aria-expanded={offlineOpen}
                >
                  {offlineOpen ? (
                    <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
                  )}
                  <span className="truncate">{section.title}</span>
                  <span className="text-muted-foreground/70 font-semibold shrink-0"> · {section.members.length}</span>
                </button>
              ) : (
                <div
                  className="px-2 pb-2 text-[11px] font-bold tracking-widest truncate"
                  style={section.color ? { color: section.color } : undefined}
                >
                  {section.title}
                  <span className="text-muted-foreground/70 font-semibold"> · {section.members.length}</span>
                </div>
              )}
              {sectionOpen && (
                <div className="space-y-0.5">
                  {shown.map((m) => (
                    <div key={m.id} className={cn(section.dimmed && 'opacity-60')}>
                      <MemberRow
                        member={m}
                        status={statusOf(m.id)}
                        awayStamp={statusOf(m.id) === 'idle' ? awaySince[m.id] : undefined}
                        lastSeenStamp={!onlineUserIds[m.id] ? lastSeen[m.id] : undefined}
                        meId={me?.id ?? null}
                        onOpenProfile={viewProfile}
                        onContext={memberContext}
                        onAvatarClick={openMini}
                        miniOpen={mini?.username === m.username}
                      />
                    </div>
                  ))}
                  {section.members.length > shown.length && (
                    <button
                      className="w-full py-1 text-xs text-hyper hover:underline"
                      onClick={() => {
                        sounds.play('lightTick')
                        setExpanded((s) => ({ ...s, [section.key]: true }))
                      }}
                    >
                      Show all {section.members.length}
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {members.length === 0 && (
          <div className="px-2 py-4 text-xs text-muted-foreground leading-relaxed">
            No members to show yet. Share the invite code from the server menu.
          </div>
        )}

        {members.length > 0 && onlineCount === 0 && (
          <p className="px-2 py-1 text-xs text-muted-foreground">nobody else is here right now.</p>
        )}
      </div>

      <div className="px-3 py-3 border-t border-white/10 text-[11px] text-muted-foreground flex items-center gap-1.5">
        <AtSign className="size-3" />
        Click a member for their profile. Right-click for more.
      </div>

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
