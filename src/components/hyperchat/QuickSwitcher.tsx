'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Hash, AtSign, Server as ServerIcon, CornerDownLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sounds } from '@/lib/client/sounds'

type Item = {
  key: string
  label: string
  sub: string
  kind: 'channel' | 'dm' | 'server'
  action: () => void
}

/** Simple fuzzy match: every character of the query appears in order. */
function fuzzy(haystack: string, needle: string): boolean {
  if (!needle) return true
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  let hi = 0
  for (const ch of n) {
    hi = h.indexOf(ch, hi)
    if (hi === -1) return false
    hi++
  }
  return true
}

/** Ctrl+K quick switcher: jump to any channel, DM or server by typing. */
export function QuickSwitcher({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const servers = useChatStore((s) => s.servers)
  const conversations = useChatStore((s) => s.conversations)
  const selectServer = useChatStore((s) => s.selectServer)
  const selectChannel = useChatStore((s) => s.selectChannel)
  const selectConversation = useChatStore((s) => s.selectConversation)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // reset the query whenever the switcher opens (render-phase adjust)
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setQuery('')
      setIndex(0)
    }
  }

  const items: Item[] = useMemo(() => {
    const out: Item[] = []
    for (const server of servers) {
      for (const channel of server.channels) {
        out.push({
          key: `c-${channel.id}`,
          label: `#${channel.name}`,
          sub: server.name,
          kind: 'channel',
          action: () => {
            void selectServer(server.id).then(() => void selectChannel(channel.id))
          },
        })
      }
    }
    for (const convo of conversations) {
      out.push({
        key: `d-${convo.id}`,
        label: convo.otherUser.displayName || convo.otherUser.username,
        sub: `@${convo.otherUser.username}`,
        kind: 'dm',
        action: () => void selectConversation(convo.id),
      })
    }
    for (const server of servers) {
      out.push({
        key: `s-${server.id}`,
        label: server.name,
        sub: `${server.memberCount} members`,
        kind: 'server',
        action: () => void selectServer(server.id),
      })
    }
    return out
  }, [servers, conversations, selectServer, selectChannel, selectConversation])

  const results = useMemo(() => {
    if (!query.trim()) return items.slice(0, 14)
    return items.filter((it) => fuzzy(`${it.label} ${it.sub}`, query.trim())).slice(0, 14)
  }, [items, query])

  // typing changes the list: clamp the selection so it always points at a row
  const activeIndex = results.length === 0 ? 0 : Math.min(index, results.length - 1)

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  function run(item: Item) {
    sounds.play('lightTick')
    item.action()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 border-border glass overflow-hidden rounded-sm top-6 translate-y-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">quick switcher</DialogTitle>
        <div className="p-3 border-b border-white/10">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIndex((i) => Math.min(i + 1, results.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex((i) => Math.max(i - 1, 0))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const item = results[activeIndex]
                if (item) run(item)
              } else if (e.key === 'Escape') {
                onOpenChange(false)
              }
            }}
            placeholder="jump to a channel, dm or server..."
            className="w-full bg-app-raise border border-white/10 rounded-sm px-3 py-2 text-sm outline-none focus:border-hyper/50 placeholder:text-muted-foreground"
            aria-label="search destinations"
          />
        </div>
        <div className="max-h-80 overflow-y-auto scroll-thin p-1.5" role="listbox" aria-label="destinations">
          {results.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-6">nothing matches that.</p>
          )}
          {results.map((item, i) => (
            <button
              key={item.key}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(item)}
              className={cn(
                'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-sm text-left transition-colors',
                i === activeIndex ? 'bg-accent text-foreground' : 'text-foreground/80 hover:bg-accent/60'
              )}
            >
              {item.kind === 'channel' && <Hash className="size-4 text-muted-foreground shrink-0" />}
              {item.kind === 'dm' && <AtSign className="size-4 text-muted-foreground shrink-0" />}
              {item.kind === 'server' && <ServerIcon className="size-4 text-muted-foreground shrink-0" />}
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium truncate">{item.label}</span>
                <span className="block text-[10px] text-muted-foreground truncate">{item.sub}</span>
              </span>
              {i === activeIndex && <CornerDownLeft className="size-3.5 text-muted-foreground shrink-0" />}
            </button>
          ))}
        </div>
        <div className="px-3 py-2 border-t border-white/10 text-[10px] text-muted-foreground flex items-center gap-3">
          <span className="flex items-center gap-1">
            <kbd className="bg-app-raise border border-white/10 rounded-sm px-1">↑↓</kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="bg-app-raise border border-white/10 rounded-sm px-1">enter</kbd> jump
          </span>
          <span className="flex items-center gap-1">
            <kbd className="bg-app-raise border border-white/10 rounded-sm px-1">esc</kbd> close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}
