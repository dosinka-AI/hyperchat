'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AtSign } from 'lucide-react'
import { useChatStore } from '@/lib/client/store'
import { apiClient } from '@/lib/client/api'
import { sounds } from '@/lib/client/sounds'
import { Avatar } from './Avatar'
import type { MentionSummary } from '@/lib/types'

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** Highlight every @me token inside a mention preview. */
function MentionText({ content, username }: { content: string; username: string }) {
  if (!username) return <>{content}</>
  const parts = content.split(new RegExp(`(@${username})`, 'ig'))
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === `@${username.toLowerCase()}` ? (
          <span key={i} className="text-hyper font-semibold">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  )
}

/** The mentions inbox (Discord's "recent mentions"): one button in the room
 *  header opens every message that pinged me across servers and DMs. Rows
 *  jump straight to where it happened. */
export function InboxButton() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<MentionSummary[] | null>(null)
  const [dots, setDots] = useState(false)
  const [loading, setLoading] = useState(false)
  const me = useChatStore((s) => s.me)
  const jumpToMessage = useChatStore((s) => s.jumpToMessage)

  // silent probe on mount: a hyper dot appears when unseen mentions exist
  useEffect(() => {
    let cancelled = false
    void apiClient
      .mentions()
      .then((res) => {
        if (cancelled) return
        setDots(res.mentions.some((m) => !res.lastReadAt || m.createdAt > res.lastReadAt))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const res = await apiClient.mentions()
        if (cancelled) return
        setItems(res.mentions)
        setDots(res.mentions.some((m) => !res.lastReadAt || m.createdAt > res.lastReadAt))
        // opening the inbox is seeing it: the next open starts clean unless
        // something new arrives afterwards
        if (res.mentions.length > 0) {
          void apiClient.markMentionsRead().catch(() => {})
        }
      } catch {
        if (!cancelled) setItems([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-9 px-2 rounded-sm relative"
        onClick={() => {
          sounds.play('lightTick')
          setOpen(true)
        }}
        aria-label="recent mentions"
        title="recent mentions"
      >
        <AtSign className="size-4" />
        {dots && <span className="absolute right-1 top-1 size-2 rounded-full bg-hyper" aria-hidden="true" />}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 lowercase">
              <AtSign className="size-4 text-hyper" />
              recent mentions
            </DialogTitle>
          </DialogHeader>

          <div className="max-h-96 overflow-y-auto -mx-1 px-1 space-y-1">
            {loading && (
              <p className="text-sm text-muted-foreground py-6 text-center">
                looking through the last 7 days...
              </p>
            )}
            {!loading && items && items.length === 0 && (
              <p className="text-sm text-muted-foreground py-6 text-center">
                nobody has pinged you in the last 7 days.
              </p>
            )}
            {!loading &&
              items?.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    sounds.play('lightTick')
                    setOpen(false)
                    void jumpToMessage(m.id)
                  }}
                  className="w-full text-left flex items-start gap-3 rounded-sm border border-white/5 bg-app-raise/60 px-3 py-2.5 hover:border-hyper/50 hover:bg-app-raise transition-colors"
                >
                  <Avatar
                    name={m.author.username}
                    color={m.author.avatarColor}
                    url={m.author.avatarUrl}
                    size="sm"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-bold truncate">
                        {m.author.displayName || m.author.username}
                      </span>
                      <span className="text-[11px] text-muted-foreground shrink-0">{ago(m.createdAt)}</span>
                      {m.pingsEveryone && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-hyper/15 text-hyper shrink-0">
                          everyone
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-muted-foreground truncate">
                      {m.scope.kind === 'channel'
                        ? `${m.scope.serverName} / #${m.scope.channelName}`
                        : m.scope.conversationName ?? 'direct message'}
                    </span>
                    <span className="block text-sm text-foreground/90 truncate">
                      {m.content ? (
                        <MentionText content={m.content} username={me?.username ?? ''} />
                      ) : m.imageUrl ? (
                        'sent an image'
                      ) : (
                        ''
                      )}
                    </span>
                  </span>
                </button>
              ))}
          </div>

          <p className="text-[11px] text-muted-foreground">click a row to jump to where it happened.</p>
        </DialogContent>
      </Dialog>
    </>
  )
}
