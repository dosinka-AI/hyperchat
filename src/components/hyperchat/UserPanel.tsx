'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/lib/client/store'
import { listAccounts, removeAccount, type SavedAccount } from '@/lib/client/accounts'
import { Avatar } from './Avatar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Check,
  ChevronDown,
  ChevronUp,
  LogOut,
  Pencil,
  Plus,
  Settings,
  Shield,
  UserRound,
  X,
} from 'lucide-react'
import { sounds } from '@/lib/client/sounds'
import { useToast } from '@/hooks/use-toast'
import type { UserPresenceChoice } from '@/lib/types'

/** The bottom-left user panel: one compact strip (avatar, name, status) that
 *  opens a single popover holding everything about "you": the status quote,
 *  presence picker, the account switcher (this is where accounts live now),
 *  and quiet text rows for profile / settings / sign out. Proportions follow
 *  the sidebar's own rhythm: 9px vertical rows, 11px metadata, no banners,
 *  no oversized bordered buttons. */
export function UserPanel() {
  const me = useChatStore((s) => s.me)
  const connected = useChatStore((s) => s.connected)
  const setMyPresence = useChatStore((s) => s.setMyPresence)
  const updateProfile = useChatStore((s) => s.updateProfile)
  const openProfile = useChatStore((s) => s.openProfile)
  const setProfileEditorOpen = useChatStore((s) => s.setProfileEditorOpen)
  const setAccountOpen = useChatStore((s) => s.setAccountOpen)
  const setAdminPanelOpen = useChatStore((s) => s.setAdminPanelOpen)
  const switchAccount = useChatStore((s) => s.switchAccount)
  const doLogout = useChatStore((s) => s.doLogout)
  const setView = useChatStore((s) => s.setView)
  const { toast } = useToast()

  const [open, setOpen] = useState(false)
  const [statusDraft, setStatusDraft] = useState('')
  const [statusFocused, setStatusFocused] = useState(false)
  const [accounts, setAccounts] = useState<SavedAccount[]>([])
  const [switching, setSwitching] = useState<string | null>(null)

  // seed the status draft + vault snapshot exactly when the popover flips
  // open (derive-from-state; no effects)
  const [seed, setSeed] = useState<string | null>(null)
  if (open && seed === null && !statusFocused) {
    const v = me?.customStatus ?? ''
    setSeed(v)
    setStatusDraft(v)
    setAccounts(listAccounts())
  } else if (!open && seed !== null) {
    setSeed(null)
  }

  if (!me) return null

  const others = accounts.filter((a) => a.id !== me.id)

  async function saveStatusQuote() {
    if (!me) return
    const next = statusDraft.trim() || null
    if (next === (me.customStatus ?? null)) return
    try {
      await updateProfile({ customStatus: next })
      sounds.play('lightTick')
    } catch {
      sounds.play('error')
      toast({ title: 'could not save status' })
    }
  }

  function close(commitStatus: boolean) {
    if (commitStatus && (statusFocused || statusDraft.trim() !== (me?.customStatus ?? ''))) {
      void saveStatusQuote()
    }
    setStatusFocused(false)
    setOpen(false)
  }

  async function onSwitch(account: SavedAccount) {
    if (switching) return
    setSwitching(account.id)
    try {
      await switchAccount(account.token)
      // reloads on success; this only runs if it threw
      setSwitching(null)
    } catch {
      setSwitching(null)
      // dead token: drop it from the vault so the list stays honest
      setAccounts(removeAccount(account.id))
      toast({ title: 'that login expired', description: 'sign in again to switch back.' })
    }
  }

  const presence = connected ? (me.presence === 'invisible' ? 'offline' : me.presence) : 'offline'

  return (
    <div className="bg-app-rail/60 px-2 h-[52px] flex items-center gap-1 border-t border-white/10 shrink-0">
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (next) setOpen(true)
          else close(true)
        }}
      >
        <PopoverTrigger asChild>
          <button
            className="group flex items-center gap-2 flex-1 min-w-0 h-10 sm:h-9 px-1.5 -mx-1 rounded-sm hover:bg-white/[0.05] active:bg-white/[0.08] transition-colors text-left"
            aria-label={`account options for ${me.username}`}
          >
            <Avatar
              name={me.username}
              color={me.avatarColor}
              url={me.avatarUrl}
              size="sm"
              status={presence}
              showDot
            />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="text-[13px] font-semibold truncate">{me.displayName || me.username}</p>
              <p className="text-[11px] truncate">
                {me.customStatus ? (
                  <span className="text-foreground/75 truncate">{me.customStatus}</span>
                ) : (
                  <span className="text-muted-foreground">{presenceLabel(me.presence, connected)}</span>
                )}
              </p>
            </div>
            <ChevronUp
              className={cn(
                'size-3.5 text-muted-foreground/70 shrink-0 transition-transform duration-200',
                !open && 'rotate-180'
              )}
              aria-hidden="true"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className={cn(
            'w-[19rem] max-w-[calc(100vw-1.5rem)] p-0 rounded-sm border border-white/10',
            'glass overflow-hidden shadow-xl'
          )}
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {/* header: who you are, at reading distance */}
          <div className="flex items-center gap-2.5 px-3 pt-3 pb-2">
            <Avatar
              name={me.username}
              color={me.avatarColor}
              url={me.avatarUrl}
              size="md"
              status={presence}
              showDot
            />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="text-sm font-bold tracking-tight truncate">{me.displayName || me.username}</p>
              <p className="text-[11px] text-muted-foreground truncate">
                @{me.username}
                {me.pronouns && <span className="text-muted-foreground/80"> · {me.pronouns}</span>}
              </p>
            </div>
          </div>

          {/* status quote */}
          <div className="px-3 pb-2">
            <input
              value={statusDraft}
              onChange={(e) => setStatusDraft(e.target.value)}
              onFocus={() => setStatusFocused(true)}
              onBlur={() => {
                setStatusFocused(false)
                if (statusDraft.trim() !== (me.customStatus ?? '')) void saveStatusQuote()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void saveStatusQuote()
                }
                if (e.key === 'Escape') close(true)
              }}
              placeholder="set a status"
              maxLength={80}
              aria-label="your status quote"
              className={cn(
                'status-bubble border px-2.5 h-8 text-xs outline-none w-full transition-colors placeholder:text-muted-foreground/60',
                statusDraft.trim()
                  ? 'border-white/10 bg-app-raise text-foreground/90 focus:border-hyper/50'
                  : 'border-dashed border-white/15 bg-app-raise/60 text-foreground/80 focus:border-hyper/40'
              )}
            />
          </div>

          {/* presence picker */}
          <div className="px-3 pb-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="w-full flex items-center gap-2 h-8 px-2 rounded-sm border border-white/10 bg-app-raise text-xs hover:border-white/25 transition-colors"
                  aria-label="change your status"
                >
                  <StatusGlyph status={me.presence} />
                  <span className="flex-1 text-left truncate">
                    {connected ? presenceChoiceLabel(me.presence) : 'reconnecting'}
                  </span>
                  <ChevronDown className="size-3.5 text-muted-foreground shrink-0" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-48 rounded-sm">
                {(
                  [
                    ['online', 'Online'],
                    ['idle', 'Away / Idle'],
                    ['busy', 'Busy'],
                    ['dnd', 'Do not disturb'],
                    ['invisible', 'Invisible'],
                  ] as [UserPresenceChoice, string][]
                ).map(([value, label]) => (
                  <DropdownMenuItem
                    key={value}
                    onClick={() => {
                      sounds.play('lightTick')
                      void setMyPresence(value)
                    }}
                    className="gap-2 py-1.5"
                  >
                    <StatusGlyph status={value} />
                    <span className="flex-1">{label}</span>
                    {me.presence === value && (
                      <span className="text-[10px] text-muted-foreground">current</span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* account switcher: this is where accounts live */}
          <div className="border-t border-white/10 pt-2 pb-1">
            <p className="px-3 pb-1.5 text-[10px] font-bold tracking-widest text-muted-foreground">
              accounts
            </p>
            <div className="px-1.5 space-y-px">
              <div className="flex items-center gap-2 h-9 px-1.5 rounded-sm bg-app-raise">
                <AccountAvatar account={me} />
                <div className="min-w-0 flex-1 leading-tight">
                  <p className="text-[13px] font-semibold truncate">{me.displayName || me.username}</p>
                  <p className="text-[11px] text-muted-foreground truncate">@{me.username}</p>
                </div>
                <span className="shrink-0 flex items-center gap-1 text-[10px] font-semibold text-hyper">
                  <Check className="size-3.5" aria-hidden="true" />
                  active
                </span>
              </div>

              {others.map((account) => (
                <div
                  key={account.id}
                  className="group/acct flex items-center gap-2 h-9 px-1.5 rounded-sm hover:bg-accent transition-colors"
                >
                  <button
                    className="flex flex-1 items-center gap-2 min-w-0 text-left disabled:opacity-50"
                    onClick={() => void onSwitch(account)}
                    disabled={switching !== null}
                    aria-label={`switch to ${account.username}`}
                  >
                    <AccountAvatar account={account} />
                    <div className="min-w-0 flex-1 leading-tight">
                      <p className="text-[13px] font-semibold truncate">
                        {account.displayName || account.username}
                      </p>
                      <p className="text-[11px] text-muted-foreground truncate">@{account.username}</p>
                    </div>
                    {switching === account.id && (
                      <span className="text-[10px] text-muted-foreground shrink-0">switching…</span>
                    )}
                  </button>
                  <button
                    className="size-6 grid place-items-center rounded-sm text-muted-foreground/50 hover:text-destructive md:opacity-0 md:group-hover/acct:opacity-100 focus-visible:opacity-100 transition-opacity shrink-0"
                    onClick={() => setAccounts(removeAccount(account.id))}
                    aria-label={`forget ${account.username}`}
                    title="forget this login"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}

              <button
                className="w-full flex items-center gap-2 h-9 px-1.5 rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors text-[13px] font-medium"
                onClick={() => {
                  close(false)
                  setView('login')
                }}
              >
                <span className="size-6 grid place-items-center rounded-sm border border-dashed border-white/20 shrink-0">
                  <Plus className="size-3.5" />
                </span>
                add account
              </button>
            </div>
          </div>

          {/* quiet action rows */}
          <div className="border-t border-white/10 py-1">
            {me.siteAdmin && (
              <PanelRow
                icon={<Shield className="size-4" />}
                label="admin panel"
                onClick={() => {
                  sounds.play('midTick')
                  setAdminPanelOpen(true)
                  close(false)
                }}
              />
            )}
            <PanelRow
              icon={<UserRound className="size-4" />}
              label="view profile"
              onClick={() => {
                sounds.play('lightTick')
                void openProfile(me.username)
                close(false)
              }}
            />
            <PanelRow
              icon={<Pencil className="size-4" />}
              label="edit profile"
              onClick={() => {
                sounds.play('midTick')
                setProfileEditorOpen(true)
                close(false)
              }}
            />
            <PanelRow
              icon={<Settings className="size-4" />}
              label="settings"
              onClick={() => {
                sounds.play('midTick')
                setAccountOpen(true)
                close(false)
              }}
            />
          </div>

          <div className="border-t border-white/10 py-1">
            <button
              className="w-full flex items-center gap-2.5 h-9 px-3.5 rounded-sm text-[13px] font-medium text-destructive/90 hover:bg-destructive/10 hover:text-destructive transition-colors"
              onClick={() => {
                close(false)
                void doLogout()
              }}
            >
              <LogOut className="size-4" />
              sign out
            </button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** Tiny 24px avatar for account rows (image or initials on the user color). */
function AccountAvatar({ account }: { account: { username: string; avatarUrl: string | null; avatarColor: string } }) {
  if (account.avatarUrl) {
    return <img src={account.avatarUrl} alt="" className="size-6 rounded-full object-cover shrink-0" />
  }
  return (
    <span
      className="size-6 rounded-full grid place-items-center text-[9px] font-bold text-black/80 shrink-0"
      style={{ backgroundColor: account.avatarColor }}
    >
      {account.username.slice(0, 2).toUpperCase()}
    </span>
  )
}

function PanelRow({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      className="w-full flex items-center gap-2.5 h-9 px-3.5 rounded-sm text-[13px] font-medium text-foreground/85 hover:bg-accent hover:text-foreground transition-colors"
      onClick={onClick}
    >
      <span className="text-muted-foreground">{icon}</span>
      {label}
    </button>
  )
}

/** Small presence dot for the status dropdown trigger. */
function StatusGlyph({ status }: { status: UserPresenceChoice }) {
  return (
    <span className="relative size-2.5 shrink-0" aria-hidden="true">
      {status === 'online' && <span className="absolute inset-0 rounded-full bg-online status-breathe" />}
      {status === 'idle' && (
        <>
          <span className="absolute inset-0 rounded-full bg-idle" />
          <span className="absolute -top-[30%] -right-[25%] w-[70%] h-[70%] rounded-full bg-popover" />
        </>
      )}
      {status === 'busy' && (
        <>
          <span className="absolute inset-0 rounded-full bg-busy" />
          <span className="absolute left-1/2 bottom-1/2 w-[1.5px] h-[32%] -translate-x-1/2 bg-white/95 rounded-full" />
          <span className="absolute top-1/2 left-1/2 w-[32%] h-[1.5px] -translate-y-1/2 bg-white/95 rounded-full" />
        </>
      )}
      {status === 'dnd' && (
        <span className="absolute inset-0 rounded-full bg-dnd grid place-items-center">
          <span className="w-[55%] h-[2px] rounded-full bg-popover" />
        </span>
      )}
      {status === 'invisible' && <span className="absolute inset-0 rounded-full bg-offline" />}
    </span>
  )
}

function presenceChoiceLabel(status: UserPresenceChoice): string {
  switch (status) {
    case 'idle':
      return 'Away / Idle'
    case 'busy':
      return 'Busy'
    case 'dnd':
      return 'Do not disturb'
    case 'invisible':
      return 'Invisible'
    default:
      return 'Online'
  }
}

function presenceLabel(presence: UserPresenceChoice | undefined, connected: boolean): string {
  if (!connected) return 'reconnecting'
  switch (presence) {
    case 'idle':
      return 'away'
    case 'busy':
      return 'busy'
    case 'dnd':
      return 'do not disturb'
    case 'invisible':
      return 'invisible'
    default:
      return 'online'
  }
}
