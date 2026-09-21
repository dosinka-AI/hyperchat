'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/lib/client/store'
import { sounds } from '@/lib/client/sounds'
import { HyperionMark } from '@/components/hyperion/Logo'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Crown, Plus, Compass, Shield, Users } from 'lucide-react'
import { Avatar } from './Avatar'
import { ServerBrowserDialog } from './ServerBrowserDialog'

type ServerRailProps = {
  onAddServer: () => void
  onNavigated: () => void
}

export function ServerRail({ onAddServer, onNavigated }: ServerRailProps) {
  const servers = useChatStore((s) => s.servers)
  const activeServerId = useChatStore((s) => s.activeServerId)
  const me = useChatStore((s) => s.me)
  const channelUnread = useChatStore((s) => s.channelUnread)
  const channelMentions = useChatStore((s) => s.channelMentions)
  const conversations = useChatStore((s) => s.conversations)
  const incomingRequests = useChatStore((s) => s.incomingRequests)
  const selectHome = useChatStore((s) => s.selectHome)
  const selectServer = useChatStore((s) => s.selectServer)
  const openFriendsView = useChatStore((s) => s.openFriendsView)
  const friendsViewOpen = useChatStore((s) => s.friendsViewOpen)

  const [discoverOpen, setDiscoverOpen] = useState(false)
  const setAdminPanelOpen = useChatStore((s) => s.setAdminPanelOpen)

  const homeActive = activeServerId === null && !friendsViewOpen
  const dmUnread = conversations.reduce((acc, c) => acc + c.unreadCount, 0)
  const homeBadge = dmUnread + incomingRequests.length

  // total unread and mentions across a server's channels
  const unreadByServer: Record<string, number> = {}
  const mentionsByServer: Record<string, number> = {}
  for (const server of servers) {
    let total = 0
    let mentions = 0
    for (const channel of server.channels) {
      total += channelUnread[channel.id] ?? 0
      mentions += channelMentions[channel.id] ?? 0
    }
    if (total > 0) unreadByServer[server.id] = total
    if (mentions > 0) mentionsByServer[server.id] = mentions
  }

  return (
    <nav
      className="w-16 md:w-[72px] bg-app-rail border-r border-white/10 flex flex-col items-center gap-2 py-3 shrink-0 overflow-y-auto scroll-thin"
      aria-label="Servers"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => {
              selectHome()
              onNavigated()
            }}
            className={cn(
              'relative w-11 h-11 md:w-12 md:h-12 rounded-sm grid place-items-center transition-colors',
              homeActive ? 'bg-app-raise' : 'bg-transparent hover:bg-app-raise/70'
            )}
            aria-label="Direct messages, home"
            aria-current={homeActive ? 'page' : undefined}
          >
            {homeActive && <span className="rail-pill absolute -left-[10px] w-[3px] h-7 bg-white rounded-full" />}
            <HyperionMark className="w-7 h-7 md:w-8 md:h-8 rounded-sm" />
            {homeBadge > 0 && !homeActive && (
              <span className="absolute -bottom-1 -right-1 min-w-4 h-4 px-1 bg-hyper text-[9px] font-bold text-white grid place-items-center rounded-sm">
                {homeBadge > 99 ? '99+' : homeBadge}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Direct messages</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => {
              sounds.play('lightTick')
              openFriendsView()
              onNavigated()
            }}
            className={cn(
              'relative w-11 h-11 md:w-12 md:h-12 rounded-sm grid place-items-center transition-colors',
              friendsViewOpen
                ? 'bg-app-raise text-foreground'
                : 'text-muted-foreground hover:bg-app-raise/70 hover:text-foreground'
            )}
            aria-label="Friends"
            aria-current={friendsViewOpen ? 'page' : undefined}
          >
            {friendsViewOpen && <span className="rail-pill absolute -left-[10px] w-[3px] h-7 bg-white rounded-full" />}
            <Users className="size-5 md:size-6" />
            {incomingRequests.length > 0 && !friendsViewOpen && (
              <span className="absolute -bottom-1 -right-1 min-w-4 h-4 px-1 bg-hyper text-[9px] font-bold text-white grid place-items-center rounded-sm">
                {incomingRequests.length}
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Friends</TooltipContent>
      </Tooltip>

      <div className="w-8 h-px bg-white/10 my-1" role="separator" />

      {servers.map((server) => {
        const active = server.id === activeServerId
        const unread = unreadByServer[server.id] ?? 0
        const mentions = mentionsByServer[server.id] ?? 0
        const isMine = server.myRole === 'OWNER'
        return (
          <Tooltip key={server.id}>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  void selectServer(server.id)
                  onNavigated()
                }}
                className={cn(
                  'relative w-11 h-11 md:w-12 md:h-12 rounded-sm grid place-items-center transition-colors',
                  active ? 'bg-app-raise' : 'hover:bg-app-raise/60'
                )}
                aria-label={`Server ${server.name}`}
                aria-current={active ? 'page' : undefined}
              >
                {active && <span className="rail-pill absolute -left-[10px] w-[3px] h-7 bg-white rounded-full" />}
                {server.iconUrl ? (
                   
                  <img src={server.iconUrl} alt="" className="size-8 md:size-9 rounded-sm object-cover" draggable={false} />
                ) : (
                  <span className="text-[13px] font-bold tracking-tight truncate max-w-full px-1">
                    {server.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase()}
                  </span>
                )}
                {isMine && (
                  <span className="absolute -top-1 -right-1 bg-app-chat rounded-sm p-0.5" title="your server">
                    <Crown className="size-3 text-white/80" />
                  </span>
                )}
                {(unread > 0 && (!active || mentions > 0)) && (
                  <span
                    className={cn(
                      'absolute -bottom-1 -right-1 min-w-4 h-4 px-1 text-[9px] font-bold grid place-items-center rounded-sm',
                      mentions > 0
                        ? 'bg-hyper text-white mention-badge'
                        : 'bg-white text-black'
                    )}
                  >
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{server.name}</TooltipContent>
          </Tooltip>
        )
      })}

      {me?.siteAdmin && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => {
                sounds.play('lightTick')
                setAdminPanelOpen(true)
              }}
              className="w-11 h-11 md:w-12 md:h-12 rounded-sm border border-dashed border-white/25 grid place-items-center text-muted-foreground hover:text-foreground hover:border-white/50 transition-colors"
              aria-label="Site admin"
              title="admin"
            >
              <Shield className="size-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Admin</TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => {
              sounds.play('lightTick')
              setDiscoverOpen(true)
            }}
            className="w-11 h-11 md:w-12 md:h-12 rounded-sm border border-dashed border-white/25 grid place-items-center text-muted-foreground hover:text-foreground hover:border-white/50 transition-colors"
            aria-label="Discover public servers"
            title="discover public servers"
          >
            <Compass className="size-5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Discover</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={onAddServer}
            className="w-11 h-11 md:w-12 md:h-12 rounded-sm border border-dashed border-white/25 grid place-items-center text-muted-foreground hover:text-foreground hover:border-white/50 transition-colors"
            aria-label="Add a server"
          >
            <Plus className="size-5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Add a server</TooltipContent>
      </Tooltip>

      <ServerBrowserDialog open={discoverOpen} onOpenChange={setDiscoverOpen} />
    </nav>
  )
}
