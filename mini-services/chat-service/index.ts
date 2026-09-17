/// <reference types="bun-types" />
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { Server, Socket } from 'socket.io'
import { jwtVerify } from 'jose'
import { Database } from 'bun:sqlite'

const PORT = 3003
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'hyperion-dev-secret-9f4k2m8s1q7')
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || 'hyperion-internal-7x3n9'

// site-level suspension check on the handshake: banned users must not hold a
// socket. Reads the same SQLite file Prisma writes (bannedUntil = epoch ms).
const DB_URL = process.env.DATABASE_URL || ''
const DB_PATH = DB_URL.startsWith('file:') ? DB_URL.slice(5) : DB_URL || '../../db/custom.db'
let accountDb: Database | null = null

// read-write handle for the last-seen bookkeeping. Prisma never writes
// User.lastSeenAt (it only reads it), so this service is the sole writer:
// a write-behind stamp on the final socket disconnect, cleared on reconnect.
// Every access is guarded: a DB hiccup must never take the socket service down.
let rwDb: Database | null = null

function openRw(): Database | null {
  if (rwDb) return rwDb
  try {
    rwDb = new Database(DB_PATH, { readwrite: true, create: false })
    // Prisma's connection may be mid-write: wait instead of failing busy
    rwDb.exec('PRAGMA busy_timeout = 4000')
    return rwDb
  } catch {
    rwDb = null
    return null
  }
}

/** Stamp User.lastSeenAt (epoch ms, matching how Prisma stores DateTime in
 *  SQLite). Pass null to clear (user came back online). */
function stampLastSeen(userId: string, at: number | null): void {
  try {
    const db = openRw()
    if (!db) return
    db.run('UPDATE User SET lastSeenAt = ? WHERE id = ?', [at, userId])
  } catch {
    // last-seen is cosmetic: swallow and move on
  }
}

function isoOf(value: number | string | null): string | null {
  if (value === null) return null
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** userId -> ISO last-seen for every user that is offline right now but was
 *  seen before (straight from the DB). Users currently holding a socket,
 *  invisible ones included, are skipped so lurking stays indistinguishable
 *  from being gone. */
function lastSeenSnapshot(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const db = openRw()
    if (!db) return out
    const rows = db
      .query('SELECT id, lastSeenAt FROM User WHERE lastSeenAt IS NOT NULL')
      .all() as { id: string; lastSeenAt: number | string }[]
    for (const row of rows) {
      if (online.has(row.id)) continue
      const iso = isoOf(row.lastSeenAt)
      if (iso) out[row.id] = iso
    }
  } catch {
    // fall through with whatever was collected
  }
  return out
}

function isSuspended(userId: string): boolean {
  try {
    if (!accountDb) accountDb = new Database(DB_PATH, { readonly: true })
    const row = accountDb
      .query('SELECT bannedUntil FROM User WHERE id = ?')
      .get(userId) as { bannedUntil: number | string | null } | null
    if (!row || row.bannedUntil === null) return false
    const until = Number(row.bannedUntil)
    return Number.isFinite(until) && until > Date.now()
  } catch {
    // fail open: the Next.js session gate is the authority on bans
    return false
  }
}

interface SocketUser {
  userId: string
  username: string
  presence?: 'online' | 'idle' | 'busy' | 'dnd' | 'invisible'
}

