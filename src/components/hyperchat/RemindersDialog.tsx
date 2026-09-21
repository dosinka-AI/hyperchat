'use client'

import { useChatStore } from '@/lib/client/store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { BellRing, X, Trash2, ArrowUpRight } from 'lucide-react'
import { sounds } from '@/lib/client/sounds'
import { cn } from '@/lib/utils'

function whenLabel(iso: string): string {
  const d = new Date(iso)
  const diff = d.getTime() - Date.now()
  if (diff < 0) return 'due now'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `in ${hours}h${mins % 60 ? ` ${mins % 60}m` : ''}`
  return `in ${Math.floor(hours / 24)}d`
}

/** The reminder manager: everything you asked Hyperion to nudge you about,
 *  in one list, each one a jump away from its message and one click from
 *  being dropped. Set reminders from the bell in a message's toolbar. */
export function RemindersDialog() {
  const remindersOpen = useChatStore((s) => s.remindersOpen)
  const setRemindersOpen = useChatStore((s) => s.setRemindersOpen)
  const reminders = useChatStore((s) => s.reminders)
  const cancelReminder = useChatStore((s) => s.cancelReminder)
  const refreshReminders = useChatStore((s) => s.refreshReminders)
  const jumpToMessage = useChatStore((s) => s.jumpToMessage)
  const close = () => setRemindersOpen(false)

  return (
    <Dialog open={remindersOpen} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md p-0 border-border bg-app-sidebar overflow-hidden rounded-sm h-[min(70vh,640px)] top-6 translate-y-0 flex flex-col" aria-describedby={undefined}>
        <DialogTitle className="sr-only">reminders</DialogTitle>
        <div className="flex items-center gap-2 px-4 h-12 border-b border-white/10 shrink-0">
          <BellRing className="size-4 text-hyper" />
          <h3 className="text-sm font-bold tracking-tight flex-1 lowercase">reminders</h3>
          <button
            onClick={() => void refreshReminders()}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors lowercase"
          >
            refresh
          </button>
          <button
            onClick={close}
            className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="close reminders"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="overflow-y-auto scroll-thin p-3 flex-1">
          {reminders.length === 0 ? (
            <div className="text-center py-10 px-4">
              <BellRing className="size-8 mx-auto text-muted-foreground/40 mb-2" />
              <p className="text-sm font-semibold lowercase">no reminders</p>
              <p className="text-xs text-muted-foreground mt-1 lowercase">
                right-click a message or use the bell to set one
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {reminders.map((r) => (
                <div
                  key={r.id}
                  className="group rounded-sm border border-white/10 bg-app-raise/50 p-2.5 hover:border-white/20 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-1 text-[11px]">
                    <span
                      className={cn(
                        'px-1.5 py-0.5 rounded-sm font-semibold shrink-0',
                        new Date(r.remindAt).getTime() <= Date.now()
                          ? 'bg-hyper/15 text-hyper'
                          : 'bg-app-raise text-muted-foreground'
                      )}
                    >
                      {whenLabel(r.remindAt)}
                    </span>
                    <span className="text-muted-foreground truncate">@{r.message.authorUsername}</span>
                    <span className="text-muted-foreground/70 shrink-0 ml-auto">
                      {new Date(r.remindAt).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  <p className="text-[13px] leading-snug text-foreground/90 break-words line-clamp-3">
                    {r.message.contentPreview ?? 'a message you wanted to revisit'}
                  </p>
                  <div className="mt-1.5 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 rounded-sm text-[11px]"
                      onClick={() => {
                        sounds.play('lightTick')
                        void jumpToMessage(r.message.id)
                        close()
                      }}
                    >
                      <ArrowUpRight className="size-3" /> jump
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 rounded-sm text-[11px] text-destructive hover:text-destructive"
                      onClick={() => {
                        sounds.play('error')
                        void cancelReminder(r.id)
                      }}
                    >
                      <Trash2 className="size-3" /> remove
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
