'use client'

import { useChatStore } from '@/lib/client/store'
import { Avatar } from './Avatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Bookmark, X, Trash2, ArrowUpRight } from 'lucide-react'
import { sounds } from '@/lib/client/sounds'
import { renderMessageContent } from '@/lib/client/markdown'
import { shortTime } from '@/lib/client/format'

/** Personal saved-messages collection. Private bookmarks with jump-back. */
export function SavedMessagesDialog() {
  const savedOpen = useChatStore((s) => s.savedOpen)
  const setSavedOpen = useChatStore((s) => s.setSavedOpen)
  const bookmarks = useChatStore((s) => s.bookmarks)
  const toggleBookmark = useChatStore((s) => s.toggleBookmark)
  const jumpToMessage = useChatStore((s) => s.jumpToMessage)
  const closeSaved = () => setSavedOpen(false)

  return (
    <Dialog open={savedOpen} onOpenChange={(open) => !open && closeSaved()}>
      <DialogContent className="max-w-lg p-0 border-border bg-app-sidebar overflow-hidden rounded-sm h-[min(80vh,720px)] top-6 translate-y-0 flex flex-col" aria-describedby={undefined}>
        <DialogTitle className="sr-only">saved messages</DialogTitle>
        <div className="flex items-center gap-2 px-4 h-12 border-b border-white/10 shrink-0">
          <Bookmark className="size-4 text-hyper" />
          <h3 className="text-sm font-bold tracking-tight flex-1">saved messages</h3>
          <span className="text-[11px] text-muted-foreground">{bookmarks.length} saved</span>
          <button
            onClick={closeSaved}
            className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="close saved messages"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="overflow-y-auto scroll-thin p-3 flex-1">
          {bookmarks.length === 0 ? (
            <div className="text-center py-10 px-4">
              <Bookmark className="size-8 mx-auto text-muted-foreground/40 mb-2" />
              <p className="text-sm font-semibold">nothing saved yet</p>
            </div>
          ) : (
            <div className="space-y-2">
              {bookmarks.map((b) => (
                <div
                  key={b.id}
                  className="group rounded-sm border border-white/10 bg-app-raise/50 p-2.5 hover:border-white/20 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-1.5 text-[11px] text-muted-foreground">
                    <Avatar
                      name={b.message.author.username}
                      color={b.message.author.avatarColor}
                      url={b.message.author.avatarUrl}
                      size="sm"
                    />
                    <span className="font-semibold text-foreground/80 truncate">
                      {b.message.author.displayName || b.message.author.username}
                    </span>
                    <span className="shrink-0">{shortTime(b.message.createdAt)}</span>
                    {b.scope && (
                      <span className="ml-auto shrink-0 px-1.5 py-0.5 bg-app-raise rounded-sm text-[10px] font-semibold truncate max-w-32">
                        {b.scope.name}
                      </span>
                    )}
                  </div>
                  {b.message.content && (
                    <div className="text-[13px] leading-snug text-foreground/90 break-words line-clamp-4">
                      {renderMessageContent(b.message.content, {})}
                    </div>
                  )}
                  {b.message.imageUrl && (
                    <img
                      src={b.message.imageUrl}
                      alt=""
                      className="mt-1.5 max-h-24 rounded-sm border border-border object-cover"
                      loading="lazy"
                    />
                  )}
                  <div className="flex items-center gap-1 mt-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 rounded-sm text-[11px]"
                      onClick={() => {
                        sounds.play('lightTick')
                        void jumpToMessage(b.message.id)
                        closeSaved()
                      }}
                    >
                      <ArrowUpRight className="size-3" /> jump to it
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 rounded-sm text-[11px] text-destructive hover:text-destructive"
                      onClick={() => {
                        sounds.play('error')
                        void toggleBookmark(b.message.id)
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
