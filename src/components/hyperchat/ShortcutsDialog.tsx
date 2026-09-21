'use client'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Keyboard } from 'lucide-react'
import { sounds } from '@/lib/client/sounds'

const GROUPS: { title: string; items: { keys: string[]; label: string }[] }[] = [
  {
    title: 'navigation',
    items: [
      { keys: ['ctrl', 'k'], label: 'quick switcher' },
      { keys: ['alt', '↑'], label: 'previous channel' },
      { keys: ['alt', '↓'], label: 'next channel' },
      { keys: ['esc'], label: 'close panels and dialogs' },
    ],
  },
  {
    title: 'messages',
    items: [
      { keys: ['enter'], label: 'send' },
      { keys: ['shift', 'enter'], label: 'new line' },
      { keys: ['↑'], label: 'edit your last message' },
      { keys: ['@'], label: 'mention someone' },
      { keys: [':', ':'], label: 'emoji shortcode' },
      { keys: ['/'], label: 'slash commands' },
    ],
  },
  {
    title: 'in a call',
    items: [
      { keys: ['m'], label: 'mute / unmute' },
      { keys: ['d'], label: 'deafen / undeafen' },
      { keys: ['f'], label: 'fullscreen and back' },
    ],
  },
  {
    title: 'everywhere',
    items: [
      { keys: ['shift', '?'], label: 'this overlay' },
    ],
  },
]

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-6 h-6 px-1.5 rounded-sm border border-white/15 bg-app-raise text-[11px] font-semibold text-foreground/90 select-none">
      {children}
    </kbd>
  )
}

/** the keyboard cheat sheet: shift+? anywhere (outside inputs) or the
 *  keyboard button in the chat header. */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) sounds.play('lightTick')
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-sm w-[92vw] rounded-sm p-0 gap-0 overflow-hidden">
        <div className="flex items-center gap-2 px-4 pt-4 pb-3">
          <Keyboard className="size-4 text-muted-foreground" aria-hidden="true" />
          <DialogTitle className="text-base font-bold tracking-tight">keyboard</DialogTitle>
        </div>
        <div className="px-4 pb-4 space-y-4">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <div className="text-[10px] font-bold tracking-widest text-muted-foreground mb-1.5">{g.title}</div>
              <div className="space-y-1">
                {g.items.map((item) => (
                  <div key={item.label} className="flex items-center justify-between gap-3">
                    <span className="text-sm text-foreground/90">{item.label}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {item.keys.map((k, i) => (
                        <span key={i} className="flex items-center gap-1">
                          {i > 0 && <span className="text-[10px] text-muted-foreground" aria-hidden="true">+</span>}
                          <Key>{k}</Key>
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
