'use client'

import { useEffect, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { sounds } from '@/lib/client/sounds'
import { ApiError } from '@/lib/client/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/hooks/use-toast'
import { Trash2, Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Bulk-delete the newest messages in the open channel. */
export function PurgeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const servers = useChatStore((s) => s.servers)
  const activeServerId = useChatStore((s) => s.activeServerId)
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const serverMembers = useChatStore((s) => s.serverMembers)
  const purgeChannel = useChatStore((s) => s.purgeChannel)
  const { toast } = useToast()

  const server = servers.find((s) => s.id === activeServerId)
  const channel = server?.channels.find((c) => c.id === activeChannelId) ?? null
  const members = activeServerId ? serverMembers[activeServerId] ?? [] : []

  const [count, setCount] = useState(10)
  const [fromUserId, setFromUserId] = useState('')
  const [working, setWorking] = useState(false)

  useEffect(() => {
    if (open) {
      setCount(10)
      setFromUserId('')
    }
  }, [open])

  if (!channel) return null

  async function run() {
    setWorking(true)
    try {
      const deleted = await purgeChannel(channel!.id, count, fromUserId || undefined)
      sounds.play('urgent')
      toast({ title: `purged ${deleted} message${deleted === 1 ? '' : 's'}` })
      onOpenChange(false)
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'purge failed',
        description: err instanceof ApiError ? err.message : 'something went wrong. try again.',
      })
    } finally {
      setWorking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm p-0 border-border bg-app-sidebar overflow-hidden rounded-sm" aria-describedby={undefined}>
        <DialogTitle className="sr-only">purge messages in {channel.name}</DialogTitle>

        <div className="px-5 pt-5 pb-3 border-b border-white/10">
          <h2 className="text-base font-extrabold tracking-tight flex items-center gap-2">
            <Trash2 className="size-4 text-destructive" />
            purge in #{channel.name}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">bulk-delete the newest messages.</p>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="space-y-1.5">
            <p className="text-xs font-bold tracking-wide text-muted-foreground">how many</p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="rounded-sm px-2"
                onClick={() => setCount((c) => Math.max(1, c - 5))}
                aria-label="five fewer messages"
              >
                <Minus className="size-3.5" />
              </Button>
              <input
                type="number"
                min={1}
                max={100}
                value={count}
                onChange={(e) => {
                  const v = Math.floor(Number(e.target.value))
                  if (!Number.isNaN(v)) setCount(Math.min(100, Math.max(1, v)))
                }}
                className="w-20 text-center bg-app-raise border border-white/10 rounded-sm px-2 py-1.5 text-sm tabular-nums outline-none focus:border-hyper/50"
                aria-label="number of messages to purge"
              />
              <Button
                variant="outline"
                size="sm"
                className="rounded-sm px-2"
                onClick={() => setCount((c) => Math.min(100, c + 5))}
                aria-label="five more messages"
              >
                <Plus className="size-3.5" />
              </Button>
              {[10, 25, 50, 100].map((n) => (
                <button
                  key={n}
                  onClick={() => setCount(n)}
                  className={cn(
                    'px-2 py-1 text-[11px] font-semibold rounded-sm border transition-colors',
                    count === n
                      ? 'bg-hyper/20 border-hyper text-hyper'
                      : 'border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25'
                  )}
                  aria-pressed={count === n}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-bold tracking-wide text-muted-foreground">only from</p>
            <select
              value={fromUserId}
              onChange={(e) => setFromUserId(e.target.value)}
              className="w-full bg-app-raise border border-white/10 rounded-sm px-2 py-2 text-sm outline-none focus:border-hyper/50"
              aria-label="filter purge to one member"
            >
              <option value="">everyone (newest {count || 'n'} messages)</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.nickname || m.displayName || m.username}
                </option>
              ))}
            </select>
          </div>

          <p className="text-[11px] text-muted-foreground leading-relaxed">
            deletion is permanent and lands in the audit log. pinned messages are removed too.
          </p>
        </div>

        <div className="px-5 py-4 border-t border-white/10 flex justify-end gap-2">
          <Button variant="ghost" size="sm" className="rounded-sm" onClick={() => onOpenChange(false)}>
            cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="rounded-sm press"
            disabled={working}
            onClick={() => void run()}
          >
            <Trash2 className="size-4" />
            {working ? 'purging' : `purge ${count}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
