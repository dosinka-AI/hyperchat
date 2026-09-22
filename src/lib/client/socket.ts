'use client'

import { io, type Socket } from 'socket.io-client'
import { useChatStore } from './store'
import { sounds } from './sounds'
import { notifications } from './notifications'
import { voiceEngine } from './voice'
import { callEngine } from './call'
import { toast } from '@/hooks/use-toast'
import type { ClientMessage, ForumPostSummary, PublicUser, UserPresenceChoice, VisiblePresence } from '@/lib/types'
import { STANDALONE } from './store'
import { createLocalSocket, type LocalSocket } from '../../../standalone/localsocket'

/** Mute check shared by the sound gates: a room is muted when its channel is
 *  muted or the entire server is muted. */
function isRoomMuted(
  store: { mutedScopes: Record<string, boolean>; servers: { id: string; channels: { id: string }[] }[] },
  room: string
): boolean {
  if (store.mutedScopes[room]) return true
  if (room.startsWith('channel:')) {
    const channelId = room.slice('channel:'.length)
    const server = store.servers.find((s) => s.channels.some((c) => c.id === channelId))
    return server ? !!store.mutedScopes[`server:${server.id}`] : false
  }
  return false
}

type AnySocket = Socket | LocalSocket

/** The socket, its timers and its liveness clock live on globalThis so a
 *  Fast Refresh that re-evaluates this module reuses the LIVE connection
 *  instead of orphaning it. The old flow (module-level singleton) produced
 *  a split brain under HMR: gen-1 kept the physical socket (and swallowed
 *  every event into a dead store instance) while gen-2 saw getSocket() ===
 *  null and silently dropped every emit - voice joins, call SDP/ICE, room
 *  subscriptions, everything. Symptom: a call that connects but carries no
 *  audio in either direction, and voice rooms whose presence silently
 *  evaporates. */
const SOCKET_KEY = '__hyperionSocket'
const WATCHDOG_KEY = '__hyperionWatchdog'
const IDLE_KEY = '__hyperionIdleTimer'
const GEN_KEY = '__hyperionSocketGen'
/** unique per module evaluation: a reuse whose generation differs means the
 *  module body just re-ran (dev Fast Refresh) and the handlers must be
 *  re-bound to the fresh store/engine closures. */
const MODULE_GEN = Math.random().toString(36).slice(2)

type GlobalSocketState = {
  [SOCKET_KEY]?: AnySocket
  [WATCHDOG_KEY]?: ReturnType<typeof setInterval>
  [IDLE_KEY]?: ReturnType<typeof setInterval>
  [GEN_KEY]?: string
}
const G = globalThis as unknown as GlobalSocketState

let socket: AnySocket | null = null
let currentRoom: string | null = null
let currentServerRoom: string | null = null

// watchdog bookkeeping
let lastActivityAt = Date.now()
let lastEngineActivity = Date.now()
/** the last moment ANY packet arrived from the server (pings included). A
 *  socket that claims connected while nothing has arrived for ~45s is a
 *  zombie (paused poll loop, half-open websocket after a proxy hiccup):
 *  cycling it is the only cure. */
let lastInboundAt = Date.now()
// the manual status the user picked (online / idle / dnd / invisible);
// auto-idle only flips ONLINE users to idle, manual statuses stay put
let manualPresence: UserPresenceChoice = 'online'
let autoIdled = false

export function getSocket(): AnySocket | null {
  ensureWired()
  return socket
}

/** Live socket health for QA/debugging (window.__hyperionSocketDiagnostics). */
export function socketDiagnostics(): Record<string, unknown> {
  ensureWired()
  const s = socket
  let transport = 'none'
  if (s && 'io' in s) {
    const engine = (s as Socket).io?.engine as unknown as { transport?: { name?: string } } | undefined
    transport = engine?.transport?.name ?? 'unknown'
  } else if (s) {
    transport = 'local-broadcast'
  }
  return {
    hasSocket: !!s,
    connected: s?.connected ?? false,
    transport,
    moduleGenerationMatches: G[GEN_KEY] === MODULE_GEN,
    globalGen: G[GEN_KEY],
    moduleGen: MODULE_GEN,
    msSinceInbound: Date.now() - lastInboundAt,
    msSinceEngineActivity: Date.now() - lastEngineActivity,
    currentRoom,
    currentServerRoom,
  }
}

