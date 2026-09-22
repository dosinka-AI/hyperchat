/// <reference types="bun-types" />
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { spawn } from 'node:child_process'
import { Server, Socket } from 'socket.io'
import { jwtVerify } from 'jose'
import { openSqlite, type SqliteDb } from './db-compat.ts'

const PORT = 3003
const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'hyperion-dev-secret-9f4k2m8s1q7')
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || 'hyperion-internal-7x3n9'

// site-level suspension check on the handshake: banned users must not hold a
// socket. Reads the same SQLite file Prisma writes (bannedUntil = epoch ms).
const DB_URL = process.env.DATABASE_URL || ''
const DB_PATH = DB_URL.startsWith('file:') ? DB_URL.slice(5) : DB_URL || '../../db/custom.db'
let accountDb: SqliteDb | null = null

// read-write handle for the last-seen bookkeeping. Prisma never writes
// User.lastSeenAt (it only reads it), so this service is the sole writer:
// a write-behind stamp on the final socket disconnect, cleared on reconnect.
// Every access is guarded: a DB hiccup must never take the socket service down.
let rwDb: SqliteDb | null = null

// the shim opens are async (runtime detection); these resolve during startup
// before the first socket handshake, and every consumer already tolerates a
// null handle by failing soft
const rwReady = openSqlite(DB_PATH).then((db) => {
  if (db) {
    try {
      // Prisma's connection may be mid-write: wait instead of failing busy
      db.exec('PRAGMA busy_timeout = 4000')
    } catch {
      /* pragma is best-effort */
    }
  }
  rwDb = db
  return db
})
const accountReady = openSqlite(DB_PATH, { readonly: true }).then((db) => {
  accountDb = db
  return db
})

/** Stamp User.lastSeenAt (epoch ms, matching how Prisma stores DateTime in
 *  SQLite). Pass null to clear (user came back online). */
function stampLastSeen(userId: string, at: number | null): void {
  try {
    if (!rwDb) return
    rwDb.run('UPDATE User SET lastSeenAt = ? WHERE id = ?', [at, userId])
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
    if (!rwDb) return out
    const rows = rwDb.all('SELECT id, lastSeenAt FROM User WHERE lastSeenAt IS NOT NULL') as {
      id: string
      lastSeenAt: number | string
    }[]
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
    if (!accountDb) return false
    // Task 6-c site bans: a UserBan row existing at all means suspended
    // (same SQLite file Prisma writes; createdAt/bannedBy never matter here)
    const banned = accountDb.get<{ one: number }>('SELECT 1 AS one FROM UserBan WHERE userId = ?', [userId])
    if (banned) return true
    const row = accountDb.get<{ bannedUntil: number | string | null }>(
      'SELECT bannedUntil FROM User WHERE id = ?',
      [userId]
    )
    if (!row || row.bannedUntil === null) return false
    const until = Number(row.bannedUntil)
    return Number.isFinite(until) && until > Date.now()
  } catch {
    // fail open: the Next.js session gate is the authority on bans
    return false
  }
}

// ---- server-side membership / permission checks (security hardening) ----
// The handshake proves WHO is connected; these checks prove WHAT they may
// touch. All lookups hit the same SQLite file Prisma writes, through the
// readonly account handle. A missing or throwing DB fails OPEN (service
// degraded): the HTTP layer stays the outer authority, exactly like
// isSuspended above, and realtime must not go down with a DB hiccup.

/** permission bits mirrored from src/lib/perm.ts (bit values are the contract) */
const PERM_ADMINISTRATOR = 1
const PERM_MANAGE_SERVER = 1 << 1
const PERM_MANAGE_MESSAGES = 1 << 7

/** The base id of a channel or conversation space: call-channel rooms ride
 *  synthetic `<baseId>~<slug>` ids that map back to their owning row. */
function baseSpaceIdOf(id: string): string {
  const i = id.indexOf('~')
  return i === -1 ? id : id.slice(0, i)
}

/** May this socket listen to this room? null = DB unavailable (fail open). */
function roomAccessOf(userId: string, room: string): boolean | null {
  if (room === `user:${userId}`) return true
  try {
    if (room.startsWith('server:')) {
      if (!accountDb) return null
      return !!accountDb.get('SELECT 1 AS one FROM ServerMember WHERE userId = ? AND serverId = ?', [
        userId,
        room.slice('server:'.length),
      ])
    }
    if (room.startsWith('channel:')) {
      const access = channelAccessOf(userId, room.slice('channel:'.length))
      return access === null ? null : access.ok
    }
    if (room.startsWith('conversation-guest:')) {
      // a cross-rung call guest's SEND-ONLY room: admission requires a live
      // (unexpired) guest ticket. Accepted guests are seated server-side on
      // call:accept; this check covers explicit re-subscribes (reconnects).
      if (!accountDb) return null
      return !!accountDb.get(
        'SELECT 1 AS one FROM CallGuest WHERE conversationId = ? AND userId = ? AND expiresAt > ?',
        [baseSpaceIdOf(room.slice('conversation-guest:'.length)), userId, Date.now()]
      )
    }
    if (room.startsWith('conversation:')) {
      if (!accountDb) return null
      return !!accountDb.get('SELECT 1 AS one FROM ConversationParticipant WHERE conversationId = ? AND userId = ?', [
        baseSpaceIdOf(room.slice('conversation:'.length)),
        userId,
      ])
    }
  } catch {
    return null
  }
  // voice: rooms are managed by voice:join; anything else is not a
  // client-subscribable room shape
  return false
}

/** Channel read access mirroring the app's getMemberContext().canReadChannel:
 *  server membership, plus for private channels the moderation bits or an
 *  access grant for the member's custom role. Also returns the channel's
 *  REAL serverId so presence broadcasts can never be aimed at a
 *  client-claimed foreign server room. null = DB unavailable (fail open). */
function channelAccessOf(userId: string, channelId: string): { ok: boolean; serverId: string } | null {
  if (!accountDb) return null
  try {
    const baseId = baseSpaceIdOf(channelId)
    const row = accountDb.get<{
      serverId: string
      private: number
      ownerId: string
      baseRole: string | null
      roleId: string | null
      rolePerms: number | null
    }>(
      `SELECT c.serverId AS serverId, c.private AS private, s.ownerId AS ownerId,
              sm.role AS baseRole, sm.roleId AS roleId, r.permissions AS rolePerms
       FROM Channel c
       JOIN Server s ON s.id = c.serverId
       LEFT JOIN ServerMember sm ON sm.serverId = c.serverId AND sm.userId = ?
       LEFT JOIN Role r ON r.id = sm.roleId
       WHERE c.id = ?`,
      [userId, baseId]
    )
    if (!row) return { ok: false, serverId: '' }
    if (!row.baseRole) return { ok: false, serverId: row.serverId } // not a member
    if (row.ownerId === userId || row.baseRole === 'ADMIN') return { ok: true, serverId: row.serverId }
    if (!row.private) return { ok: true, serverId: row.serverId }
    if (((row.rolePerms ?? 0) & (PERM_ADMINISTRATOR | PERM_MANAGE_MESSAGES)) !== 0) {
      return { ok: true, serverId: row.serverId }
    }
    if (row.roleId) {
      const grant = accountDb.get('SELECT 1 AS one FROM ChannelAccess WHERE channelId = ? AND roleId = ?', [
        baseId,
        row.roleId,
      ])
      return { ok: !!grant, serverId: row.serverId }
    }
    return { ok: false, serverId: row.serverId }
  } catch {
    return null
  }
}

/** May this user manage a server (MANAGE_SERVER / ADMINISTRATOR)? Mirrors
 *  the client's UI gate for the voice-stage crown. null = DB unavailable. */
