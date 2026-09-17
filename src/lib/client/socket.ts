'use client'

import { io, type Socket } from 'socket.io-client'
import { useChatStore } from './store'
import { sounds } from './sounds'
import { notifications } from './notifications'
import { voiceEngine } from './voice'
import { callEngine } from './call'
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

let socket: AnySocket | null = null
let currentRoom: string | null = null
let currentServerRoom: string | null = null

// watchdog bookkeeping
let watchdogTimer: ReturnType<typeof setInterval> | null = null
let lastActivityAt = Date.now()
let lastEngineActivity = Date.now()
let idleTimer: ReturnType<typeof setInterval> | null = null
// the manual status the user picked (online / idle / dnd / invisible);
// auto-idle only flips ONLINE users to idle, manual statuses stay put
let manualPresence: UserPresenceChoice = 'online'
let autoIdled = false

export function getSocket(): AnySocket | null {
  return socket
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
  currentRoom = room
  if (room) subscribeRoom(room)
}

/** The server room the sidebar listens on for live voice participant state
 *  (server:<id> carries voice:state even when not in the call). */
export function subscribeServerRoom(serverId: string | null): void {
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
  if (!socket) return
  if (!socket.connected) {
    // a manager stuck in backoff can sit silent for seconds: force it awake
    socket.disconnect()
    socket.connect()
  }
}

