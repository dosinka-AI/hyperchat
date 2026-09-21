/**
 * Discord-style audit log panel (Task 67 upgrade of the old flat list).
 * Renders AuditEventSummary rows with: category filter chips, actor filter,
 * tone-coded action icons, day grouping headers, and expandable detail rows.
 */
import { useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Eraser,
  Gavel,
  Hammer,
  Hash,
  Link2,
  LogIn,
  LogOut,
  MessageSquare,
  Settings,
  Shield,
  Tag,
  Trash2,
  UserMinus,
  UserPlus,
  UserRound,
  Clock,
  ScrollText,
  ImageIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AuditEventSummary } from '@/lib/types'

// ---------------------------------------------------------------------------
// catalog: tone + icon per event type

type Tone = 'danger' | 'warn' | 'good' | 'neutral'

interface ActionMeta {
  label: string
  icon: typeof Hash
  tone: Tone
}

const ACTIONS: Record<string, ActionMeta> = {
  member_join: { label: 'joined the server', icon: LogIn, tone: 'good' },
  member_leave: { label: 'left the server', icon: LogOut, tone: 'neutral' },
  member_kick: { label: 'kicked', icon: UserMinus, tone: 'warn' },
  member_ban: { label: 'banned', icon: Hammer, tone: 'danger' },
  member_unban: { label: 'unbanned', icon: Gavel, tone: 'good' },
  member_timeout: { label: 'timed out', icon: Clock, tone: 'warn' },
  timeout_clear: { label: 'removed a timeout from', icon: Clock, tone: 'good' },
  role_change: { label: 'changed the rank of', icon: Shield, tone: 'neutral' },
  role_create: { label: 'created a role', icon: Shield, tone: 'good' },
  role_update: { label: 'updated a role', icon: Shield, tone: 'neutral' },
  role_delete: { label: 'deleted a role', icon: Shield, tone: 'danger' },
  role_assign: { label: 'set a role on', icon: Tag, tone: 'neutral' },
  nickname_change: { label: 'changed the nickname of', icon: Tag, tone: 'neutral' },
  channel_create: { label: 'created a channel', icon: Hash, tone: 'good' },
  channel_delete: { label: 'deleted a channel', icon: Trash2, tone: 'danger' },
  channel_update: { label: 'updated a channel', icon: Hash, tone: 'neutral' },
  channel_purge: { label: 'purged messages in', icon: Eraser, tone: 'danger' },
  message_delete: { label: 'deleted a message from', icon: MessageSquare, tone: 'warn' },
  category_create: { label: 'created a category', icon: Hash, tone: 'good' },
  category_delete: { label: 'deleted a category', icon: Trash2, tone: 'danger' },
  server_update: { label: 'updated the server', icon: Settings, tone: 'neutral' },
  member_avatar_change: { label: 'changed a server avatar', icon: ImageIcon, tone: 'neutral' },
  banner_change: { label: 'changed the server banner', icon: ImageIcon, tone: 'neutral' },
  invite_create: { label: 'created an invite', icon: Link2, tone: 'good' },
  invite_delete: { label: 'revoked an invite', icon: Link2, tone: 'warn' },
}

const FALLBACK: ActionMeta = { label: 'did something', icon: UserRound, tone: 'neutral' }

// categories for the filter chips
const CATEGORIES: { key: string; label: string; types: RegExp }[] = [
  { key: 'members', label: 'members', types: /^member_|^timeout_clear|^role_assign|^nickname_change/ },
  { key: 'roles', label: 'roles', types: /^role_/ },
  { key: 'channels', label: 'channels', types: /^channel_|^category_/ },
  { key: 'messages', label: 'messages', types: /^message_delete/ },
  { key: 'server', label: 'server', types: /^server_|^banner_change|^invite_/ },
]

const TONE_ICON: Record<Tone, string> = {
  danger: 'text-red-400 bg-red-500/10',
  warn: 'text-amber-400 bg-amber-500/10',
  good: 'text-emerald-400 bg-emerald-500/10',
  neutral: 'text-muted-foreground bg-app-raise',
}

// ---------------------------------------------------------------------------
// helpers

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, today)) return 'today'
  if (sameDay(d, yesterday)) return 'yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function detailOf(event: AuditEventSummary): string {
  const d = event.data as {
    name?: string
    reason?: string
    role?: string
    reordered?: boolean
    count?: number
    nickname?: string
    slowmodeSeconds?: number
    locked?: boolean
    private?: boolean
    code?: string
    detail?: string
    inviteRegenerated?: boolean
  }
  let detail = ''
  if (d.name) detail = d.name
  if (d.detail) detail = d.detail
  if (d.role) detail = `to ${String(d.role).toLowerCase()}`
  if (d.nickname) detail = `to "${d.nickname}"`
  if (typeof d.count === 'number') detail = `${d.count} message${d.count === 1 ? '' : 's'}`
  if (d.code) detail = d.code
  if (d.reordered) detail = 'reordered the sidebar'
  if (typeof d.slowmodeSeconds === 'number') detail = `slowmode ${d.slowmodeSeconds}s`
  if (d.inviteRegenerated) detail = 'invite code regenerated'
  if (d.reason) detail = detail ? `${detail} · reason: ${d.reason}` : `reason: ${d.reason}`
  return detail
}