const io = new Server({
  // Match the browser client (path '/socket.io'). Next rewrites same-origin
  // /socket.io → this process; Trae XTransformPort proxies the same path.
  path: '/socket.io',
  // Reflect the request origin so withCredentials (session cookie) works
  // if anything still hits this port directly.
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// userId -> set of socket ids
const online = new Map<string, Set<string>>()
// userId -> manual presence status
const statuses = new Map<string, 'online' | 'idle' | 'busy' | 'dnd' | 'invisible'>()
// userId -> epoch ms of when the user went idle (for "away for X" displays)
const awaySince = new Map<string, number>()

// ---- voice presence (ephemeral, in-memory only) ----
// channelId -> userId -> participant. Voice state is deliberately not
// persisted: it lives and dies with the socket session (the Prisma schema
// has no VoiceParticipant row this wave).
type VoiceParticipant = { userId: string; username: string; sessionId: string; muted: boolean; deafened: boolean; socketId: string }
const voice = new Map<string, Map<string, VoiceParticipant>>()

function voiceParticipants(channelId: string): { userId: string; username: string; sessionId: string; muted: boolean; deafened: boolean }[] {
  const map = voice.get(channelId)
  if (!map) return []
  return Array.from(map.values()).map((p) => ({
    userId: p.userId,
    username: p.username,
    sessionId: p.sessionId,
    muted: p.muted,
    deafened: p.deafened,
  }))
}

/** Emit the live participant list to the voice room and the server room
 *  (the sidebar reads it to show live avatars even when not in the call). */
function broadcastVoice(channelId: string, serverId: string): void {
  const payload = { channelId, participants: voiceParticipants(channelId) }
  io.to(`voice:${channelId}`).emit('voice:state', payload)
  io.to(`server:${serverId}`).emit('voice:state', payload)
}

/** Remove one participant from a voice room and re-broadcast. Idempotent. */
function dropVoiceParticipant(channelId: string, serverId: string, userId: string): void {
  const map = voice.get(channelId)
  if (!map) return
  map.delete(userId)
  if (map.size === 0) voice.delete(channelId)
  broadcastVoice(channelId, serverId)
}

// ---- calls (1:1 and group, ephemeral, in-memory) ----
// One live call per conversation. Presence lives and dies with sockets, like
// the voice-channel map above. Signaling stays relay-only: the sidecar never
// parses SDP/ICE, it routes opaque payloads between user rooms.
type CallParticipant = {
  userId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  avatarColor: string
  socketId: string
  muted: boolean
  deafened: boolean
  /** camera streaming */
  video: boolean
  /** screenshare streaming */
  screen: boolean
}
type ActiveCall = {
  callId: string
  conversationId: string
  createdBy: string
  createdAt: number
  /** joined and streaming */
  participants: Map<string, CallParticipant>
  /** still being rung (subset of conversation members not yet decided) */
  ringing: Set<string>
  /** every user we tried to ring (for multi-tab / multi-device end fanout) */
  ringTargets: Set<string>
  /** first accept timestamp; null while nobody has joined */
  acceptedAt: number | null
  /** when participants hit 1: an alone-timer starts (10 min -> auto end) */
  aloneTimer: ReturnType<typeof setTimeout> | null
}
const calls = new Map<string, ActiveCall>()
const callByConversation = new Map<string, string>()

/** Pending voice-channel rings: friend invites into a server VC. */
type VoiceRing = {
  inviteId: string
  channelId: string
  serverId: string
  serverName: string
  serverIconUrl: string | null
  channelName: string
  from: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }
  toUserId: string
  createdAt: number
  timer: ReturnType<typeof setTimeout> | null
}
const voiceRings = new Map<string, VoiceRing>()

const CALL_RING_TIMEOUT_MS = 60_000
const CALL_ALONE_TIMEOUT_MS = 10 * 60_000
const VOICE_RING_TIMEOUT_MS = 45_000

function callParticipantsPayload(call: ActiveCall) {
  return Array.from(call.participants.values()).map((p) => ({
    userId: p.userId,
    username: p.username,
    displayName: p.displayName,
    avatarUrl: p.avatarUrl,
    avatarColor: p.avatarColor,
    muted: p.muted,
    deafened: p.deafened,
    video: p.video,
    screen: p.screen,
  }))
}

/** Full state broadcast to the conversation room and every ring target's
 *  personal room so multi-device tabs that never opened the chat still learn
 *  when the call was picked up or expired. */
function broadcastCallState(call: ActiveCall, state: 'ringing' | 'active'): void {
  const payload = {
    callId: call.callId,
    conversationId: call.conversationId,
    state,
    createdBy: call.createdBy,
    createdAt: call.createdAt,
    participants: callParticipantsPayload(call),
  }
  io.to(`conversation:${call.conversationId}`).emit('call:state', payload)
  for (const uid of call.ringTargets) {
    io.to(`user:${uid}`).emit('call:state', payload)
  }
}

function destroyCall(call: ActiveCall, reason: string): void {
  if (call.aloneTimer) clearTimeout(call.aloneTimer)
  calls.delete(call.callId)
  if (callByConversation.get(call.conversationId) === call.callId) {
    callByConversation.delete(call.conversationId)
  }
  const payload = {
    callId: call.callId,
    conversationId: call.conversationId,
    reason,
  }
  // conversation room covers people watching the chat; personal rooms cover
  // every device that was rung (even tabs that never opened the conversation)
  io.to(`conversation:${call.conversationId}`).emit('call:ended', payload)
  for (const uid of call.ringTargets) {
    io.to(`user:${uid}`).emit('call:ended', payload)
  }
  for (const uid of call.participants.keys()) {
    io.to(`user:${uid}`).emit('call:ended', payload)
  }
}

/** Drop one participant (hangup or disconnect). The call only ends when the
 *  LAST participant leaves; a lone survivor gets a 10-minute grace window
 *  before the call auto-ends (they may be waiting for someone to return).
 *  Hangup is always personal leave: never destroy just because the creator left. */
function dropCallParticipant(call: ActiveCall, userId: string): void {
  call.participants.delete(userId)
  if (call.participants.size === 0) {
    destroyCall(call, 'empty')
    return
  }
  if (call.participants.size === 1 && call.acceptedAt) {
    if (call.aloneTimer) clearTimeout(call.aloneTimer)
    call.aloneTimer = setTimeout(() => {
      const c = calls.get(call.callId)
      if (c && c.participants.size <= 1) destroyCall(c, 'timeout')
    }, CALL_ALONE_TIMEOUT_MS)
  } else if (call.aloneTimer && call.participants.size > 1) {
    clearTimeout(call.aloneTimer)
    call.aloneTimer = null
  }
  const leftPayload = { callId: call.callId, userId }
  io.to(`conversation:${call.conversationId}`).emit('call:peer-left', leftPayload)
  for (const uid of call.participants.keys()) {
    io.to(`user:${uid}`).emit('call:peer-left', leftPayload)
  }
  broadcastCallState(call, call.acceptedAt ? 'active' : 'ringing')
}

type VisibleStatus = 'online' | 'idle' | 'busy' | 'dnd' | 'offline'

/** What everyone ELSE should see for this user. Invisible users look offline. */
function visibleStatusOf(userId: string): VisibleStatus {
  const s = statuses.get(userId)
  if (!s) return 'offline'
  if (s === 'invisible') return 'offline'
  return s
}

function setInternalStatus(userId: string, status: 'online' | 'idle' | 'busy' | 'dnd' | 'invisible') {
  statuses.set(userId, status)
  if (status === 'idle') {
    if (!awaySince.has(userId)) awaySince.set(userId, Date.now())
  } else {
    awaySince.delete(userId)
  }
}

function presencePayload(userId: string, status: VisibleStatus) {
  return {
    userId,
    status,
    awaySince: status === 'idle' ? awaySince.get(userId) ?? null : null,
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    const val = part.slice(idx + 1).trim()
    if (key) out[key] = decodeURIComponent(val)
  }
  return out
}

// handshake auth: token in auth payload, or the session cookie set by the Next.js app.
// The auth payload may also carry the user's persisted presence choice so an
// invisible or dnd user connects with the right status from the first moment.
async function authorize(handshake: {
  auth?: Record<string, unknown> | { token?: unknown; presence?: unknown }
  headers?: Record<string, string | string[] | undefined>
}): Promise<(SocketUser & { presence?: 'online' | 'idle' | 'busy' | 'dnd' | 'invisible' }) | null> {
  let token: unknown = (handshake.auth as { token?: unknown } | undefined)?.token
  if (typeof token !== 'string' || !token) {
    const cookies = parseCookies(handshake.headers?.cookie as string | undefined)
    token = cookies['hyperchat_session']
  }
  if (typeof token !== 'string' || !token) return null
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET)
    if (typeof payload.sub !== 'string') return null
    if (isSuspended(payload.sub)) return null
    const rawPresence = (handshake.auth as { presence?: unknown } | undefined)?.presence
    const presence =
      rawPresence === 'idle' || rawPresence === 'busy' || rawPresence === 'dnd' || rawPresence === 'invisible' ? rawPresence : undefined
    return { userId: payload.sub, username: (payload.username as string) || '', presence }
  } catch {
    return null
  }
}

