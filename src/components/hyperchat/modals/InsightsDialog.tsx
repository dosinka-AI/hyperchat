/**
 * Server Insights (Discord Server Insights parity, Task 67).
 * 14-day activity window: member growth, message volume, busiest hours,
 * top channels + top talkers. Pure-CSS bar charts, no chart lib.
 */
import { useEffect, useState } from 'react'
import { BarChart3, Hash, TrendingUp, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/lib/client/store'
import { apiClient, ApiError } from '@/lib/client/api'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import type { InsightsPayload } from '@/lib/types'

function shortDay(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' })
}

/** Row of bars: staggered grow-in animation, hyper tint, hover tooltip. */
function BarChart({ data, tone }: { data: { date: string; count: number }[]; tone: 'hyper' | 'green' }) {
  const max = Math.max(1, ...data.map((d) => d.count))
  const total = data.reduce((a, d) => a + d.count, 0)
  return (
    <div>
      <div className="flex h-24 items-end gap-1" role="img" aria-label={`${total} events over ${data.length} days`}>
        {data.map((d, i) => (
          <div
            key={d.date}
            className="group relative flex h-full flex-1 items-end"
            title={`${d.date}: ${d.count}`}
          >
            <div
              className={cn(
                'w-full rounded-sm transition-[height] duration-500',
                tone === 'hyper' ? 'bg-hyper/70 group-hover:bg-hyper' : 'bg-emerald-500/70 group-hover:bg-emerald-400',
                d.count === 0 && 'bg-white/8 group-hover:bg-white/15'
              )}
              style={{
                height: `${Math.max(d.count === 0 ? 3 : 8, (d.count / max) * 100)}%`,
                animation: `fluid-pop 380ms ${i * 22}ms cubic-bezier(0.32,0.72,0,1) backwards`,
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-1">
        {data.map((d, i) => (
          <span key={d.date} className="flex-1 text-center text-[9px] text-muted-foreground/70">
            {i % 2 === 0 ? shortDay(d.date) : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
}: {
  label: string
  value: string
  sub?: string
  icon: typeof Users
}) {
  return (
    <div className="rounded-sm border border-white/10 bg-app-raise/60 p-3">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="size-3.5" />
        <span className="text-[11px] font-semibold">{label}</span>
      </div>
      <p className="mt-1 text-2xl font-extrabold tabular-nums tracking-tight">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

export function InsightsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const servers = useChatStore((s) => s.servers)
  const activeServerId = useChatStore((s) => s.activeServerId)
  const server = servers.find((s) => s.id === activeServerId) ?? null

  const [data, setData] = useState<InsightsPayload | null>(null)
  /** which server the loaded payload belongs to (stale rows hide on switch) */
  const [dataFor, setDataFor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !activeServerId) return
    let cancelled = false
    // all state flips ride the async callbacks (lint-clean pattern): while
    // in flight the panel shows its spinner; a server switch mid-fetch only
    // lands if this effect is still the live one
    apiClient
      .serverInsights(activeServerId)
      .then((res) => {
        if (cancelled) return
        setData(res)
        setDataFor(activeServerId)
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'could not load insights.')
      })
    return () => {
      cancelled = true
    }
  }, [open, activeServerId])

  const loading = open && dataFor !== activeServerId && error === null
  const live = dataFor === activeServerId ? data : null

  const maxHour = Math.max(1, ...(live?.hours ?? [1]))
  const maxChannel = Math.max(1, ...(live?.topChannels ?? []).map((c) => c.count))
  const maxMember = Math.max(1, ...(live?.topMembers ?? []).map((m) => m.count))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(94vw,680px)] rounded-sm border-border bg-app-sidebar p-0 overflow-hidden">
        <div className="h-2.5 shrink-0 bg-app-raise border-b border-white/10" />
        <div className="p-5 pt-4 space-y-5 max-h-[78vh] overflow-y-auto">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle className="text-lg font-extrabold tracking-tight lowercase">
              {server?.name ?? 'server'} insights
            </DialogTitle>
            <span className="text-[11px] font-semibold text-muted-foreground">last 14 days</span>
          </div>

          {loading && (
            <div className="grid place-items-center py-16">
              <Spinner className="size-5 text-hyper" />
            </div>
          )}
          {error && <p className="py-8 text-center text-sm text-red-400">{error}</p>}

          {live && (
            <>
              {/* stat cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <StatCard
                  label="members"
                  value={String(live.members.total)}
                  sub={`${live.members.online} online now`}
                  icon={Users}
                />
                <StatCard
                  label="new members"
                  value={String(live.members.joined14d)}
                  sub={`${live.members.joined7d} in the last 7d`}
                  icon={TrendingUp}
                />
                <StatCard
                  label="active members"
                  value={String(live.activeMembers14d)}
                  sub="posted in the last 14d"
                  icon={Users}
                />
                <StatCard
                  label="messages"
                  value={String(live.messages.last14d)}
                  sub={`${live.messages.today} today · ${live.messages.total} all time`}
                  icon={BarChart3}
                />
              </div>

              {/* charts */}
              <div className="grid gap-5 sm:grid-cols-2">
                <section className="space-y-2">
                  <h3 className="text-[11px] font-bold uppercase tracking-widest text-hyper/70">new members per day</h3>
                  <BarChart data={live.joinsByDay} tone="green" />
                </section>
                <section className="space-y-2">
                  <h3 className="text-[11px] font-bold uppercase tracking-widest text-hyper/70">messages per day</h3>
                  <BarChart data={live.messagesByDay} tone="hyper" />
                </section>
              </div>

              {/* busiest hours */}
              <section className="space-y-2">
                <h3 className="text-[11px] font-bold uppercase tracking-widest text-hyper/70">busiest hours</h3>
                <div className="flex items-end gap-0.5 h-14" role="img" aria-label="message volume by hour of day">
                  {live.hours.map((count, hour) => (
                    <div
                      key={hour}
                      className="group relative flex-1"
                      title={`${hour.toString().padStart(2, '0')}:00 — ${count} message${count === 1 ? '' : 's'}`}
                    >
                      <div
                        className={cn(
                          'w-full rounded-[2px] group-hover:bg-hyper',
                          count === 0 ? 'bg-white/8' : 'bg-hyper/60'
                        )}
                        style={{ height: `${Math.max(count === 0 ? 2 : 10, (count / maxHour) * 56)}px` }}
                      />
                    </div>
                  ))}
                </div>
                <div className="flex justify-between text-[9px] text-muted-foreground/70">
                  <span>12am</span>
                  <span>6am</span>
                  <span>12pm</span>
                  <span>6pm</span>
                  <span>11pm</span>
                </div>
              </section>

              {/* top lists */}
              <div className="grid gap-5 sm:grid-cols-2">
                <section className="space-y-2">
                  <h3 className="text-[11px] font-bold uppercase tracking-widest text-hyper/70">top channels</h3>
                  {live.topChannels.length === 0 && (
                    <p className="text-xs text-muted-foreground">no messages in the window.</p>
                  )}
                  <div className="space-y-1.5">
                    {live.topChannels.map((c) => (
                      <div key={c.name} className="space-y-0.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="flex items-center gap-1 font-semibold">
                            <Hash className="size-3 text-muted-foreground" />
                            {c.name}
                          </span>
                          <span className="tabular-nums text-muted-foreground">{c.count}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-white/6 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-hyper/70"
                            style={{ width: `${(c.count / maxChannel) * 100}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="space-y-2">
                  <h3 className="text-[11px] font-bold uppercase tracking-widest text-hyper/70">top talkers</h3>
                  {live.topMembers.length === 0 && (
                    <p className="text-xs text-muted-foreground">no messages in the window.</p>
                  )}
                  <div className="space-y-1.5">
                    {live.topMembers.map((m) => (
                      <div key={m.name} className="space-y-0.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="truncate font-semibold">{m.name}</span>
                          <span className="tabular-nums text-muted-foreground">{m.count}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-white/6 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-emerald-500/60"
                            style={{ width: `${(m.count / maxMember) * 100}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
