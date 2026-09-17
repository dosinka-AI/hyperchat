'use client'

import { useEffect, useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Check, LogOut, Plus, X } from 'lucide-react'
import { useChatStore } from '@/lib/client/store'
import { listAccounts, removeAccount, type SavedAccount } from '@/lib/client/accounts'

function MiniAvatar({
  account,
  size = 'md',
}: {
  account: { username: string; avatarUrl: string | null; avatarColor: string }
  size?: 'sm' | 'md'
}) {
  const cls = size === 'sm' ? 'size-6 text-[10px]' : 'size-8 text-xs'
  if (account.avatarUrl) {
    return <img src={account.avatarUrl} alt="" className={`${cls} rounded-full object-cover shrink-0`} />
  }
  return (
    <div
      className={`${cls} rounded-full grid place-items-center font-bold text-black/80 shrink-0`}
      style={{ backgroundColor: account.avatarColor }}
    >
      {account.username.slice(0, 2).toUpperCase()}
    </div>
  )
}

/**
 * Floating account switcher, pinned to the bottom-right corner whenever the
 * app is open. Lists every account logged in from this browser (the local
 * token vault), lets you hop between them without passwords, add one more,
 * or forget any of them.
 *
 * Positioning: it sits 12px above the composer's top edge so it never covers
 * the input or its buttons, and lifts itself above the media player whenever
 * that panel is docked in the same corner. Re-measured on a light interval —
 * one getBoundingClientRect per tick, no observers needed.
 */
export function AccountSwitcher() {
  const me = useChatStore((s) => s.me)
  const view = useChatStore((s) => s.view)
  const switchAccount = useChatStore((s) => s.switchAccount)
  const doLogout = useChatStore((s) => s.doLogout)
  const setView = useChatStore((s) => s.setView)

  const [accounts, setAccounts] = useState<SavedAccount[]>([])
  const [open, setOpen] = useState(false)
  const [bottom, setBottom] = useState(16)
  const [switching, setSwitching] = useState<string | null>(null)

  // render-phase sync: refresh the vault snapshot exactly when the popover
  // flips open (derive-from-state pattern; no effects, no refs in render)
  const [syncedOpen, setSyncedOpen] = useState(false)
  if (open !== syncedOpen) {
    setSyncedOpen(open)
    if (open) setAccounts(listAccounts())
  }

  // stack above the composer and (when present) the media player panel
  useEffect(() => {
    if (view !== 'app') return
    const measure = () => {
      let top: number | null = null
      const composer = document.querySelector('[data-composer-root]')?.getBoundingClientRect()
      if (composer && composer.height > 0) top = composer.top
      const player = document.querySelector('[data-media-player]')?.getBoundingClientRect()
      if (player && player.height > 0 && (top === null || player.top < top)) top = player.top
      // CSS bottom = distance from viewport bottom to the pill's bottom edge;
      // sitting 12px clear ABOVE the measured top edge means bottom = ih - top + 12
      if (top !== null) setBottom(Math.max(12, window.innerHeight - top + 12))
      else setBottom(12)
    }
    const raf = requestAnimationFrame(measure)
    const id = window.setInterval(measure, 500)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      window.clearInterval(id)
      window.removeEventListener('resize', measure)
    }
  }, [view])

  if (!me || view !== 'app') return null

  const others = accounts.filter((a) => a.id !== me.id)

  async function onSwitch(account: SavedAccount) {
    if (switching) return
    setSwitching(account.id)
    try {
      await switchAccount(account.token)
      // switchAccount reloads the page; this only runs if it threw
      setSwitching(null)
    } catch {
      setSwitching(null)
      // dead token: drop it from the vault so the list stays honest
      setAccounts(removeAccount(account.id))
    }
  }

  function forget(account: SavedAccount) {
    setAccounts(removeAccount(account.id))
  }

  return (
    <div
      className="fixed right-3 z-40 transition-[bottom] duration-150 ease-out"
      style={{ bottom }}
      data-account-pill
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className="size-11 rounded-full border border-white/15 bg-app-raise/95 backdrop-blur-sm shadow-lg grid place-items-center overflow-hidden hover:border-hyper/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hyper/50 transition-colors"
            aria-label={`account: ${me.username}. switch accounts`}
          >
            {me.avatarUrl ? (
              <img src={me.avatarUrl} alt="" className="size-full object-cover" />
            ) : (
              <span
                className="size-full grid place-items-center text-sm font-bold text-black/80"
                style={{ backgroundColor: me.avatarColor }}
              >
                {me.username.slice(0, 2).toUpperCase()}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={10}
          className="w-64 p-0 border-border bg-app-sidebar rounded-sm overflow-hidden"
          aria-describedby={undefined}
        >
          <div className="px-3 pt-3 pb-2 text-[10px] font-bold tracking-widest text-muted-foreground">
            this account
          </div>
          <div className="mx-1 mb-1 flex items-center gap-2.5 rounded-sm bg-app-raise px-2.5 py-2">
            <MiniAvatar account={me} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold truncate">{me.displayName || me.username}</p>
              <p className="text-xs text-muted-foreground truncate">@{me.username}</p>
            </div>
            <Check className="size-4 text-hyper shrink-0" />
          </div>

          {others.length > 0 && (
            <>
              <div className="px-3 pt-2 pb-2 text-[10px] font-bold tracking-widest text-muted-foreground">
                saved accounts
              </div>
              <div className="max-h-56 overflow-y-auto px-1 space-y-0.5">
                {others.map((account) => (
                  <div key={account.id} className="group flex items-center gap-2.5 rounded-sm px-2.5 py-2 hover:bg-accent transition-colors">
                    <button
                      className="flex flex-1 items-center gap-2.5 min-w-0 text-left disabled:opacity-50"
                      onClick={() => void onSwitch(account)}
                      disabled={switching !== null}
                      aria-label={`switch to ${account.username}`}
                    >
                      <MiniAvatar account={account} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold truncate">{account.displayName || account.username}</p>
                        <p className="text-xs text-muted-foreground truncate">@{account.username}</p>
                      </div>
                    </button>
                    <button
                      className="size-6 grid place-items-center rounded-sm text-muted-foreground/60 hover:text-destructive opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                      onClick={() => forget(account)}
                      aria-label={`forget ${account.username}`}
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="p-2 border-t border-border/60 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 rounded-sm"
              onClick={() => {
                setOpen(false)
                setView('login')
              }}
            >
              <Plus className="size-3.5" />
              add account
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="rounded-sm text-destructive hover:text-destructive"
              onClick={() => {
                setOpen(false)
                void doLogout()
              }}
            >
              <LogOut className="size-3.5" />
              sign out
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