if (typeof window !== 'undefined') {
  ;(window as unknown as { __hyperionSocketDiagnostics?: () => Record<string, unknown> }).__hyperionSocketDiagnostics =
    socketDiagnostics
}

/** Adopt a socket that survived this module being re-evaluated (dev Fast
 *  Refresh). Without this, generation 2 of the module starts with a null
 *  socket while generation 1's connection keeps humming with listeners that
 *  feed a dead store instance - every emit silently dropped, every event
 *  swallowed: a "connected" app whose voice rooms and calls carry no audio.
 *  Re-wiring re-binds handlers to the CURRENT module's closures and
 *  re-announces voice/call membership so the media mesh survives. */
function ensureWired(): void {
  const surviving = G[SOCKET_KEY]
  if (!surviving || G[GEN_KEY] === MODULE_GEN) return
  G[GEN_KEY] = MODULE_GEN
  socket = surviving
  try {
    surviving.removeAllListeners()
  } catch {
    /* local-socket flavour has a lighter listener surface */
  }
  wireHandlers(surviving)
  // the physical rooms survived server-side; this module's bookkeeping is
  // fresh, so re-announce everything important
  resubscribeAll()
  voiceEngine.rejoinAfterReconnect()
  callEngine.rejoinAfterReconnect()
}

/** Open a room by its socket room key; reused by the desktop notification
 *  click handler so clicking a notification lands exactly where a quick
 *  switcher jump would (selectChannel/selectConversation resolve context). */
function openRoom(room: string): void {
  const store = useChatStore.getState()
  if (room.startsWith('channel:')) {
    void store.selectChannel(room.slice('channel:'.length))
  } else if (room.startsWith('conversation:')) {
    void store.selectConversation(room.slice('conversation:'.length))
  }
}

/** The room the UI currently shows; used to re-subscribe after reconnects,
 *  which is the fix for updates dying silently until a page reload. */
export function trackActiveRoom(room: string | null): void {
  ensureWired()
  currentRoom = room
  if (room) subscribeRoom(room)
}

/** The server room the sidebar listens on for live voice participant state
 *  (server:<id> carries voice:state even when not in the call). */
export function subscribeServerRoom(serverId: string | null): void {
  ensureWired()
  if (currentServerRoom === `server:${serverId ?? ''}`) return
  if (currentServerRoom) socket?.emit('unsubscribe', { rooms: [currentServerRoom] })
  currentServerRoom = serverId ? `server:${serverId}` : null
  if (currentServerRoom) socket?.emit('subscribe', { rooms: [currentServerRoom] })
}

function markActivity() {
  lastActivityAt = Date.now()
  // any input clears an AUTO idle so the dot turns green again; manual
  // statuses (dnd, invisible, self-chosen idle) survive input
  if (autoIdled) {
    autoIdled = false
    if (manualPresence === 'online') {
      socket?.emit('status:update', { status: 'online' })
    }
  }
}

function resubscribeAll(): void {
  if (currentRoom) subscribeRoom(currentRoom)
  if (currentServerRoom) socket?.emit('subscribe', { rooms: [currentServerRoom] })
}

/** Force an immediate reconnect attempt (used by the online/visibility hooks
 *  and the watchdog). Safe to call when already connected. */
function nudgeReconnect(): void {
  ensureWired()
  if (!socket) return
  if (!socket.connected) {
    // a manager stuck in backoff can sit silent for seconds: force it awake
    socket.disconnect()
    socket.connect()
  }
}

