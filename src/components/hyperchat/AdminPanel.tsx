'use client'

import { useCallback, useEffect, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { apiClient, ApiError, type AdminAuditEvent, type AdminUserSummary, type AdminVaultUpload } from '@/lib/client/api'
import { formatBytes, formatJoinDate, formatRemaining, relativeTime } from '@/lib/client/format'
import { sounds } from '@/lib/client/sounds'
import { Avatar } from './Avatar'
import { confirmDialog, promptDialog } from './ConfirmDialog'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import {
  Shield,
  Search,
  RefreshCw,
  Globe,
  Pencil,
  Check,
  X,
  Ban,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Users,
  MessageSquare,
  Server as ServerIcon,
  HardDrive,
  Clock3,
  Gavel,
  ScrollText,
  Download,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * THE ADMIN PANEL (Task 6-c) — the owner's console, gated on User.siteAdmin
 * (see src/lib/siteAdmin.ts; every /api/admin/* route 403s non-admins).
 * Four tabs: overview (stats + the client-discovery check card), users
 * (search + verify / admin / ban actions), vault (force-expire uploads),
 * audit (the existing ServerEvent log, latest first). Classic dark
 * surfaces, emerald for live/positive, red for danger, tabular-nums
 * everywhere numbers live.
 */

type OverviewData = {
  users: { total: number; verified: number; newLast7d: number }
  messages: { total: number; last24h: number }
  servers: { total: number }
  vault: { uploads: number; readyBytes: number; uploading: number; expiredSoon: number; diskUsageBytes: number }
  onlineNow: number
}

type BootstrapData = { configured: boolean; bootstrapUrl: string | null; address: string | null; addressAt: string | null; ok: boolean; error?: string }

/** seconds since the last resolve attempt, floored for the card caption */
function checkedAgo(iso: string | null, now: number): string | null {
  if (!iso) return null
  const diff = Math.floor((now - Date.parse(iso)) / 1000)
  if (!Number.isFinite(diff) || diff < 0) return null
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

const AUDIT_LABELS: Record<string, string> = {
  member_join: 'joined',
  member_leave: 'left',
  member_kick: 'kicked',
  member_ban: 'banned',
  member_unban: 'unbanned',
  member_timeout: 'timed out',
  timeout_clear: 'cleared a timeout for',
  role_change: 'changed a rank',
  role_create: 'created a role',
  role_update: 'updated a role',
  role_delete: 'deleted a role',
  role_assign: 'set a role on',
  nickname_change: 'changed a nickname',
  channel_create: 'created a channel',
  channel_delete: 'deleted a channel',
  channel_update: 'updated a channel',
  channel_purge: 'purged messages in',
  message_delete: 'deleted a message from',
  category_create: 'created a category',
  category_update: 'updated a category',
  category_delete: 'deleted a category',
  server_update: 'updated the server',
  tagAdded: 'added a forum tag',
  tagRemoved: 'removed a forum tag',
}

export function AdminPanel() {
  const me = useChatStore((s) => s.me)
  const open = useChatStore((s) => s.adminPanelOpen)
  const setOpen = useChatStore((s) => s.setAdminPanelOpen)

  // site admins only ever see this dialog; a demoted admin mid-session
  // loses it on the next render
  const allowed = !!me?.siteAdmin

  return (
    <Dialog open={open && allowed} onOpenChange={setOpen}>
      <DialogContent
        className="max-w-none sm:max-w-none w-[min(96vw,1180px)] h-[min(92vh,900px)] top-[4vh] translate-y-0 p-0 border-border bg-app-sidebar overflow-hidden rounded-sm flex flex-col"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Hyperion admin panel</DialogTitle>
        {allowed && <AdminPanelBody />}
      </DialogContent>
    </Dialog>
  )
}

function AdminPanelBody() {
  const me = useChatStore((s) => s.me)
  const [tab, setTab] = useState('overview')

  return (
    <Tabs value={tab} onValueChange={(v) => { sounds.play('lightTick'); setTab(v) }} className="flex-1 flex flex-col gap-0 min-h-0">
      {/* header + tab rail */}
      <div className="px-5 pt-5 pb-0 shrink-0">
        <div className="flex items-center gap-3">
          <div className="size-10 rounded-sm bg-app-raise grid place-items-center border border-white/10">
            <Shield className="size-5 text-hyper" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-extrabold tracking-tight truncate">Hyperion admin</h2>
            <p className="text-xs text-muted-foreground">
              signed in as {me?.username} · every action is enforced server-side
            </p>
          </div>
        </div>
        <TabsList className="mt-4 h-auto w-full justify-start gap-1 rounded-none border-b border-white/10 bg-transparent p-0">
          {(
            [
              ['overview', 'overview'],
              ['users', 'users'],
              ['vault', 'vault'],
              ['audit', 'audit log'],
            ] as [string, string][]
          ).map(([key, label]) => (
            <TabsTrigger
              key={key}
              value={key}
              className="h-9 rounded-none rounded-t-sm border-0 border-b-2 border-transparent px-3 text-xs font-bold tracking-wide text-muted-foreground shadow-none transition-colors hover:text-foreground data-[state=active]:border-white data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <TabsContent value="overview" className="min-h-0 overflow-y-auto scroll-thin px-5 py-5 mt-0">
        <OverviewTab active={tab === 'overview'} />
      </TabsContent>
      <TabsContent value="users" className="min-h-0 overflow-y-auto scroll-thin px-5 py-5 mt-0">
        <UsersTab active={tab === 'users'} />
      </TabsContent>
      <TabsContent value="vault" className="min-h-0 overflow-y-auto scroll-thin px-5 py-5 mt-0">
        <VaultTab active={tab === 'vault'} />
      </TabsContent>
      <TabsContent value="audit" className="min-h-0 overflow-y-auto scroll-thin px-5 py-5 mt-0">
        <AuditTab active={tab === 'audit'} />
      </TabsContent>
    </Tabs>
  )
}

/* ------------------------------------------------------------------ *
 * OVERVIEW — stat cards + the bootstrap address card                  *
 * ------------------------------------------------------------------ */

function StatCard({
  icon,
  label,
  value,
  sub,
  live,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub?: string
  live?: boolean
}) {
  return (
    <div className="bg-app-raise border border-white/10 rounded-sm p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="shrink-0">{icon}</span>
        <p className="text-[11px] font-bold tracking-widest uppercase">{label}</p>
      </div>
      <p className="mt-2 text-2xl font-extrabold tracking-tight tabular-nums">{value}</p>
      {sub && (
        <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">{sub}</p>
      )}
      {live && (
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-online font-semibold">
          <span className="size-1.5 rounded-full bg-online status-breathe" aria-hidden="true" />
          live
        </p>
      )}
    </div>
  )
}

function OverviewTab({ active }: { active: boolean }) {
  const { toast } = useToast()
  const [overview, setOverview] = useState<OverviewData | null>(null)
  const [boot, setBoot] = useState<BootstrapData | null>(null)
  const [loading, setLoading] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [editingUrl, setEditingUrl] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')
  const [now, setNow] = useState(Date.now())

  const loadOverview = useCallback(async () => {
    setLoading(true)
    try {
      setOverview(await apiClient.adminOverview())
    } catch {
      toast({ title: 'could not load the overview' })
    } finally {
      setLoading(false)
    }
  }, [toast])

  const loadBoot = useCallback(async () => {
    try {
      setBoot(await apiClient.bootstrap())
    } catch {
      // the overview card shows its own error state; stay quiet here
    }
  }, [])

  useEffect(() => {
    if (!active) return
    void loadOverview()
    void loadBoot()
  }, [active, loadOverview, loadBoot])

  // "checked Xs ago" ticks while the panel tab is open
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [active])

  async function refreshAddress() {
    setResolving(true)
    try {
      const next = await apiClient.adminSetBootstrap({ refresh: true })
      setBoot(next)
      sounds.play(next.ok ? 'lightTick' : 'error')
      if (!next.ok) {
        toast({ title: 'could not resolve the address', description: next.error ?? undefined })
      }
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not refresh',
        description: err instanceof ApiError ? err.message : 'something went wrong. try again.',
      })
    } finally {
      setResolving(false)
    }
  }

  async function saveUrl() {
    const next = urlDraft.trim()
    if (!/^https?:\/\/\S+$/i.test(next)) {
      toast({ title: 'enter a valid http(s) URL' })
      return
    }
    setResolving(true)
    try {
      const saved = await apiClient.adminSetBootstrap({ bootstrapUrl: next })
      setBoot(saved)
      setEditingUrl(false)
      sounds.play('midTick')
      toast({ title: saved.ok ? 'txt link saved — clients will read that' : 'link saved, but the check failed', description: saved.ok ? undefined : saved.error ?? undefined })
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not save the link',
        description: err instanceof ApiError ? err.message : 'something went wrong. try again.',
      })
    } finally {
      setResolving(false)
    }
  }

  async function clearCheck() {
    setResolving(true)
    try {
      const cleared = await apiClient.adminSetBootstrap({ bootstrapUrl: '' })
      setBoot(cleared)
      setEditingUrl(false)
      sounds.play('midTick')
      toast({ title: 'check cleared — the server never needed it' })
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not clear the check',
        description: err instanceof ApiError ? err.message : 'something went wrong. try again.',
      })
    } finally {
      setResolving(false)
    }
  }

  const v = overview?.vault

  return (
    <div className="space-y-5">
      {/* client discovery: what the owner's github txt currently tells
          clients — an optional sanity check; the server runs standalone */}
      <section className="bg-app-raise border border-white/10 rounded-sm p-4" aria-label="client discovery status">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Globe className="size-4 shrink-0" aria-hidden="true" />
              <p className="text-[11px] font-bold tracking-widest uppercase">client discovery</p>
              <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60 border border-white/10 rounded-sm px-1.5 py-0.5">
                optional
              </span>
            </div>
            {resolving ? (
              <div className="mt-2.5 flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="size-3.5" />
                reading the github txt…
              </div>
            ) : boot?.configured && boot.ok && boot.address ? (
              <p className="mt-2 text-lg font-extrabold tracking-tight text-online break-all" title="what clients will read from your github txt">
                {boot.address}
              </p>
            ) : boot?.configured ? (
              <div className="mt-2">
                <p className="text-sm font-bold text-destructive">unresolved</p>
                {boot.error && <p className="mt-0.5 text-xs text-destructive/80 break-words">{boot.error}</p>}
              </div>
            ) : (
              <div className="mt-2">
                <p className="text-sm font-bold text-muted-foreground">not set up</p>
                <p className="mt-0.5 text-xs text-muted-foreground/80">
                  clients read your github txt on their own — the server never needs it.
                </p>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {editingUrl ? (
              <>
                <button
                  onClick={() => void saveUrl()}
                  disabled={resolving}
                  className="h-8 px-3 rounded-sm bg-hyper text-black text-xs font-bold hover:bg-hyper/90 transition-colors disabled:opacity-50"
                  aria-label="save the txt link"
                >
                  save
                </button>
                {boot?.configured && (
                  <button
                    onClick={() => void clearCheck()}
                    disabled={resolving}
                    className="h-8 px-3 rounded-sm border border-white/15 text-xs font-bold text-muted-foreground hover:text-destructive hover:border-destructive/50 transition-colors disabled:opacity-50"
                    aria-label="stop checking the txt"
                    title="stop checking the txt"
                  >
                    stop checking
                  </button>
                )}
                <button
                  onClick={() => setEditingUrl(false)}
                  disabled={resolving}
                  className="size-8 grid place-items-center rounded-sm border border-white/15 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="cancel editing the txt link"
                >
                  <X className="size-3.5" />
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => {
                    sounds.play('lightTick')
                    setUrlDraft(boot?.bootstrapUrl ?? '')
                    setEditingUrl(true)
                  }}
                  className="size-8 grid place-items-center rounded-sm border border-white/15 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label="set the txt link to check"
                  title="set the txt link to check"
                >
                  <Pencil className="size-3.5" />
                </button>
                {boot?.configured && (
                  <button
                    onClick={() => void refreshAddress()}
                    disabled={resolving}
                    className="h-8 px-3 rounded-sm border border-hyper/50 text-hyper text-xs font-bold hover:bg-hyper/10 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    <RefreshCw className={cn('size-3.5', resolving && 'animate-spin')} aria-hidden="true" />
                    refresh
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {editingUrl ? (
          <div className="mt-3">
            <input
              autoFocus
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              maxLength={2000}
              placeholder="https://raw.githubusercontent.com/…/server.txt"
              aria-label="github txt URL to check"
              className="w-full bg-app-sidebar border border-white/10 rounded-sm px-2.5 py-1.5 text-xs outline-none focus:border-hyper/60 transition-colors placeholder:text-muted-foreground/60 font-mono break-all"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              the txt you update by hand on github — first line is the address (the tunnel link).
              clients read it directly; this server-side check is just your sanity window.
            </p>
          </div>
        ) : boot?.configured ? (
          <p className="mt-3 text-[11px] text-muted-foreground break-all font-mono" title="the github txt this check reads">
            {boot.bootstrapUrl}
          </p>
        ) : (
          <p className="mt-3 text-[11px] text-muted-foreground/70">
            you edit the txt on github yourself; clients always follow it. paste its URL here if you
            want this panel to confirm what they currently read.
          </p>
        )}
        {boot?.configured && (
          <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
            {boot.addressAt ? `checked ${checkedAgo(boot.addressAt, now) ?? 'just now'}` : 'never checked'}
          </p>
        )}
      </section>

      {/* stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard
          icon={<Users className="size-3.5" aria-hidden="true" />}
          label="users"
          value={overview ? String(overview.users.total) : '…'}
          sub={overview ? `${overview.users.verified} verified · ${overview.users.newLast7d} new this week` : undefined}
        />
        <StatCard
          icon={<MessageSquare className="size-3.5" aria-hidden="true" />}
          label="messages 24h"
          value={overview ? String(overview.messages.last24h) : '…'}
          sub={overview ? `${overview.messages.total} all time` : undefined}
        />
        <StatCard
          icon={<ServerIcon className="size-3.5" aria-hidden="true" />}
          label="servers"
          value={overview ? String(overview.servers.total) : '…'}
        />
        <StatCard
          icon={<HardDrive className="size-3.5" aria-hidden="true" />}
          label="vault disk"
          value={v ? formatBytes(v.diskUsageBytes) : '…'}
          sub={v ? `${v.uploads} uploads · ${formatBytes(v.readyBytes)} live` : undefined}
        />
        <StatCard
          icon={<Clock3 className="size-3.5" aria-hidden="true" />}
          label="expiring soon"
          value={v ? String(v.expiredSoon) : '…'}
          sub={v && v.uploading > 0 ? `${v.uploading} still uploading` : 'within 24h'}
        />
        <StatCard
          icon={<span className="size-1.5 rounded-full bg-online status-breathe" aria-hidden="true" />}
          label="online now"
          value={overview ? String(overview.onlineNow) : '…'}
          live
        />
      </div>

      {loading && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3" /> refreshing…
        </p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * USERS — search + directory + per-row actions                       *
 * ------------------------------------------------------------------ */

function UsersTab({ active }: { active: boolean }) {
  const me = useChatStore((s) => s.me)
  const { toast } = useToast()
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<AdminUserSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(
    async (q: string, p: number) => {
      setLoading(true)
      try {
        const res = await apiClient.adminUsers(q, p)
        setRows(res.users)
        setTotal(res.total)
      } catch {
        toast({ title: 'could not load users' })
      } finally {
        setLoading(false)
      }
    },
    [toast]
  )

  // typing debounces into `search` and always snaps back to page 1
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(query.trim())
      setPage(1)
    }, 250)
    return () => clearTimeout(t)
  }, [query])

  // one loader keyed on the effective (search, page) — no stale overlaps
  useEffect(() => {
    if (!active) return
    void load(search, page)
  }, [active, search, page, load])

  function applyRow(next: AdminUserSummary) {
    setRows((list) => list.map((r) => (r.id === next.id ? next : r)))
  }

  async function act(u: AdminUserSummary, action: 'verify' | 'admin' | 'ban' | 'unban', reason?: string) {
    setBusyId(u.id)
    try {
      const res = await apiClient.adminUserAction(u.id, action, reason)
      applyRow(res.user)
      sounds.play(action === 'ban' ? 'error' : 'lightTick')
      toast({ title: ACTION_LABEL[action] })
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'action failed',
        description: err instanceof ApiError ? err.message : 'something went wrong. try again.',
      })
    } finally {
      setBusyId(null)
    }
  }

  async function onBan(u: AdminUserSummary) {
    const reason = await promptDialog({
      title: `ban ${u.username}?`,
      body: 'their sessions die immediately and login is refused until the ban is lifted.',
      tone: 'warning',
      placeholder: 'reason (shown to them)',
      optional: true,
      confirmLabel: 'ban',
      maxLength: 200,
    })
    if (reason === null) return
    await act(u, 'ban', reason || undefined)
  }

  async function onUnban(u: AdminUserSummary) {
    const okToLift = await confirmDialog({
      title: `lift ${u.username}'s ban?`,
      body: 'they can sign in again right away.',
      confirmLabel: 'lift ban',
    })
    if (!okToLift) return
    await act(u, 'unban')
  }

  async function onAdmin(u: AdminUserSummary) {
    const okFlip = await confirmDialog({
      title: u.siteAdmin ? `remove ${u.username} from admins?` : `make ${u.username} a site admin?`,
      body: u.siteAdmin
        ? 'they lose the admin panel and every admin route.'
        : 'they gain the admin panel: users, bans, the vault, the address link.',
      confirmLabel: u.siteAdmin ? 'remove admin' : 'make admin',
    })
    if (!okFlip) return
    await act(u, 'admin')
  }

  const maxPage = Math.max(1, Math.ceil(total / 50))

  return (
    <div className="space-y-3">
      <div className="relative max-w-md">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" aria-hidden="true" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search username, display name, email"
          className="w-full bg-app-raise border border-white/10 rounded-sm pl-8 pr-3 py-1.5 text-sm outline-none focus:border-hyper/60 transition-colors placeholder:text-muted-foreground"
          aria-label="search users"
        />
        {loading && <Spinner className="absolute right-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />}
      </div>

      <div className="bg-app-raise border border-white/10 rounded-sm overflow-hidden">
        <table className="w-full caption-bottom text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-[11px] font-bold tracking-widest uppercase text-muted-foreground">
              <th scope="col" className="px-4 py-2.5">user</th>
              <th scope="col" className="px-4 py-2.5 hidden lg:table-cell">email</th>
              <th scope="col" className="px-4 py-2.5 hidden md:table-cell">created</th>
              <th scope="col" className="px-4 py-2.5 hidden xl:table-cell">activity</th>
              <th scope="col" className="px-4 py-2.5 text-right">actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.06]">
            {rows.map((u) => {
              const self = u.id === me?.id
              return (
                <tr key={u.id} className="align-middle hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Avatar name={u.username} color={u.avatarColor} url={u.avatarUrl} size="md" />
                      <div className="min-w-0 leading-tight">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[13px] font-semibold truncate">{u.username}</span>
                          {u.siteAdmin && (
                            <span className="text-hyper border border-hyper/40 px-1.5 rounded-sm text-[10px] font-bold tracking-wide shrink-0">
                              admin
                            </span>
                          )}
                          {u.banned && (
                            <span className="text-destructive border border-destructive/40 px-1.5 rounded-sm text-[10px] font-bold tracking-wide shrink-0">
                              banned
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {u.email ?? 'no email'}
                          {u.verified ? (
                            <Check className="inline size-3 ml-1 text-online align-[-2px]" aria-label="email verified" />
                          ) : (
                            <span className="ml-1 text-muted-foreground/60">unverified</span>
                          )}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-xs text-muted-foreground">{u.email ?? '—'}</td>
                  <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">{formatJoinDate(u.createdAt)}</td>
                  <td className="px-4 py-3 hidden xl:table-cell text-xs text-muted-foreground tabular-nums">
                    {u.serverCount} servers · {u.messageCount} msgs
                    {u.lastMessageAt && <span className="block text-muted-foreground/70">last {relativeTime(u.lastMessageAt)}</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1.5 flex-wrap">
                      {busyId === u.id && <Spinner className="size-3.5 text-muted-foreground" />}
                      <RowAction
                        label={u.verified ? 'unverify' : 'verify'}
                        title={u.verified ? 'remove the verified flag' : 'mark the email as verified'}
                        onClick={() => void act(u, 'verify')}
                        disabled={busyId === u.id}
                      />
                      {!self && (
                        <RowAction
                          label={u.siteAdmin ? 'remove admin' : 'make admin'}
                          icon={u.siteAdmin ? <ShieldOff className="size-3" /> : <ShieldCheck className="size-3" />}
                          title={u.siteAdmin ? 'revoke site admin' : 'grant site admin'}
                          onClick={() => void onAdmin(u)}
                          disabled={busyId === u.id}
                        />
                      )}
                      {u.banned ? (
                        <RowAction
                          label="unban"
                          title="lift the site ban"
                          onClick={() => void onUnban(u)}
                          disabled={busyId === u.id}
                        />
                      ) : (
                        !self && (
                          <RowAction
                            label="ban"
                            icon={<Ban className="size-3" />}
                            title="ban this account"
                            tone="danger"
                            onClick={() => void onBan(u)}
                            disabled={busyId === u.id}
                          />
                        )
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-xs text-muted-foreground">
                  no users match that search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pager page={page} maxPage={maxPage} total={total} onPage={setPage} noun="users" />
    </div>
  )
}

const ACTION_LABEL: Record<'verify' | 'admin' | 'ban' | 'unban', string> = {
  verify: 'account updated',
  admin: 'admin flag updated',
  ban: 'account banned',
  unban: 'ban lifted',
}

function RowAction({
  label,
  icon,
  title,
  onClick,
  disabled,
  tone,
}: {
  label: string
  icon?: React.ReactNode
  title: string
  onClick: () => void
  disabled?: boolean
  tone?: 'danger'
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded-sm border transition-colors disabled:opacity-50',
        tone === 'danger'
          ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
          : 'border-white/15 text-muted-foreground hover:text-foreground hover:border-white/30'
      )}
    >
      {icon}
      {label}
    </button>
  )
}

/* ------------------------------------------------------------------ *
 * VAULT — every upload + force-expire                                *
 * ------------------------------------------------------------------ */

function VaultTab({ active }: { active: boolean }) {
  const { toast } = useToast()
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<AdminVaultUpload[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(
    async (p: number) => {
      setLoading(true)
      try {
        const res = await apiClient.adminVault(p)
        setRows(res.uploads)
        setTotal(res.total)
      } catch {
        toast({ title: 'could not load the vault' })
      } finally {
        setLoading(false)
      }
    },
    [toast]
  )

  useEffect(() => {
    if (!active) return
    void load(page)
  }, [active, page, load])

  async function onExpire(u: AdminVaultUpload) {
    const ok = await confirmDialog({
      title: `force-expire ${u.filename}?`,
      body: `deletes the upload (${formatBytes(u.size)}), its chunks on disk, and the file card in chat. this cannot be undone.`,
      tone: 'danger',
      confirmLabel: 'force-expire',
    })
    if (!ok) return
    setBusyId(u.id)
    try {
      await apiClient.adminVaultExpire(u.id)
      sounds.play('lightTick')
      toast({ title: 'upload expired' })
      await load(page)
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not expire the upload',
        description: err instanceof ApiError ? err.message : 'something went wrong. try again.',
      })
    } finally {
      setBusyId(null)
    }
  }

  const maxPage = Math.max(1, Math.ceil(total / 50))

  return (
    <div className="space-y-3">
      {loading && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner className="size-3" /> loading…
        </p>
      )}
      <div className="bg-app-raise border border-white/10 rounded-sm overflow-hidden">
        <table className="w-full caption-bottom text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-[11px] font-bold tracking-widest uppercase text-muted-foreground">
              <th scope="col" className="px-4 py-2.5">file</th>
              <th scope="col" className="px-4 py-2.5 hidden sm:table-cell">size</th>
              <th scope="col" className="px-4 py-2.5">status</th>
              <th scope="col" className="px-4 py-2.5 hidden md:table-cell">expires in</th>
              <th scope="col" className="px-4 py-2.5 hidden lg:table-cell">uploader</th>
              <th scope="col" className="px-4 py-2.5 hidden lg:table-cell">downloads</th>
              <th scope="col" className="px-4 py-2.5 text-right">action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.06]">
            {rows.map((u) => (
              <tr key={u.id} className="align-middle hover:bg-white/[0.02] transition-colors">
                <td className="px-4 py-3">
                  <p className="text-[13px] font-semibold truncate max-w-[16rem]" title={u.filename}>{u.filename}</p>
                  <p className="text-[11px] text-muted-foreground sm:hidden tabular-nums">{formatBytes(u.size)}</p>
                </td>
                <td className="px-4 py-3 hidden sm:table-cell text-xs text-muted-foreground tabular-nums">{formatBytes(u.size)}</td>
                <td className="px-4 py-3">
                  <span
                    className={cn(
                      'text-[11px] font-bold px-1.5 py-0.5 rounded-sm border',
                      u.status === 'ready'
                        ? 'text-online border-online/40'
                        : u.status === 'uploading'
                          ? 'text-idle border-idle/40'
                          : 'text-muted-foreground border-white/15'
                    )}
                  >
                    {u.status}
                  </span>
                </td>
                <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground tabular-nums">{formatRemaining(u.expiresAt)}</td>
                <td className="px-4 py-3 hidden lg:table-cell text-xs text-muted-foreground">
                  {u.uploader ? u.uploader.username : '—'}
                </td>
                <td className="px-4 py-3 hidden lg:table-cell text-xs text-muted-foreground tabular-nums">
                  <span className="inline-flex items-center gap-1">
                    <Download className="size-3" aria-hidden="true" />
                    {u.downloadCount}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  {busyId === u.id ? (
                    <Spinner className="size-3.5 text-muted-foreground inline" />
                  ) : (
                    <RowAction
                      label="force-expire"
                      icon={<Trash2 className="size-3" />}
                      title="delete this upload now"
                      tone="danger"
                      onClick={() => void onExpire(u)}
                    />
                  )}
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-xs text-muted-foreground">
                  the vault is empty.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} maxPage={maxPage} total={total} onPage={setPage} noun="uploads" />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * AUDIT — the existing ServerEvent log, latest 100                   *
 * ------------------------------------------------------------------ */

function AuditTab({ active }: { active: boolean }) {
  const { toast } = useToast()
  const [events, setEvents] = useState<AdminAuditEvent[] | null>(null)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    apiClient
      .adminAudit()
      .then((res) => {
        if (!cancelled) setEvents(res.events)
      })
      .catch(() => toast({ title: 'could not load the audit log' }))
    return () => {
      cancelled = true
    }
  }, [active, toast])

  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <ScrollText className="size-3.5" aria-hidden="true" />
        the latest 100 events across every server.
      </p>
      <div className="bg-app-raise border border-white/10 rounded-sm max-h-96 overflow-y-auto scroll-thin" aria-label="audit log">
        {events === null ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground flex items-center justify-center gap-2">
            <Spinner className="size-3.5" /> loading…
          </p>
        ) : events.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">no events yet.</p>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {events.map((e) => (
              <div key={e.id} className="px-4 py-2.5 flex items-start gap-2.5">
                <Gavel className="size-3.5 text-muted-foreground mt-0.5 shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1 leading-snug">
                  <p className="text-[13px]">
                    <span className="font-semibold">{e.actor ?? 'someone'}</span>{' '}
                    <span className="text-muted-foreground">{AUDIT_LABELS[e.type] ?? e.type}</span>{' '}
                    {e.target && e.target !== e.actor && <span className="font-semibold">{e.target}</span>}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {e.serverName} · {relativeTime(e.createdAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * shared pager                                                        *
 * ------------------------------------------------------------------ */

function Pager({
  page,
  maxPage,
  total,
  onPage,
  noun,
}: {
  page: number
  maxPage: number
  total: number
  onPage: (page: number) => void
  noun: string
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-[11px] text-muted-foreground tabular-nums">
        {total} {noun}
      </p>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="size-8 grid place-items-center rounded-sm border border-white/15 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
          aria-label="previous page"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-[11px] text-muted-foreground tabular-nums px-1">
          {page} / {maxPage}
        </span>
        <button
          onClick={() => onPage(Math.min(maxPage, page + 1))}
          disabled={page >= maxPage}
          className="size-8 grid place-items-center rounded-sm border border-white/15 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
          aria-label="next page"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  )
}
