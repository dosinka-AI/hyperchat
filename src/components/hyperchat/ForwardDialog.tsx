'use client'

import { useMemo, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { sounds } from '@/lib/client/sounds'
import { useToast } from '@/hooks/use-toast'
import { Hash, Send, Search, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from './Avatar'

/** Forward picker: every channel you can post in plus every DM and group,
 *  one query, one click. The copy carries "forwarded from @author". */
export function ForwardDialog() {
  const forwardTarget = useChatStore((s) => s.forwardTarget)
  const setForwardTarget = useChatStore((s) => s.setForwardTarget)
  const forwardMessage = useChatStore((s) => s.forwardMessage)
  const servers = useChatStore((s) => s.servers)
  const conversations = useChatStore((s) => s.conversations)
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const { toast } = useToast()

  const [query, setQuery] = useState('')
  const [sendingTo, setSendingTo] = useState<string | null>(null)

  const open = !!forwardTarget

  // reset the query each time the dialog opens
  const [seed, setSeed] = useState<string | null>(null)
  if (open && seed !== forwardTarget!.id) {
    setSeed(forwardTarget!.id)
    setQuery('')
  } else if (!open && seed !== null) {
    setSeed(null)
  }

  const q = query.trim().toLowerCase()

  type Entry =
    | { key: string; kind: 'channel'; serverName: string; channelId: string; name: string; private: boolean }
    | { key: string; kind: 'conversation'; conversationId: string; label: string; avatar: { name: string; color: string; url: string | null } | null }

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = []
    for (const s of servers) {
      for (const c of s.channels) {
        // locked channels accept forwards only from moderators; keep the
        // list honest by showing the lock and letting the server reject
        if (q && !(`${s.name} ${c.name}`.toLowerCase().includes(q))) continue
        list.push({ key: `c-${c.id}`, kind: 'channel', serverName: s.name, channelId: c.id, name: c.name, private: c.private })
      }
    }
    for (const c of conversations) {
      if (c.hidden) continue
      const label = c.kind === 'GROUP' ? (c.name ?? 'group') : (c.otherUser.displayName || c.otherUser.username)
      if (q && !`${label}`.toLowerCase().includes(q)) continue
      list.push({
        key: `v-${c.id}`,
        kind: 'conversation',
        conversationId: c.id,
        label,
        avatar: c.kind === 'GROUP'
          ? null
          : { name: c.otherUser.username, color: c.otherUser.avatarColor, url: c.otherUser.avatarUrl },
      })
    }
    return list
  }, [servers, conversations, q])

  async function pick(entry: Entry) {
    if (!forwardTarget || sendingTo) return
    setSendingTo(entry.key)
    sounds.play('lightTick')
    try {
      // instant send voice at click time: forwarding is fire-and-forget
      sounds.play('send')
      if (entry.kind === 'channel') {
        await forwardMessage(forwardTarget.id, 'channel', entry.channelId)
      } else {
        await forwardMessage(forwardTarget.id, 'conversation', entry.conversationId)
      }
      toast({ title: 'forwarded' })
      setForwardTarget(null)
    } catch {
      sounds.play('error')
      toast({ title: 'could not forward', description: 'try again.' })
    } finally {
      setSendingTo(null)
    }
    void activeChannelId
    void activeConversationId
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && setForwardTarget(null)}>
      <DialogContent className="sm:max-w-md w-[92vw] rounded-sm p-0 gap-0 overflow-hidden top-6 translate-y-0">
        <DialogTitle className="sr-only">forward message</DialogTitle>
        <div className="px-4 pt-4 pb-3">
          <h2 className="text-base font-bold tracking-tight">forward to</h2>
          {forwardTarget?.content && (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-1">{forwardTarget.content}</p>
          )}
        </div>
        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 bg-app-raise border border-white/10 rounded-sm px-2.5 py-2 focus-within:border-white/25 transition-colors">
            <Search className="size-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search"
              className="flex-1 bg-transparent outline-none text-sm"
              aria-label="search destinations"
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto scroll-thin px-2 pb-3">
          {entries.length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground text-center">no destinations</p>
          ) : (
            entries.map((e) => (
              <button
                key={e.key}
                onClick={() => void pick(e)}
                disabled={sendingTo !== null}
                className={cn(
                  'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-sm text-left transition-colors hover:bg-accent disabled:opacity-50',
                  sendingTo === e.key && 'bg-accent'
                )}
              >
                {e.kind === 'channel' ? (
                  e.private ? (
                    <Lock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <Hash className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )
                ) : e.avatar ? (
                  <Avatar name={e.avatar.name} color={e.avatar.color} url={e.avatar.url} size="sm" />
                ) : (
                  <Send className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold truncate">
                    {e.kind === 'channel' ? e.name : e.label}
                  </span>
                  <span className="block text-[10px] text-muted-foreground truncate">
                    {e.kind === 'channel' ? e.serverName : e.kind === 'conversation' ? 'direct' : ''}
                  </span>
                </span>
                <Send className={cn('size-3.5 shrink-0', sendingTo === e.key ? 'text-hyper' : 'text-muted-foreground/40')} aria-hidden="true" />
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