export function initSocket(presence?: UserPresenceChoice): AnySocket {
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
    wireHandlers(socket)
    return socket
  }

  // Local/LAN: talk to the sidecar on :3003 with credentials so the
  // httpOnly session cookie is included. CORS on the sidecar reflects the
  // request origin (credentials cannot work with origin '*').
  // Hosted/Trae: same-origin + XTransformPort so the outer proxy can reach it.
  const realtimeUrl = (() => {
    if (process.env.NEXT_PUBLIC_SOCKET_URL) return process.env.NEXT_PUBLIC_SOCKET_URL
    if (typeof window === 'undefined') return '/'
    const host = window.location.hostname
    const isLocal =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
    if (isLocal) return `${window.location.protocol}//${host}:3003`
    return '/?XTransformPort=3003'
  })()

  socket = io(realtimeUrl, {
    // polling first, then upgrade to websocket: polling works anywhere plain
    // HTTP works, so hostile proxies can never fully kill realtime; the
    // upgrade happens automatically once a websocket handshake succeeds
    path: '/socket.io',
    transports: ['polling', 'websocket'],
    withCredentials: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 750,
    reconnectionDelayMax: 5000,
    randomizationFactor: 0.4,
    timeout: 12000,
    // the persisted presence rides along in the handshake so invisible / dnd
    // users connect with the right status from the very first moment
    auth: {
      presence: presence ?? 'online',
    },
  })
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
    // every (re)connection must restore room subscriptions: a reconnect
    // gives us a fresh socket with zero rooms joined
    resubscribeAll()
    // catch up on anything missed while the line was down
    void store.syncNow()
  })

  // engine-level liveness signals. The engine object is replaced on every
  // reconnect, so re-attach when the manager opens a new one.
  activeSocket.io.on('open', () => {
    lastEngineActivity = Date.now()
    const engine = activeSocket.io.engine
    engine.on('ping', () => {
      lastEngineActivity = Date.now()
    })
    engine.on('pong', () => {
      lastEngineActivity = Date.now()
    })
  })

  sock.on('disconnect', () => {
    useChatStore.getState().onConnected(false)
  })

  sock.on('connect_error', () => {
    useChatStore.getState().onConnected(false)
  })

  // ---------- OS / browser level recovery hooks ----------
  if (typeof window !== 'undefined') {
    // the network itself came back (wifi drop, sleep/wake): reconnect now
    window.addEventListener(
      'online',
      () => {
        nudgeReconnect()
        void useChatStore.getState().syncNow()
      },
      { passive: true }
    )

    // returning to the tab: browsers freeze background timers and can kill
    // sockets silently, so probe the connection and refresh data
    document.addEventListener('visibilitychange', () => {
      const visible = document.visibilityState === 'visible'
      sounds.setUnfocused(!visible)
      if (visible) {
        nudgeReconnect()
        void useChatStore.getState().syncNow()
      }
    })

    // user input marks activity (used for the idle status)
    window.addEventListener('pointerdown', markActivity, { passive: true })
    window.addEventListener('keydown', markActivity)
  }

  // watchdog: never let the socket sit dead silently. If it claims to be
  // connected we also sanity-probe, because suspended tabs can leave a
  // zombie socket that never notices it died.
  watchdogTimer = setInterval(() => {
    if (!socket) return
    if (!socket.connected) {
      nudgeReconnect()
      return
    }
    // a healthy engine exchanges pings every pingInterval (25s); if the
    // last ping/pong is ancient, the connection is a zombie: cycle it
    if (Date.now() - lastEngineActivity > 90000) {
      lastEngineActivity = Date.now()
      socket.disconnect().connect()
    }
  }, 15000)

  // unlock audio on the first interaction (autoplay policies)
  const unlock = () => {
    sounds.unlock()
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', unlock, { passive: true })
    window.addEventListener('keydown', unlock)
    sounds.setUnfocused(document.visibilityState !== 'visible')
  }

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
  sock.on('voice:state', (data: { channelId: string; participants: { userId: string; username: string; sessionId: string; muted: boolean; deafened: boolean }[] }) => {
    if (!data?.channelId || !Array.isArray(data.participants)) return
    useChatStore.getState().onVoiceState(data)
  })

  sock.on('voice:signal', (data: { from: string; data: unknown }) => {
    if (!data?.from) return
    voiceEngine.handleSignal(data as { from: string; data: never })
  })

  // ---- calls ----
  sock.on('call:ring', (data: {
    callId: string
    conversationId: string
    from: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }
    video: boolean
    createdAt: number
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

  sock.on('call:ended', (data: { callId: string; conversationId: string; reason: string }) => {
    if (!data?.callId) return
    useChatStore.getState().onCallEnded(data)
  })

  sock.on('call:signal', (data: { from: string; callId: string; data: unknown }) => {
    if (!data?.from) return
    useChatStore.getState().onCallSignal(data)
  })

  sock.on('voice:ring', (data: {
    inviteId: string
    channelId: string
    serverId: string
    serverName: string
    serverIconUrl: string | null
    channelName: string
    from: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }
    createdAt: number
  }) => {
    if (!data?.inviteId || !data?.from?.userId) return
    useChatStore.getState().onVoiceRing(data)
  })

  sock.on('voice:ring-ended', (data: { inviteId: string; reason: string; channelId?: string; serverId?: string }) => {
    if (!data?.inviteId) return
    useChatStore.getState().onVoiceRingEnded(data)
  })

  // same-browser tabs share accept/decline/expire so leftover rings clear
  useChatStore.getState().bindCallTabSync()

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
  // are never overridden by inactivity
  idleTimer = setInterval(() => {
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
  manualPresence = presence
  autoIdled = false
  // reconnects re-send the handshake auth: keep it in sync
  if (socket && 'auth' in socket) {
    ;(socket as unknown as { auth: Record<string, unknown> }).auth.presence = presence
  }
  socket?.emit('status:update', { status: presence })
}

export function destroySocket(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
  if (idleTimer) {
    clearInterval(idleTimer)
    idleTimer = null
  }
  if (socket) {
    socket.removeAllListeners()
    socket.disconnect()
    socket = null
  }
  currentRoom = null
  manualPresence = 'online'
  autoIdled = false
}

export function subscribeRoom(room: string): void {
  socket?.emit('subscribe', { rooms: [room] })
}

export function unsubscribeRoom(room: string): void {
  socket?.emit('unsubscribe', { rooms: [room] })
}

let typingSentAt = 0

export function emitTyping(room: string): void {
  const now = Date.now()
  if (now - typingSentAt < 1500) return
  typingSentAt = now
  socket?.emit('typing:start', { room })
}

export function emitTypingStop(room: string): void {
  typingSentAt = 0
  socket?.emit('typing:stop', { room })
}
