'use client'

/** Same-browser tab sync for call UI. When one tab accepts, declines, lets
 *  the ring die locally, or sees a call expire, every other tab for this
 *  origin clears the matching incoming/active shell so leftover ring
 *  overlays never stick around. */

export type CallTabEvent =
  | { type: 'dismiss-incoming'; callId: string }
  | { type: 'call-ended'; callId: string }
  | { type: 'accepted-here'; callId: string }
  | { type: 'left-call'; callId: string }
  | { type: 'voice-ring-dismiss'; inviteId: string }

const CHANNEL = 'hyperchat-call-tabs'

type Listener = (event: CallTabEvent) => void

let channel: BroadcastChannel | null = null
const listeners = new Set<Listener>()

function ensure(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = (ev: MessageEvent<CallTabEvent>) => {
      const data = ev.data
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return
      for (const fn of listeners) fn(data)
    }
  }
  return channel
}

let callTabSyncBound = false

export function publishCallTabEvent(event: CallTabEvent): void {
  try {
    ensure()?.postMessage(event)
  } catch {
    /* private mode / closed channel */
  }
}

export function subscribeCallTabEvents(fn: Listener): () => void {
  ensure()
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Bind once for the process lifetime. Safe to call from socket init. */
export function ensureCallTabSync(fn: Listener): void {
  if (callTabSyncBound) return
  callTabSyncBound = true
  subscribeCallTabEvents(fn)
}