export function initSocket(presence?: UserPresenceChoice): AnySocket {
  ensureWired()
  if (socket) {
    // boot may learn the persisted status after the socket exists: apply it
    if (presence && presence !== manualPresence) setPresence(presence)
    return socket
  }
  if (presence) manualPresence = presence

  // the standalone html build runs the same handler wiring over a local
  // BroadcastChannel socket instead of the socket.io service
  if (STANDALONE) {
    socket = createLocalSocket(presence)
    G[SOCKET_KEY] = socket
    G[GEN_KEY] = MODULE_GEN
    wireHandlers(socket)
    return socket
  }

  // Realtime endpoint.
  // - Default / tunnel / hosted: SAME ORIGIN so one public URL (cloudflared →
  //   :3000) works. Next rewrites /socket.io → sidecar :3003 and forwards the
  //   session cookie. XTransformPort is Trae/sandbox-only and returns HTML on
  //   Cloudflare tunnels, which leaves the socket unauthorized and the whole
  //   ChatApp stuck on the reconnect screen.
  // - Optional NEXT_PUBLIC_SOCKET_URL / PATH for split deploys (see DEPLOY.md).
  // - NEXT_PUBLIC_USE_XTRANSFORM=1 keeps the old Trae gateway path.
  const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL || undefined
  const socketPath = process.env.NEXT_PUBLIC_SOCKET_PATH || undefined
  const useXTransform = process.env.NEXT_PUBLIC_USE_XTRANSFORM === '1'

  const realtimeUrl = (() => {
    if (socketUrl) return socketUrl
    if (useXTransform) return '/?XTransformPort=3003'
    return '/'
  })()

  const socketOptions = {
    path: socketPath ?? '/socket.io',
    // polling first, then upgrade to websocket: polling works anywhere plain
    // HTTP works, so hostile proxies can never fully kill realtime; the
    // upgrade happens automatically once a websocket handshake succeeds
    transports: ['polling', 'websocket'] as ('polling' | 'websocket')[],
    withCredentials: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 750,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.4,
    timeout: 12000,
    // Token in auth (from /api/socket-token) so handshake still works when a
    // proxy strips cookies on the rewrite to :3003. Falls back to cookie.
    // Reads manualPresence so reconnects pick up status picker changes.
    auth: (cb: (data: Record<string, unknown>) => void) => {
      const base = { presence: manualPresence || presence || 'online' }
      if (typeof window === 'undefined') {
        cb(base)
        return
      }
      void fetch('/api/socket-token', { credentials: 'include', cache: 'no-store' })
        .then(async (res) => {
          if (!res.ok) {
            cb(base)
            return
          }
          const data = (await res.json()) as { token?: string }
          cb(typeof data.token === 'string' ? { ...base, token: data.token } : base)
        })
        .catch(() => cb(base))
    },
  }

  socket = io(realtimeUrl, socketOptions)
  G[SOCKET_KEY] = socket
  G[GEN_KEY] = MODULE_GEN
  wireHandlers(socket)
  return socket
}

