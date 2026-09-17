'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { apiClient, ApiError, type SearchResult } from '@/lib/client/api'
import { renderMessageContent } from '@/lib/client/markdown'
import { relativeTime } from '@/lib/client/format'
import { Avatar } from './Avatar'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { Search, Hash, AtSign, Users } from 'lucide-react'

/** two search scopes:
 *  - 'room': the search button in the chat header — searches the DM/group
 *    you are looking at, or the whole active server when you are in one
 *  - 'conversations': the sidebar search — searches every dm and group chat */
export type SearchScope = 'room' | 'conversations'

export function SearchDialog({
  open,
  onOpenChange,
  scope = 'room',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  scope?: SearchScope
}) {
  const me = useChatStore((s) => s.me)
  const servers = useChatStore((s) => s.servers)
  const conversations = useChatStore((s) => s.conversations)
  const activeServerId = useChatStore((s) => s.activeServerId)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const jumpToMessage = useChatStore((s) => s.jumpToMessage)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const inServer = !!activeServerId && !activeConversationId
  const activeConversation = conversations.find((c) => c.id === activeConversationId)

  // resolve a conversation row's display label: group name, or the partner
  const conversationLabel = useMemo(() => {
    const byId = new Map<string, { name: string | null; other: string }>()
    for (const c of conversations) {
      byId.set(c.id, {
        name: c.name,
        other: c.otherUser.displayName || c.otherUser.username,
      })
    }
    return byId
  }, [conversations])

  // the channel-name lookup for server hits
  const channelById = useMemo(() => {
    const byId = new Map<string, { name: string; serverName: string }>()
    for (const s of servers) {
      for (const ch of s.channels) byId.set(ch.id, { name: ch.name, serverName: s.name })
    }
    return byId
  }, [servers])

  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
      setSearched(false)
    }
  }, [open])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = query.trim()
    if (!q || !open) {
      setResults([])
      setSearched(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        let res: { messages: SearchResult[] }
        if (scope === 'conversations') {
          res = await apiClient.searchMessages(q, { conversationsOnly: true })
        } else if (activeConversationId && !inServer) {
          res = await apiClient.searchMessages(q, { conversationId: activeConversationId })
        } else {
          const serverId = servers.some((s) => s.id === activeServerId) ? activeServerId ?? undefined : undefined
          res = await apiClient.searchMessages(q, { serverId })
        }
        setResults(res.messages)
        setSearched(true)
      } catch (err) {
        if (err instanceof ApiError && err.status !== 400) {
          setResults([])
        }
      } finally {
        setLoading(false)
      }
    }, 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, open, scope, activeConversationId, activeServerId, inServer, servers])

  function jump(msg: SearchResult) {
    onOpenChange(false)
    void jumpToMessage(msg.id)
  }

  const placeholder =
    scope === 'conversations'
      ? 'search all your dms and groups'
      : inServer
        ? 'search this server'
        : activeConversation
          ? activeConversation.kind === 'GROUP'
            ? `search ${activeConversation.name ?? 'this group'}`
            : `search ${activeConversation.otherUser.displayName || activeConversation.otherUser.username}`
          : 'search this conversation'

  const hint =
    scope === 'conversations'
      ? 'Find messages across every dm and group chat.'
      : inServer
        ? 'Find messages across this server.'
        : 'Find messages in this conversation.'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0 border-border bg-app-sidebar overflow-hidden rounded-sm top-6 translate-y-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Search messages</DialogTitle>

        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/10">
          <Search className="size-4 text-muted-foreground shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
            aria-label="Search messages"
          />
          {loading && <Spinner />}
        </div>

        <div className="max-h-[60vh] overflow-y-auto scroll-thin">
          {!searched && !loading && (
            <p className="px-4 py-6 text-xs text-muted-foreground text-center">{hint}</p>
          )}
          {searched && !loading && results.length === 0 && (
            <p className="px-4 py-6 text-xs text-muted-foreground text-center">No messages matched.</p>
          )}
          <div className="divide-y divide-white/[0.06]">
            {results.map((msg) => {
              const chan = msg.room.startsWith('channel:')
                ? channelById.get(msg.room.slice('channel:'.length))
                : undefined
              const convo = msg.room.startsWith('conversation:')
                ? conversationLabel.get(msg.room.slice('conversation:'.length))
                : undefined
              return (
                <button
                  key={msg.id}
                  onClick={() => jump(msg)}
                  className="w-full text-left px-4 py-3 hover:bg-app-raise/60 transition-colors flex gap-3"
                >
                  <Avatar name={msg.author.username} color={msg.author.avatarColor} url={msg.author.avatarUrl} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-semibold truncate">{msg.author.displayName || msg.author.username}</span>
                      <span className="text-muted-foreground shrink-0">{relativeTime(msg.createdAt)}</span>
                      {chan && (
                        <span className="text-muted-foreground flex items-center gap-0.5 shrink-0 truncate">
                          <Hash className="size-3" />
                          {chan.name}
                        </span>
                      )}
                      {convo && (
                        <span className="text-muted-foreground flex items-center gap-0.5 shrink-0 truncate">
                          {convo.name ? <Users className="size-3" /> : <AtSign className="size-3" />}
                          {convo.name ?? convo.other}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[13px] text-foreground/85 line-clamp-2 break-words">
                      {msg.content ? renderMessageContent(msg.content, { myUsername: me?.username }) : '[image]'}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
