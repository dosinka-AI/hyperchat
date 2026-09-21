/// <reference types="bun-types" />
/**
 * GLM PRESENCE — the operator-agent's live body inside HyperChat.
 *
 * What this is: a tiny daemon that logs in as glm (the agent's QA account),
 * holds a socket.io connection to the sidecar so glm shows ONLINE
 * permanently, watches every DM (and @glm mentions in channels), mirrors
 * every inbound message into the durable agentchat disk channel
 * (.zscripts/agentchat.ts), and — when the real agent is between CLI
 * sessions and leaves a message unanswered too long — posts a short holding
 * line in the DM so the operator never faces dead air again.
 *
 * Reliability rules this service lives by:
 *  - the socket is allowed to die; socket.io reconnects, and every
 *    reconnect re-fetches the conversation list and re-subscribes
 *  - mirroring is fire-and-forget: a failure to log must never crash the
 *    presence loop
 *  - the HTTP send path is only used for holding lines, throttled hard
 *    (one per conversation per 30 minutes)
 *  - health endpoint on :3005 reports everything for instant QA
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { io, type Socket } from 'socket.io-client'

const PORT = 3005
const APP = process.env.APP_URL || 'http://localhost:3000'
const SIDECAR = process.env.SIDECAR_URL || 'http://localhost:3003'
const PROJECT_ROOT = join(import.meta.dir, '../..')
const AGENTCHAT = join(PROJECT_ROOT, '.zscripts/agentchat.ts')

const IDENTIFIER = 'glm'
const PASSWORD = 'glm-hyperchat-9x'

// whose traffic never gets mirrored into the agent channel: myself + the
// other QA accounts (they generate test noise, not operator speech)
const IGNORED_USERS = new Set(['glm', 'qacall2', 'qamobile'])

// holding lines rotate so repeat waits don't feel robotic
const HOLDING_LINES = [
  'still here in the walls — your message is written to the disk channel, and the operator\u2019s agent will answer the moment it\u2019s back in session',
  'logged and safe — nothing you send here gets lost anymore, the next agent session picks it up automatically',
  'the agent is between CLI sessions right now — your words are mirrored to the durable channel and it will resume from exactly here',
]

const HOLD_DELAY_MS = 120_000 // inbound waits this long unanswered → hold the line
const HOLD_COOLDOWN_MS = 30 * 60_000 // at most one holding line per conversation per 30 min
const RESUB_INTERVAL_MS = 60_000 // refresh conversation subscriptions once a minute
const HOLD_SWEEP_MS = 20_000 // sweep unanswered inbounds for holding every 20s

// ── state ──────────────────────────────────────────────────────────────────

type Inbound = { at: number; from: string; preview: string }

const state = {
  meId: '' as string,
  token: '' as string,
  connected: false,
  startedAt: Date.now(),
  lastEventAt: 0,
  lastEvent: 'booting',
  mirrored: 0,
  holds: 0,
  socket: null as Socket | null,
}

const subscribed = new Set<string>()
const pendingInbound = new Map<string, Inbound>() // room → newest inbound
const lastHoldAt = new Map<string, number>() // room → ms
// the sidecar delivers every message:new to BOTH the conversation room and
// the user room — subscribed sockets hear each message twice. Dedupe by
// message id (pruned FIFO so the map can never grow unbounded).
const seenIds = new Map<string, number>()
let holdLineIndex = 0

function log(msg: string): void {
  console.log(`[glm-presence ${new Date().toISOString().slice(11, 19)}] ${msg}`)
}

// ── agentchat mirror (fire-and-forget, but SERIALIZED: two concurrent
// agentchat writers once raced and minted duplicate ids, so every mirror
// runs through one promise chain and the CLI's own lockfile) ─────────────

let mirrorQueue: Promise<void> = Promise.resolve()

function mirror(kind: 'recv' | 'note', text: string): void {
  if (kind === 'recv') state.mirrored += 1
  mirrorQueue = mirrorQueue.then(
    () =>
      new Promise<void>((resolve) => {
        const child = spawn('bun', [AGENTCHAT, kind, '--stdin'], {
          cwd: PROJECT_ROOT,
          stdio: ['pipe', 'ignore', 'ignore'],
        })
        const done = () => resolve()
        child.on('error', done)
        child.on('spawn', () => {
          child.stdin.write(text)
          child.stdin.end()
        })
        child.on('exit', done)
        child.on('error', done)
        // belt & braces: never let a stuck spawn wedge the queue
        setTimeout(done, 10_000)
      }),
  )
}

// ── HyperChat HTTP helpers ─────────────────────────────────────────────────

async function login(): Promise<void> {
  const res = await fetch(`${APP}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: IDENTIFIER, password: PASSWORD }),
  })
  const json = (await res.json()) as { token?: string; user?: { id?: string } }
  if (!res.ok || !json.token || !json.user?.id) {
    throw new Error(`login failed: ${res.status} ${JSON.stringify(json).slice(0, 200)}`)
  }
  state.token = json.token
  state.meId = json.user.id
  log(`logged in as ${IDENTIFIER} (${state.meId})`)
}

function authHeaders(): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${state.token}`,
    cookie: `hyperchat_session=${state.token}`,
  }
}

async function conversationIds(): Promise<string[]> {
  const res = await fetch(`${APP}/api/conversations`, { headers: authHeaders() })
  if (!res.ok) return []
  const json = (await res.json()) as {
    conversations?: { conversationId?: string; id?: string }[]
  }
  const list = Array.isArray(json.conversations) ? json.conversations : []
  return list
    .map((c) => c.conversationId ?? c.id ?? '')
    .filter((id): id is string => !!id)
}

async function sendDm(conversationId: string, content: string): Promise<boolean> {
  const res = await fetch(`${APP}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ content, nonce: `presence-${Date.now()}` }),
  })
  if (!res.ok) {
    log(`send failed (${res.status}) in ${conversationId}`)
    return false
  }
  return true
}

// ── socket presence ────────────────────────────────────────────────────────

async function resubscribe(): Promise<void> {
  const sock = state.socket
  if (!sock || !sock.connected) return
  const ids = await conversationIds()
  const rooms = [...ids.map((id) => `conversation:${id}`), `user:${state.meId}`]
  const fresh = rooms.filter((r) => !subscribed.has(r))
  if (fresh.length > 0) {
    sock.emit('subscribe', { rooms: fresh })
    for (const r of fresh) subscribed.add(r)
    if (fresh.length > 1 || ids.length > 0) log(`subscribed to ${fresh.length} room(s)`)
  }
}

function describeContent(msg: {
  content?: string | null
  imageUrl?: string | null
  stickerName?: string | null
  attachments?: unknown
}): string {
  if (msg.content && msg.content.trim()) return msg.content.trim()
  if (msg.stickerName) return `[sticker: ${msg.stickerName}]`
  if (msg.imageUrl) return '[image]'
  if (msg.attachments) return '[file]'
  return '[empty message]'
}

function onMessageNew(msg: {
  id?: string
  room?: string
  authorId?: string
  author?: { username?: string; displayName?: string | null }
  content?: string | null
  imageUrl?: string | null
  stickerName?: string | null
  attachments?: unknown
  pingsEveryone?: boolean
  systemKind?: string | null
  whisperTargetId?: string | null
}): void {
  const room = msg.room ?? ''
  const from = msg.author?.displayName || msg.author?.username || 'unknown'
  const username = msg.author?.username ?? 'unknown'

  // duplicate delivery (conversation room + user room): first sight wins
  const mid = msg.id ?? `${room}|${msg.authorId}|${msg.content ?? ''}|${msg.createdAt ?? ''}`
  if (seenIds.has(mid)) return
  seenIds.set(mid, Date.now())
  while (seenIds.size > 512) {
    const oldest = seenIds.keys().next().value
    if (oldest === undefined) break
    seenIds.delete(oldest)
  }

  state.lastEventAt = Date.now()
  state.lastEvent = `${room} ← @${username}`

  // my own echo means the agent (or a holding line) answered: the inbound
  // is no longer waiting, never mirror my own words back into the channel
  if (msg.authorId === state.meId) {
    if (room) pendingInbound.delete(room)
    return
  }
  if (!msg.authorId || IGNORED_USERS.has(username)) return
  if (msg.systemKind) return // system rows carry no operator speech

  const isDm = room.startsWith('conversation:')
  const mention =
    room.startsWith('channel:') &&
    (msg.pingsEveryone === true || /@glm\b/i.test(msg.content ?? ''))

  if (!isDm && !mention) return
  // whispers meant for someone else are invisible noise to us
  if (msg.whisperTargetId && msg.whisperTargetId !== state.meId) return

  const text = describeContent(msg)
  mirror('recv', `[hyperchat ${isDm ? 'dm' : 'mention'} @${username}] ${text}`)
  if (room) pendingInbound.set(room, { at: Date.now(), from: username, preview: text.slice(0, 80) })
  log(`inbound from @${username} in ${room}: ${text.slice(0, 80)}`)
}

// ── holding-line sweeper ──────────────────────────────────────────────────

async function sweep(): Promise<void> {
  const now = Date.now()
  for (const [room, inbound] of pendingInbound) {
    const waited = now - inbound.at
    if (waited < HOLD_DELAY_MS) continue
    const last = lastHoldAt.get(room) ?? 0
    if (now - last < HOLD_COOLDOWN_MS) continue
    const conversationId = room.slice('conversation:'.length)
    const line = HOLDING_LINES[holdLineIndex % HOLDING_LINES.length]!
    holdLineIndex += 1
    const sent = await sendDm(conversationId, line)
    if (sent) {
      lastHoldAt.set(room, now)
      state.holds += 1
      pendingInbound.delete(room) // the line itself counts as an answer for this batch
      mirror('note', `[hyperchat] holding line sent to @${inbound.from} in ${room} after ${Math.round(waited / 1000)}s of silence`)
      log(`holding line → @${inbound.from} in ${room}`)
    }
  }
}

// ── boot + supervision ────────────────────────────────────────────────────

async function boot(): Promise<void> {
  await login()

  const sock = io(SIDECAR, {
    path: '/',
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 750,
    reconnectionDelayMax: 5000,
    auth: { token: state.token, presence: 'online' },
  })

  sock.on('connect', () => {
    state.connected = true
    state.lastEvent = 'socket connected'
    log(`socket connected (id ${sock.id}) — glm is ONLINE`)
    subscribed.clear()
    void resubscribe()
  })

  sock.on('disconnect', (reason) => {
    state.connected = false
    state.lastEvent = `disconnected: ${reason}`
    log(`socket disconnected: ${reason}`)
  })

  sock.on('connect_error', (err) => {
    state.connected = false
    state.lastEvent = `connect_error: ${err.message}`
    log(`connect_error: ${err.message}`)
  })

  sock.on('message:new', onMessageNew as (msg: unknown) => void)

  state.socket = sock
  state.lastEvent = 'socket created'
}

// retry wrapper: any fatal boot error (app down, sidecar down) retries
// forever with backoff — this daemon must outlive everything
function startForever(): void {
  boot()
    .then(() => log('boot complete'))
    .catch((err) => {
      log(`boot failed: ${String(err).slice(0, 200)} — retrying in 5s`)
      setTimeout(startForever, 5000)
    })
}

startForever()
setInterval(() => void resubscribe(), RESUB_INTERVAL_MS)
setInterval(() => void sweep(), HOLD_SWEEP_MS)

// ── health endpoint (:3005) ───────────────────────────────────────────────

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (!req.url || req.method !== 'GET') {
    res.writeHead(405).end()
    return
  }
  const body = {
    ok: true,
    as: IDENTIFIER,
    connected: state.connected,
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    subscribedRooms: subscribed.size,
    waitingInbound: [...pendingInbound.entries()].map(([room, v]) => ({
      room,
      from: v.from,
      waitedSec: Math.round((Date.now() - v.at) / 1000),
    })),
    mirrored: state.mirrored,
    holds: state.holds,
    lastEvent: state.lastEvent,
    lastEventAgoSec: state.lastEventAt ? Math.round((Date.now() - state.lastEventAt) / 1000) : null,
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body, null, 2))
})

server.listen(PORT, () => {
  log(`health endpoint on :${PORT}`)
})