function canManageServer(userId: string, serverId: string): boolean | null {
  if (!accountDb) return null
  try {
    const row = accountDb.get<{ ownerId: string; role: string | null; rolePerms: number | null }>(
      `SELECT s.ownerId AS ownerId, sm.role AS role, r.permissions AS rolePerms
       FROM Server s
       LEFT JOIN ServerMember sm ON sm.serverId = s.id AND sm.userId = ?
       LEFT JOIN Role r ON r.id = sm.roleId
       WHERE s.id = ?`,
      [userId, serverId]
    )
    if (!row || !row.role) return false
    if (row.ownerId === userId || row.role === 'ADMIN') return true
    return ((row.rolePerms ?? 0) & (PERM_ADMINISTRATOR | PERM_MANAGE_SERVER)) !== 0
  } catch {
    return null
  }
}

/** Is this user a participant of this conversation? Call-channel space ids
 *  (`convId~room`) resolve to their base conversation. null = DB
 *  unavailable (fail open), false = definitely not a member. */
function conversationMemberOf(userId: string, spaceId: string): boolean | null {
  if (!accountDb) return null
  try {
    const row = accountDb.get('SELECT 1 AS one FROM ConversationParticipant WHERE conversationId = ? AND userId = ?', [
      baseSpaceIdOf(spaceId),
      userId,
    ])
    return !!row
  } catch {
    return null
  }
}

/** Is either side blocked? Blocks gate rings exactly like they gate DMs
 *  (both directions), so a blocked account can never ring its blocker.
 *  null = DB unavailable (fail open). */
function blockedBetween(a: string, b: string): boolean | null {
  if (!accountDb) return null
  try {
    const row = accountDb.get(
      'SELECT 1 AS one FROM UserBlock WHERE (blockerId = ? AND blockedId = ?) OR (blockerId = ? AND blockedId = ?)',
      [a, b, b, a]
    )
    return !!row
  } catch {
    return null
  }
}

interface SocketUser {
  userId: string
  username: string
  presence?: 'online' | 'idle' | 'busy' | 'dnd' | 'invisible'
}

