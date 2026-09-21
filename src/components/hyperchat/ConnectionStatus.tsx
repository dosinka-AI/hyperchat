'use client'

import { useEffect, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

/** Small dot (plus label on hover) showing realtime connection health.
 *  Blue solid = live, blue pulsing = reconnecting, red = offline.
 *  Placed in the chat header so the state is always one glance away. */
export function ConnectionIndicator() {
  const connected = useChatStore((s) => s.connected)
  const [disconnectedFor, setDisconnectedFor] = useState(0)

  // reset the counter the moment the line comes back (render-phase adjust)
  const [wasConnected, setWasConnected] = useState(connected)
  if (connected !== wasConnected) {
    setWasConnected(connected)
    if (connected) setDisconnectedFor(0)
  }

  // tick seconds while disconnected (setState inside a subscription callback)
  useEffect(() => {
    if (connected) return
    const started = Date.now()
    const t = setInterval(() => setDisconnectedFor(Math.round((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(t)
  }, [connected])

  const label = connected
    ? 'Connected'
    : disconnectedFor < 3
      ? 'Connection hiccup, recovering'
      : `Reconnecting, ${disconnectedFor}s`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex items-center gap-1.5 px-1.5 py-1 cursor-default"
          role="status"
          aria-label={label}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              connected
                ? 'bg-hyper'
                : disconnectedFor < 3
                  ? 'bg-hyper animate-pulse'
                  : 'bg-destructive animate-pulse'
            )}
          />
          <span
            className={cn(
              'text-[10px] font-semibold tracking-wide hidden lg:inline',
              connected ? 'text-muted-foreground' : 'text-destructive'
            )}
          >
            {connected ? '' : label.toUpperCase()}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {connected
          ? 'Realtime connection is live.'
          : disconnectedFor < 3
            ? 'Brief hiccup. Reconnecting automatically.'
            : `Offline for ${disconnectedFor}s. Retrying in the background; the app keeps working and catches up on reconnect.`}
      </TooltipContent>
    </Tooltip>
  )
}

/** Slim banner across the main column when the line has been down long
 *  enough that it is not just a blip. The app stays usable through the
 *  HTTP sync fallback, so the banner informs instead of blocking. */
export function ConnectionBanner() {
  const connected = useChatStore((s) => s.connected)
  const [show, setShow] = useState(false)

  // hide instantly on recovery (render-phase adjust)
  const [wasConnected, setWasConnected] = useState(connected)
  if (connected !== wasConnected) {
    setWasConnected(connected)
    if (connected) setShow(false)
  }

  useEffect(() => {
    if (connected) return
    // only surface after a short grace period so blips never flash UI
    const t = setTimeout(() => setShow(true), 4000)
    return () => clearTimeout(t)
  }, [connected])

  if (!show || connected) return null

  return (
    <div
      className="shrink-0 flex items-center justify-center gap-2 px-4 py-1.5 bg-destructive/10 border-b border-destructive/30 text-[11px] font-medium text-destructive"
      role="alert"
    >
      <span className="size-1.5 rounded-full bg-destructive animate-pulse" aria-hidden="true" />
      Connection interrupted. Reconnecting automatically. Hyperion keeps working and catches up when the line returns.
    </div>
  )
}