// handshake auth: JWT signed by the Next.js app (auth token or session cookie)
io.use(async (socket, next) => {
  const user = await authorize(socket.handshake)
  if (!user) {
    next(new Error('unauthorized'))
    return
  }
  socket.data.user = user
  next()
})

io.on('connection', (socket: Socket) => {
  const user = socket.data.user as SocketUser
  if (!user) {
    socket.disconnect(true)
    return
  }

  let set = online.get(user.userId)
  const isFirstSocket = !set
  if (!set) {
    set = new Set()
    online.set(user.userId, set)
  }
  set.add(socket.id)

  // personal room for direct notifications (DMs, server refresh)
  void socket.join(`user:${user.userId}`)

  if (isFirstSocket) {
    const bootStatus = user.presence ?? 'online'
    setInternalStatus(user.userId, bootStatus)
    // back online: "last online" should stop being meaningful until the next
    // drop, so clear any stale stamp (invisible users included: their socket
    // is live, they count as seen)
    stampLastSeen(user.userId, null)
    io.emit('presence:online', presencePayload(user.userId, visibleStatusOf(user.userId)))
  }
  // each socket gets the current presence map; invisible users are hidden
  // from everyone (their own client learns its own status from the session)
  const visibleIds = Array.from(online.keys()).filter((id) => visibleStatusOf(id) !== 'offline' || id === user.userId)
  socket.emit('presence:init', {
    onlineUserIds: visibleIds,
    statuses: Object.fromEntries(visibleIds.map((id) => [id, visibleStatusOf(id)])),
    awaySince: Object.fromEntries(
      visibleIds
        .filter((id) => awaySince.has(id))
        .map((id) => [id, awaySince.get(id)])
    ),
    lastSeen: lastSeenSnapshot(),
  })

  socket.on('subscribe', (data: { rooms?: string[] }) => {
    const rooms = Array.isArray(data?.rooms) ? data.rooms.filter((r) => typeof r === 'string') : []
    for (const room of rooms) void socket.join(room)
  })

  socket.on('unsubscribe', (data: { rooms?: string[] }) => {
    const rooms = Array.isArray(data?.rooms) ? data.rooms.filter((r) => typeof r === 'string') : []
    for (const room of rooms) void socket.leave(room)
  })

  socket.on('typing:start', (data: { room?: string }) => {
    if (typeof data?.room !== 'string') return
    socket.to(data.room).emit('typing', { room: data.room, userId: user.userId, username: user.username, typing: true })
  })

  socket.on('typing:stop', (data: { room?: string }) => {
    if (typeof data?.room !== 'string') return
    socket.to(data.room).emit('typing', { room: data.room, userId: user.userId, username: user.username, typing: false })
  })

  // manual presence status: online / idle / dnd / invisible (persisted choice
  // from the client). Auto-idle flips online -> idle after inactivity; any
  // input flips it back. Broadcast uses the VISIBLE status so invisible users
  // appear offline to others while staying connected.
  socket.on('status:update', (data: { status?: string; silent?: boolean }) => {
    const raw = data?.status
    const status: 'online' | 'idle' | 'busy' | 'dnd' | 'invisible' =
      raw === 'idle' || raw === 'busy' || raw === 'dnd' || raw === 'invisible' ? raw : 'online'
    if (!online.has(user.userId)) return
    if (statuses.get(user.userId) === status) {
      // still refresh awaySince bookkeeping on repeat idles
      if (status === 'idle' && !awaySince.has(user.userId)) awaySince.set(user.userId, Date.now())
      return
    }
    // coming back from idle manually should not fire a broadcast storm
    setInternalStatus(user.userId, status)
    if (!data?.silent) {
      io.emit('presence:status', presencePayload(user.userId, visibleStatusOf(user.userId)))
    }
  })

  // ---- voice: presence + WebRTC signaling relay ----
  // The sidecar never parses SDP/ICE: 'voice:signal' relays opaque payloads
  // between peers. Presence is tracked in the in-memory `voice` map above.
  socket.on('voice:join', (data: { channelId?: string; serverId?: string; sessionId?: string }) => {
    const channelId = typeof data?.channelId === 'string' ? data.channelId : ''
    const serverId = typeof data?.serverId === 'string' ? data.serverId : ''
    const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : socket.id
    if (!channelId) return
    void socket.join(`voice:${channelId}`)
    // remember this socket owns a voice presence so disconnect can clean it up
    ;(socket.data as { voice?: { channelId: string; serverId: string } }).voice = { channelId, serverId }
    let map = voice.get(channelId)
    if (!map) {
      map = new Map()
      voice.set(channelId, map)
    }
    map.set(user.userId, { userId: user.userId, username: user.username, sessionId, muted: false, deafened: false, socketId: socket.id })
    broadcastVoice(channelId, serverId)
  })

  socket.on('voice:leave', () => {
    const v = (socket.data as { voice?: { channelId: string; serverId: string } }).voice
    if (!v) return
    delete (socket.data as { voice?: unknown }).voice
    dropVoiceParticipant(v.channelId, v.serverId, user.userId)
  })

  socket.on('voice:mute', (data: { muted?: boolean }) => {
    const v = (socket.data as { voice?: { channelId: string; serverId: string } }).voice
    if (!v) return
    const map = voice.get(v.channelId)
    const p = map?.get(user.userId)
    if (p) {
      p.muted = data?.muted !== false
      broadcastVoice(v.channelId, v.serverId)
    }
  })

  socket.on('voice:deafen', (data: { deafen?: boolean }) => {
    const v = (socket.data as { voice?: { channelId: string; serverId: string } }).voice
    if (!v) return
    const map = voice.get(v.channelId)
    const p = map?.get(user.userId)
    if (p) {
      p.deafened = data?.deafen !== false
      broadcastVoice(v.channelId, v.serverId)
    }
  })

  socket.on('voice:signal', (data: { to?: string; data?: unknown }) => {
    if (typeof data?.to !== 'string' || data.to === user.userId) return
    socket.to(`user:${data.to}`).emit('voice:signal', { from: user.userId, data: data.data })
  })

  // ring a friend into the voice channel I'm already in
  socket.on(
    'voice:ring',
    (data: {
      channelId?: string
      serverId?: string
      serverName?: string
      serverIconUrl?: string | null
      channelName?: string
      toUserId?: string
      profile?: { displayName?: string | null; avatarUrl?: string | null; avatarColor?: string }
    }) => {
      const channelId = typeof data?.channelId === 'string' ? data.channelId : ''
      const serverId = typeof data?.serverId === 'string' ? data.serverId : ''
      const toUserId = typeof data?.toUserId === 'string' ? data.toUserId : ''
      if (!channelId || !serverId || !toUserId || toUserId === user.userId) return
      const v = (socket.data as { voice?: { channelId: string; serverId: string } }).voice
      if (!v || v.channelId !== channelId) return
      // one pending ring per target at a time
      for (const [id, r] of voiceRings) {
        if (r.toUserId === toUserId) {
          if (r.timer) clearTimeout(r.timer)
          voiceRings.delete(id)
        }
      }
      const inviteId = `vr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const ring: VoiceRing = {
        inviteId,
        channelId,
        serverId,
        serverName: typeof data?.serverName === 'string' ? data.serverName.slice(0, 80) : 'server',
        serverIconUrl: typeof data?.serverIconUrl === 'string' ? data.serverIconUrl : null,
        channelName: typeof data?.channelName === 'string' ? data.channelName.slice(0, 80) : 'voice',
        from: {
          userId: user.userId,
          username: user.username,
          displayName: typeof data?.profile?.displayName === 'string' ? data.profile.displayName : null,
          avatarUrl: typeof data?.profile?.avatarUrl === 'string' ? data.profile.avatarUrl : null,
          avatarColor: typeof data?.profile?.avatarColor === 'string' ? data.profile.avatarColor : '#2e2e2e',
        },
        toUserId,
        createdAt: Date.now(),
        timer: null,
      }
      ring.timer = setTimeout(() => {
        const cur = voiceRings.get(inviteId)
        if (!cur) return
        voiceRings.delete(inviteId)
        io.to(`user:${cur.toUserId}`).emit('voice:ring-ended', { inviteId, reason: 'no-answer' })
        io.to(`user:${cur.from.userId}`).emit('voice:ring-ended', { inviteId, reason: 'no-answer' })
      }, VOICE_RING_TIMEOUT_MS)
      voiceRings.set(inviteId, ring)
      io.to(`user:${toUserId}`).emit('voice:ring', {
        inviteId,
        channelId,
        serverId,
        serverName: ring.serverName,
        serverIconUrl: ring.serverIconUrl,
        channelName: ring.channelName,
        from: ring.from,
        createdAt: ring.createdAt,
      })
    }
  )

  socket.on('voice:ring-accept', (data: { inviteId?: string }) => {
    const inviteId = typeof data?.inviteId === 'string' ? data.inviteId : ''
    const ring = voiceRings.get(inviteId)
    if (!ring || ring.toUserId !== user.userId) return
    if (ring.timer) clearTimeout(ring.timer)
    voiceRings.delete(inviteId)
    io.to(`user:${ring.from.userId}`).emit('voice:ring-ended', { inviteId, reason: 'accepted' })
    // the accepting client joins voice itself; we just clear the invite
    socket.emit('voice:ring-ended', { inviteId, reason: 'accepted', channelId: ring.channelId, serverId: ring.serverId })
  })

  socket.on('voice:ring-decline', (data: { inviteId?: string }) => {
    const inviteId = typeof data?.inviteId === 'string' ? data.inviteId : ''
    const ring = voiceRings.get(inviteId)
    if (!ring || ring.toUserId !== user.userId) return
    if (ring.timer) clearTimeout(ring.timer)
    voiceRings.delete(inviteId)
    io.to(`user:${ring.from.userId}`).emit('voice:ring-ended', { inviteId, reason: 'declined' })
    socket.emit('voice:ring-ended', { inviteId, reason: 'declined' })
  })

  socket.on('voice:ring-cancel', (data: { inviteId?: string }) => {
    const inviteId = typeof data?.inviteId === 'string' ? data.inviteId : ''
    const ring = voiceRings.get(inviteId)
    if (!ring || ring.from.userId !== user.userId) return
    if (ring.timer) clearTimeout(ring.timer)
    voiceRings.delete(inviteId)
    io.to(`user:${ring.toUserId}`).emit('voice:ring-ended', { inviteId, reason: 'cancelled' })
  })

  // ---- calls: lifecycle + WebRTC signaling relay ----
  socket.on(
    'call:start',
    (data: {
      conversationId?: string
      video?: boolean
      profile?: { username?: string; displayName?: string | null; avatarUrl?: string | null; avatarColor?: string }
      participantIds?: string[]
    }) => {
      const conversationId = typeof data?.conversationId === 'string' ? data.conversationId : ''
      if (!conversationId) return
      // one live call per conversation: join the existing one instead
      const existingId = callByConversation.get(conversationId)
      const existing = existingId ? calls.get(existingId) : undefined
      const call =
        existing ??
        ({
          callId: `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          conversationId,
          createdBy: user.userId,
          createdAt: Date.now(),
          participants: new Map(),
          ringing: new Set(),
          ringTargets: new Set(),
          acceptedAt: null,
          aloneTimer: null,
        } satisfies ActiveCall)
      if (!existing) {
        calls.set(call.callId, call)
        callByConversation.set(conversationId, call.callId)
      }

      call.participants.set(user.userId, {
        userId: user.userId,
        username: user.username,
        displayName: typeof data?.profile?.displayName === 'string' ? data.profile.displayName : null,
        avatarUrl: typeof data?.profile?.avatarUrl === 'string' ? data.profile.avatarUrl : null,
        avatarColor: typeof data?.profile?.avatarColor === 'string' ? data.profile.avatarColor : '#2e2e2e',
        socketId: socket.id,
        muted: false,
        deafened: false,
        video: data?.video === true,
        screen: false,
      })
      ;(socket.data as { call?: { callId: string } }).call = { callId: call.callId }

      // ring every other conversation member: the conversation room (anyone
      // standing there) plus each member's personal user room (reaches
      // members who never opened this conversation)
      const ringPayload = {
        callId: call.callId,
        conversationId,
        from: {
          userId: user.userId,
          username: user.username,
          displayName: typeof data?.profile?.displayName === 'string' ? data.profile.displayName : null,
          avatarUrl: typeof data?.profile?.avatarUrl === 'string' ? data.profile.avatarUrl : null,
          avatarColor: typeof data?.profile?.avatarColor === 'string' ? data.profile.avatarColor : '#2e2e2e',
        },
        video: data?.video === true,
        createdAt: call.createdAt,
      }
      io.to(`conversation:${conversationId}`).emit('call:ring', ringPayload)
      const ringTargets = Array.isArray(data?.participantIds)
        ? data.participantIds.filter((id) => typeof id === 'string' && id !== user.userId)
        : []
      for (const pid of ringTargets) {
        call.ringTargets.add(pid)
        call.ringing.add(pid)
        io.to(`user:${pid}`).emit('call:ring', ringPayload)
      }
      broadcastCallState(call, existing ? 'active' : 'ringing')

      // unanswered rings expire so callers never ring forever
      if (!existing) {
        setTimeout(() => {
          const c = calls.get(call.callId)
          if (c && c.acceptedAt === null) destroyCall(c, 'no-answer')
        }, CALL_RING_TIMEOUT_MS)
      }
    }
  )

  socket.on('call:accept', (data: { callId?: string }) => {
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    if (!call) return
    call.ringing.delete(user.userId)
    if (!call.participants.has(user.userId)) {
      call.participants.set(user.userId, {
        userId: user.userId,
        username: user.username,
        displayName: null,
        avatarUrl: null,
        avatarColor: '#2e2e2e',
        socketId: socket.id,
        muted: false,
        deafened: false,
        video: false,
        screen: false,
      })
    }
    const p = call.participants.get(user.userId)
    if (p) p.socketId = socket.id
    ;(socket.data as { call?: { callId: string } }).call = { callId: call.callId }
    if (!call.acceptedAt) call.acceptedAt = Date.now()
    io.to(`conversation:${call.conversationId}`).emit('call:accepted', {
      callId: call.callId,
      userId: user.userId,
      username: user.username,
    })
    broadcastCallState(call, 'active')
  })

  socket.on('call:decline', (data: { callId?: string }) => {
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    if (!call) return
    call.ringing.delete(user.userId)
    io.to(`conversation:${call.conversationId}`).emit('call:declined', {
      callId: call.callId,
      userId: user.userId,
      username: user.username,
    })
    // a decline from the only non-caller ends a 1:1 call that never connected
    if (call.participants.size <= 1 && !call.acceptedAt) destroyCall(call, 'declined')
  })

  // let-ring: the callee dismisses the incoming screen but the caller keeps
  // ringing. Deliberately silent to the other side: no broadcast at all.
  socket.on('call:let-ring', (data: { callId?: string }) => {
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    if (call) call.ringing.delete(user.userId)
  })

  // caller withdraws before anyone accepted
  socket.on('call:cancel', (data: { callId?: string }) => {
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    if (!call) return
    delete (socket.data as { call?: unknown }).call
    dropCallParticipant(call, user.userId)
    if (!call.acceptedAt && calls.has(call.callId)) destroyCall(call, 'cancelled')
  })

  // hangup: I leave, the call itself continues for everyone still in it
  socket.on('call:hangup', (data: { callId?: string }) => {
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    if (!call) return
    delete (socket.data as { call?: unknown }).call
    dropCallParticipant(call, user.userId)
  })

  socket.on('call:mute', (data: { callId?: string; muted?: boolean }) => {
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    const p = call?.participants.get(user.userId)
    if (call && p) {
      p.muted = data?.muted !== false
      broadcastCallState(call, 'active')
    }
  })

  socket.on('call:deafen', (data: { callId?: string; deafened?: boolean }) => {
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    const p = call?.participants.get(user.userId)
    if (call && p) {
      p.deafened = data?.deafened !== false
      broadcastCallState(call, 'active')
    }
  })

  // camera / screenshare toggles propagate as authoritative media flags:
  // receivers detach remote video surfaces the moment the flags say off, so
  // a stopped screenshare can never freeze on its last frame
  socket.on('call:media-state', (data: { callId?: string; video?: boolean; screen?: boolean }) => {
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    const p = call?.participants.get(user.userId)
    if (call && p) {
      if (typeof data?.video === 'boolean') p.video = data.video
      if (typeof data?.screen === 'boolean') p.screen = data.screen
      broadcastCallState(call, 'active')
    }
  })

  socket.on('call:signal', (data: { callId?: string; to?: string; data?: unknown }) => {
    if (typeof data?.to !== 'string' || data.to === user.userId) return
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    if (!call || !call.participants.has(user.userId) || !call.participants.has(data.to)) return
    socket.to(`user:${data.to}`).emit('call:signal', { from: user.userId, callId: call.callId, data: data.data })
  })

  socket.on('disconnect', () => {
    // voice presence dies with the socket that joined it
    const v = (socket.data as { voice?: { channelId: string; serverId: string } }).voice
    if (v) {
      const map = voice.get(v.channelId)
      const vp = map?.get(user.userId)
      // only the socket that owns the seat drops it (other tabs of the same
      // user keep the voice presence alive)
      if (vp && vp.socketId === socket.id) dropVoiceParticipant(v.channelId, v.serverId, user.userId)
    }
    // an in-call socket dropping means that participant left the call, but
    // only when THIS socket still owns their seat (another tab may have
    // taken over via accept/start)
    const c = (socket.data as { call?: { callId: string } }).call
    if (c) {
      const call = calls.get(c.callId)
      const p = call?.participants.get(user.userId)
      if (call && p && p.socketId === socket.id) dropCallParticipant(call, user.userId)
    }
    // clear voice rings aimed at this user only when they go fully offline
    const set = online.get(user.userId)
    // any rings aimed at this socket's user stay until fully offline
    for (const call of calls.values()) {
      if (!set || set.size <= 1) call.ringing.delete(user.userId)
    }
    if (set) {
      set.delete(socket.id)
      if (set.size === 0) {
        online.delete(user.userId)
        statuses.delete(user.userId)
        awaySince.delete(user.userId)
        for (const [id, r] of voiceRings) {
          if (r.toUserId === user.userId || r.from.userId === user.userId) {
            if (r.timer) clearTimeout(r.timer)
            voiceRings.delete(id)
            const other = r.toUserId === user.userId ? r.from.userId : r.toUserId
            io.to(`user:${other}`).emit('voice:ring-ended', { inviteId: id, reason: 'offline' })
          }
        }
        // truly offline: persist when we saw them last (epoch ms in the DB,
        // ISO in the broadcast, matching the rest of the app) so clients can
        // render "last online Xh ago" now and after a service restart
        const at = Date.now()
        stampLastSeen(user.userId, at)
        io.emit('presence:offline', {
          userId: user.userId,
          lastSeenAt: new Date(at).toISOString(),
        })
      }
    }
  })
})

