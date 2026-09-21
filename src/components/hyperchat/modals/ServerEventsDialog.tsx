'use client'

import { useEffect, useMemo, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { sounds } from '@/lib/client/sounds'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { CalendarPlus, CalendarClock, Users, Volume2, X, Trash2, Ban, Check, MapPin } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { ApiError } from '@/lib/client/api'
import { confirmDialog } from '../ConfirmDialog'
import { Avatar } from '../Avatar'
import type { ScheduledEventSummary } from '@/lib/types'
import type { ChannelSummary, ServerSummary } from '@/lib/types'

/** Discord-style scheduled server events: what is happening, when, where
 *  (optionally a channel), and who is going. Moderators schedule and cancel;
 *  everyone flips their own RSVP. Live events glow hyper. */

function eventPhase(e: ScheduledEventSummary): 'upcoming' | 'live' | 'ended' | 'canceled' {
  if (e.canceledAt) return 'canceled'
  const start = new Date(e.startsAt).getTime()
  const end = e.endsAt ? new Date(e.endsAt).getTime() : start + 4 * 3600_000
  const now = Date.now()
  if (now >= start && now <= end) return 'live'
  if (now > end) return 'ended'
  return 'upcoming'
}

function whenLabel(e: ScheduledEventSummary): string {
  const start = new Date(e.startsAt)
  const now = new Date()
  const sameYear = start.getFullYear() === now.getFullYear()
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(sameYear ? {} : { year: 'numeric' }),
  }
  return new Intl.DateTimeFormat(undefined, opts).format(start)
}

