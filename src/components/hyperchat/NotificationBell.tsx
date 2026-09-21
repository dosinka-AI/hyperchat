'use client'

import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Bell, BellMinus, BellOff, BellRing, Check, Clock } from 'lucide-react'
import { useChatStore } from '@/lib/client/store'
import { sounds } from '@/lib/client/sounds'
import { cn } from '@/lib/utils'

/** The shared notification-settings body: level radios (all / mentions /
 *  nothing), @everyone suppression and TIMED mutes (15m .. 24h, or until
 *  turned back on). Works for channel:<id> and server:<id> scopes alike. */
export function NotificationSettingsPanel({
  scopeKey,
  name,
  onDone,
}: {
  scopeKey: string
  name: string
  onDone?: () => void
}) {
  const muted = useChatStore((s) => !!s.mutedScopes[scopeKey])
  const level = useChatStore((s) => (s.notificationLevels[scopeKey] === 'MENTIONS' ? 'MENTIONS' : 'ALL'))
  const suppressEveryone = useChatStore((s) => s.suppressEveryoneScopes.includes(scopeKey))
  const remaining = useChatStore((s) => s.muteRemaining(scopeKey))
  const setNotificationLevel = useChatStore((s) => s.setNotificationLevel)
  const muteScopeFor = useChatStore((s) => s.muteScopeFor)
  const toggleMute = useChatStore((s) => s.toggleMute)

  const current: 'ALL' | 'MENTIONS' | 'NONE' = muted ? 'NONE' : level

  return (
    <div className="text-foreground">
      <p className="px-3 pt-2.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        notifications · {name}
      </p>

      {/* level radios */}
      <div role="radiogroup" aria-label="notification level" className="px-1.5 pb-1">
        {(
          [
            { value: 'ALL', label: 'all messages', hint: 'every message pings', icon: BellRing },
            { value: 'MENTIONS', label: 'only mentions', hint: '@you, @everyone, @here', icon: BellMinus },
            { value: 'NONE', label: 'nothing', hint: 'no pings, badge still counts', icon: BellOff },
          ] as const
        ).map((opt) => {
          const active = current === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                sounds.play('lightTick')
                void setNotificationLevel(scopeKey, opt.value, suppressEveryone)
                if (opt.value !== 'NONE') onDone?.()
              }}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors',
                active ? 'bg-hyper/12 text-hyper' : 'text-foreground/85 hover:bg-white/6'
              )}
            >
              <opt.icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex-1">
                <span className="block text-[12px] font-semibold leading-tight">{opt.label}</span>
                <span className={cn('block text-[10px] leading-tight mt-0.5', active ? 'text-hyper/70' : 'text-muted-foreground')}>
                  {opt.hint}
                </span>
              </span>
              {active && <Check className="size-3.5 shrink-0" aria-hidden="true" />}
            </button>
          )
        })}
      </div>

      {/* timed mute */}
      <div className="border-t border-white/10 px-3 py-2">
        <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          <Clock className="size-3" aria-hidden="true" />
          mute for
        </p>
        <div className="mt-1.5 grid grid-cols-3 gap-1">
          {(
            [
              { minutes: 15, label: '15m' },
              { minutes: 60, label: '1h' },
              { minutes: 180, label: '3h' },
              { minutes: 480, label: '8h' },
              { minutes: 1440, label: '24h' },
              { minutes: null, label: 'forever' },
            ] as const
          ).map((opt) => (
            <button
              key={opt.label}
              type="button"
              onClick={() => {
                sounds.play('lightTick')
                void muteScopeFor(scopeKey, opt.minutes)
                onDone?.()
              }}
              className="rounded-sm border border-white/10 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-hyper/50 hover:bg-hyper/10 hover:text-hyper focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {opt.label}
            </button>
          ))}
        </div>
        {muted && (
          <button
            type="button"
            onClick={() => {
              sounds.play('lightTick')
              void toggleMute(scopeKey)
              onDone?.()
            }}
            className="mt-1.5 w-full rounded-sm border border-hyper/40 bg-hyper/10 py-1 text-[11px] font-semibold text-hyper transition-colors hover:bg-hyper/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {remaining ? `muted · ${remaining} left · unmute now` : 'unmute now'}
          </button>
        )}
      </div>
    </div>
  )
}

/** Discord-style notification bell for the channel header / sidebar row:
 *  trigger button + the shared panel in a popover. */
export function NotificationBell({
  scopeKey,
  name,
  variant = 'header',
}: {
  scopeKey: string
  name: string
  variant?: 'header' | 'row'
}) {
  const [open, setOpen] = useState(false)
  const muted = useChatStore((s) => !!s.mutedScopes[scopeKey])
  const level = useChatStore((s) => (s.notificationLevels[scopeKey] === 'MENTIONS' ? 'MENTIONS' : 'ALL'))
  const remaining = useChatStore((s) => s.muteRemaining(scopeKey))

  const current: 'ALL' | 'MENTIONS' | 'NONE' = muted ? 'NONE' : level
  const Icon = current === 'ALL' ? (variant === 'header' ? BellRing : Bell) : current === 'MENTIONS' ? BellMinus : BellOff

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`notification settings for ${name}`}
          title={muted ? (remaining ? `muted · ${remaining} left` : 'muted') : current === 'MENTIONS' ? 'only @mentions notify' : 'all messages notify'}
          className={cn(
            'relative flex items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            variant === 'header' ? 'size-7' : 'size-6'
          )}
        >
          <Icon className={variant === 'header' ? 'size-4' : 'size-3.5'} aria-hidden="true" />
          {muted && remaining && (
            <span
              className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-hyper"
              aria-hidden="true"
              title={`timed mute · ${remaining} left`}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align={variant === 'header' ? 'end' : 'center'}
        className="w-64 rounded-sm p-0 overflow-hidden border border-white/10 bg-app-raise shadow-xl"
        aria-describedby={undefined}
      >
        <NotificationSettingsPanel scopeKey={scopeKey} name={name} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

/** Server-level notification settings (opened from the server dropdown). */
export function ServerNotificationDialog({
  open,
  onOpenChange,
  serverId,
  serverName,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  serverId: string
  serverName: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,22rem)] rounded-sm border border-white/10 bg-app-raise p-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="text-[15px] font-bold text-foreground">
            notifications · {serverName}
          </DialogTitle>
          <p className="text-[11px] text-muted-foreground -mt-1">
            applies to every channel in this server unless a channel overrides it
          </p>
        </DialogHeader>
        <div className="pb-2">
          <NotificationSettingsPanel scopeKey={`server:${serverId}`} name={serverName} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