// Internal control API on its own port. The Next.js app calls this
// over localhost after persisting messages to broadcast events.
const CONTROL_PORT = 3004

const controlServer = createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0]

  if (req.method === 'GET' && url === '/health') {
    json(res, 200, { ok: true, online: online.size })
    return
  }

  // presence snapshot for the Next.js sync endpoint (HTTP fallback when
  // websockets degrade behind proxies: presence must never require a reload)
  if (req.method === 'GET' && url === '/presence') {
    const token = req.headers['x-internal-token']
    if (token !== INTERNAL_TOKEN) {
      json(res, 401, { error: 'unauthorized' })
      return
    }
    const visibleIds = Array.from(online.keys()).filter((id) => visibleStatusOf(id) !== 'offline')
    json(res, 200, {
      onlineUserIds: visibleIds,
      statuses: Object.fromEntries(visibleIds.map((id) => [id, visibleStatusOf(id)])),
      awaySince: Object.fromEntries(
        visibleIds
          .filter((id) => awaySince.has(id))
          .map((id) => [id, awaySince.get(id)])
      ),
      lastSeen: lastSeenSnapshot(),
    })
    return
  }

  // voice presence snapshot for the Next.js voice route (initial sidebar
  // render before the socket delivers voice:state)
  if (req.method === 'GET' && url === '/voice') {
    const token = req.headers['x-internal-token']
    if (token !== INTERNAL_TOKEN) {
      json(res, 401, { error: 'unauthorized' })
      return
    }
    const query = (req.url || '').split('?')[1] ?? ''
    const channelId = decodeURIComponent(new URLSearchParams(query).get('channelId') ?? '')
    json(res, 200, { channelId, participants: voiceParticipants(channelId) })
    return
  }

  // live call registry (observability: which conversations have calls)
  if (req.method === 'GET' && url === '/calls') {
    const token = req.headers['x-internal-token']
    if (token !== INTERNAL_TOKEN) {
      json(res, 401, { error: 'unauthorized' })
      return
    }
    json(res, 200, {
      calls: Array.from(calls.values()).map((c) => ({
        callId: c.callId,
        conversationId: c.conversationId,
        createdBy: c.createdBy,
        createdAt: c.createdAt,
        acceptedAt: c.acceptedAt,
        participants: callParticipantsPayload(c),
      })),
    })
    return
  }

  // internal emit endpoint used by the Next.js API after persisting messages
  if (req.method === 'POST' && url === '/emit') {
    const token = req.headers['x-internal-token']
    if (token !== INTERNAL_TOKEN) {
      json(res, 401, { error: 'unauthorized' })
      return
    }
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      const event = typeof body.event === 'string' ? body.event : ''
      // broadcast mode: { broadcast: true, event, payload } reaches EVERY
      // connected socket (io.emit). Used for profile changes, where every
      // online client may hold a cached view of the user. The classic
      // rooms[] path below stays exactly as it was.
      if (body.broadcast === true) {
        if (!event) {
          json(res, 400, { error: 'event is required' })
          return
        }
        io.emit(event, body.payload ?? null)
        json(res, 200, { ok: true, delivered: 1, broadcast: true })
        return
      }
      const rooms: string[] = Array.isArray(body.rooms)
        ? body.rooms
        : typeof body.room === 'string'
          ? [body.room]
          : []
      if (!rooms.length || !event) {
        json(res, 400, { error: 'rooms and event are required' })
        return
      }
      for (const room of rooms) {
        io.to(room).emit(event, body.payload ?? null)
      }
      json(res, 200, { ok: true, delivered: rooms.length })
    } catch {
      json(res, 400, { error: 'invalid body' })
    }
    return
  }

  json(res, 404, { error: 'not found' })
})

controlServer.listen(CONTROL_PORT, '127.0.0.1', () => {
  console.log(`HyperChat control API listening on port ${CONTROL_PORT}`)
})

io.listen(PORT)
io.engine.on('connection', () => {
  // first client socket wires the server; log once
})
console.log(`HyperChat realtime service listening on port ${PORT}`)

// graceful shutdown: everyone still holding a socket just went offline
// through no choice of their own, so stamp them all before exiting (cheap:
// one UPDATE per connected user)
function stampAllOnline(): void {
  const at = Date.now()
  for (const id of online.keys()) stampLastSeen(id, at)
}

process.on('SIGTERM', () => {
  stampAllOnline()
  void io.close()
  controlServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  stampAllOnline()
  void io.close()
  controlServer.close(() => process.exit(0))
})