function countdownLabel(e: ScheduledEventSummary): string {
  const diff = new Date(e.startsAt).getTime() - Date.now()
  if (diff <= 0) return 'happening now'
  const mins = Math.round(diff / 60_000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `in ${hours}h ${mins % 60}m`
  return `in ${Math.floor(hours / 24)}d`
}

export function ServerEventsDialog({ open, onOpenChange, server }: { open: boolean; onOpenChange: (open: boolean) => void; server: ServerSummary | null }) {
  const me = useChatStore((s) => s.me)
  const events = useChatStore((s) => (server ? s.serverEvents[server.id] : undefined)) ?? []
  const loadServerEvents = useChatStore((s) => s.loadServerEvents)
  const createServerEvent = useChatStore((s) => s.createServerEvent)
  const cancelServerEvent = useChatStore((s) => s.cancelServerEvent)
  const toggleEventAttendance = useChatStore((s) => s.toggleEventAttendance)
  const selectChannel = useChatStore((s) => s.selectChannel)
  const { toast } = useToast()

  const canManage = !!server && (server.myPerms & (1 | 2)) !== 0 // ADMINISTRATOR | MANAGE_SERVER
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [channelId, setChannelId] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open && server) void loadServerEvents(server.id)
  }, [open, server?.id, loadServerEvents])

  const voiceChannels = useMemo<ChannelSummary[]>(
    () => (server?.channels ?? []).filter((c) => c.type === 'voice' || c.type === 'stage'),
    [server?.channels]
  )

  const { upcoming, past } = useMemo(() => {
    const live: ScheduledEventSummary[] = []
    const soon: ScheduledEventSummary[] = []
    const ended: ScheduledEventSummary[] = []
    for (const e of events) {
      const phase = eventPhase(e)
      if (phase === 'live' || phase === 'upcoming') (phase === 'live' ? live : soon).push(e)
      else ended.push(e)
    }
    return { upcoming: [...live, ...soon], past: ended }
  }, [events])

  async function submit() {
    if (!server || !name.trim() || !startsAt || busy) return
    setBusy(true)
    try {
      await createServerEvent(server.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        startsAt: new Date(startsAt).toISOString(),
        channelId: channelId || null,
      })
      setName('')
      setDescription('')
      setStartsAt('')
      setChannelId('')
      setCreating(false)
    } catch (err) {
      toast({ title: 'could not schedule the event', description: err instanceof ApiError ? err.message : 'Try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 border-border bg-app-sidebar overflow-hidden rounded-sm top-6 translate-y-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">events in {server?.name}</DialogTitle>
        <div className="px-5 pt-5 pb-3 border-b border-white/10 flex items-center justify-between gap-2">
          <h2 className="text-base font-extrabold tracking-tight flex items-center gap-2">
            <CalendarClock className="size-4 text-hyper" />
            events
          </h2>
          {canManage && !creating && (
            <Button size="sm" className="rounded-sm h-7 px-2.5" onClick={() => { sounds.play('lightTick'); setCreating(true) }}>
              <CalendarPlus className="size-3.5" />
              schedule
            </Button>
          )}
        </div>

        <div className="px-5 py-4 space-y-3 max-h-[65vh] overflow-y-auto scroll-thin">
          {creating && (
            <div className="rounded-sm border border-hyper/30 bg-hyper/5 p-3 space-y-2.5">
              <div className="space-y-1.5">
                <Label htmlFor="event-name">event name</Label>
                <Input id="event-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="movie night, dev q&a, raid prep" className="rounded-sm h-8" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="event-desc">description, optional</Label>
                <Input id="event-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={400} placeholder="what is happening" className="rounded-sm h-8" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="event-start">starts</Label>
                  <Input id="event-start" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="rounded-sm h-8" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="event-channel">where, optional</Label>
                  <select
                    id="event-channel"
                    value={channelId}
                    onChange={(e) => setChannelId(e.target.value)}
                    className="h-8 w-full rounded-sm bg-app-raise border border-white/10 px-2 text-xs outline-none focus:border-hyper/50"
                  >
                    <option value="">nowhere in particular</option>
                    {voiceChannels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.type === 'stage' ? 'stage · ' : ''}
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 pt-0.5">
                <Button variant="ghost" size="sm" className="rounded-sm h-7" onClick={() => setCreating(false)}>
                  cancel
                </Button>
                <Button size="sm" className="rounded-sm h-7" disabled={!name.trim() || !startsAt || busy} onClick={() => void submit()}>
                  {busy ? 'scheduling' : 'schedule event'}
                </Button>
              </div>
            </div>
          )}

          {upcoming.length === 0 && past.length === 0 && !creating && (
            <p className="text-xs text-muted-foreground text-center py-8">
              nothing scheduled yet{canManage ? '. hit schedule to plan something.' : '.'}
            </p>
          )}

          {upcoming.map((e) => {
            const phase = eventPhase(e)
            return (
              <div key={e.id} className={cn('rounded-sm border p-3 space-y-2', phase === 'live' ? 'border-hyper/50 bg-hyper/[0.07]' : 'border-white/10 bg-app-raise/40')}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-bold tracking-tight truncate flex items-center gap-1.5">
                      {phase === 'live' && <span className="size-1.5 rounded-full bg-hyper animate-pulse shrink-0" aria-hidden="true" />}
                      {e.name}
                    </p>
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 mt-0.5 flex-wrap">
                      <CalendarClock className="size-3 shrink-0" aria-hidden="true" />
                      <span className="font-semibold">{whenLabel(e)}</span>
                      <span className="text-muted-foreground/60">·</span>
                      <span className={phase === 'live' ? 'text-hyper font-semibold' : ''}>{countdownLabel(e)}</span>
                      {e.channelName && (
                        <>
                          <span className="text-muted-foreground/60">·</span>
                          <button
                            onClick={() => {
                              sounds.play('lightTick')
                              if (e.channelId) void selectChannel(e.channelId)
                            }}
                            className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
                            aria-label={`go to ${e.channelName}`}
                          >
                            <Volume2 className="size-3" aria-hidden="true" />
                            {e.channelName}
                          </button>
                        </>
                      )}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'px-1.5 py-0.5 rounded-full text-[9px] font-bold tracking-wide uppercase shrink-0 border',
                      phase === 'live'
                        ? 'bg-hyper/20 border-hyper/50 text-hyper'
                        : phase === 'upcoming'
                          ? 'bg-app-raise border-white/15 text-muted-foreground'
                          : 'bg-app-raise border-white/10 text-muted-foreground/60'
                    )}
                  >
                    {phase === 'live' ? 'live' : phase === 'upcoming' ? 'upcoming' : 'ended'}
                  </span>
                </div>
                {e.description && <p className="text-[12px] text-muted-foreground leading-[1.35] line-clamp-3">{e.description}</p>}
                <div className="flex items-center justify-between gap-2 pt-0.5">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {e.attendees.slice(0, 5).map((a) => (
                      <span key={a.userId} title={a.displayName || a.username} className="shrink-0">
                        <Avatar name={a.username} color={a.avatarColor} url={a.avatarUrl} size="sm" className="size-5 rounded-full" />
                      </span>
                    ))}
                    <span className="text-[10px] text-muted-foreground font-semibold tabular-nums shrink-0">
                      {e.attendeeCount === 1 ? '1 going' : `${e.attendeeCount} going`}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {canManage && (
                      <>
                        <button
                          onClick={() => {
                            void (async () => {
                              if (await confirmDialog({ title: `cancel "${e.name}"?`, body: 'the event stays listed as canceled.', tone: 'danger', confirmLabel: 'cancel event' })) {
                                void cancelServerEvent(e.id, 'cancel')
                              }
                            })()
                          }}
                          className="grid place-items-center size-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                          aria-label={`cancel ${e.name}`}
                          title="cancel event"
                        >
                          <Ban className="size-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            void (async () => {
                              if (await confirmDialog({ title: `delete "${e.name}"?`, body: 'it disappears from the list entirely.', tone: 'danger', confirmLabel: 'delete event' })) {
                                void cancelServerEvent(e.id, 'delete')
                              }
                            })()
                          }}
                          className="grid place-items-center size-6 rounded-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          aria-label={`delete ${e.name}`}
                          title="delete event"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </>
                    )}
                    {phase !== 'ended' && (
                      <button
                        onClick={() => void toggleEventAttendance(e.id)}
                        className={cn(
                          'flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold transition-colors',
                          e.iAmGoing ? 'bg-hyper text-black hover:bg-hyper/85' : 'border border-white/15 text-muted-foreground hover:text-foreground hover:border-white/30'
                        )}
                        aria-pressed={e.iAmGoing}
                        aria-label={e.iAmGoing ? 'leave this event' : 'mark yourself as going'}
                      >
                        {e.iAmGoing ? <Check className="size-3" aria-hidden="true" /> : <Users className="size-3" aria-hidden="true" />}
                        {e.iAmGoing ? 'going' : 'going?'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}

          {past.length > 0 && (
            <div className="pt-2 space-y-1.5">
              <p className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">past</p>
              {past.map((e) => (
                <div key={e.id} className="rounded-sm border border-white/5 bg-app-raise/20 p-2.5 flex items-center justify-between gap-2 opacity-70">
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold truncate flex items-center gap-1.5">
                      {e.canceledAt && <X className="size-3 text-destructive shrink-0" aria-hidden="true" />}
                      {e.name}
                    </p>
                    <p className="text-[10px] text-muted-foreground">{whenLabel(e)}</p>
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">{e.attendeeCount} went</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