function rawEntries(event: AuditEventSummary): [string, string][] {
  return Object.entries(event.data ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])
}

// ---------------------------------------------------------------------------
// panel

export function AuditLogPanel({ events }: { events: AuditEventSummary[] }) {
  const [category, setCategory] = useState<string>('all')
  const [actorId, setActorId] = useState<string>('all')
  const [expanded, setExpanded] = useState<string | null>(null)

  const actors = useMemo(() => {
    const map = new Map<string, string>()
    for (const e of events) {
      if (e.actor) map.set(e.actor.id, e.actor.displayName || e.actor.username)
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }))
  }, [events])

  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (actorId !== 'all' && e.actor?.id !== actorId) return false
      if (category === 'all') return true
      const cat = CATEGORIES.find((c) => c.key === category)
      return cat ? cat.types.test(e.type) : true
    })
  }, [events, category, actorId])

  // group by day preserving order
  const groups = useMemo(() => {
    const out: { day: string; items: AuditEventSummary[] }[] = []
    for (const e of filtered) {
      const day = dayLabel(e.createdAt)
      const last = out[out.length - 1]
      if (last && last.day === day) last.items.push(e)
      else out.push({ day, items: [e] })
    }
    return out
  }, [filtered])

  const activeFilters = category !== 'all' || actorId !== 'all'

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <ScrollText className="size-3.5" />
        the official record of who did what. newest {events.length} event{events.length === 1 ? '' : 's'}.
      </p>

      {/* filter row: category chips + actor dropdown */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setCategory('all')}
          className={cn(
            'rounded-sm border px-2 py-1 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            category === 'all'
              ? 'border-hyper/40 bg-hyper/10 text-hyper'
              : 'border-white/10 text-muted-foreground hover:border-hyper/50 hover:bg-hyper/10 hover:text-hyper'
          )}
        >
          all
        </button>
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => setCategory(category === c.key ? 'all' : c.key)}
            className={cn(
              'rounded-sm border px-2 py-1 text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              category === c.key
                ? 'border-hyper/40 bg-hyper/10 text-hyper'
                : 'border-white/10 text-muted-foreground hover:border-hyper/50 hover:bg-hyper/10 hover:text-hyper'
            )}
          >
            {c.label}
          </button>
        ))}

        <div className="relative ml-auto">
          <select
            aria-label="filter by moderator"
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
            className="appearance-none rounded-sm border border-white/10 bg-app-raise py-1 pl-2 pr-7 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-hyper/50 hover:text-hyper focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="all">everyone</option>
            {actors.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        </div>

        {activeFilters && (
          <button
            type="button"
            onClick={() => {
              setCategory('all')
              setActorId('all')
            }}
            className="rounded-sm px-2 py-1 text-[11px] font-semibold text-muted-foreground underline decoration-dotted underline-offset-2 transition-colors hover:text-hyper"
          >
            clear ({filtered.length})
          </button>
        )}
      </div>

      {events.length === 0 && <p className="text-sm text-muted-foreground py-4">nothing has happened yet.</p>}
      {events.length > 0 && filtered.length === 0 && (
        <p className="text-sm text-muted-foreground py-4">no events match those filters.</p>
      )}

      {groups.map((g) => (
        <div key={g.day} className="space-y-0.5">
          <div className="sticky top-0 z-10 -mx-1 bg-app-sidebar/95 px-1 py-1">
            <p className="text-[10px] font-bold uppercase tracking-widest text-hyper/70">{g.day}</p>
          </div>
          {g.items.map((event) => {
            const meta = ACTIONS[event.type] ?? FALLBACK
            const Icon = meta.icon
            const actor = event.actor?.displayName || event.actor?.username || 'someone'
            const target = event.targetUser?.displayName || event.targetUser?.username
            const detail = detailOf(event)
            const raw = rawEntries(event)
            const open = expanded === event.id
            return (
              <div key={event.id} className="rounded-sm hover:bg-app-raise/60 transition-colors">
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : event.id)}
                  aria-expanded={open}
                  className="flex w-full items-start gap-2.5 px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring rounded-sm"
                >
                  <span
                    className={cn(
                      'mt-0.5 grid size-6 shrink-0 place-items-center rounded-sm',
                      TONE_ICON[meta.tone]
                    )}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-xs leading-relaxed block">
                      <span className="font-semibold">{actor}</span>{' '}
                      <span className="text-muted-foreground">{meta.label}</span>
                      {target && <span className="font-semibold"> {target}</span>}
                      {detail && <span className="text-muted-foreground"> · {detail}</span>}
                    </span>
                    {open && raw.length > 0 && (
                      <span className="mt-1.5 block space-y-1">
                        {raw.map(([k, v]) => (
                          <span key={k} className="flex gap-2 text-[11px] leading-snug">
                            <span className="w-28 shrink-0 text-right text-muted-foreground/70">{k}</span>
                            <span className="min-w-0 break-all text-foreground/80">{v}</span>
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {relativeTime(event.createdAt)}
                    </span>
                    {raw.length > 0 &&
                      (open ? (
                        <ChevronDown className="size-3 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-3 text-muted-foreground" />
                      ))}
                  </span>
                </button>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