const io = new Server({
  // path '/' matches Caddy/nginx handle_path which STRIPS /socket.io before
  // proxying here. Next's rewrite (below) does the same strip so cloudflared
  // → :3000 → rewrite → :3003/?EIO=… lands on this Engine path.
  path: '/',
  // Reflect request origin so withCredentials works for local :3003 clients.
  // Same-origin via the Next rewrite never needs CORS; this covers direct
  // LAN/dev connections without breaking cookie auth.
  cors: {
    origin: (origin, cb) => cb(null, origin || true),
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
type VoiceParticipant = {
  userId: string
  username: string
  sessionId: string
  muted: boolean
  deafened: boolean
  socketId: string
  /** recording this channel's audio */
  recording: boolean
  /** camera streaming */
  video: boolean
  /** screenshare streaming (with sound) */
  screen: boolean
  /** remembered so a takeover can broadcast the channel the user left */
  serverId: string
}
const voice = new Map<string, Map<string, VoiceParticipant>>()

/** the priority speaker per voice channel (channelId -> userId), the
 *  voice-stage moderation crown: a moderator crowns one participant and
 *  while that person transmits, every other client ducks their output so
 *  the crown always cuts through. Ephemeral like the rest of voice state:
 *  it dies with the room (and with its wearer's departure). */
const prioritySpeaker = new Map<string, string>()

/** users currently being rung INTO a voice channel (channelId -> userId ->
 *  expiry timer + the exact ring payload). Everyone in the channel sees
 *  their pinging avatar; the ring dies on answer, decline or expiry. The
 *  payload is kept so an OFFLINE target gets the ring redelivered the
 *  moment they come back online (within the ring window). */
type VoiceRingEntry = { timer: ReturnType<typeof setTimeout>; ring: CallRingPayload }
const voiceRinging = new Map<string, Map<string, VoiceRingEntry>>()

/** GUESTS in server voice channels: users rung into a channel whose server
 *  they are NOT a member of (allowed while Server.allowGuestRings).
 *  channelId -> the invited userIds: their voice:join ticket and their
 *  rejoin window while they stay connected. Entries die with the ring
 *  (expiry / decline) or with the guest's own departure; the whole set
 *  dies when the channel empties or the last real member leaves. */
const guestVoice = new Map<string, Set<string>>()

/** May members ring NON-members into this server's voice channels?
 *  null = DB unavailable (the guest privilege fails closed). */
function serverAllowsGuestRings(serverId: string): boolean | null {
  try {
    if (!accountDb) return null
    const row = accountDb.get<{ allowGuestRings: number | null }>(
      'SELECT allowGuestRings FROM Server WHERE id = ?',
      [serverId]
    )
    if (!row) return false
    return row.allowGuestRings !== 0
  } catch {
    return null
  }
}

/** Invite a guest into a channel (their voice:join ticket). */
function guestVoiceAdd(channelId: string, userId: string): void {
  let set = guestVoice.get(channelId)
  if (!set) {
    set = new Set()
    guestVoice.set(channelId, set)
  }
  set.add(userId)
}

/** A guest's invitation died (ring expired / declined / they left): clear
 *  it unless they already ANSWERED — an answered guest keeps the ticket as
 *  their rejoin window until they actually leave the channel. */
function guestVoiceDrop(channelId: string, userId: string): void {
  const set = guestVoice.get(channelId)
  if (!set) return
  if (voice.get(channelId)?.has(userId)) return
  set.delete(userId)
  if (set.size === 0) guestVoice.delete(channelId)
}

/** The send-only room cross-rung CALL guests sit in (they are never in the
 *  conversation room itself). Call-channel space ids resolve to their base
 *  conversation. */
function guestRoomOf(conversationId: string): string {
  return `conversation-guest:${baseSpaceIdOf(conversationId)}`
}

/** Does this conversation's owner forbid cross-ringing non-members into
 *  its calls? true = forbidden; DB-down reads as allowed (fail open, like
 *  the rest of the degraded mode). */
function conversationBlocksCrossRing(spaceId: string): boolean {
  try {
    if (!accountDb) return false
    const row = accountDb.get<{ kind: string; allowCrossRing: number }>(
      'SELECT kind, allowCrossRing FROM Conversation WHERE id = ?',
      [baseSpaceIdOf(spaceId)]
    )
    return !!row && row.kind === 'GROUP' && row.allowCrossRing === 0
  } catch {
    return false
  }
}

/** how long a call-guest send ticket may live even if cleanup never ran
 *  (the messages route re-checks expiry on every send) */
const CALL_GUEST_TTL_MS = 24 * 60 * 60 * 1000

/** Stamp (or refresh) a cross-rung call guest's send-only ticket on the
 *  shared SQLite file. A failed write simply means the guest cannot send
 *  until a later accept restamps them. */
function stampCallGuest(callId: string, conversationId: string, userId: string): void {
  try {
    if (!rwDb) return
    const baseId = baseSpaceIdOf(conversationId)
    rwDb.run('DELETE FROM CallGuest WHERE conversationId = ? AND userId = ?', [baseId, userId])
    rwDb.run(
      'INSERT INTO CallGuest (id, callId, conversationId, userId, expiresAt) VALUES (?, ?, ?, ?, ?)',
      [
        `cg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        callId,
        baseId,
        userId,
        Date.now() + CALL_GUEST_TTL_MS,
      ]
    )
  } catch {
    /* the call itself is unaffected; the guest just cannot send */
  }
}

/** A call guest left the call: their send-only ticket dies with their seat
 *  (a re-accept stamps a fresh one). */
function clearCallGuest(call: ActiveCall, userId: string): void {
  try {
    rwDb?.run('DELETE FROM CallGuest WHERE conversationId = ? AND userId = ?', [
      baseSpaceIdOf(call.conversationId),
      userId,
    ])
  } catch {
    /* expiry is the backstop */
  }
}

const RING_USER_TIMEOUT_MS = 60_000

/** The payload shape of every `call:ring` emission (DM/group calls and
 *  rings into voice channels alike) — cached per target so a target who
 *  was offline can be handed the exact ring on return. */
type CallRingPayload = {
  callId: string
  conversationId: string
  from: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }
  video: boolean
  createdAt: number
  voice?: { channelId: string; serverId: string; channelName: string; guest?: boolean }
}

function voiceRingingIds(channelId: string): string[] {
  return Array.from(voiceRinging.get(channelId)?.keys() ?? [])
}

/** Remove one target's voice ring (answer / decline / expiry) and
 * re-broadcast so every client's pinging tile clears. */
function dropVoiceRing(channelId: string, targetId: string, serverId: string | undefined): void {
  const timers = voiceRinging.get(channelId)
  if (!timers) return
  const entry = timers.get(targetId)
  if (entry) clearTimeout(entry.timer)
  timers.delete(targetId)
  if (timers.size === 0) voiceRinging.delete(channelId)
  // a declined guest loses their voice:join ticket (unless they already
  // answered — guestVoiceDrop guards that itself)
  guestVoiceDrop(channelId, targetId)
  if (serverId) broadcastVoice(channelId, serverId)
}

function voiceParticipants(channelId: string): { userId: string; username: string; sessionId: string; muted: boolean; deafened: boolean; recording: boolean; video: boolean; screen: boolean }[] {
  const map = voice.get(channelId)
  if (!map) return []
  return Array.from(map.values()).map((p) => ({
    userId: p.userId,
    username: p.username,
    sessionId: p.sessionId,
    muted: p.muted,
    deafened: p.deafened,
    recording: p.recording,
    video: p.video,
    screen: p.screen,
  }))
}

/** The channel's priority speaker, or null when nobody holds the crown.
 *  Self-healing on read: a crown whose wearer is not in the room anymore
 *  (a takeover that never rejoined, a service hiccup) is dropped on the
 *  spot so a dangling entry can never reach a client. */
function voicePriorityOf(channelId: string): string | null {
  const id = prioritySpeaker.get(channelId)
  if (!id) return null
  const map = voice.get(channelId)
  if (!map || !map.has(id)) {
    prioritySpeaker.delete(channelId)
    return null
  }
  return id
}

/** Emit the live participant list (plus who is being rung in, plus who
 *  holds the priority-speaker crown) to the voice room and the server room
 *  (the sidebar reads it to show live avatars even when not in the call). */
function broadcastVoice(channelId: string, serverId: string): void {
  const payload = {
    channelId,
    participants: voiceParticipants(channelId),
    ringing: voiceRingingIds(channelId),
    priorityUserId: voicePriorityOf(channelId),
  }
  io.to(`voice:${channelId}`).emit('voice:state', payload)
  io.to(`server:${serverId}`).emit('voice:state', payload)
}

/** Remove one participant from a voice room and re-broadcast. Idempotent.
 *  `departingSocketId` guards the multi-tab case: only the socket that
 *  currently owns the presence may drop it, so a stale tab leaving never
 *  kills the fresh session that took over. Rings AIMED at the departing user
 *  die with them (nobody can answer from a gone socket). When the room
 *  empties entirely, every remaining ring dies too. */
function dropVoiceParticipant(
  channelId: string,
  serverId: string,
  userId: string,
  departingSocketId?: string
): void {
  const map = voice.get(channelId)
  if (!map) return
  const p = map.get(userId)
  if (!p) return
  if (departingSocketId && p.socketId !== departingSocketId) return
  map.delete(userId)
  // the crown dies with its wearer, and with the room when it empties
  // (voicePriorityOf would self-heal a dangling read anyway, but the
  // explicit delete keeps the map honest)
  if (prioritySpeaker.get(channelId) === userId) prioritySpeaker.delete(channelId)
  if (map.size === 0) {
    voice.delete(channelId)
    prioritySpeaker.delete(channelId)
    expireAllVoiceRings(channelId)
  }
  // a guest's own departure ends their invitation (coming back needs a
  // fresh ring); guestVoiceDrop keeps answered-and-connected guests alone
  guestVoiceDrop(channelId, userId)
  // failsafe: the last REAL member left while invited guests remain — a
  // channel cannot live on guests alone, so every guest is dropped and
  // told (their client tears the session down cleanly)
  if (map.size > 0) {
    const guests = guestVoice.get(channelId)
    if (guests && guests.size > 0 && ![...map.keys()].some((id) => !guests.has(id))) {
      for (const gid of [...map.keys()]) {
        if (prioritySpeaker.get(channelId) === gid) prioritySpeaker.delete(channelId)
        map.delete(gid)
        io.to(`user:${gid}`).emit('voice:dropped', { channelId })
      }
      voice.delete(channelId)
      prioritySpeaker.delete(channelId)
      guestVoice.delete(channelId)
      expireAllVoiceRings(channelId)
    }
  }
  expireVoiceRing(channelId, userId, serverId)
  broadcastVoice(channelId, serverId)
}

/** One voice presence per account, like Discord: a second tab or device
 *  joining voice takes over the mic. The previous socket is told it lost
 *  the session (`voice:taken-over`) so its client can tear down quietly
 *  instead of fighting over the same presence. */
function takeoverVoicePresence(userId: string, newSocketId: string): void {
  for (const [channelId, map] of voice) {
    const existing = map.get(userId)
    if (!existing || existing.socketId === newSocketId) continue
    io.to(existing.socketId).emit('voice:taken-over', {
      channelId,
      newChannelId: channelId,
    })
    map.delete(userId)
    if (map.size === 0) voice.delete(channelId)
    broadcastVoice(channelId, existing.serverId)
  }
}

/** The current voice state of every live channel in a server, handed to a
 *  socket the moment it joins (or re-joins after a reconnect) that server's
 *  room. Without this, a freshly-loaded sidebar shows nobody until the next
 *  join/leave broadcasts - people who were already talking stay invisible
 *  until something changes. */
function sendServerVoiceState(socket: Socket, serverId: string): void {
  for (const [channelId, map] of voice) {
    if (map.size === 0) continue
    // every participant row carries the owning serverId
    const any = map.values().next().value
    if (!any || any.serverId !== serverId) continue
    socket.emit('voice:state', {
      channelId,
      participants: voiceParticipants(channelId),
      ringing: voiceRingingIds(channelId),
      priorityUserId: voicePriorityOf(channelId),
    })
  }
}

/** Kill a voice-channel ring aimed at a user and TELL them: the target's
 *  incoming-call modal (and its ringtone) only clears on an explicit event -
 *  the channel-side broadcast alone never reaches a user who is not in the
 *  server room. Emits `call:ended` with the ring's synthetic callId
 *  (`voice-<channelId>`), which the client already treats as "my incoming
 *  ring died". */
function expireVoiceRing(channelId: string, targetId: string, serverId: string | undefined): void {
  const timers = voiceRinging.get(channelId)
  const entry = timers?.get(targetId)
  if (!timers || !entry) return
  clearTimeout(entry.timer)
  timers.delete(targetId)
  if (timers.size === 0) voiceRinging.delete(channelId)
  // the expired invitation no longer admits the target into the channel
  // (an already-answered guest keeps their ticket until they leave)
  guestVoiceDrop(channelId, targetId)
  io.to(`user:${targetId}`).emit('call:ended', {
    callId: entry.ring.callId,
    conversationId: '',
    reason: 'expired',
    acceptedAt: null,
    durationSec: null,
  })
  if (serverId) broadcastVoice(channelId, serverId)
}

/** The last participant left a voice channel: every ring still aimed at it
 *  dies with the room (there is nothing left to answer into). */
function expireAllVoiceRings(channelId: string): void {
  const timers = voiceRinging.get(channelId)
  if (!timers || timers.size === 0) return
  for (const [targetId, entry] of timers) {
    clearTimeout(entry.timer)
    io.to(`user:${targetId}`).emit('call:ended', {
      callId: entry.ring.callId,
      conversationId: '',
      reason: 'expired',
      acceptedAt: null,
      durationSec: null,
    })
  }
  voiceRinging.delete(channelId)
  // the channel is gone: every outstanding guest invitation dies with it
  guestVoice.delete(channelId)
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
  /** recording this call (drives the red REC badges + warning sounds) */
  recording: boolean
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
  /** per-target expiry timers for rings (initial targets and mid-call
   *  call:ring-user alike): the pinging tile everyone sees clears itself
   *  even for offline targets */
  ringTimers: Map<string, ReturnType<typeof setTimeout>>
  /** the exact ring payload per rung target, so a target who was OFFLINE
   *  when the ring fired gets the identical ring redelivered the moment
   *  they connect (within the ring window) */
  ringPayloads: Map<string, CallRingPayload>
  /** every conversation member ever passed to call:start (union): lifecycle
   *  broadcasts fan out to these personal rooms so members who never opened
   *  the conversation still hear rings die and calls start/end */
  memberIds: Set<string>
  /** cross-rung guests: memberIds users who are NOT conversation participants
   *  (rung in from outside). They receive call state through the
   *  conversation-guest room instead of the conversation room, and their
   *  send-only tickets (CallGuest rows) die with the call. */
  guests: Set<string>
  /** first accept timestamp; null while nobody has joined */
  acceptedAt: number | null
  /** group-conversation call: unlike 1:1 DM calls it stays live while
   *  anyone remains (the 1:1 "either side hanging up ends it" rule must
   *  not fire when one of two group members hops into a call channel) */
  group: boolean
  /** when participants hit 1: an alone-timer starts (10 min -> auto end) */
  aloneTimer: ReturnType<typeof setTimeout> | null
}
const calls = new Map<string, ActiveCall>()
const callByConversation = new Map<string, string>()

const CALL_RING_TIMEOUT_MS = 60_000
const CALL_ALONE_TIMEOUT_MS = 10 * 60_000

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
    recording: p.recording,
  }))
}

/** The honest state label for a call: 'active' only once somebody actually
 *  answered. Flag broadcasts (mute / deafen / camera / recording) used to
 *  hard-code 'active', which flipped a still-ringing call into a live-looking
 *  one the moment the caller toggled anything mid-ring (the "record while
 *  calling breaks the UI" bug: the outgoing ring died, the stage switched to
 *  a one-person active call, and the callee's view said live). */
function callStateOf(call: ActiveCall): 'ringing' | 'active' {
  return call.acceptedAt ? 'active' : 'ringing'
}

/** Full state broadcast: the conversation room (anyone standing there) AND
 *  every member's personal room (reaches members who never opened the
 *  conversation), which is what keeps sidebar indicators, join buttons and
 *  dying rings honest everywhere. The `ringing` list (userIds still being
 *  rung) rides along so every participant can show the pinging tiles. */
function broadcastCallState(call: ActiveCall, state: 'ringing' | 'active'): void {
  const payload = {
    callId: call.callId,
    conversationId: call.conversationId,
    state,
    createdBy: call.createdBy,
    createdAt: call.createdAt,
    acceptedAt: call.acceptedAt,
    participants: callParticipantsPayload(call),
    ringing: Array.from(call.ringing),
  }
  io.to(`conversation:${call.conversationId}`).emit('call:state', payload)
  for (const mid of call.memberIds) io.to(`user:${mid}`).emit('call:state', payload)
  // cross-rung guests also receive the state through their guest room (a
  // guest is never in the conversation room): this is what keeps the
  // participant grid on their call stage stable across joins, leaves and
  // media flips instead of collapsing back to the seeded ring entry
  if (call.guests.size > 0) io.to(guestRoomOf(call.conversationId)).emit('call:state', payload)
}

/** Remove one target's ring from the call (answer / decline / let-ring /
 *  expiry) and re-broadcast so the pinging tiles clear. */
function dropCallRing(call: ActiveCall, targetId: string): void {
  const t = call.ringTimers.get(targetId)
  if (t) clearTimeout(t)
  call.ringTimers.delete(targetId)
  call.ringPayloads.delete(targetId)
  if (call.ringing.delete(targetId)) {
    broadcastCallState(call, callStateOf(call))
  }
}

function destroyCall(call: ActiveCall, reason: string): void {
  if (call.aloneTimer) clearTimeout(call.aloneTimer)
  for (const t of call.ringTimers.values()) clearTimeout(t)
  call.ringTimers.clear()
  calls.delete(call.callId)
  if (callByConversation.get(call.conversationId) === call.callId) {
    callByConversation.delete(call.conversationId)
  }
  // duration rides along so any client can stamp the call's chat message
  // without reconstructing timing locally
  const payload = {
    callId: call.callId,
    conversationId: call.conversationId,
    reason,
    acceptedAt: call.acceptedAt,
    durationSec: call.acceptedAt ? Math.max(0, Math.round((Date.now() - call.acceptedAt) / 1000)) : null,
  }
  io.to(`conversation:${call.conversationId}`).emit('call:ended', payload)
  // members who never opened the conversation (rung via their personal
  // room) must hear the death too, or their ring loops forever
  for (const mid of call.memberIds) io.to(`user:${mid}`).emit('call:ended', payload)
  for (const rid of call.ringing) io.to(`user:${rid}`).emit('call:ended', payload)
  // the call's guests lose their send-only ticket with it; strays past the
  // TTL ceiling are swept in the same stroke (the HTTP route re-checks
  // expiry on every send anyway — belt and braces)
  try {
    if (rwDb) {
      rwDb.run('DELETE FROM CallGuest WHERE callId = ?', [call.callId])
      rwDb.run('DELETE FROM CallGuest WHERE expiresAt <= ?', [Date.now()])
    }
  } catch {
    /* cosmetic cleanup; expiry already guards the permission */
  }
}

/** Drop one participant (hangup or disconnect). Two-person (1:1) calls end
 *  for the survivor the moment the other side hangs up - the Discord behavior
 *  users expect from DM calls, instead of a ghost call for 10 minutes. Larger
 *  group calls keep going, and a lone survivor there still gets the 10-minute
 *  grace window before the call auto-ends (they may be waiting for a return).
 *
 *  `departingSocketId` guards the multi-tab case: only the socket that
 *  currently owns the participant row may drop it. Returns whether the
 *  participant was actually removed. */
function dropCallParticipant(call: ActiveCall, userId: string, departingSocketId?: string): boolean {
  const p = call.participants.get(userId)
  if (!p) return false
  if (departingSocketId && p.socketId !== departingSocketId) return false
  // a guest hanging up forfeits their send-only ticket (a re-accept stamps
  // a fresh one)
  if (call.guests.has(userId)) clearCallGuest(call, userId)
  const wasTwoPerson = call.participants.size === 2
  call.participants.delete(userId)
  if (call.participants.size === 0) {
    destroyCall(call, 'empty')
    return true
  }
  // 1:1 semantics: in a direct call either side hanging up ends it for
  // both. Group calls (and their call-channel rooms) keep living for the
  // remaining participants, exactly like a server voice channel.
  if (wasTwoPerson && call.acceptedAt && !call.group) {
    destroyCall(call, 'ended')
    return true
  }
  if (call.participants.size === 1 && call.acceptedAt) {
    if (call.aloneTimer) clearTimeout(call.aloneTimer)
    call.aloneTimer = setTimeout(() => {
      const c = calls.get(call.callId)
      if (c && c.participants.size <= 1) destroyCall(c, 'timeout')
    }, CALL_ALONE_TIMEOUT_MS)
  }
  io.to(`conversation:${call.conversationId}`).emit('call:peer-left', {
    callId: call.callId,
    userId,
  })
  broadcastCallState(call, callStateOf(call))
  return true
}

/** One call per account across every tab and device, like Discord: joining
 *  a call (or starting one) from a second session takes over from the first.
 *  The previous socket is told (`call:taken-over`) so its client can leave
 *  gracefully instead of both sessions fighting over one participant row.
 *  Same-call takeovers re-assign the row in place: dropping it would end a
 *  two-person call out from under the session that just took it over.
 *  A DIFFERENT call always drops the old row — even when the same socket
 *  owns it (one client hopping conversations must not leave a ghost
 *  participant behind in the call it just left). */
function takeoverCallPresence(userId: string, newSocketId: string, keepCallId: string): void {
  for (const other of calls.values()) {
    const p = other.participants.get(userId)
    if (!p) continue
    if (other.callId === keepCallId) {
      if (p.socketId === newSocketId) continue
      io.to(p.socketId).emit('call:taken-over', {
        callId: other.callId,
        conversationId: other.conversationId,
      })
      p.socketId = newSocketId
    } else {
      if (p.socketId !== newSocketId) {
        io.to(p.socketId).emit('call:taken-over', {
          callId: other.callId,
          conversationId: other.conversationId,
        })
      }
      dropCallParticipant(other, userId, p.socketId)
    }
  }
}

type VisibleStatus = 'online' | 'idle' | 'busy' | 'dnd' | 'offline'

/** Offline -> online: hand this user every ring still live and aimed at
 *  them — DM/group call rings and voice-channel rings alike — by re-emitting
 *  the cached payload to their fresh personal room. Rings keep their
 *  original expiry, so arriving late simply means less time to answer; an
 *  expired, declined or answered ring is already gone from the maps. */
function deliverPendingRings(userId: string): void {
  for (const call of calls.values()) {
    if (!call.ringing.has(userId)) continue
    const ring = call.ringPayloads.get(userId)
    if (ring) io.to(`user:${userId}`).emit('call:ring', ring)
  }
  for (const targets of voiceRinging.values()) {
    const entry = targets.get(userId)
    if (entry) io.to(`user:${userId}`).emit('call:ring', entry.ring)
  }
}

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
    // rings that fired while this user was offline (called while away,
    // rung into a voice channel while away) land NOW — the exact payload,
    // still within its expiry window
    deliverPendingRings(user.userId)
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

  socket.on('subscribe', async (data: { rooms?: string[] }) => {
    const rooms = Array.isArray(data?.rooms) ? data.rooms.filter((r) => typeof r === 'string') : []
    for (const room of rooms) {
      // room membership is verified server-side: a socket may only listen to
      // rooms its user genuinely belongs to (own user room, member servers,
      // readable channels, own conversations). Anything else is ignored, so
      // a modded client can never eavesdrop on other people's rooms.
      if (roomAccessOf(user.userId, room) === false) continue
      void socket.join(room)
      // joining a server room hands this socket the live voice state of
      // every channel in that server: the sidebar renders who is already
      // talking without waiting for the next join/leave broadcast (covers
      // both first load and post-reconnect re-subscription)
      if (room.startsWith('server:')) {
        sendServerVoiceState(socket, room.slice('server:'.length))
      }
    }
  })

  socket.on('unsubscribe', (data: { rooms?: string[] }) => {
    const rooms = Array.isArray(data?.rooms) ? data.rooms.filter((r) => typeof r === 'string') : []
    for (const room of rooms) void socket.leave(room)
  })

  socket.on('typing:start', (data: { room?: string }) => {
    if (typeof data?.room !== 'string') return
    // typing indicators only into rooms this socket actually occupies
    if (!socket.rooms.has(data.room)) return
    socket.to(data.room).emit('typing', { room: data.room, userId: user.userId, username: user.username, typing: true })
  })

  socket.on('typing:stop', (data: { room?: string }) => {
    if (typeof data?.room !== 'string') return
    if (!socket.rooms.has(data.room)) return
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
  socket.on('voice:join', async (data: { channelId?: string; serverId?: string; sessionId?: string }) => {
    const channelId = typeof data?.channelId === 'string' ? data.channelId : ''
    const sessionId = typeof data?.sessionId === 'string' ? data.sessionId : socket.id
    if (!channelId) return
    // server-side gate, same rule as the HTTP voice route: the joiner must
    // be able to READ this channel in its server (membership + private-
    // channel access). The one exception: an invited GUEST (rung in by a
    // member while the server allows guest rings) holds a ticket in
    // guestVoice — they join the voice mesh without ever reading the
    // channel. The channel's REAL serverId replaces any client claim, so
    // presence broadcasts can never be aimed at a foreign room.
    const access = channelAccessOf(user.userId, channelId)
    if (access && !access.ok) {
      if (!guestVoice.get(channelId)?.has(user.userId)) return
    }
    const serverId = access?.serverId || (typeof data?.serverId === 'string' ? data.serverId : '')
    if (!serverId) return
    void socket.join(`voice:${channelId}`)
    // remember this socket owns a voice presence so disconnect can clean it up
    ;(socket.data as { voice?: { channelId: string; serverId: string } }).voice = { channelId, serverId }
    // one voice presence per account: a second tab/device joining takes
    // over the mic and the older session is told to stand down
    takeoverVoicePresence(user.userId, socket.id)
    let map = voice.get(channelId)
    if (!map) {
      map = new Map()
      voice.set(channelId, map)
    }
    map.set(user.userId, { userId: user.userId, username: user.username, sessionId, muted: false, deafened: false, socketId: socket.id, recording: false, video: false, screen: false, serverId })
    // answering a ring into this channel: the pinging tile everyone sees
    // clears, and the joiner's own lingering ring modal (if they were rung)
    // is told to close - joining IS answering
    expireVoiceRing(channelId, user.userId, undefined)
    broadcastVoice(channelId, serverId)
  })

  socket.on('voice:leave', () => {
    const v = (socket.data as { voice?: { channelId: string; serverId: string } }).voice
    if (!v) return
    delete (socket.data as { voice?: unknown }).voice
    // only the owning socket drops the presence: a stale tab leaving must
    // not kill the fresh session that took over
    dropVoiceParticipant(v.channelId, v.serverId, user.userId, socket.id)
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

  // camera / screenshare toggles propagate as authoritative media flags on
  // the voice participant row (same contract as calls): receivers detach
  // remote video surfaces the moment the flags say off
  socket.on('voice:media', (data: { video?: boolean; screen?: boolean }) => {
    const v = (socket.data as { voice?: { channelId: string; serverId: string } }).voice
    if (!v) return
    const map = voice.get(v.channelId)
    const p = map?.get(user.userId)
    if (p) {
      if (typeof data?.video === 'boolean') p.video = data.video
      if (typeof data?.screen === 'boolean') p.screen = data.screen
      broadcastVoice(v.channelId, v.serverId)
    }
  })

  // channel recording flags ride voice:state; clients derive the
  // first/last-recorder transitions for the warning sounds from it
  socket.on('voice:recording', (data: { recording?: boolean }) => {
    const v = (socket.data as { voice?: { channelId: string; serverId: string } }).voice
    if (!v) return
    const map = voice.get(v.channelId)
    const p = map?.get(user.userId)
    if (p) {
      p.recording = data?.recording === true
      broadcastVoice(v.channelId, v.serverId)
    }
  })

  // voice-stage moderation: crown one participant as the priority speaker
  // (targetUserId null/absent = clear the crown). Only a participant of the
  // channel may move it, and the wearer must actually be in the room; the
  // crown rides the next voice:state broadcast to everyone. The client UI
  // gates this behind MANAGE_SERVER - the sidecar now enforces the same
  // rule server-side, so a modded client cannot crown anyone without the
  // permission.
  socket.on('voice:priority', (data: { channelId?: string; targetUserId?: string | null }) => {
    const v = (socket.data as { voice?: { channelId: string; serverId: string } }).voice
    if (!v) return
    const channelId = typeof data?.channelId === 'string' ? data.channelId : ''
    if (!channelId || channelId !== v.channelId) return
    const map = voice.get(channelId)
    if (!map?.has(user.userId)) return
    if (canManageServer(user.userId, v.serverId) === false) return
    const target = typeof data?.targetUserId === 'string' && data.targetUserId ? data.targetUserId : null
    if (target) {
      // crown someone who is actually in the room; anything else clears
      if (map.has(target)) prioritySpeaker.set(channelId, target)
      else prioritySpeaker.delete(channelId)
    } else {
      prioritySpeaker.delete(channelId)
    }
    broadcastVoice(channelId, v.serverId)
  })

  // ring someone INTO this server voice channel ("server call"): the
  // ringer must actually be in the channel. The target gets the standard
  // incoming-call ring with a voice payload; accepting hops them into the
  // channel directly. Offline targets are ringable too (the emit simply
  // lands nowhere until they return) - everyone in the channel sees the
  // pinging tile, styled "unlikely to answer" on their clients.
  socket.on('voice:ring', (data: { channelId?: string; serverId?: string; targetUserId?: string; profile?: { username?: string; displayName?: string | null; avatarUrl?: string | null; avatarColor?: string }; channelName?: string }) => {
    const channelId = typeof data?.channelId === 'string' ? data.channelId : ''
    const targetId = typeof data?.targetUserId === 'string' ? data.targetUserId : ''
    if (!channelId || !targetId || targetId === user.userId) return
    const map = voice.get(channelId)
    const ringer = map?.get(user.userId)
    if (!ringer) return
    // the ringer's OWN presence row carries the channel's verified serverId:
    // rings and their broadcasts can never be aimed at a client-claimed
    // foreign server room
    const serverId = ringer.serverId
    // already in the channel: nothing to ring (map is non-null whenever the
    // ringer lookup above found a participant)
    if (map?.has(targetId)) return
    // the target must actually be able to join this channel — a server
    // member with read access rings like always; a NON-member only rings
    // when the server allows GUEST rings (Server.allowGuestRings) and no
    // block stands between them and the ringer. A modded client rings only
    // the people the real client could ring.
    const targetAccess = channelAccessOf(targetId, channelId)
    let guestRing = false
    if (targetAccess && !targetAccess.ok) {
      if (serverAllowsGuestRings(serverId) !== true) return
      guestRing = true
      // the invitation is the target's voice:join ticket (cleared on ring
      // expiry / decline / their own departure)
      guestVoiceAdd(channelId, targetId)
    }
    if (blockedBetween(user.userId, targetId) === true) return
    const ringPayload: CallRingPayload = {
      callId: `voice-${channelId}`,
      conversationId: '',
      from: {
        userId: ringer.userId,
        username: ringer.username,
        displayName: typeof data?.profile?.displayName === 'string' ? data.profile.displayName : null,
        avatarUrl: typeof data?.profile?.avatarUrl === 'string' ? data.profile.avatarUrl : null,
        avatarColor: typeof data?.profile?.avatarColor === 'string' ? data.profile.avatarColor : '#2e2e2e',
      },
      video: false,
      createdAt: Date.now(),
      voice: {
        channelId,
        serverId,
        channelName: typeof data?.channelName === 'string' ? data.channelName : 'voice',
        // guest rings mark the payload: the client joins the voice space
        // WITHOUT selecting the channel (they cannot read it) and stays
        // wherever they were — the voice stage renders from the connection
        ...(guestRing ? { guest: true } : {}),
      },
    }
    // a live voice ring replaces the stale one (re-ring refreshes the
    // timer); the payload is cached so an OFFLINE target gets the exact
    // ring redelivered the moment they come back online
    let timers = voiceRinging.get(channelId)
    if (!timers) {
      timers = new Map()
      voiceRinging.set(channelId, timers)
    }
    const oldTimer = timers.get(targetId)
    if (oldTimer) clearTimeout(oldTimer.timer)
    const timer = setTimeout(() => {
      // unanswered ring expires: the pinging tile clears everywhere AND the
      // target's incoming-call modal (with its ringtone) is told to close
      expireVoiceRing(channelId, targetId, serverId)
    }, RING_USER_TIMEOUT_MS)
    timers.set(targetId, { timer, ring: ringPayload })
    io.to(`user:${targetId}`).emit('call:ring', ringPayload)
    broadcastVoice(channelId, serverId)
  })

  // screen-watch notification: a channel member started / stopped watching
  // someone's screen share. Relayed to the SHARER's personal room with the
  // watcher's profile so their tile can show the live audience. Only
  // meaningful between two members of the same live voice channel.
  socket.on('voice:screen-watch', (data: { channelId?: string; targetUserId?: string; watching?: boolean; profile?: { displayName?: string | null; avatarUrl?: string | null; avatarColor?: string } }) => {
    const v = (socket.data as { voice?: { channelId: string; serverId: string } }).voice
    if (!v) return
    const channelId = typeof data?.channelId === 'string' ? data.channelId : ''
    const targetId = typeof data?.targetUserId === 'string' ? data.targetUserId : ''
    if (!channelId || channelId !== v.channelId || !targetId || targetId === user.userId) return
    const map = voice.get(channelId)
    if (!map?.has(user.userId) || !map.has(targetId)) return
    io.to(`user:${targetId}`).emit('voice:screen-watch', {
      channelId,
      watcher: {
        userId: user.userId,
        username: user.username,
        displayName: typeof data?.profile?.displayName === 'string' ? data.profile.displayName : null,
        avatarUrl: typeof data?.profile?.avatarUrl === 'string' ? data.profile.avatarUrl : null,
        avatarColor: typeof data?.profile?.avatarColor === 'string' ? data.profile.avatarColor : '#2e2e2e',
      },
      watching: data?.watching === true,
    })
  })

  // the target declined the voice-channel ring: tell the ringer and clear
  // the pinging tile for everyone in the channel
  socket.on('voice:ring-decline', (data: { channelId?: string; to?: string }) => {
    const channelId = typeof data?.channelId === 'string' ? data.channelId : ''
    const to = typeof data?.to === 'string' ? data.to : ''
    if (!channelId || !to || to === user.userId) return
    // only meaningful when the ringer is still in that channel
    const map = voice.get(channelId)
    const ringer = map?.get(to)
    if (!ringer) return
    dropVoiceRing(channelId, user.userId, ringer.serverId)
    io.to(`user:${to}`).emit('voice:ring-decline', {
      channelId,
      userId: user.userId,
      username: user.username,
    })
  })

  socket.on('voice:signal', (data: { to?: string; data?: unknown }) => {
    if (typeof data?.to !== 'string' || data.to === user.userId) return
    // signals only flow between participants of the SAME live voice channel:
    // the sender must hold a voice presence here, and the target's socket is
    // the one that owns the presence row in that same channel. A modded
    // client must never be able to force a media connection at an arbitrary
    // in-voice user.
    const v = (socket.data as { voice?: { channelId: string; serverId: string } }).voice
    if (!v) return
    const map = voice.get(v.channelId)
    const target = map?.get(data.to)
    if (!target) return
    io.to(target.socketId).emit('voice:signal', { from: user.userId, data: data.data })
  })

  // ---- calls: lifecycle + WebRTC signaling relay ----
  socket.on(
    'call:start',
    (data: {
      conversationId?: string
      video?: boolean
      /** silent: an invitational join - no ring at all, the call simply
       *  exists for members to see and hop into */
      silent?: boolean
      /** set by the client when the conversation is a GROUP (or one of its
       *  synthetic call-channel rooms): group calls outlive a 1:1 wind-down */
      group?: boolean
      profile?: { username?: string; displayName?: string | null; avatarUrl?: string | null; avatarColor?: string }
      participantIds?: string[]
    }) => {
      const conversationId = typeof data?.conversationId === 'string' ? data.conversationId : ''
      if (!conversationId) return
      // the caller must genuinely belong to the conversation they are calling
      // in (synthetic call-channel rooms resolve to their base conversation).
      // Without this gate a modded client could start a call on ANY
      // conversation id — ringing strangers from a conversation it has no
      // part in and injecting call state into other people's rooms.
      if (conversationMemberOf(user.userId, conversationId) === false) return
      // one live call per conversation: join the existing one instead
      const existingId = callByConversation.get(conversationId)
      const existing = existingId ? calls.get(existingId) : undefined
      const silent = data?.silent === true
      const call =
        existing ??
        ({
          callId: `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          conversationId,
          createdBy: user.userId,
          createdAt: Date.now(),
          participants: new Map(),
          ringing: new Set(),
          ringTimers: new Map(),
          ringPayloads: new Map(),
          memberIds: new Set(),
          guests: new Set(),
          // a silent start is "live" from the moment it exists: nobody is
          // being asked to answer anything
          acceptedAt: silent ? Date.now() : null,
          group: data?.group === true,
          aloneTimer: null,
        } satisfies ActiveCall)
      if (!existing) {
        calls.set(call.callId, call)
        callByConversation.set(conversationId, call.callId)
      }
      // the member union powers the lifecycle fanout to personal rooms
      for (const pid of Array.isArray(data?.participantIds) ? data.participantIds : []) {
        if (typeof pid === 'string') call.memberIds.add(pid)
      }
      call.memberIds.add(user.userId)

      // one call per account across tabs and devices: the session that
      // joins now takes over from any older one
      takeoverCallPresence(user.userId, socket.id, call.callId)

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
        recording: false,
      })
      ;(socket.data as { call?: { callId: string } }).call = { callId: call.callId }

      // a body joining a still-ringing call connects it: the moment a
      // second participant exists, acceptedAt is honest and the caller's
      // outgoing ring gives way to the live call
      if (existing && !call.acceptedAt && call.participants.size >= 2) call.acceptedAt = Date.now()

      // ring every other conversation member: the conversation room (anyone
      // standing there) plus each member's personal user room (reaches
      // members who never opened this conversation). Silent joins and joins
      // of an already-live call never ring - a late member walking in is
      // not an invitation for everyone else.
      if (!silent && !existing) {
        const ringPayload: CallRingPayload = {
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
          // blocks gate direct rings the same way they gate DMs (both
          // directions): a blocked account can never ring its blocker
          if (blockedBetween(user.userId, pid) === true) continue
          io.to(`user:${pid}`).emit('call:ring', ringPayload)
          call.ringing.add(pid)
          // cache the payload + a per-target expiry so an offline target is
          // redelivered on return and a never-answered ring clears its
          // pinging tile even when the call itself lives on (group answer)
          call.ringPayloads.set(pid, ringPayload)
          const oldTimer = call.ringTimers.get(pid)
          if (oldTimer) clearTimeout(oldTimer)
          call.ringTimers.set(
            pid,
            setTimeout(() => {
              const c = calls.get(call.callId)
              if (c) dropCallRing(c, pid)
            }, CALL_RING_TIMEOUT_MS)
          )
        }
      }
      broadcastCallState(call, existing || silent ? 'active' : 'ringing')

      // unanswered rings expire so callers never ring forever; a silent
      // start with nobody else in it gets the same 10-minute alone window
      // as a call whose partner left
      if (!existing) {
        if (silent) {
          call.aloneTimer = setTimeout(() => {
            const c = calls.get(call.callId)
            if (c && c.participants.size <= 1) destroyCall(c, 'timeout')
          }, CALL_ALONE_TIMEOUT_MS)
        } else {
          setTimeout(() => {
            const c = calls.get(call.callId)
            if (c && c.acceptedAt === null) destroyCall(c, 'no-answer')
          }, CALL_RING_TIMEOUT_MS)
        }
      }
    }
  )

  socket.on('call:accept', (data: { callId?: string }) => {
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    if (!call) {
      // the ring outlived its call (no-answer expiry while the invitee
      // stared at the modal): tell THIS socket so their stage tears down
      // with a clean "call ended" instead of hanging on a ghost
      socket.emit('call:ended', {
        callId: typeof data?.callId === 'string' ? data.callId : '',
        conversationId: '',
        reason: 'ended',
        acceptedAt: null,
        durationSec: null,
        late: true,
      })
      return
    }
    dropCallRing(call, user.userId)
    // a cross-rung GUEST (rung in from outside the conversation) accepts:
    // stamp their send-only ticket and seat their socket in the guest room —
    // the conversation room itself stays members-only
    if (call.memberIds.has(user.userId) && conversationMemberOf(user.userId, call.conversationId) === false) {
      call.guests.add(user.userId)
      void socket.join(guestRoomOf(call.conversationId))
      stampCallGuest(call.callId, call.conversationId, user.userId)
    }
    // one call per account: accepting here retires any older session
    takeoverCallPresence(user.userId, socket.id, call.callId)
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
        recording: false,
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
    io.to(`conversation:${call.conversationId}`).emit('call:declined', {
      callId: call.callId,
      userId: user.userId,
      username: user.username,
    })
    // declining clears the pinging tile everyone in the call sees
    dropCallRing(call, user.userId)
    // a decline from the only non-caller ends a 1:1 call that never connected
    if (call.participants.size <= 1 && !call.acceptedAt) destroyCall(call, 'declined')
  })

  // let-ring: the callee dismisses the incoming screen but the caller keeps
  // ringing. Silent to the other side, but the pinging tile clears for
  // everyone in the call (the ring itself died).
  socket.on('call:let-ring', (data: { callId?: string }) => {
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    if (call) dropCallRing(call, user.userId)
  })

  // caller withdraws before anyone accepted
  socket.on('call:cancel', (data: { callId?: string }) => {
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    if (!call) return
    delete (socket.data as { call?: unknown }).call
    const dropped = dropCallParticipant(call, user.userId, socket.id)
    if (dropped && !call.acceptedAt && calls.has(call.callId)) destroyCall(call, 'cancelled')
  })

  // hangup: I leave, the call itself continues for everyone still in it
  socket.on('call:hangup', (data: { callId?: string }) => {
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    if (!call) return
    delete (socket.data as { call?: unknown }).call
    dropCallParticipant(call, user.userId, socket.id)
  })

  socket.on('call:mute', (data: { callId?: string; muted?: boolean }) => {
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    const p = call?.participants.get(user.userId)
    if (call && p) {
      p.muted = data?.muted !== false
      broadcastCallState(call, callStateOf(call))
    }
  })

  socket.on('call:deafen', (data: { callId?: string; deafened?: boolean }) => {
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    const p = call?.participants.get(user.userId)
    if (call && p) {
      p.deafened = data?.deafened !== false
      broadcastCallState(call, callStateOf(call))
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
      broadcastCallState(call, callStateOf(call))
    }
  })

  // recording flags: who is capturing the call's audio. Rides call:state so
  // every participant (and anyone watching the strip) sees the red REC
  // badges; clients derive the first-recorder / last-recorder transitions
  // from the state stream to play the warning sounds.
  socket.on('call:recording', (data: { callId?: string; recording?: boolean }) => {
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    const p = call?.participants.get(user.userId)
    if (call && p) {
      p.recording = data?.recording === true
      broadcastCallState(call, callStateOf(call))
    }
  })

  // ring one specific user into an existing call: the "add to call" /
  // "ring them in" path. Works for calls whose conversation the target is
  // NOT a member of (a DM call adding a third person): they get the ring,
  // join the call, and never see the conversation's messages. Works for
  // OFFLINE targets too: the emit lands nowhere, but the ring sits in the
  // call's ringing list (with an expiry) so everyone in the call sees the
  // pinging tile styled "unlikely to answer" until it expires.
  socket.on('call:ring-user', (data: { callId?: string; targetUserId?: string }) => {
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    const targetId = typeof data?.targetUserId === 'string' ? data.targetUserId : ''
    if (!call || !targetId || targetId === user.userId) return
    const ringer = call.participants.get(user.userId)
    if (!ringer) return
    // already in? nothing to ring
    if (call.participants.has(targetId)) return
    // blocks gate direct rings the same way they gate DMs (both directions):
    // a blocked account can never ring its blocker into a call
    if (blockedBetween(user.userId, targetId) === true) return
    // a GROUP whose owner turned cross-ringing off only admits EXISTING
    // participants; a cross-rung non-participant becomes a tracked GUEST of
    // the call (guest room fanout + a send-only ticket on accept)
    const targetIsMember = conversationMemberOf(targetId, call.conversationId)
    if (targetIsMember === false) {
      if (conversationBlocksCrossRing(call.conversationId)) return
      call.guests.add(targetId)
    }
    call.memberIds.add(targetId)
    const ringPayload: CallRingPayload = {
      callId: call.callId,
      conversationId: call.conversationId,
      from: {
        userId: ringer.userId,
        username: ringer.username,
        displayName: ringer.displayName,
        avatarUrl: ringer.avatarUrl,
        avatarColor: ringer.avatarColor,
      },
      video: false,
      createdAt: Date.now(),
    }
    // a live ring replaces the stale one (re-ring refreshes the expiry)
    const oldTimer = call.ringTimers.get(targetId)
    if (oldTimer) clearTimeout(oldTimer)
    call.ringing.add(targetId)
    // payload cached so an OFFLINE target is redelivered on return
    call.ringPayloads.set(targetId, ringPayload)
    call.ringTimers.set(
      targetId,
      setTimeout(() => {
        // unanswered ring expires: the pinging tile clears for everyone
        const c = calls.get(call.callId)
        if (c) dropCallRing(c, targetId)
      }, RING_USER_TIMEOUT_MS)
    )
    io.to(`user:${targetId}`).emit('call:ring', ringPayload)
    broadcastCallState(call, callStateOf(call))
  })

  // whisper-in-calls: a participant routes their mic to one other person
  // (everyone else stops hearing them). Relay-only, no session state: the
  // emitter tells the target directly, the target's client shows/clears its
  // "x is whispering to you" chip. A whisperer whose socket dies without a
  // stop event is cleaned up client-side from the next call:state prune.
  socket.on('call:whisper', (data: { to?: string; active?: boolean; profile?: { displayName?: string | null; avatarUrl?: string | null; avatarColor?: string } }) => {
    const to = typeof data?.to === 'string' ? data.to : ''
    if (!to || to === user.userId) return
    // a whisper START only flows between people who share a live surface
    // (a call or a voice channel), matching what the real client offers.
    // Stop events (active !== true) are always relayed: they only ever
    // CLEAR the receiver's chip, so a sender leaving the surface can still
    // hang up their private line.
    if (data?.active === true) {
      let shared = false
      for (const c of calls.values()) {
        if (c.participants.has(user.userId) && c.participants.has(to)) {
          shared = true
          break
        }
      }
      if (!shared) {
        for (const map of voice.values()) {
          if (map.has(user.userId) && map.has(to)) {
            shared = true
            break
          }
        }
      }
      if (!shared) return
    }
    io.to(`user:${to}`).emit('call:whisper', {
      from: {
        userId: user.userId,
        username: user.username,
        displayName: typeof data?.profile?.displayName === 'string' ? data.profile.displayName : null,
        avatarUrl: typeof data?.profile?.avatarUrl === 'string' ? data.profile.avatarUrl : null,
        avatarColor: typeof data?.profile?.avatarColor === 'string' ? data.profile.avatarColor : '#2e2e2e',
      },
      active: data?.active === true,
    })
  })

  socket.on('call:signal', (data: { callId?: string; to?: string; data?: unknown }) => {
    if (typeof data?.to !== 'string' || data.to === user.userId) return
    const call = typeof data?.callId === 'string' ? calls.get(data.callId) : undefined
    if (!call || !call.participants.has(user.userId)) return
    const target = call.participants.get(data.to)
    if (!target) return
    // route to the socket that currently owns the target's participant
    // row: a stale tab of the same account must not answer for the live one
    io.to(target.socketId).emit('call:signal', { from: user.userId, callId: call.callId, data: data.data })
  })

  socket.on('disconnect', () => {
    // voice presence dies with the socket that joined it (a stale tab whose
    // presence was taken over drops nothing: the guard checks ownership)
    const v = (socket.data as { voice?: { channelId: string; serverId: string } }).voice
    if (v) dropVoiceParticipant(v.channelId, v.serverId, user.userId, socket.id)
    // an in-call socket dropping means that participant left the call
    // (same ownership guard: taken-over tabs must not drop the live session)
    const c = (socket.data as { call?: { callId: string } }).call
    if (c) {
      const call = calls.get(c.callId)
      if (call) dropCallParticipant(call, user.userId, socket.id)
    }
    // NOTE: rings aimed at this user are NOT dropped on disconnect anymore.
    // Their expiry timers own the cleanup, and the cached payloads power the
    // offline -> online redelivery (deliverPendingRings): a dropped socket
    // (reload, blip) within the 60s window gets the still-live ring back,
    // exactly what a person called while away expects on return.
    const set = online.get(user.userId)
    if (set) {
      set.delete(socket.id)
      if (set.size === 0) {
        online.delete(user.userId)
        statuses.delete(user.userId)
        awaySince.delete(user.userId)
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

  // live call + voice dump for QA (localhost only, same token gate)
  if (req.method === 'GET' && url === '/debug-state') {
    const token = req.headers['x-internal-token']
    if (token !== INTERNAL_TOKEN) {
      json(res, 401, { error: 'unauthorized' })
      return
    }
    json(res, 200, {
      calls: Array.from(calls.values()).map((c) => ({
        callId: c.callId,
        conversationId: c.conversationId,
        acceptedAt: c.acceptedAt,
        participants: Array.from(c.participants.values()).map((p) => ({
          userId: p.userId.slice(-6),
          socketId: p.socketId.slice(-6),
          muted: p.muted,
        })),
      })),
      voice: Array.from(voice.entries()).map(([channelId, map]) => ({
        channelId: channelId.slice(-6),
        participants: Array.from(map.values()).map((p) => ({ userId: p.userId.slice(-6), socketId: p.socketId.slice(-6) })),
      })),
    })
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

  // degraded-sandbox bootstrap (Task 42): the sandbox harness reaps every
  // process born inside an agent tool-session tree, but processes born under
  // THIS service survive (the sidecar predates the reaper and its own child
  // processes live indefinitely). This endpoint exists ONLY to bootstrap the
  // infra watchdog in that state. It is deliberately fixed-path: it spawns
  // exactly `bash /home/z/run/app-watchdog.sh` - no arguments, no generality,
  // nothing an attacker could aim elsewhere. Same 127.0.0.1-only listener and
  // internal token as every other control endpoint; on a normal deploy the
  // path simply does not exist and spawn fails with 500.
  if (req.method === 'POST' && url === '/spawn-watchdog') {
    const token = req.headers['x-internal-token']
    if (token !== INTERNAL_TOKEN) {
      json(res, 401, { error: 'unauthorized' })
      return
    }
    try {
      const child = spawn('bash', ['/home/z/run/app-watchdog.sh'], {
        cwd: '/home/z/run',
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit'],
      })
      child.unref()
      json(res, 200, { ok: true, pid: child.pid })
    } catch {
      json(res, 500, { error: 'spawn failed' })
    }
    return
  }

  json(res, 404, { error: 'not found' })
})

controlServer.listen(CONTROL_PORT, '127.0.0.1', () => {
  console.log(`Hyperion control API listening on port ${CONTROL_PORT}`)
})

// resolve the database handles before the first handshake can arrive (the
// guards inside stampLastSeen/isSuspended already fail soft if this rejects)
await Promise.allSettled([rwReady, accountReady])

io.listen(PORT)
io.engine.on('connection', () => {
  // first client socket wires the server; log once
})
console.log(`Hyperion realtime service listening on port ${PORT}`)

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
