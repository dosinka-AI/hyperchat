'use client'

import { useMemo, useState } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { useChatStore } from '@/lib/client/store'
import { shortTime } from '@/lib/client/format'
import { cn } from '@/lib/utils'
import { ChevronsDown, ChevronsUp } from 'lucide-react'
import { Avatar } from './Avatar'
import { EmojiText } from '@/lib/client/serverEmoji'
import type { PublicUser, ReactionGroup } from '@/lib/types'

/** The chip row under a message. Clicking toggles the reaction; hovering a
 *  chip lists everyone who reacted with it and when (expandable so a long
 *  list can be read in full). */

type UserLike = Pick<PublicUser, 'id' | 'username' | 'displayName' | 'avatarUrl' | 'avatarColor'>

/** Build a userId -> user lookup for the room the chips live in: server
 *  members, conversation participants, the row's author and any author
 *  already rendered in the room cover nearly every reactor in practice. */
function useReactionUserLookup(room: string, author: UserLike | null): (userId: string) => UserLike | null {
  const serverMembers = useChatStore((s) => s.serverMembers)
  const servers = useChatStore((s) => s.servers)
  const conversations = useChatStore((s) => s.conversations)
  const me = useChatStore((s) => s.me)
  const roomMessages = useChatStore((s) => s.rooms[room]?.messages)

  return useMemo(() => {
    const map = new Map<string, UserLike>()
    const add = (u: UserLike | null | undefined) => {
      if (u && !map.has(u.id)) map.set(u.id, u)
    }
    if (room.startsWith('channel:')) {
      const channelId = room.slice('channel:'.length)
      const owner = servers.find((sv) => sv.channels.some((c) => c.id === channelId))
      if (owner) for (const m of serverMembers[owner.id] ?? []) add(m)
    } else if (room.startsWith('conversation:')) {
      const conversationId = room.slice('conversation:'.length)
      const convo = conversations.find((c) => c.id === conversationId)
      if (convo) {
        add(convo.otherUser)
        for (const p of convo.participants ?? []) add(p)
      }
    }
    for (const m of roomMessages ?? []) add(m.author)
    add(author)
    if (me) add(me)
    return (userId: string) => map.get(userId) ?? null
  }, [room, serverMembers, servers, conversations, me, roomMessages, author])
}

/** One chip: the toggle button plus its hover card of reactors. */
function ReactionChip({
  group,
  meId,
  resolve,
  onToggle,
}: {
  group: ReactionGroup
  meId: string | null
  resolve: (userId: string) => UserLike | null
  onToggle: (emoji: string) => void
}) {
  const mine = meId ? group.userIds.includes(meId) : false
  const entries = group.userIds.map((userId, i) => ({
    user: resolve(userId),
    userId,
    at: group.at?.[i] ?? null,
  }))
  return (
    <HoverCard openDelay={260} closeDelay={140}>
      <HoverCardTrigger asChild>
        <button
          onClick={() => onToggle(group.emoji)}
          className={cn(
            // the hit area is a size smaller than it used to be, but the
            // emoji itself never shrank: less accidental taps, same glyph
            'chip-pop flex items-center gap-1.5 h-8 px-2 rounded-sm border transition-all duration-100 hover:scale-[1.06] active:scale-95',
            mine
              ? 'bg-hyper/20 border-hyper/70 text-foreground'
              : 'bg-app-raise/70 border-white/15 text-foreground/90 hover:border-white/35'
          )}
          aria-label={`${group.userIds.length} reacted with ${group.emoji}. ${mine ? 'Click to remove.' : 'Click to react.'}`}
        >
          <EmojiText emoji={group.emoji} className="text-[19px] leading-none" />
          <span className="text-[12.5px] font-semibold tabular-nums">{group.userIds.length}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        className="glass-raise w-56 p-0 rounded-sm border border-white/10 shadow-xl overflow-hidden"
        aria-describedby={undefined}
      >
        <ReactorList entries={entries} meId={meId} emoji={group.emoji} />
      </HoverCardContent>
    </HoverCard>
  )
}

/** The list of who reacted, with an expand toggle for long rosters. */
function ReactorList({
  entries,
  meId,
  emoji,
}: {
  entries: { user: UserLike | null; userId: string; at: string | null }[]
  meId: string | null
  emoji: string
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div>
      <div className="px-2.5 py-1.5 border-b border-white/[0.06] flex items-center gap-2">
        <EmojiText emoji={emoji} className="text-lg leading-none" />
        <span className="text-[10px] font-bold tracking-widest text-muted-foreground lowercase">
          {entries.length} reacted
        </span>
        {entries.length > 7 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="ml-auto p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label={expanded ? 'Collapse the list' : 'Show everybody'}
            title={expanded ? 'show fewer' : 'show all'}
          >
            {expanded ? <ChevronsUp className="size-3" /> : <ChevronsDown className="size-3" />}
          </button>
        )}
      </div>
      <div
        className={cn(
          'overflow-y-auto scroll-thin py-1',
          expanded ? 'max-h-[22rem]' : 'max-h-40'
        )}
      >
        {entries.map((e, i) => (
          <div key={`${e.userId}-${i}`} className="flex items-center gap-2 px-2.5 py-1">
            <Avatar
              name={e.user?.username ?? '?'}
              color={e.user?.avatarColor ?? '#2e2e2e'}
              url={e.user?.avatarUrl}
              size="sm"
            />
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
              {e.user ? (e.user.displayName || e.user.username) : 'member'}
              {e.userId === meId && <span className="ml-1 text-[10px] text-muted-foreground">you</span>}
            </span>
            {e.at && (
              <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{shortTime(e.at)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export function ReactionChips({
  reactions,
  meId,
  room,
  author,
  onToggle,
}: {
  reactions: ReactionGroup[]
  meId: string | null
  room: string
  author: UserLike | null
  onToggle: (emoji: string) => void
}) {
  const resolve = useReactionUserLookup(room, author)
  if (reactions.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 mt-1.5">
      {reactions.map((r) => (
        <ReactionChip key={r.emoji} group={r} meId={meId} resolve={resolve} onToggle={onToggle} />
      ))}
    </div>
  )
}
