/* The standalone build's "socket.io": the exact same event surface the real
 * client wiring expects, but backed by a BroadcastChannel so multiple tabs
 * of the single html file see each other live (presence, typing, messages).
 * The in-page local backend drives it through the same bus. */

export type LocalEvent = { event: string; payload: unknown }

type Handlers = Record<string, Set<(payload: unknown) => void>>

const CHANNEL = 'hyperchat-standalone-rt'

class LocalSocketImpl {
  connected = true
  io: {
    on: (_: string, __?: () => void) => void
    engine: { on: (_: string, __?: () => void) => void }
  }

  private handlers: Handlers = {}
  private chan: BroadcastChannel | null = null
  private tabId = Math.random().toString(36).slice(2)
  presence: string
  /** the signed-in user of this tab: typing relays and whisper delivery
   *  are stamped / filtered with it */
  user: { id: string; username: string } | null = null

  constructor(presence?: string) {
    this.presence = presence ?? 'online'
    this.io = {
      on: () => {},
      engine: { on: () => {} },
    }
    if (typeof BroadcastChannel !== 'undefined') {
      this.chan = new BroadcastChannel(CHANNEL)
      this.chan.onmessage = (e) => {
        const msg = e.data as LocalEvent & { from?: string }
        if (!msg || msg.from === this.tabId) return
        this.dispatch(msg.event, msg.payload)
      }
    }
    // the store treats the first connect as the realtime coming up
    queueMicrotask(() => this.dispatch('connect', undefined))
  }

  setUser(id: string | null, username?: string): void {
    this.user = id ? { id, username: username ?? '' } : null
  }

  on(event: string, handler: (payload: never) => void): this {
    ;(this.handlers[event] ??= new Set()).add(handler as (payload: unknown) => void)
    return this
  }

  off(event: string, handler: (payload: never) => void): this {
    this.handlers[event]?.delete(handler as (payload: unknown) => void)
    return this
  }

  removeAllListeners(): this {
    this.handlers = {}
    return this
  }

  emit(event: string, payload?: unknown): this {
    // the real service relays these server-side; the local bus does the
    // translation itself so other tabs receive the same shapes
    if (event === 'typing:start' || event === 'typing:stop') {
      if (this.user) {
        this.post({ event: 'typing', payload: { room: (payload as { room?: string })?.room, userId: this.user.id, username: this.user.username, typing: event === 'typing:start' } })
      }
      return this
    }
    if (event === 'status:update' && this.user) {
      this.post({ event: 'presence:status', payload: { userId: this.user.id, status: (payload as { status?: string })?.status } })
      return this
    }
    // subscribe / unsubscribe need no relay: every tab receives every event
    return this
  }

  disconnect(): this {
    return this
  }

  connect(): this {
    queueMicrotask(() => this.dispatch('connect', undefined))
    return this
  }

  close(): void {
    this.chan?.close()
    this.handlers = {}
  }

  /** fire a local handler set (used by the in-page backend and cross-tab) */
  dispatch(event: string, payload: unknown): void {
    // whispers carry their delivery list: tabs logged in as someone else
    // never see them, exactly like the real targeted socket rooms
    const p = payload as { __targets?: string[] } | null | undefined
    if (p && Array.isArray(p.__targets)) {
      if (!this.user || !p.__targets.includes(this.user.id)) return
      const clean = { ...p }
      delete clean.__targets
      payload = clean
    }
    const set = this.handlers[event]
    if (!set) return
    for (const fn of set) {
      try {
        fn(payload)
      } catch {
        /* a broken handler never breaks the bus */
      }
    }
  }

  post(msg: LocalEvent & { from?: string }): void {
    try {
      this.chan?.postMessage(msg)
    } catch {
      /* channel closed: single-tab mode still works via local dispatch */
    }
  }
}

export type LocalSocket = LocalSocketImpl

let live: LocalSocket | null = null

export function createLocalSocket(presence?: string): LocalSocket {
  if (live) return live
  live = new LocalSocketImpl(presence)
  return live
}

/** The in-page backend emits realtime events through here. */
export function getLiveLocalSocket(): LocalSocket | null {
  return live
}

/** Fire-and-forget bus message from the backend side (no tab filter). */
export function busEmit(event: string, payload: unknown): void {
  live?.dispatch(event, payload)
  live?.post({ event, payload })
}
