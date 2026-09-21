'use client'

import { useEffect, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { apiClient } from '@/lib/client/api'
import { sounds } from '@/lib/client/sounds'
import { lastOnlineLabel } from '@/lib/client/format'
import { Avatar } from './Avatar'
import { awayForLabel } from './MessageList'
import { AtSign, Phone, Users, Video, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PublicUser } from '@/lib/types'

/** Medium profile of the person you are DMing, docked to the right side of
 *  the conversation. Banner, avatar, live status, custom status speech
 *  bubble, bio and mutual servers, all at reading distance. */
export function DMProfilePanel({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const me = useChatStore((s) => s.me)
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === conversationId))
  const onlineUserIds = useChatStore((s) => s.onlineUserIds)
  const presenceStatuses = useChatStore((s) => s.presenceStatuses)
  const awaySince = useChatStore((s) => s.awaySince)
  const lastSeen = useChatStore((s) => s.lastSeen)
  const blockedUserIds = useChatStore((s) => s.blockedUserIds)
  const openProfile = useChatStore((s) => s.openProfile)
  const [profile, setProfile] = useState<{ user: PublicUser; mutualServers: string[] } | null>(null)

  const otherUser = conversation?.otherUser
  const username = otherUser?.username

  useEffect(() => {
    if (!username) return
    let alive = true
    void apiClient
      .userProfile(username)
      .then((res) => {
        if (alive) setProfile(res)
      })
      .catch(() => {
        if (alive) setProfile(null)
      })
    return () => {
      alive = false
    }
  }, [username])

  if (!conversation) return null
  // the fetched profile knows the fields the conversation row lacks
  // (pronouns, mutual servers); the row is patched LIVE by the global
  // user:profile broadcast, so its identity fields always win: the panel
  // repaints the moment the other person changes anything, no refetch.
  // plain merge (no hook): the store reference change triggers the render.
  const base = profile?.user ?? conversation.otherUser
  const user =
    conversation.otherUser.id === base.id
      ? {
          ...base,
          username: conversation.otherUser.username,
          displayName: conversation.otherUser.displayName,
          avatarUrl: conversation.otherUser.avatarUrl,
          avatarColor: conversation.otherUser.avatarColor,
          bio: conversation.otherUser.bio,
          customStatus: conversation.otherUser.customStatus,
          bannerColor: conversation.otherUser.bannerColor,
          bannerUrl: conversation.otherUser.bannerUrl,
        }
      : base
  const online = !!onlineUserIds[user.id]
  const status = online ? presenceStatuses[user.id] ?? 'online' : 'offline'
  const awayStamp = online && status === 'idle' ? awaySince[user.id] : undefined
  const lastSeenIso = !online ? lastSeen[user.id] : undefined
  const blocked = !!blockedUserIds[user.id]

  return (
    <aside
      className="fixed inset-y-0 right-0 z-40 w-[85vw] max-w-sm lg:static lg:w-80 lg:max-w-none lg:shrink-0 bg-app-sidebar border-l border-white/10 flex flex-col shadow-2xl lg:shadow-none panel-in pb-[env(safe-area-inset-bottom)]"
      aria-label={`${user.username} profile`}
    >
      {/* profile head: solid-color banner, avatar breaking the bottom edge on
       * its own layer above the border */}
      <div className="relative shrink-0">
        <div
          className="h-28 relative overflow-hidden border-b border-white/10"
          style={
            !user.bannerUrl && user.bannerColor
              ? { backgroundColor: user.bannerColor }
              : !user.bannerUrl
                ? { backgroundColor: '#1c1c1c' }
                : undefined
          }
        >
          {user.bannerUrl && (
            <img src={user.bannerUrl} alt="" className="absolute inset-0 size-full object-cover" draggable={false} />
          )}
        </div>
        <button
          onClick={() => {
            sounds.play('lightTick')
            void openProfile(user.username)
          }}
          className="absolute left-5 top-[72px] z-10 rounded-full ring-4 ring-app-sidebar transition-transform duration-200 hover:scale-[1.03] hover:ring-hyper/60 focus-visible:ring-hyper/60 cursor-pointer"
          aria-label={`Open ${user.username}'s profile`}
          title="open profile"
        >
          <Avatar
            name={user.username}
            color={user.avatarColor}
            url={user.avatarUrl}
            size="xl"
            status={status}
            showDot
          />
        </button>
        {user.customStatus && (
          <div className="absolute left-[6.5rem] top-[84px] z-10 max-w-[calc(100%-7.5rem)] fade-in">
            <div className="status-bubble border border-white/10 bg-app-raise px-2.5 py-1 text-[11px] text-foreground/90 break-words leading-snug whitespace-pre-wrap">
              {user.customStatus}
            </div>
          </div>
        )}
        <button
          onClick={onClose}
          className="absolute top-2 right-2 z-20 size-9 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-black/40 transition-colors"
          aria-label="hide profile panel"
          title="hide profile panel"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="pt-12 px-4 pb-4 overflow-y-auto scroll-thin flex-1">
        <h3 className="text-[15px] font-bold tracking-tight truncate">
          {user.displayName || user.username}
        </h3>
        <p className="text-[11px] text-muted-foreground flex items-center gap-1 truncate mt-0.5">
          <AtSign className="size-3 shrink-0" />
          {user.username}
          {user.pronouns && <span className="text-muted-foreground/80">· {user.pronouns}</span>}
          {me && user.id === me.id && <span className="text-hyper font-semibold">(you)</span>}
        </p>

        <p className="mt-1.5 text-xs flex items-center gap-1.5">
          <span
            className={cn(
              'size-2 rounded-full shrink-0',
              status === 'online' && 'bg-online',
              status === 'idle' && 'bg-idle',
              status === 'busy' && 'bg-busy',
              status === 'dnd' && 'bg-dnd',
              status === 'offline' && 'bg-offline'
            )}
            aria-hidden="true"
          />
          <span
            className={cn(
              'font-semibold',
              status === 'online' && 'text-online',
              status === 'idle' && 'text-idle',
              status === 'busy' && 'text-busy',
              status === 'dnd' && 'text-dnd',
              status === 'offline' && 'text-muted-foreground'
            )}
          >
            {status === 'idle'
              ? 'Away'
              : status === 'busy'
                ? 'Busy'
                : status === 'dnd'
                  ? 'Do not disturb'
                  : status === 'online'
                    ? 'Online'
                    : 'Offline'}
          </span>
          {awayStamp && <span className="text-muted-foreground">{awayForLabel(awayStamp)}</span>}
          {!online && lastSeenIso && (
            <span className="text-muted-foreground truncate">last online {lastOnlineLabel(lastSeenIso)}</span>
          )}
        </p>

        {/* call row: ring this person straight from their profile */}
        {(!me || user.id !== me.id) && !blocked && (
          <div className="mt-3 flex gap-1.5">
            <button
              onClick={() => {
                sounds.play('lightTick')
                void useChatStore.getState().callUser(user.id)
              }}
              className="flex-1 flex items-center justify-center gap-1.5 h-9 rounded-sm border border-white/10 bg-app-raise text-[13px] font-semibold hover:border-white/30 transition-colors"
              aria-label={`call ${user.username}`}
              title="voice call"
            >
              <Phone className="size-4" />
              call
            </button>
            <button
              onClick={() => {
                sounds.play('lightTick')
                void useChatStore.getState().callUser(user.id, true)
              }}
              className="grid place-items-center size-9 rounded-sm border border-white/10 bg-app-raise hover:border-white/30 transition-colors"
              aria-label={`video call ${user.username}`}
              title="video call"
            >
              <Video className="size-4" />
            </button>
          </div>
        )}

        {user.bio && (
          <p className="mt-3 text-[13px] text-foreground/85 leading-relaxed break-words whitespace-pre-wrap">{user.bio}</p>
        )}

        <div className="mt-4">
          <p className="text-[10px] font-bold tracking-widest text-muted-foreground flex items-center gap-1">
            <Users className="size-3" />
            mutual servers
          </p>
          <p className="text-xs text-foreground/80 mt-1">
            {profile === null ? '…' : profile.mutualServers.length > 0 ? profile.mutualServers.join(', ') : 'none'}
          </p>
        </div>

        {blocked && (
          <p className="mt-4 text-xs text-destructive border border-destructive/30 bg-destructive/5 rounded-sm px-2.5 py-2">
            You blocked this user.
          </p>
        )}
      </div>
    </aside>
  )
}