/** Every realtime handler, attached to whichever socket flavour is live. */
function wireHandlers(activeSocket: AnySocket) {
  const sock: AnySocket = activeSocket
  // voice signaling rides the same socket transport
  voiceEngine.setEmitter((event, payload) => {
    sock.emit(event, payload)
  })
  // and so does call signaling
  callEngine.setEmitter((event, payload) => {
    sock.emit(event, payload)
  })
  sock.on('connect', () => {
    const store = useChatStore.getState()
    store.onConnected(true)
    lastEngineActivity = Date.now()
    lastInboundAt = Date.now()
    // every (re)connection must restore room subscriptions: a reconnect
    // gives us a fresh socket with zero rooms joined
    resubscribeAll()
    // media self-heal: the disconnect that preceded this reconnect already
    // dropped our voice/call presence on the realtime service - rejoin both
    // so participants, WebRTC peers and SDP/ICE signaling all come back
    // (without this a brief network blip leaves a ghost voice state and a
    // call that stays connected on screen while no audio flows)
    voiceEngine.rejoinAfterReconnect()
    callEngine.rejoinAfterReconnect()
    // catch up on anything missed while the line was down
    void store.syncNow()
  })

  // engine-level liveness signals. The engine object is replaced on every
  // reconnect, so re-attach when the manager opens a new one.
  activeSocket.io.on('open', () => {
    lastEngineActivity = Date.now()
    lastInboundAt = Date.now()
    const engine = activeSocket.io.engine
    engine.on('packet', () => {
      lastInboundAt = Date.now()
    })
    engine.on('ping', () => {
      lastEngineActivity = Date.now()
      lastInboundAt = Date.now()
    })
    engine.on('pong', () => {
      lastEngineActivity = Date.now()
      lastInboundAt = Date.now()
    })
  })

  sock.on('disconnect', () => {
    useChatStore.getState().onConnected(false)
  })

  sock.on('connect_error', () => {
    useChatStore.getState().onConnected(false)
  })

  // ---------- OS / browser level recovery hooks ----------
  // attached exactly once per page (globalThis flag); the handlers route
  // through a globalThis dispatch table that each re-wire refreshes, so the
  // one-time listeners always reach the CURRENT module generation instead of
  // fighting over stale closures (a gen-1 closure re-wiring back to gen-1
  // would ping-pong with gen-2 forever).
  const HOOKS_KEY = '__hyperionHookFns'
  const HG = globalThis as unknown as {
    [HOOKS_KEY]?: { nudge: () => void; sync: () => void; activity: () => void }
  }
  HG[HOOKS_KEY] = {
    nudge: () => nudgeReconnect(),
    sync: () => {
      void useChatStore.getState().syncNow()
    },
    activity: () => markActivity(),
  }
  const WINDOW_HOOKS_KEY = '__hyperionWindowHooks'
  const WH = globalThis as unknown as { [WINDOW_HOOKS_KEY]?: boolean }
  if (typeof window !== 'undefined' && !WH[WINDOW_HOOKS_KEY]) {
    WH[WINDOW_HOOKS_KEY] = true
    // the network itself came back (wifi drop, sleep/wake): reconnect now
    window.addEventListener(
      'online',
      () => {
        HG[HOOKS_KEY]?.nudge()
        HG[HOOKS_KEY]?.sync()
      },
      { passive: true }
    )

    // returning to the tab: browsers freeze background timers and can kill
    // sockets silently, so probe the connection and refresh data
    document.addEventListener('visibilitychange', () => {
      const visible = document.visibilityState === 'visible'
      sounds.setUnfocused(!visible)
      if (visible) {
        HG[HOOKS_KEY]?.nudge()
        HG[HOOKS_KEY]?.sync()
      }
    })

    // user input marks activity (used for the idle status)
    window.addEventListener('pointerdown', () => HG[HOOKS_KEY]?.activity(), { passive: true })
    window.addEventListener('keydown', () => HG[HOOKS_KEY]?.activity())

    // unlock audio on the first interaction (autoplay policies)
    const unlock = () => {
      sounds.unlock()
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock, { passive: true })
    window.addEventListener('keydown', unlock)
    sounds.setUnfocused(document.visibilityState !== 'visible')
  }

  // watchdog: never let the socket sit dead silently. If it claims to be
  // connected we also sanity-probe, because suspended tabs can leave a
  // zombie socket that never notices it died. The interval is REPLACED on
  // every re-wire so it always reads this generation's liveness clocks (a
  // stale interval would see stale clocks and cycle a healthy socket).
  if (G[WATCHDOG_KEY]) clearInterval(G[WATCHDOG_KEY])
  G[WATCHDOG_KEY] = setInterval(() => {
    const live = G[SOCKET_KEY]
    if (!live) return
    if (!live.connected) {
      nudgeReconnect()
      return
    }
    // a healthy engine exchanges pings every pingInterval (25s); if the
    // last ping/pong is ancient, the connection is a zombie: cycle it
    if (Date.now() - lastEngineActivity > 90000) {
      lastEngineActivity = Date.now()
      lastInboundAt = Date.now()
      live.disconnect().connect()
      return
    }
    // inbound liveness: connected + nothing received for 45s (two missed
    // pings) means the transport is receive-dead (paused poll loop after a
    // failed websocket upgrade, or a half-open proxy connection). The
    // engine's own pings may still "succeed" client-side, so this check
    // is the one that catches the silent zombies.
    if (Date.now() - lastInboundAt > 45000) {
      lastInboundAt = Date.now()
      lastEngineActivity = Date.now()
      live.disconnect().connect()
    }
  }, 15000)

  sock.on('presence:init', (data: {
    onlineUserIds: string[]
    statuses?: Record<string, VisiblePresence>
    awaySince?: Record<string, number>
    lastSeen?: Record<string, string>
  }) => {
    useChatStore.getState().onPresenceInit(data.onlineUserIds || [], data.statuses, data.awaySince, data.lastSeen)
  })

  sock.on('presence:online', (data: { userId: string; status?: VisiblePresence; awaySince?: number | null }) => {
    const store = useChatStore.getState()
    store.onPresenceOnline(data.userId, data.status, data.awaySince)
    // join sound for people I actually talk to or share a server with
    if (store.me && data.userId !== store.me.id) {
      const isDmPartner = store.conversations.some((c) => c.otherUser.id === data.userId)
      const inActiveServer = store.activeServerId
        ? (store.serverMembers[store.activeServerId] ?? []).some((m) => m.id === data.userId)
        : false
      if (isDmPartner || inActiveServer) sounds.play('join')
    }
  })

  sock.on('presence:offline', (data: { userId: string; lastSeenAt?: string | null }) => {
    useChatStore.getState().onPresenceOffline(data.userId, data.lastSeenAt)
  })

  sock.on('presence:status', (data: { userId: string; status: VisiblePresence; awaySince?: number | null }) => {
    if (!data?.userId) return
    useChatStore.getState().onPresenceStatus(data.userId, data.status, data.awaySince)
  })

  sock.on('typing', (data: { room: string; userId: string; username: string; typing: boolean }) => {
    useChatStore.getState().onTyping(data.room, data.userId, data.username, data.typing)
  })

  sock.on('message:new', (msg: ClientMessage) => {
    if (!msg || typeof msg !== 'object' || !msg.id) return
    // reduced guest echoes (a cross-rung call guest's send landing) carry
    // only { id, conversationId, authorId }: they exist to tell other tabs
    // the row landed, never to render — full payloads always carry a room
    // and an author object
    if (!msg.room || !msg.author) return
    const store = useChatStore.getState()
    const mine = store.me?.id === msg.authorId

    if (!mine && !msg.systemKind) {
      const activeRoom =
        store.activeChannelId
          ? `channel:${store.activeChannelId}`
          : store.activeConversationId
            ? `conversation:${store.activeConversationId}`
            : null
      const viewingThis = activeRoom === msg.room && document.visibilityState === 'visible'
      const lower = (msg.content ?? '').toLowerCase()
      const mentioned =
        !!store.me &&
        (!!msg.content && (lower.includes(`@${store.me.username.toLowerCase()}`) || (msg.pingsEveryone && /(^|\s)@(everyone|here)(?=\s|$)/i.test(msg.content))))

      // mutes kill every sound (mention pings included)
      const muted = isRoomMuted(store, msg.room)

      // viewing the room while focused: the message is already on screen,
      // a sound for it is noise (mention pings included)
      if (!muted && !viewingThis) {
        if (mentioned) {
          sounds.play('ping')
        } else {
          sounds.play(document.visibilityState === 'visible' ? 'msg' : 'msgunfocused')
        }
      }

      // desktop notification: the OS may play its own default sound; the app
      // stays silent and lets the sounds engine own audio. Only realtime
      // messages route through here (never sync), so nothing fires on load.
      notifications.maybeNotify({
        message: {
          authorId: msg.authorId,
          content: msg.content,
          room: msg.room,
          systemKind: msg.systemKind,
          pingsEveryone: msg.pingsEveryone,
          mine,
          authorName: msg.author.displayName || msg.author.username,
          authorAvatarUrl: msg.author.avatarUrl,
        },
        activeRoom,
        myUsername: store.me?.username ?? '',
        onOpen: openRoom,
      })
    }

    store.onMessageNew(msg)
  })

  sock.on('message:update', (msg: ClientMessage) => {
    if (!msg || typeof msg !== 'object' || !msg.id) return
    useChatStore.getState().onMessageUpdate(msg)
  })

  sock.on('message:delete', (data: { messageId: string }) => {
    if (!data?.messageId) return
    useChatStore.getState().onMessageDelete(data)
  })

  sock.on('messages:purge', (data: { room: string; ids: string[] }) => {
    if (!data?.ids || !Array.isArray(data.ids)) return
    useChatStore.getState().onMessagesPurge(data.ids)
  })

  sock.on('message:reaction', (data: { messageId: string; room: string; reactions: { emoji: string; userIds: string[]; at?: string[] }[] }) => {
    if (!data?.messageId) return
    useChatStore.getState().onMessageReaction(data)
  })

  sock.on('read:update', (data: { conversationId: string; userId: string; lastReadAt: string }) => {
    if (!data?.conversationId) return
    useChatStore.getState().onReadUpdate(data)
  })

  sock.on('channel:read', (data: { channelId: string; userId: string; lastReadAt: string }) => {
    if (!data?.channelId || !data?.userId) return
    useChatStore.getState().onChannelRead(data)
  })

  sock.on('server:refresh', (data: { serverId: string }) => {
    if (!data?.serverId) return
    useChatStore.getState().onServerRefresh(data.serverId)
  })

  sock.on('server:deleted', (data: { serverId: string }) => {
    if (!data?.serverId) return
    useChatStore.getState().onServerDeleted(data.serverId)
  })

  sock.on('conversation:new', () => {
    useChatStore.getState().onConversationNew()
  })

  sock.on('user:update', (data: {
    userId: string
    username?: string
    displayName?: string | null
    avatarUrl?: string | null
    avatarColor?: string
    bio?: string
    customStatus?: string | null
    pronouns?: string | null
    bannerColor?: string | null
    bannerUrl?: string | null
  }) => {
    if (!data?.userId) return
    // someone changed their profile: patch every cached view of them
    // (their own client patches "me" from the same broadcast). Only the
    // fields the payload actually carries are applied, so partial
    // broadcasts never wipe cached values.
    const patch: Record<string, unknown> = { id: data.userId }
    for (const key of [
      'username',
      'displayName',
      'avatarUrl',
      'avatarColor',
      'bio',
      'customStatus',
      'pronouns',
      'bannerColor',
      'bannerUrl',
    ] as const) {
      if (data[key] !== undefined) patch[key] = data[key]
    }
    useChatStore.getState().onUserUpdate(patch as PublicUser)
  })

  // global profile broadcast: someone (possibly me, from another tab)
  // changed their profile and every cached view of them repaints now
  sock.on('user:profile', (data: {
    userId: string
    username?: string
    displayName?: string | null
    avatarUrl?: string | null
    avatarColor?: string
    bio?: string
    customStatus?: string | null
    pronouns?: string | null
    bannerColor?: string | null
    bannerUrl?: string | null
  }) => {
    if (!data?.userId) return
    useChatStore.getState().applyUserProfilePatch(data.userId, {
      username: data.username,
      displayName: data.displayName,
      avatarUrl: data.avatarUrl,
      avatarColor: data.avatarColor,
      bio: data.bio,
      customStatus: data.customStatus,
      pronouns: data.pronouns,
      bannerColor: data.bannerColor,
      bannerUrl: data.bannerUrl,
    })
  })

  sock.on('friends:update', () => {
    void useChatStore.getState().refreshFriends()
  })

  sock.on('blocks:update', () => {
    // block changes come back through the sync channel; nudge it now
    void useChatStore.getState().syncNow()
  })

  sock.on('account:suspended', (data: { reason?: string | null; until?: string | null }) => {
    // a site admin suspended this account mid-session: drop to the blocked screen
    useChatStore.getState().onAccountSuspended(data?.reason ?? null, data?.until ?? null)
  })

  // ---- voice ----
  sock.on('voice:state', (data: { channelId: string; participants: { userId: string; username: string; sessionId: string; muted: boolean; deafened: boolean; recording?: boolean; video?: boolean; screen?: boolean }[]; ringing?: string[]; priorityUserId?: string | null }) => {
    if (!data?.channelId || !Array.isArray(data.participants)) return
    useChatStore.getState().onVoiceState(data)
  })

  // someone I rang into this channel declined: a quiet heads-up while I
  // am still sitting in it
  sock.on('voice:ring-decline', (data: { channelId: string; userId: string; username: string }) => {
    if (!data?.channelId || !data?.username) return
    const s = useChatStore.getState()
    if (s.voiceConnected?.channelId === data.channelId) {
      toast({ title: `${data.username} declined the ring` })
    }
  })

  sock.on('voice:signal', (data: { from: string; data: unknown }) => {
    if (!data?.from) return
    voiceEngine.handleSignal(data as { from: string; data: never })
  })

  // another tab or device of this account took over the voice session
  sock.on('voice:taken-over', (data: { channelId: string; newChannelId?: string }) => {
    if (!data?.channelId) return
    useChatStore.getState().onVoiceTakenOver(data)
  })

  // the sidecar dropped my GUEST voice session (the channel emptied or its
  // last real member left): tear down cleanly with an honest toast
  sock.on('voice:dropped', (data: { channelId: string }) => {
    if (!data?.channelId) return
    useChatStore.getState().onVoiceDropped(data)
  })

  // someone started / stopped watching MY screen share in a voice channel
  sock.on('voice:screen-watch', (data: {
    channelId: string
    watcher: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }
    watching: boolean
  }) => {
    if (!data?.channelId || !data?.watcher?.userId) return
    useChatStore.getState().onScreenWatch(data)
  })

  // a server's soundboard changed (admin added / removed a sound): any list
  // already loaded refetches so open pickers stay honest
  sock.on('soundboard:update', (data: { serverId: string }) => {
    if (!data?.serverId) return
    if (useChatStore.getState().soundboards[data.serverId]) {
      void useChatStore.getState().refreshSoundboard(data.serverId)
    }
  })

  // ---- calls ----
  sock.on('call:ring', (data: {
    callId: string
    conversationId: string
    from: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }
    video: boolean
    createdAt: number
    voice?: { channelId: string; serverId: string; channelName: string }
  }) => {
    if (!data?.callId || !data?.from?.userId) return
    useChatStore.getState().onCallRing(data)
  })

  sock.on('call:state', (data: {
    callId: string
    conversationId: string
    state: 'ringing' | 'active'
    createdBy: string
    createdAt: number
    acceptedAt?: number | null
    ringing?: string[]
    participants: {
      userId: string
      username: string
      displayName: string | null
      avatarUrl: string | null
      avatarColor: string
      muted: boolean
      deafened: boolean
      video: boolean
      screen: boolean
      recording: boolean
    }[]
  }) => {
    if (!data?.callId || !Array.isArray(data.participants)) return
    useChatStore.getState().onCallState(data)
  })

  sock.on('call:accepted', (data: { callId: string; userId: string; username: string }) => {
    if (!data?.callId) return
    useChatStore.getState().onCallAccepted(data)
  })

  sock.on('call:declined', (data: { callId: string; userId: string; username: string }) => {
    if (!data?.callId) return
    useChatStore.getState().onCallDeclined(data)
  })

  sock.on('call:peer-left', (data: { callId: string; userId: string }) => {
    if (!data?.callId) return
    useChatStore.getState().onCallPeerLeft(data)
  })

  sock.on('call:ended', (data: { callId: string; conversationId: string; reason: string; acceptedAt?: number | null; durationSec?: number | null }) => {
    if (!data?.callId) return
    useChatStore.getState().onCallEnded(data)
  })

  sock.on('call:signal', (data: { from: string; callId: string; data: unknown }) => {
    if (!data?.from) return
    useChatStore.getState().onCallSignal(data)
  })

  // another tab or device of this account took over the call
  sock.on('call:taken-over', (data: { callId: string; conversationId: string }) => {
    if (!data?.callId) return
    useChatStore.getState().onCallTakenOver(data)
  })

  // whisper-in-calls: someone in my call started / stopped routing their mic
  // to me alone; the chip on my call stage follows it
  sock.on('call:whisper', (data: {
    from: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }
    active: boolean
  }) => {
    if (!data?.from?.userId) return
    useChatStore.getState().onCallWhisper(data)
  })

  // ---- forum ----
  sock.on('forum:post:new', (data: { post: ForumPostSummary }) => {
    if (data?.post?.id) useChatStore.getState().onForumPostNew(data.post)
  })

  sock.on('forum:post:update', (data: { post: ForumPostSummary }) => {
    if (data?.post?.id) useChatStore.getState().onForumPostUpdate(data.post)
  })

  sock.on('forum:post:delete', (data: { postId: string }) => {
    if (data?.postId) useChatStore.getState().onForumPostDelete(data.postId)
  })

  // auto-idle: after 5 minutes without input, ONLINE users dim to idle
  // (yellow) with an away timestamp; manual dnd / invisible / chosen idle
  // are never overridden by inactivity. Replaced per re-wire like the
  // watchdog so it always reads the current generation's clocks.
  if (G[IDLE_KEY]) clearInterval(G[IDLE_KEY])
  G[IDLE_KEY] = setInterval(() => {
    if (manualPresence === 'online' && !autoIdled && Date.now() - lastActivityAt > 5 * 60 * 1000) {
      autoIdled = true
      socket?.emit('status:update', { status: 'idle' })
    }
  }, 30000)

  return socket
}

