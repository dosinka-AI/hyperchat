'use client'

import { useEffect, useRef, useState } from 'react'
import { apiClient, ApiError } from '@/lib/client/api'
import { formatJoinDate } from '@/lib/client/format'
import { sounds } from '@/lib/client/sounds'
import { Avatar } from './Avatar'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { Shield, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

type AdminUser = {
  id: string
  username: string
  displayName: string | null
  role: string
  presence: string
  avatarUrl: string | null
  avatarColor: string
  bannedUntil: string | null
  banReason: string | null
  createdAt: string
}

type DurationKey = '1' | '7' | '30' | 'perm' | 'custom'

const DURATIONS: { key: DurationKey; label: string }[] = [
  { key: '1', label: '1d' },
  { key: '7', label: '7d' },
  { key: '30', label: '30d' },
  { key: 'perm', label: 'perm' },
]

function isBanned(u: AdminUser): boolean {
  return !!u.bannedUntil && new Date(u.bannedUntil).getTime() > Date.now()
}

function presenceOf(u: AdminUser): 'online' | 'idle' | 'dnd' | 'offline' {
  if (u.presence === 'online' || u.presence === 'idle' || u.presence === 'dnd') return u.presence
  return 'offline'
}

/** Site admin console: every account, with suspend / lift controls. */
export function AdminDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { toast } = useToast()

  const [query, setQuery] = useState('')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // inline suspend panel state
  const [panelId, setPanelId] = useState<string | null>(null)
  const [duration, setDuration] = useState<DurationKey>('7')
  const [customDays, setCustomDays] = useState('')
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (open) {
      setQuery('')
      setUsers([])
      setPanelId(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = query.trim()
    debounceRef.current = setTimeout(() => {
      setLoading(true)
      apiClient
        .adminUsers(q)
        .then((res) => setUsers(res.users))
        .catch(() => setUsers([]))
        .finally(() => setLoading(false))
    }, 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [open, query])

  // presence is live state: poll the directory while the console is open so
  // dots and labels move as people come and go
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => {
      apiClient
        .adminUsers(query.trim())
        .then((res) => setUsers(res.users))
        .catch(() => undefined)
    }, 12000)
    return () => clearInterval(t)
  }, [open, query])

  function openPanel(u: AdminUser) {
    sounds.play('lightTick')
    setPanelId(u.id)
    setDuration('7')
    setCustomDays('')
    setReason('')
  }

  function closePanel() {
    setPanelId(null)
  }

  function effectiveDays(): number | null | undefined {
    if (duration === 'perm') return null
    if (duration === 'custom') {
      const n = Math.floor(Number(customDays))
      return Number.isFinite(n) && n > 0 ? n : undefined
    }
    return Number(duration)
  }

  async function confirmSuspend(u: AdminUser) {
    const days = effectiveDays()
    if (days === undefined) return
    setBusyId(u.id)
    try {
      const res = await apiClient.adminBanUser(u.id, days, reason.trim())
      setUsers((list) =>
        list.map((x) => (x.id === u.id ? { ...x, bannedUntil: res.bannedUntil, banReason: reason.trim() || null } : x))
      )
      sounds.play('lightTick')
      closePanel()
      toast({ title: 'suspended' })
    } catch (err) {
      toast({
        title: 'could not suspend',
        description: err instanceof ApiError ? err.message : 'something went wrong. try again.',
      })
    } finally {
      setBusyId(null)
    }
  }

  async function lift(u: AdminUser) {
    setBusyId(u.id)
    try {
      await apiClient.adminUnbanUser(u.id)
      setUsers((list) => list.map((x) => (x.id === u.id ? { ...x, bannedUntil: null, banReason: null } : x)))
      sounds.play('lightTick')
      toast({ title: 'suspension lifted' })
    } catch (err) {
      toast({
        title: 'could not lift',
        description: err instanceof ApiError ? err.message : 'something went wrong. try again.',
      })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl sm:max-w-xl h-[min(80vh,720px)] top-6 translate-y-0 p-0 border-border bg-app-sidebar overflow-hidden rounded-sm flex flex-col"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">admin</DialogTitle>

        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/10 shrink-0">
          <Shield className="size-4 text-hyper shrink-0" />
          <div className="min-w-0">
            <h2 className="text-sm font-bold tracking-tight">HyperChat admin</h2>
          </div>
          {loading ? (
            <Spinner className="size-3.5 text-muted-foreground" />
          ) : (
            <span className="text-xs text-muted-foreground shrink-0">{users.length}</span>
          )}
        </div>

        <div className="px-4 py-3 border-b border-white/10 shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search"
              className="w-full bg-app-raise border border-white/10 rounded-sm pl-8 pr-3 py-1.5 text-sm outline-none focus:border-hyper/60 transition-colors placeholder:text-muted-foreground"
              aria-label="search users"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto scroll-thin">
          {!loading && users.length === 0 && (
            <p className="px-4 py-6 text-xs text-muted-foreground text-center">no users found.</p>
          )}
          <div className="divide-y divide-white/[0.06]">
            {users.map((u) => {
              const banned = isBanned(u)
              const panelOpen = panelId === u.id
              const days = effectiveDays()
              return (
                <div key={u.id} className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar
                      name={u.username}
                      color={u.avatarColor}
                      url={u.avatarUrl}
                      size="md"
                      status={presenceOf(u)}
                      showDot
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium truncate">{u.username}</span>
                        {u.role === 'ADMIN' && (
                          <span className="text-hyper border border-hyper/40 px-1.5 rounded-sm text-[10px] font-bold tracking-wide shrink-0" title="administers the entire HyperChat platform">
                            HyperChat admin
                          </span>
                        )}
                        {banned && (
                          <span className="text-destructive border border-destructive/40 px-1.5 rounded-sm text-[10px] font-bold tracking-wide shrink-0">
                            suspended
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        <span
                          className={cn(
                            'font-semibold',
                            presenceOf(u) === 'online' && 'text-online',
                            presenceOf(u) === 'idle' && 'text-idle',
                            presenceOf(u) === 'dnd' && 'text-dnd',
                            presenceOf(u) === 'offline' && 'text-muted-foreground'
                          )}
                        >
                          {presenceOf(u) === 'idle' ? 'away' : presenceOf(u)}
                        </span>
                        {u.displayName ? ` · ${u.displayName}` : ''} · {formatJoinDate(u.createdAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {busyId === u.id && <Spinner className="size-3.5 text-muted-foreground" />}
                      {banned ? (
                        <button
                          onClick={() => void lift(u)}
                          disabled={busyId === u.id}
                          className="px-3 py-1.5 text-xs font-semibold rounded-sm border border-white/15 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-60"
                        >
                          lift
                        </button>
                      ) : u.role !== 'ADMIN' ? (
                        <button
                          onClick={() => (panelOpen ? closePanel() : openPanel(u))}
                          disabled={busyId === u.id}
                          className="px-3 py-1.5 text-xs font-semibold rounded-sm text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-60"
                          aria-expanded={panelOpen}
                        >
                          suspend
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {panelOpen && (
                    <div className="mt-3 dialog-in border border-white/10 rounded-sm bg-app-raise/40 p-3 space-y-3">
                      <div className="grid grid-cols-5 gap-1 bg-app-raise p-1 rounded-sm">
                        {DURATIONS.map((d) => (
                          <button
                            key={d.key}
                            onClick={() => {
                              setDuration(d.key)
                              sounds.play('lightTick')
                            }}
                            className={cn(
                              'py-1.5 text-xs font-semibold rounded-sm transition-colors',
                              duration === d.key
                                ? 'bg-popover text-foreground'
                                : 'text-muted-foreground hover:text-foreground'
                            )}
                            aria-pressed={duration === d.key}
                          >
                            {d.label}
                          </button>
                        ))}
                      </div>

                      <button
                        onClick={() => {
                          setDuration('custom')
                          sounds.play('lightTick')
                        }}
                        className={cn(
                          'flex items-center gap-2 text-xs font-semibold transition-colors',
                          duration === 'custom' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                        )}
                        aria-pressed={duration === 'custom'}
                      >
                        <span
                          className={cn(
                            'size-3 rounded-sm border grid place-items-center',
                            duration === 'custom' ? 'border-hyper' : 'border-white/25'
                          )}
                        >
                          {duration === 'custom' && <span className="size-1.5 bg-hyper rounded-[1px]" />}
                        </span>
                        custom
                        {duration === 'custom' && (
                          <span className="flex items-center gap-1">
                            <input
                              autoFocus
                              value={customDays}
                              onChange={(e) => setCustomDays(e.target.value.replace(/[^0-9]/g, ''))}
                              maxLength={4}
                              inputMode="numeric"
                              className="w-16 bg-app-raise border border-white/10 rounded-sm px-2 py-1 text-xs outline-none focus:border-hyper/60"
                              aria-label="custom duration in days"
                            />
                            <span className="text-muted-foreground font-normal">days</span>
                          </span>
                        )}
                      </button>

                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        maxLength={200}
                        placeholder="reason"
                        className="w-full bg-app-raise border border-white/10 rounded-sm px-2.5 py-1.5 text-xs outline-none focus:border-hyper/60 transition-colors placeholder:text-muted-foreground"
                        aria-label="suspension reason"
                      />

                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" className="rounded-sm" onClick={closePanel}>
                          cancel
                        </Button>
                        <Button
                          size="sm"
                          className="rounded-sm press bg-destructive hover:bg-destructive/90 text-white"
                          disabled={days === undefined || busyId === u.id}
                          onClick={() => void confirmSuspend(u)}
                        >
                          suspend
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
