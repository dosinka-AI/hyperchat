'use client'

/**
 * Poke UI (TeamSpeak-style nudges):
 * - PokeInbox: the pokes aimed at me, unread highlighted, opened from the
 *   user panel. Opening marks everything seen.
 * - PokeSend: a compact composer aimed at one person (optional message),
 *   reachable from profile popovers and member menus.
 */

import { useState } from 'react'
import { Hand as PokeHand, Send, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sounds } from '@/lib/client/sounds'
import { useChatStore } from '@/lib/client/store'
import { Avatar } from './Avatar'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { relativeTime } from '@/lib/client/format'

export function PokeInbox() {
  const open = useChatStore((s) => s.pokeInboxOpen)
  const setOpen = useChatStore((s) => s.setPokeInboxOpen)
  const pokes = useChatStore((s) => s.pokes)
  const openProfile = useChatStore((s) => s.openProfile)
  const [pokeBack, setPokeBack] = useState<string | null>(null)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm p-0 border-border glass overflow-hidden rounded-sm top-6 translate-y-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">pokes</DialogTitle>
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/10">
          <PokeHand className="size-4 text-hyper shrink-0" />
          <p className="text-sm font-bold tracking-tight">pokes</p>
          <span className="text-[10px] text-muted-foreground">nudges aimed at you</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="ml-auto p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="close pokes"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto scroll-thin">
          {pokes.length === 0 ? (
            <div className="py-10 px-6 text-center text-[12px] text-muted-foreground">
              nobody has poked you yet
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {pokes.map((p) => (
                <div
                  key={p.id}
                  className={cn('px-4 py-2.5 flex items-start gap-2.5', !p.readAt && 'bg-hyper/5')}
                >
                  <button
                    type="button"
                    onClick={() => { sounds.play('lightTick'); void openProfile(p.from.username); setOpen(false) }}
                    className="shrink-0 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-hyper"
                    aria-label={`open ${p.from.displayName || p.from.username}`}
                  >
                    <Avatar name={p.from.username} color={p.from.avatarColor} url={p.from.avatarUrl} size="sm" />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <p className="text-[13px] font-semibold tracking-tight truncate">
                        {p.from.displayName || p.from.username}
                      </p>
                      {!p.readAt && <span className="shrink-0 size-1.5 rounded-full bg-hyper" aria-label="unread" />}
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{relativeTime(p.createdAt)}</span>
                    </div>
                    {p.message ? (
                      <p className="text-[12px] text-foreground/80 break-words mt-0.5">{p.message}</p>
                    ) : (
                      <p className="text-[11px] text-muted-foreground italic mt-0.5">poked you</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => { sounds.play('lightTick'); setPokeBack(pokeBack === p.id ? null : p.id) }}
                    className="shrink-0 mt-0.5 px-2 h-6 rounded-sm border border-white/10 text-[10px] font-semibold text-muted-foreground hover:text-foreground hover:border-white/30 transition-colors"
                    aria-label={`poke ${p.from.displayName || p.from.username} back`}
                  >
                    poke back
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {pokeBack && <PokeSendInline username={pokeBack} onDone={() => setPokeBack(null)} />}
      </DialogContent>
    </Dialog>
  )
}

/** Inline mini-composer appended under the inbox while poking back. */
function PokeSendInline({ username, onDone }: { username: string; onDone: () => void }) {
  const pokeUser = useChatStore((s) => s.pokeUser)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async () => {
    if (busy) return
    setBusy(true)
    try {
      await pokeUser(username, message.trim())
      sounds.play('midTick')
      onDone()
    } catch {
      sounds.play('error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-1.5 px-4 py-2.5 border-t border-white/10 fade-in">
      <input
        value={message}
        onChange={(e) => setMessage(e.target.value.slice(0, 120))}
        onKeyDown={(e) => { if (e.key === 'Enter') void send() }}
        placeholder={`poke @${username}`}
        aria-label={`poke ${username}`}
        className="flex-1 h-8 rounded-sm border border-white/10 bg-black/30 px-2.5 text-[12px] placeholder:text-muted-foreground/50 focus:outline-none focus:border-hyper/60"
      />
      <button
        type="button"
        onClick={() => void send()}
        disabled={busy}
        className="shrink-0 size-8 rounded-sm bg-hyper text-black grid place-items-center disabled:opacity-50"
        aria-label="send the poke"
      >
        <Send className="size-3.5" />
      </button>
    </div>
  )
}

/** The "poke" trigger + popover used on other people's profiles. */
export function PokeButton({ username, displayName }: { username: string; displayName?: string | null }) {
  const pokeUser = useChatStore((s) => s.pokeUser)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const send = async () => {
    if (busy) return
    setBusy(true)
    try {
      await pokeUser(username, message.trim())
      sounds.play('midTick')
      setOpen(false)
      setMessage('')
    } catch {
      sounds.play('error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label={`poke ${displayName || username}`}
          title="poke (nudge them)"
        >
          <PokeHand className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64 p-0 rounded-sm border-border glass overflow-hidden">
        <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2">
          <PokeHand className="size-3.5 text-hyper shrink-0" />
          <p className="text-[12px] font-bold tracking-tight truncate">poke {displayName || `@${username}`}</p>
        </div>
        <div className="p-2 flex items-center gap-1.5">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, 120))}
            onKeyDown={(e) => { if (e.key === 'Enter') void send() }}
            placeholder="optional note"
            aria-label="poke note"
            autoFocus
            className="flex-1 h-8 rounded-sm border border-white/10 bg-black/30 px-2.5 text-[12px] placeholder:text-muted-foreground/50 focus:outline-none focus:border-hyper/60"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy}
            className="shrink-0 size-8 rounded-sm bg-hyper text-black grid place-items-center disabled:opacity-50"
            aria-label="send the poke"
          >
            {busy ? <span className="size-3 rounded-full border border-black border-t-transparent animate-spin" /> : <Send className="size-3.5" />}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