/** Switch the user's own presence status (status picker). Updates the local
 *  bookkeeping, tells the realtime service, and clears any auto-idle state. */
export function setPresence(presence: UserPresenceChoice): void {
  ensureWired()
  manualPresence = presence
  autoIdled = false
  // reconnects re-run the auth callback which reads manualPresence
  socket?.emit('status:update', { status: presence })
}

export function destroySocket(): void {
  if (G[WATCHDOG_KEY]) {
    clearInterval(G[WATCHDOG_KEY])
    delete G[WATCHDOG_KEY]
  }
  if (G[IDLE_KEY]) {
    clearInterval(G[IDLE_KEY])
    delete G[IDLE_KEY]
  }
  if (socket) {
    socket.removeAllListeners()
    socket.disconnect()
    socket = null
  }
  delete G[SOCKET_KEY]
  delete G[GEN_KEY]
  currentRoom = null
  currentServerRoom = null
  manualPresence = 'online'
  autoIdled = false
}

export function subscribeRoom(room: string): void {
  ensureWired()
  socket?.emit('subscribe', { rooms: [room] })
}

export function unsubscribeRoom(room: string): void {
  ensureWired()
  socket?.emit('unsubscribe', { rooms: [room] })
}

let typingSentAt = 0

export function emitTyping(room: string): void {
  ensureWired()
  const now = Date.now()
  if (now - typingSentAt < 1500) return
  typingSentAt = now
  socket?.emit('typing:start', { room })
}

export function emitTypingStop(room: string): void {
  ensureWired()
  typingSentAt = 0
  socket?.emit('typing:stop', { room })
}
