'use client'

import { useChatStore } from '@/lib/client/store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { CalendarClock, X, Trash2 } from 'lucide-react'
import { sounds } from '@/lib/client/sounds'

function whenLabel(iso: string): string {
  const d = new Date(iso)
  const diff = d.getTime() - Date.now()
  if (diff < 0) return 'sending soon'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `in ${hours}h${mins % 60 ? ` ${mins % 60}m` : ''}`
  return `in ${Math.floor(hours / 24)}d`
}

/** The scheduled-message queue: compose now, delivered later, even offline. */
export function ScheduledDialog() {
  const scheduledOpen = useChatStore((s) => s.scheduledOpen)
  const setScheduledOpen = useChatStore((s) => s.setScheduledOpen)
  const scheduled = useChatStore((s) => s.scheduled)
  const cancelScheduled = useChatStore((s) => s.cancelScheduled)
  const refreshScheduled = useChatStore((s) => s.refreshScheduled)
  const close = () => setScheduledOpen(false)

  return (
    <Dialog open={scheduledOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md p-0 border-border bg-app-sidebar overflow-hidden rounded-sm h-[min(70vh,640px)] top-6 translate-y-0 flex flex-col" aria-describedby={undefined}>
        <DialogTitle className="sr-only">scheduled messages</DialogTitle>
        <div className="flex items-center gap-2 px-4 h-12 border-b border-white/10 shrink-0">
          <CalendarClock className="size-4 text-hyper" />
          <h3 className="text-sm font-bold tracking-tight flex-1">scheduled messages</h3>
          <button
            onClick={() => void refreshScheduled()}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            refresh
          </button>
          <button
            onClick={close}
            className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="close scheduled messages"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="overflow-y-auto scroll-thin p-3 flex-1">
          {scheduled.length === 0 ? (
            <div className="text-center py-10 px-4">
              <CalendarClock className="size-8 mx-auto text-muted-foreground/40 mb-2" />
              <p className="text-sm font-semibold">nothing scheduled</p>
            </div>
          ) : (
            <div className="space-y-2">
              {scheduled.map((r) => (
                <div
                  key={r.id}
                  className="group rounded-sm border border-white/10 bg-app-raise/50 p-2.5 hover:border-white/20 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-1 text-[11px]">
                    <span className="px-1.5 py-0.5 bg-app-raise rounded-sm font-semibold truncate max-w-40">
                      {r.scopeName}
                    </span>
                    <span className="text-hyper font-semibold shrink-0">{whenLabel(r.sendAt)}</span>
                    <span className="text-muted-foreground shrink-0 ml-auto">
                      {new Date(r.sendAt).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <p className="text-[13px] leading-snug text-foreground/90 break-words line-clamp-3">{r.content}</p>
                  <div className="mt-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 rounded-sm text-[11px] text-destructive hover:text-destructive"
                      onClick={() => {
                        sounds.play('error')
                        void cancelScheduled(r.id)
                      }}
                    >
                      <Trash2 className="size-3" /> cancel
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
