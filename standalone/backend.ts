/* HyperChat standalone backend: the entire platform in one page.
 *
 * The real app talks to Next.js API routes; the single-file build swaps the
 * transport, not the app. This module intercepts window.fetch for /api/*
 * and answers from an in-page database persisted to localStorage, emitting
 * the same realtime events over the BroadcastChannel socket. Every feature
 * of the client works against it: servers, channels, messages, reactions,
 * pins, whispers, DMs, groups, friends, read states, search, scheduled
 * delivery, reminders, saved messages, admin, uploads (as data URLs).
 *
 * The world is seeded with two local accounts (hyperion + demo) so a second
 * browser tab logged in as demo gives you a live person to talk to. */

import { busEmit, getLiveLocalSocket } from './localsocket'


const DB_KEY = 'hyperchat-standalone-db'
const DB_VERSION = 1

type Row = Record<string, any>

type World = {
  version: number
  seq: number
  seeded?: boolean
  users: Row[]
  sessions: Record<string, string> // token -> userId
  servers: Row[]
  members: Row[]
  channels: Row[]
  forumPosts: Row[]
  categories: Row[]
  roles: Row[]
  bans: Row[]
  messages: Row[]
  conversations: Row[]
  participants: Row[]
  reads: Row[]
  friendships: Row[]
  blocks: Row[]
  mutes: Row[]
  bookmarks: Row[]
  scheduled: Row[]
  reminders: Row[]
  events: Row[]
  savedGifs: Row[]
}

const nowIso = () => new Date().toISOString()
const uid = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
const hash = (s: string) => {
  // a tiny non-crypto digest: this is a demo world, not a vault
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `h${h >>> 0}`
}

let world: World | null = null
let sessionToken: string | null = null
let currentUserId: string | null = null

function blank(): World {
  return {
    version: DB_VERSION,
    seq: 0,
    users: [],
    sessions: {},
    servers: [],
    members: [],
    channels: [],
    forumPosts: [],
    categories: [],
    roles: [],
    bans: [],
    messages: [],
    conversations: [],
    participants: [],
    reads: [],
    friendships: [],
    blocks: [],
    mutes: [],
    bookmarks: [],
    scheduled: [],
    reminders: [],
    events: [],
    savedGifs: [],
  }
}

function save(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(world))
  } catch {
    /* quota: keep the world in memory for this session */
  }
}

function load(): World {
  if (world) return world
  try {
    const raw = localStorage.getItem(DB_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as World
      if (parsed && parsed.version === DB_VERSION) {
        // older worlds predate saved gifs: heal instead of wiping
        parsed.savedGifs = parsed.savedGifs ?? []
        world = parsed
        return world
      }
    }
  } catch {
    /* corrupted: start over */
  }
  world = blank()
  save()
  return world
}

/* ---------- lookups ---------- */

const userById = (id: string) => load().users.find((u) => u.id === id)
const userByName = (name: string) => load().users.find((u) => u.username === name.toLowerCase())
const me = () => (currentUserId ? userById(currentUserId) : undefined)

function publicUser(u: Row) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    avatarColor: u.avatarColor,
    bio: u.bio,
    role: u.role,
    customStatus: u.customStatus,
    pronouns: u.pronouns,
    bannerColor: u.bannerColor,
    bannerUrl: u.bannerUrl,
    createdAt: u.createdAt,
  }
}

function sessionUser(u: Row) {
  return {
    ...publicUser(u),
    email: u.email,
    presence: u.presence,
  }
}

/* ---------- message serialization (mirrors the real routes) ---------- */

function reactionsOf(m: Row) {
  const groups = new Map<string, string[]>()
  for (const r of m.reactions ?? []) {
    const list = groups.get(r.emoji) ?? []
    list.push(r.userId)
    groups.set(r.emoji, list)
  }
  return Array.from(groups.entries()).map(([emoji, userIds]) => ({ emoji, userIds }))
}

function toClientMessage(m: Row): Row {
  const author = userById(m.authorId) ?? { username: 'ghost', displayName: null, avatarUrl: null, avatarColor: '#333' }
  const reply = m.replyToId ? load().messages.find((x) => x.id === m.replyToId) : null
  const member = m.channelId
    ? load().members.find((x) => x.serverId === m.serverId && x.userId === m.authorId)
    : null
  const role = member?.roleId ? load().roles.find((r) => r.id === member.roleId) : null
  return {
    id: m.id,
    content: m.content ?? null,
    imageUrl: m.imageUrl ?? null,
    attachments: m.attachments ?? null,
    createdAt: m.createdAt,
    editedAt: m.editedAt ?? null,
    pinned: !!m.pinned,
    pinnedAt: m.pinnedAt ?? null,
    pingsEveryone: !!m.pingsEveryone,
    whisperTargetId: m.whisperTargetId ?? null,
    whisperTargetName: m.whisperTargetName ?? null,
    systemKind: m.systemKind ?? null,
    systemData: m.systemData ?? null,
    replyToId: m.replyToId ?? null,
    replyTo: reply
      ? {
          id: reply.id,
          authorId: reply.authorId,
          authorUsername: (userById(reply.authorId) ?? {}).username ?? 'ghost',
          authorDisplayName: (userById(reply.authorId) ?? {}).displayName ?? null,
          contentPreview: (reply.content ?? '').slice(0, 120) || null,
          hasImage: !!reply.imageUrl,
        }
      : null,
    authorId: m.authorId,
    author: {
      id: author.id,
      username: author.username,
      displayName: author.displayName,
      avatarUrl: author.avatarUrl,
      avatarColor: author.avatarColor,
    },
    authorNickname: member?.nickname ?? null,
    authorRoleColor: role?.color ?? null,
    room: m.room,
    threadOfId: m.threadOfId ?? null,
    reactions: reactionsOf(m),
    expiresAt: m.expiresAt ?? null,
  }
}

/** realtime event mirroring the real emit targets (room + participants). */
function emitMessage(m: Row, nonce?: string | null): void {
  const payload = { ...toClientMessage(m), nonce: nonce ?? null }
  const targets = m.whisperTargetId ? [m.authorId, m.whisperTargetId] : null
  busEmit('message:new', targets ? { ...payload, __targets: targets } : payload)
}

function emitUserUpdate(userId: string): void {
  busEmit('user:update', { userId })
}

/** Serialize a forum post row for the client: reply count + last activity +
 *  the viewer's read stamp (for the "new" badge). */
function forumPostSummary(post: Row, userId: string): Row {
  const w = load()
  const rootId = post.firstMessageId
  const replies = rootId ? w.messages.filter((m) => m.threadOfId === rootId) : []
  const last = replies.length ? replies[replies.length - 1].createdAt : null
  const read = w.reads.find((r) => r.userId === userId && r.scopeKey === `post:${post.id}`)
  const author = userById(post.authorId) ?? { id: post.authorId, username: 'ghost', displayName: null, avatarUrl: null, avatarColor: '#333' }
  return {
    id: post.id,
    channelId: post.channelId,
    title: post.title,
    pinned: !!post.pinned,
    locked: !!post.locked,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    firstMessageId: post.firstMessageId,
    author: {
      id: author.id,
      username: author.username,
      displayName: author.displayName ?? null,
      avatarUrl: author.avatarUrl ?? null,
      avatarColor: author.avatarColor ?? '#2e2e2e',
    },
    replyCount: replies.length,
    lastReplyAt: last,
    readAt: read?.lastReadAt ?? null,
  }
}

/* ---------- the seeded world ---------- */

function ensureSeed(): void {
  const w = load()
  if (w.users.length > 0 || w.seeded) return
  w.seeded = true

  const hyperion = {
    id: uid('u'),
    username: 'hyperion',
    email: 'hyperion@local',
    passwordHash: hash('hyperion-local'),
    displayName: 'Hyperion',
    bio: 'the first of three services. this standalone page is the whole app, running entirely in your browser.',
    avatarUrl: null as string | null,
    avatarColor: '#2e2e2e',
    role: 'ADMIN',
    customStatus: 'building the Hyperion trinity',
    pronouns: 'it/its',
    presence: 'online',
    bannerColor: '#547cff',
    bannerUrl: null as string | null,
    createdAt: nowIso(),
  }
  const demo = {
    id: uid('u'),
    username: 'demo',
    email: 'demo@local',
    passwordHash: hash('demo1234'),
    displayName: 'Demo',
    bio: 'a local account for a second tab. log in as demo / demo1234.',
    avatarUrl: null as string | null,
    avatarColor: '#23a55a',
    role: 'USER',
    customStatus: 'what are you thinking?',
    pronouns: 'they/them',
    presence: 'online',
    bannerColor: '#23a55a',
    bannerUrl: null as string | null,
    createdAt: nowIso(),
  }
  w.users.push(hyperion, demo)

  const server = {
    id: uid('s'),
    name: 'hyperchat',
    description: 'the welcome server. banners, roles, channels and pins all work here.',
    iconUrl: null,
    bannerColor: '#547cff',
    inviteCode: 'hyperion1',
    ownerId: hyperion.id,
    visibility: 'PUBLIC',
    blockedWords: '',
    createdAt: nowIso(),
  }
  w.servers.push(server)
  w.members.push(
    { id: uid('m'), userId: hyperion.id, serverId: server.id, role: 'OWNER', nickname: null, roleId: null, joinedAt: nowIso() },
    { id: uid('m'), userId: demo.id, serverId: server.id, role: 'MEMBER', nickname: null, roleId: null, joinedAt: nowIso() }
  )
  const general = {
    id: uid('c'),
    serverId: server.id,
    name: 'general',
    topic: 'everything and anything',
    position: 0,
    categoryId: null,
    slowmodeSeconds: 0,
    locked: false,
    private: false,
    createdAt: nowIso(),
  }
  const showcase = {
    id: uid('c'),
    serverId: server.id,
    name: 'showcase',
    topic: 'show what you built',
    position: 1,
    categoryId: null,
    slowmodeSeconds: 0,
    locked: false,
    private: false,
    createdAt: nowIso(),
  }
  w.channels.push(general, showcase)

  const room = `channel:${general.id}`
  const m1 = {
    id: uid('msg'),
    channelId: general.id,
    serverId: server.id,
    authorId: hyperion.id,
    content: 'welcome to hyperchat!',
    createdAt: new Date(Date.now() - 40 * 60000).toISOString(),
    reactions: [{ emoji: '👍', userId: demo.id }, { emoji: '❤️', userId: demo.id }],
    room,
  }
  const m2 = {
    id: uid('msg'),
    channelId: general.id,
    serverId: server.id,
    authorId: hyperion.id,
    content: 'this is the standalone build: the exact same app, bundled into one html file with a local backend.',
    createdAt: new Date(Date.now() - 39 * 60000).toISOString(),
    reactions: [],
    room,
  }
  const m3 = {
    id: uid('msg'),
    channelId: general.id,
    serverId: server.id,
    authorId: demo.id,
    content: 'open a second tab and log in as demo / demo1234 to chat with yourself live.',
    createdAt: new Date(Date.now() - 38 * 60000).toISOString(),
    reactions: [{ emoji: '🔥', userId: hyperion.id }],
    room,
  }
  const m4 = {
    id: uid('msg'),
    channelId: showcase.id,
    serverId: server.id,
    authorId: hyperion.id,
    content: 'try :fire: shortcodes, /whisper @demo, right-click menus, pins, reminders and the discovery page.',
    createdAt: new Date(Date.now() - 37 * 60000).toISOString(),
    reactions: [],
    room: `channel:${showcase.id}`,
  }
  w.messages.push(m1, m2, m3, m4)

  save()
}

/** The signed-in user's personal slice of the world (DM + friend request). */
function ensurePersonalWorld(userId: string): void {
  const w = load()
  if (w.users.find((u) => u.id === userId)?.personalized) return
  const u = w.users.find((x) => x.id === userId)
  if (u) u.personalized = true
  const hyperion = userByName('hyperion')
  const demo = userByName('demo')
  if (!hyperion || !demo) return

  // a 1:1 DM from hyperion with a pinned welcome
  const convo = {
    id: uid('v'),
    kind: 'DM',
    name: null,
    limitRaised: false,
    tempExpiryMinutes: null,
    createdAt: nowIso(),
  }
  w.conversations.push(convo)
  w.participants.push(
    { id: uid('p'), conversationId: convo.id, userId, hidden: false, pinned: false },
    { id: uid('p'), conversationId: convo.id, userId: hyperion.id, hidden: false, pinned: false }
  )
  const wm = {
    id: uid('msg'),
    conversationId: convo.id,
    authorId: hyperion.id,
    content: 'Thanks for using Hyperion!',
    createdAt: nowIso(),
    reactions: [],
    pinned: true,
    pinnedAt: nowIso(),
    room: `conversation:${convo.id}`,
  }
  w.messages.push(wm)

  // a group chat
  const group = {
    id: uid('v'),
    kind: 'GROUP',
    name: 'the squad',
    limitRaised: false,
    tempExpiryMinutes: null,
    createdAt: nowIso(),
  }
  w.conversations.push(group)
  w.participants.push(
    { id: uid('p'), conversationId: group.id, userId, hidden: false, pinned: false },
    { id: uid('p'), conversationId: group.id, userId: demo.id, hidden: false, pinned: false },
    { id: uid('p'), conversationId: group.id, userId: hyperion.id, hidden: false, pinned: false }
  )
  w.messages.push({
    id: uid('msg'),
    conversationId: group.id,
    authorId: demo.id,
    content: 'group chats hold five people, and one click raises it to fifty.',
    createdAt: nowIso(),
    reactions: [{ emoji: '🎉', userId: hyperion.id }],
    room: `conversation:${group.id}`,
  })

  // demo wants to be your friend
  w.friendships.push({
    id: uid('f'),
    requesterId: demo.id,
    addresseeId: userId,
    status: 'PENDING',
    requesterLabel: null,
    addresseeLabel: null,
    expiresAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  })

  save()
}

export function setStandaloneUser(userId: string | null): void {
  currentUserId = userId
  const u = userId ? userById(userId) : undefined
  getLiveLocalSocket()?.setUser(userId ?? null, u?.username)
}

/* ================= the router ================= */

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

const err = (error: string, status = 400, code?: string) => json({ error, code }, status)

function parseBody(init?: RequestInit): Row {
  try {
    if (!init?.body) return {}
    if (typeof init.body === 'string') return JSON.parse(init.body)
    return {}
  } catch {
    return {}
  }
}

function route(method: string, path: string): Row | Response {
  const w = load()
  const user = me()
  const body = parseBody(currentInit)
  const seg = path.split('/').filter(Boolean) // e.g. api/servers/x/messages

  /* ---------- auth ---------- */
  if (path === '/api/auth/me' && method === 'GET') {
    return user ? json({ user: sessionUser(user) }) : json({ user: null })
  }
  if (path === '/api/auth/register' && method === 'POST') {
    const username = String(body.username ?? '').toLowerCase().trim()
    const email = String(body.email ?? '').toLowerCase().trim()
    const password = String(body.password ?? '')
    if (!/^[a-z0-9_]{2,24}$/.test(username)) return err('pick a username of 2-24 letters, numbers or underscores')
    if (userByName(username)) return err('that username is taken', 409)
    if (w.users.some((u) => u.email === email)) return err('an account with that email exists', 409)
    if (password.length < 8) return err('passwords need at least 8 characters')
    const created = {
      id: uid('u'),
      username,
      email,
      passwordHash: hash(password),
      displayName: null,
      bio: '',
      avatarUrl: null,
      avatarColor: '#2e2e2e',
      role: 'USER',
      customStatus: null,
      pronouns: null,
      presence: 'online',
      bannerColor: null,
      bannerUrl: null,
      createdAt: nowIso(),
    }
    w.users.push(created)
    // everyone joins the welcome server
    const server = w.servers[0]
    if (server) {
      w.members.push({ id: uid('m'), userId: created.id, serverId: server.id, role: 'MEMBER', nickname: null, roleId: null, joinedAt: nowIso() })
    }
    sessionToken = uid('t')
    w.sessions[sessionToken] = created.id
    currentUserId = created.id
    ensurePersonalWorld(created.id)
    save()
    return json({ user: sessionUser(created) }, 201)
  }
  if (path === '/api/auth/login' && method === 'POST') {
    const identifier = String(body.identifier ?? '').toLowerCase().trim()
    const password = String(body.password ?? '')
    const found = w.users.find((u) => u.username === identifier || u.email === identifier)
    if (!found || found.passwordHash !== hash(password)) return err('wrong username or password', 401)
    sessionToken = uid('t')
    w.sessions[sessionToken] = found.id
    currentUserId = found.id
    ensurePersonalWorld(found.id)
    save()
    return json({ user: sessionUser(found) })
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    if (sessionToken) delete w.sessions[sessionToken]
    sessionToken = null
    currentUserId = null
    save()
    return json({ ok: true })
  }

  if (!user) return err('sign in first', 401)

  /* ---------- my profile ---------- */
  if (path === '/api/users/me' && method === 'PATCH') {
    for (const key of ['displayName', 'bio', 'avatarUrl', 'avatarColor', 'customStatus', 'pronouns', 'presence', 'bannerColor', 'bannerUrl']) {
      if (body[key] !== undefined) user[key] = body[key] === '' ? null : body[key]
    }
    save()
    emitUserUpdate(user.id)
    return json({ user: sessionUser(user) })
  }
  if (path === '/api/users/me/password' && method === 'PATCH') {
    if (user.passwordHash !== hash(String(body.currentPassword ?? ''))) return err('current password is wrong', 403)
    const next = String(body.newPassword ?? '')
    if (next.length < 8) return err('passwords need at least 8 characters')
    user.passwordHash = hash(next)
    save()
    return json({ ok: true })
  }
  if (seg[0] === 'api' && seg[1] === 'users' && seg.length === 3 && method === 'GET') {
    const found = userByName(seg[2])
    if (!found) return err('no user goes by that name', 404)
    if (w.blocks.some((b) => (b.blockerId === user.id && b.blockedId === found.id) || (b.blockerId === found.id && b.blockedId === user.id))) {
      return err('you cannot view this profile', 403)
    }
    const mutual = w.members
      .filter((m) => m.userId === user.id)
      .map((m) => m.serverId)
      .filter((sid) => w.members.some((m) => m.userId === found.id && m.serverId === sid))
      .slice(0, 6)
      .map((sid) => ({ name: w.servers.find((s) => s.id === sid)?.name ?? '' }))
    return json({ user: publicUser(found), mutualServers: mutual.map((m) => m.name) })
  }
  if (path === '/api/users' && method === 'GET') {
    const q = (currentUrl?.searchParams.get('q') ?? '').toLowerCase()
    const users = w.users
      .filter((u) => u.id !== user.id && u.username.includes(q))
      .slice(0, 12)
      .map(publicUser)
    return json({ users })
  }

  /* ---------- servers ---------- */
  if (path === '/api/servers' && method === 'GET') {
    const mine = w.members.filter((m) => m.userId === user.id)
    const servers = mine.flatMap((m) => {
      const server = w.servers.find((s) => s.id === m.serverId)
      if (!server) return []
      const members = w.members.filter((x) => x.serverId === m.serverId)
      const channels = w.channels
        .filter((c) => c.serverId === m.serverId)
        .sort((a, b) => a.position - b.position)
        .map((c) => ({
          id: c.id, serverId: c.serverId, name: c.name, topic: c.topic, position: c.position,
          categoryId: c.categoryId, type: c.type ?? 'text', slowmodeSeconds: c.slowmodeSeconds ?? 0, locked: !!c.locked,
          private: !!c.private, accessRoleIds: [],
        }))
      return {
        id: server.id, name: server.name, description: server.description, iconUrl: server.iconUrl,
        bannerColor: server.bannerColor ?? null, inviteCode: server.inviteCode, ownerId: server.ownerId,
        memberCount: members.length, myRole: m.role,
        myPerms: m.role === 'OWNER' ? 0xffff : m.role === 'ADMIN' ? 0x3ff : 0,
        channels, categories: [],
      }
    })
    return json({ servers })
  }
  if (path === '/api/servers' && method === 'POST') {
    const name = String(body.name ?? '').trim().slice(0, 48)
    if (!name) return err('name your server')
    const code = uid('').slice(0, 8)
    const server = {
      id: uid('s'), name, description: String(body.description ?? '').slice(0, 300), iconUrl: null,
      bannerColor: null, inviteCode: code, ownerId: user.id, visibility: 'PRIVATE', blockedWords: '', createdAt: nowIso(),
    }
    w.servers.push(server)
    w.members.push({ id: uid('m'), userId: user.id, serverId: server.id, role: 'OWNER', nickname: null, roleId: null, joinedAt: nowIso() })
    const channel = {
      id: uid('c'), serverId: server.id, name: 'general', topic: null, position: 0, categoryId: null,
      type: 'text', slowmodeSeconds: 0, locked: false, private: false, createdAt: nowIso(),
    }
    w.channels.push(channel)
    save()
    return json({ server: { id: server.id } }, 201)
  }
  if (path === '/api/servers/join' && method === 'POST') {
    const code = String(body.inviteCode ?? '').trim()
    const server = w.servers.find((s) => s.inviteCode === code) ?? w.servers.find((s) => s.inviteCode.toLowerCase() === code.toLowerCase())
    if (!server) return err('that invite does not work', 404)
    const already = w.members.find((m) => m.serverId === server.id && m.userId === user.id)
    if (!already) {
      w.members.push({ id: uid('m'), userId: user.id, serverId: server.id, role: 'MEMBER', nickname: null, roleId: null, joinedAt: nowIso() })
      save()
      busEmit('server:refresh', { serverId: server.id })
    }
    return json({ server: { id: server.id }, alreadyMember: !!already })
  }
  if (path === '/api/servers/browse' && method === 'GET') {
    const q = (currentUrl?.searchParams.get('q') ?? '').toLowerCase()
    const sort = currentUrl?.searchParams.get('sort') ?? 'members'
    const offset = Number(currentUrl?.searchParams.get('offset') ?? 0) || 0
    const list = w.servers
      .filter((s) => s.visibility === 'PUBLIC' && !w.members.some((m) => m.serverId === s.id && m.userId === user.id))
      .filter((s) => !q || s.name.includes(q) || (s.description ?? '').toLowerCase().includes(q))
      .map((s) => ({
        id: s.id, name: s.name, description: s.description, iconUrl: s.iconUrl,
        bannerColor: s.bannerColor ?? null, memberCount: w.members.filter((m) => m.serverId === s.id).length,
      }))
    list.sort((a, b) => (sort === 'new' ? 0 : b.memberCount - a.memberCount))
    return json({ servers: list.slice(offset, offset + 24) })
  }
  if (seg[0] === 'api' && seg[1] === 'servers' && seg[2] === 'resolve' && seg.length === 4 && method === 'GET') {
    const code = seg[3]
    const server = w.servers.find((s) => s.inviteCode === code) ?? w.servers.find((s) => s.inviteCode.toLowerCase() === code.toLowerCase())
    if (!server) return err('invite not found', 404)
    return json({
      server: {
        id: server.id, name: server.name, description: server.description, iconUrl: server.iconUrl,
        bannerColor: server.bannerColor ?? null, visibility: server.visibility,
        memberCount: w.members.filter((m) => m.serverId === server.id).length,
      },
    })
  }
  if (seg[0] === 'api' && seg[1] === 'servers' && seg.length === 3) {
    const server = w.servers.find((s) => s.id === seg[2])
    if (!server) return err('server not found', 404)
    const membership = w.members.find((m) => m.serverId === server.id && m.userId === user.id)
    if (method === 'GET') {
      if (!membership) return err('you are not a member', 403)
      const members = w.members
        .filter((m) => m.serverId === server.id)
        .map((m) => {
          const u = userById(m.userId)
          if (!u) return null
          return {
            ...publicUser(u), role: m.role, joinedAt: m.joinedAt, nickname: m.nickname,
            roleId: m.roleId, roleName: null, roleColor: null, timeoutUntil: null, siteAdmin: u.role === 'ADMIN',
          }
        })
        .filter(Boolean)
      const channels = w.channels
        .filter((c) => c.serverId === server.id)
        .sort((a, b) => a.position - b.position)
        .map((c) => ({
          id: c.id, serverId: c.serverId, name: c.name, topic: c.topic, position: c.position,
          categoryId: c.categoryId, type: c.type ?? 'text', slowmodeSeconds: c.slowmodeSeconds ?? 0, locked: !!c.locked,
          private: !!c.private, accessRoleIds: [],
        }))
      return json({
        server: {
          id: server.id, name: server.name, description: server.description, iconUrl: server.iconUrl,
          bannerColor: server.bannerColor ?? null, inviteCode: server.inviteCode, ownerId: server.ownerId,
          createdAt: server.createdAt, blockedWords: server.blockedWords, visibility: server.visibility,
        },
        channels, categories: [], members, roles: [], myRole: membership.role,
        myPerms: membership.role === 'OWNER' ? 0xffff : membership.role === 'ADMIN' ? 0x3ff : 0,
      })
    }
    if (method === 'PATCH') {
      if (!membership || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) return err('you cannot manage this server', 403)
      for (const key of ['name', 'description', 'iconUrl', 'bannerColor', 'visibility', 'blockedWords']) {
        if (body[key] !== undefined) server[key] = body[key] === '' ? null : body[key]
      }
      if (body.regenerateInvite) server.inviteCode = uid('').slice(0, 8)
      save()
      busEmit('server:refresh', { serverId: server.id })
      return json({ server })
    }
    if (method === 'DELETE') {
      if (server.ownerId !== user.id) return err('only the owner can delete', 403)
      w.servers = w.servers.filter((s) => s.id !== server.id)
      w.members = w.members.filter((m) => m.serverId !== server.id)
      w.channels = w.channels.filter((c) => c.serverId !== server.id)
      w.messages = w.messages.filter((m) => m.serverId !== server.id)
      save()
      busEmit('server:deleted', { serverId: server.id })
      return json({ ok: true })
    }
  }
  if (seg[0] === 'api' && seg[1] === 'servers' && seg[3] === 'join' && method === 'POST') {
    const server = w.servers.find((s) => s.id === seg[2])
    if (!server) return err('server not found', 404)
    if (server.visibility !== 'PUBLIC') return err('this server is private', 403)
    const already = w.members.find((m) => m.serverId === server.id && m.userId === user.id)
    if (!already) {
      w.members.push({ id: uid('m'), userId: user.id, serverId: server.id, role: 'MEMBER', nickname: null, roleId: null, joinedAt: nowIso() })
      save()
      busEmit('server:refresh', { serverId: server.id })
    }
    return json({ server: { id: server.id }, alreadyMember: !!already })
  }
  if (seg[0] === 'api' && seg[1] === 'servers' && seg[3] === 'leave' && method === 'POST') {
    const had = w.members.find((m) => m.serverId === seg[2] && m.userId === user.id)
    if (had) {
      w.members = w.members.filter((m) => m !== had)
      save()
    }
    return json({ ok: true })
  }
  if (seg[0] === 'api' && seg[1] === 'servers' && seg[3] === 'channels' && seg.length === 4 && method === 'POST') {
    const server = w.servers.find((s) => s.id === seg[2])
    const membership = server && w.members.find((m) => m.serverId === server.id && m.userId === user.id)
    if (!server || !membership || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) return err('you cannot manage this server', 403)
    const name = String(body.name ?? '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '').slice(0, 32)
    if (!name) return err('name the channel')
    if (w.channels.some((c) => c.serverId === server.id && c.name === name)) return err('a channel with that name exists', 409)
    const channel = {
      id: uid('c'), serverId: server.id, name, topic: body.topic ?? null,
      position: w.channels.filter((c) => c.serverId === server.id).length, categoryId: null,
      type: body.type === 'voice' || body.type === 'forum' ? body.type : 'text',
      slowmodeSeconds: 0, locked: false, private: false, createdAt: nowIso(),
    }
    w.channels.push(channel)
    save()
    busEmit('server:refresh', { serverId: server.id })
    return json({ channel: { id: channel.id } }, 201)
  }
  if (seg[0] === 'api' && seg[1] === 'servers' && seg[3] === 'roles' && method === 'GET') {
    return json({ roles: w.roles.filter((r) => r.serverId === seg[2]) })
  }
  if (seg[0] === 'api' && seg[1] === 'servers' && seg[3] === 'roles' && method === 'POST') {
    const role = { id: uid('r'), serverId: seg[2], name: String(body.name ?? 'role').slice(0, 32), color: body.color ?? '#f5f5f5', permissions: Number(body.permissions ?? 0), position: w.roles.length }
    w.roles.push(role)
    save()
    return json({ role }, 201)
  }
  if (seg[0] === 'api' && seg[1] === 'servers' && seg[3] === 'events' && method === 'GET') {
    return json({ events: w.events.filter((e) => e.serverId === seg[2]).slice(-40).reverse() })
  }
  if (seg[0] === 'api' && seg[1] === 'servers' && seg[3] === 'bans') {
    const server = w.servers.find((s) => s.id === seg[2])
    if (method === 'GET') return json({ bans: w.bans.filter((b) => b.serverId === seg[2]) })
    if (method === 'POST' && server) {
      const target = userById(String(body.userId ?? ''))
      if (!target) return err('who?', 404)
      const sid = server.id
      w.bans.push({ id: uid('b'), userId: target.id, serverId: sid, reason: body.reason ?? null, createdAt: nowIso() })
      w.members = w.members.filter((m) => !(m.serverId === sid && m.userId === target.id))
      save()
      busEmit('server:refresh', { serverId: sid })
      return json({ ok: true })
    }
    return err('server not found', 404)
  }

  /* ---------- channels ---------- */
  if (seg[0] === 'api' && seg[1] === 'channels' && seg.length === 3) {
    const channel = w.channels.find((c) => c.id === seg[2])
    if (!channel) return err('channel not found', 404)
    if (method === 'PATCH') {
      for (const key of ['name', 'topic', 'slowmodeSeconds', 'locked', 'private']) {
        if (body[key] !== undefined) channel[key] = body[key]
      }
      save()
      busEmit('server:refresh', { serverId: channel.serverId })
      return json({ channel })
    }
    if (method === 'DELETE') {
      w.channels = w.channels.filter((c) => c.id !== channel.id)
      w.messages = w.messages.filter((m) => m.channelId !== channel.id)
      save()
      busEmit('server:refresh', { serverId: channel.serverId })
      return json({ ok: true })
    }
  }
  if (seg[0] === 'api' && seg[1] === 'channels' && seg[3] === 'messages') {
    const channel = w.channels.find((c) => c.id === seg[2])
    if (!channel) return err('channel not found', 404)
    if (!w.members.some((m) => m.serverId === channel.serverId && m.userId === user.id)) return err('join the server first', 403)
    const room = `channel:${channel.id}`
    if (method === 'GET') {
      const rows = w.messages
        .filter((m) => m.channelId === channel.id)
        .filter((m) => !m.whisperTargetId || m.whisperTargetId === user.id || m.authorId === user.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-50)
      const read = w.reads.find((r) => r.userId === user.id && r.scopeKey === room)
      return json({ messages: rows.map(toClientMessage), hasMore: false, oldestCursor: null, myReadAt: read?.lastReadAt ?? null })
    }
    if (method === 'POST') {
      const myMembership = w.members.find((m) => m.serverId === channel.serverId && m.userId === user.id)
      if (myMembership?.timeoutUntil && new Date(myMembership.timeoutUntil).getTime() > Date.now()) {
        return err('you are timed out in this server', 403)
      }
      if (channel.locked) {
        if (!myMembership || myMembership.role === 'MEMBER') return err('this channel is locked', 403)
      }
      const content = String(body.content ?? '').trim().slice(0, 2000)
      const message = {
        id: uid('msg'), channelId: channel.id, serverId: channel.serverId, authorId: user.id,
        content: content || null, imageUrl: body.imageUrl ?? null, attachments: body.attachments ?? null,
        replyToId: body.replyToId ?? null, createdAt: nowIso(), reactions: [], room,
        whisperTargetId: null as string | null, whisperTargetName: null as string | null,
      }
      w.messages.push(message)
      const read = w.reads.find((r) => r.userId === user.id && r.scopeKey === room)
      if (read) read.lastReadAt = nowIso()
      else w.reads.push({ id: uid('r'), userId: user.id, scopeKey: room, lastReadAt: nowIso() })
      save()
      emitMessage(message, body.nonce ?? null)
      return json({ message: { ...toClientMessage(message), nonce: body.nonce ?? null } }, 201)
    }
  }
  if (seg[0] === 'api' && seg[1] === 'channels' && seg[3] === 'pins' && method === 'GET') {
    const rows = w.messages.filter((m) => m.channelId === seg[2] && m.pinned)
    return json({ messages: rows.map(toClientMessage) })
  }
  if (seg[0] === 'api' && seg[1] === 'channels' && seg[3] === 'purge' && method === 'POST') {
    const count = Math.min(Number(body.count ?? 0) || 0, 100)
    const rows = w.messages.filter((m) => m.channelId === seg[2] && (!body.userId || m.authorId === body.userId)).slice(-count)
    w.messages = w.messages.filter((m) => !rows.includes(m))
    save()
    busEmit('messages:purge', { ids: rows.map((r) => r.id) })
    return json({ ok: true, deleted: rows.length })
  }

  /* ---------- voice (no-op in the standalone build) ---------- */
  if (seg[0] === 'api' && seg[1] === 'channels' && seg[3] === 'voice' && method === 'GET') {
    // voice presence lives in the socket sidecar, which the single-file build
    // does not run. The VoiceEngine detects the standalone flag and surfaces
    // an inline "unavailable" notice instead of a real call.
    return json({ participants: [] })
  }

  /* ---------- forum posts ---------- */
  if (seg[0] === 'api' && seg[1] === 'channels' && seg[3] === 'posts' && method === 'GET') {
    const channel = w.channels.find((c) => c.id === seg[2])
    if (!channel) return err('channel not found', 404)
    if (!w.members.some((m) => m.serverId === channel.serverId && m.userId === user.id)) return err('join the server first', 403)
    const posts = w.forumPosts
      .filter((p) => p.channelId === seg[2])
      .map((p) => forumPostSummary(p, user.id))
    posts.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const ka = a.lastReplyAt ?? a.createdAt
      const kb = b.lastReplyAt ?? b.createdAt
      return ka < kb ? 1 : ka > kb ? -1 : a.id < b.id ? -1 : 1
    })
    return json({ posts })
  }
  if (seg[0] === 'api' && seg[1] === 'channels' && seg[3] === 'posts' && method === 'POST') {
    const channel = w.channels.find((c) => c.id === seg[2])
    if (!channel) return err('channel not found', 404)
    if (!w.members.some((m) => m.serverId === channel.serverId && m.userId === user.id)) return err('join the server first', 403)
    const title = String(body.title ?? '').trim().slice(0, 200)
    const content = String(body.content ?? '').trim().slice(0, 2000)
    if (!title) return err('give the post a title')
    const root = {
      id: uid('msg'), channelId: channel.id, serverId: channel.serverId, authorId: user.id,
      content: content || null, imageUrl: null, attachments: null, replyToId: null, threadOfId: null,
      createdAt: nowIso(), reactions: [], room: `channel:${channel.id}`,
      whisperTargetId: null, whisperTargetName: null,
    }
    w.messages.push(root)
    const post = {
      id: uid('p'), channelId: channel.id, authorId: user.id, title, firstMessageId: root.id,
      pinned: false, locked: false, createdAt: nowIso(), updatedAt: nowIso(),
    }
    w.forumPosts.push(post)
    save()
    busEmit('forum:post:new', { post: forumPostSummary(post, user.id) })
    return json({ post: forumPostSummary(post, user.id) }, 201)
  }
  if (seg[0] === 'api' && seg[1] === 'posts' && seg.length === 3) {
    const post = w.forumPosts.find((p) => p.id === seg[2])
    if (!post) return err('post not found', 404)
    const channel = w.channels.find((c) => c.id === post.channelId)
    const membership = channel && w.members.find((m) => m.serverId === channel.serverId && m.userId === user.id)
    if (!membership) return err('join the server first', 403)
    const canMod = membership.role === 'OWNER' || membership.role === 'ADMIN'
    if (method === 'PATCH') {
      if (body.title !== undefined) {
        if (post.authorId !== user.id && !canMod) return err('you cannot edit this post', 403)
        post.title = String(body.title ?? '').trim().slice(0, 200)
        if (!post.title) return err('give the post a title')
      }
      if (body.pinned !== undefined) {
        if (!canMod) return err('only moderators can pin posts', 403)
        post.pinned = !!body.pinned
      }
      if (body.locked !== undefined) {
        if (!canMod) return err('only moderators can lock posts', 403)
        post.locked = !!body.locked
      }
      post.updatedAt = nowIso()
      save()
      busEmit('forum:post:update', { post: forumPostSummary(post, user.id) })
      return json({ post: forumPostSummary(post, user.id) })
    }
    if (method === 'DELETE') {
      if (post.authorId !== user.id && !canMod) return err('you cannot delete this post', 403)
      const rootId = post.firstMessageId
      w.forumPosts = w.forumPosts.filter((p) => p.id !== post.id)
      w.messages = w.messages.filter((m) => m.id !== rootId && m.threadOfId !== rootId)
      save()
      busEmit('forum:post:delete', { postId: post.id })
      return json({ ok: true })
    }
  }
  if (seg[0] === 'api' && seg[1] === 'posts' && seg[3] === 'replies' && method === 'POST') {
    const post = w.forumPosts.find((p) => p.id === seg[2])
    if (!post) return err('post not found', 404)
    if (!post.firstMessageId) return err('this post has no thread')
    const channel = w.channels.find((c) => c.id === post.channelId)
    const membership = channel && w.members.find((m) => m.serverId === channel.serverId && m.userId === user.id)
    if (!membership) return err('join the server first', 403)
    if (post.locked && membership.role === 'MEMBER') return err('this post is locked', 403)
    const content = String(body.content ?? '').trim().slice(0, 2000)
    if (!content) return err('type a reply')
    const reply = {
      id: uid('msg'), channelId: post.channelId, serverId: channel.serverId, authorId: user.id,
      content, imageUrl: null, attachments: null, replyToId: null, threadOfId: post.firstMessageId,
      createdAt: nowIso(), reactions: [], room: `channel:${post.channelId}`,
      whisperTargetId: null, whisperTargetName: null,
    }
    w.messages.push(reply)
    post.updatedAt = nowIso()
    save()
    busEmit('message:new', toClientMessage(reply))
    busEmit('forum:post:update', { post: forumPostSummary(post, user.id) })
    return json({ message: toClientMessage(reply) }, 201)
  }

  /* ---------- messages ---------- */
  if (seg[0] === 'api' && seg[1] === 'messages' && seg.length === 3) {
    const message = w.messages.find((m) => m.id === seg[2])
    if (!message) return err('message not found', 404)
    if (method === 'PATCH') {
      if (message.authorId !== user.id) return err('not your message', 403)
      message.content = String(body.content ?? '').slice(0, 2000)
      message.editedAt = nowIso()
      save()
      busEmit('message:update', toClientMessage(message))
      return json({ message: toClientMessage(message) })
    }
    if (method === 'DELETE') {
      w.messages = w.messages.filter((m) => m.id !== message.id)
      save()
      busEmit('message:delete', { messageId: message.id })
      return json({ ok: true })
    }
  }
  if (seg[0] === 'api' && seg[1] === 'messages' && seg[3] === 'thread' && method === 'GET') {
    const root = w.messages.find((m) => m.id === seg[2])
    if (!root) return err('message not found', 404)
    if (root.threadOfId) return err('thread of a thread', 400)
    const replies = w.messages.filter((m) => m.threadOfId === root.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return json({ root: toClientMessage(root), messages: replies.map(toClientMessage), count: replies.length })
  }
  if (seg[0] === 'api' && seg[1] === 'messages' && seg[3] === 'reactions' && method === 'POST') {
    const message = w.messages.find((m) => m.id === seg[2])
    if (!message) return err('message not found', 404)
    if (message.channelId) {
      const myMembership = w.members.find((m) => m.serverId === message.serverId && m.userId === user.id)
      if (myMembership?.timeoutUntil && new Date(myMembership.timeoutUntil).getTime() > Date.now()) {
        return err('you are timed out in this server', 403)
      }
    }
    const emoji = String(body.emoji ?? '')
    message.reactions = message.reactions ?? []
    const existing = message.reactions.find((r) => r.emoji === emoji && r.userId === user.id)
    if (existing) message.reactions = message.reactions.filter((r) => r !== existing)
    else message.reactions.push({ emoji, userId: user.id })
    save()
    const payload = { messageId: message.id, room: message.room, reactions: reactionsOf(message) }
    busEmit('message:reaction', payload)
    return json(payload)
  }
  if (seg[0] === 'api' && seg[1] === 'messages' && seg[3] === 'pin') {
    const message = w.messages.find((m) => m.id === seg[2])
    if (!message) return err('message not found', 404)
    if (method === 'POST') {
      message.pinned = true
      message.pinnedAt = nowIso()
      w.messages.push({
        id: uid('msg'), conversationId: message.conversationId, authorId: user.id, systemKind: 'pin',
        systemData: JSON.stringify({ messageId: message.id, byUsername: user.username }),
        createdAt: nowIso(), reactions: [], room: message.room,
      })
    } else if (method === 'DELETE') {
      message.pinned = false
      message.pinnedAt = null
    }
    save()
    busEmit('message:update', toClientMessage(message))
    const sys = [...w.messages].reverse().find((m) => m.systemKind && m.systemData?.includes(message.id))
    if (sys && method === 'POST') emitMessage(sys)
    return json({ message: toClientMessage(message) })
  }

  /* ---------- conversations ---------- */
  if (path === '/api/conversations' && method === 'GET') {
    const mine = w.participants.filter((p) => p.userId === user.id)
    const conversations = mine.flatMap((p) => {
      const convo = w.conversations.find((c) => c.id === p.conversationId)
      if (!convo) return []
      const others = w.participants
        .filter((x) => x.conversationId === convo.id && x.userId !== user.id)
        .map((x) => userById(x.userId))
        .filter(Boolean)
      const rows = w.messages
        .filter((m) => m.conversationId === convo.id)
        .filter((m) => !m.whisperTargetId || m.whisperTargetId === user.id || m.authorId === user.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const last = rows[rows.length - 1]
      const otherRead = w.reads.find((r) => r.userId === others[0]?.id && r.scopeKey === `conversation:${convo.id}`)
      const myRead = w.reads.find((r) => r.userId === user.id && r.scopeKey === `conversation:${convo.id}`)
      const unread = myRead ? rows.filter((m) => m.authorId !== user.id && m.createdAt > myRead.lastReadAt).length : 0
      return {
        id: convo.id, kind: convo.kind, name: convo.name, limitRaised: !!convo.limitRaised,
        tempExpiryMinutes: convo.tempExpiryMinutes ?? null,
        otherUser: publicUser(others[0] ?? { username: 'ghost', avatarColor: '#333', id: 'x', createdAt: nowIso() }),
        participants: others.filter((o): o is Row => !!o).map((o) => ({ id: o.id, username: o.username, displayName: o.displayName, avatarUrl: o.avatarUrl, avatarColor: o.avatarColor })),
        hidden: !!p.hidden, pinned: !!p.pinned,
        lastMessage: last
          ? { id: last.id, content: last.content ?? null, imageUrl: last.imageUrl ?? null, createdAt: last.createdAt, authorId: last.authorId }
          : null,
        otherLastReadAt: otherRead?.lastReadAt ?? null,
        unreadCount: unread,
      }
    })
    conversations.sort((a, b) => (b.lastMessage?.createdAt ?? '').localeCompare(a.lastMessage?.createdAt ?? ''))
    return json({ conversations })
  }
  if (path === '/api/conversations' && method === 'POST') {
    if (body.kind === 'GROUP') {
      const name = String(body.name ?? 'group').slice(0, 48)
      const memberIds = (Array.isArray(body.memberIds) ? body.memberIds : []).filter((id: string) => id !== user.id).slice(0, 4)
      if (memberIds.length < 2) return err('pick at least two friends')
      const convo = { id: uid('v'), kind: 'GROUP', name, limitRaised: false, tempExpiryMinutes: null, createdAt: nowIso() }
      w.conversations.push(convo)
      for (const id of [user.id, ...memberIds]) {
        w.participants.push({ id: uid('p'), conversationId: convo.id, userId: id, hidden: false, pinned: false })
      }
      save()
      busEmit('conversation:new', {})
      return json({ conversationId: convo.id, existing: false }, 201)
    }
    const target = userById(String(body.userId ?? ''))
    if (!target) return err('no user with that id', 404)
    if (w.blocks.some((b) => (b.blockerId === user.id && b.blockedId === target.id) || (b.blockerId === target.id && b.blockedId === user.id))) {
      return err('you cannot message this user', 403)
    }
    const existing = w.conversations.find((c) => {
      if (c.kind !== 'DM') return false
      const ids = w.participants.filter((p) => p.conversationId === c.id).map((p) => p.userId).sort()
      return ids.length === 2 && ids.join() === [user.id, target.id].sort().join()
    })
    if (existing) return json({ conversationId: existing.id, existing: true })
    const convo = { id: uid('v'), kind: 'DM', name: null, limitRaised: false, tempExpiryMinutes: null, createdAt: nowIso() }
    w.conversations.push(convo)
    w.participants.push(
      { id: uid('p'), conversationId: convo.id, userId: user.id, hidden: false, pinned: false },
      { id: uid('p'), conversationId: convo.id, userId: target.id, hidden: false, pinned: false }
    )
    save()
    busEmit('conversation:new', {})
    return json({ conversationId: convo.id, existing: false }, 201)
  }
  if (seg[0] === 'api' && seg[1] === 'conversations' && seg[3] === 'messages') {
    const convo = w.conversations.find((c) => c.id === seg[2])
    const participant = convo && w.participants.find((p) => p.conversationId === convo.id && p.userId === user.id)
    if (!convo || !participant) return err('conversation not found', 404)
    const room = `conversation:${convo.id}`
    if (method === 'GET') {
      const rows = w.messages
        .filter((m) => m.conversationId === convo.id)
        .filter((m) => !m.whisperTargetId || m.whisperTargetId === user.id || m.authorId === user.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-50)
      const read = w.reads.find((r) => r.userId === user.id && r.scopeKey === room)
      return json({ messages: rows.map(toClientMessage), hasMore: false, oldestCursor: null, myReadAt: read?.lastReadAt ?? null })
    }
    if (method === 'POST') {
      const content = String(body.content ?? '').trim().slice(0, 2000)
      let whisperTargetId: string | null = null
      let whisperTargetName: string | null = null
      const whisperTo = String(body.whisperTo ?? '').trim().replace(/^@/, '').toLowerCase()
      if (whisperTo && convo.kind === 'GROUP') {
        const target = userByName(whisperTo)
        if (!target || !w.participants.some((p) => p.conversationId === convo.id && p.userId === target.id)) {
          return err('that person is not in this conversation')
        }
        whisperTargetId = target.id
        whisperTargetName = target.username
      }
      const expiresAt = convo.kind === 'DM' && convo.tempExpiryMinutes ? new Date(Date.now() + convo.tempExpiryMinutes * 60000).toISOString() : null
      const message = {
        id: uid('msg'), conversationId: convo.id, authorId: user.id, content: content || null,
        imageUrl: body.imageUrl ?? null, attachments: body.attachments ?? null, replyToId: body.replyToId ?? null,
        createdAt: nowIso(), reactions: [], room, whisperTargetId, whisperTargetName, expiresAt,
      }
      w.messages.push(message)
      for (const p of w.participants.filter((x) => x.conversationId === convo.id)) p.hidden = false
      const read = w.reads.find((r) => r.userId === user.id && r.scopeKey === room)
      if (read) read.lastReadAt = nowIso()
      else w.reads.push({ id: uid('r'), userId: user.id, scopeKey: room, lastReadAt: nowIso() })
      save()
      emitMessage(message, body.nonce ?? null)
      return json({ message: { ...toClientMessage(message), nonce: body.nonce ?? null } }, 201)
    }
  }
  if (seg[0] === 'api' && seg[1] === 'conversations' && seg[3] === 'pins' && method === 'GET') {
    const rows = w.messages.filter((m) => m.conversationId === seg[2] && m.pinned)
    return json({ messages: rows.map(toClientMessage) })
  }
  if (seg[0] === 'api' && seg[1] === 'conversations' && seg[3] === 'hide' && method === 'POST') {
    const p = w.participants.find((x) => x.conversationId === seg[2] && x.userId === user.id)
    if (p) p.hidden = true
    save()
    return json({ ok: true })
  }
  if (seg[0] === 'api' && seg[1] === 'conversations' && seg[3] === 'pin' && method === 'POST') {
    const p = w.participants.find((x) => x.conversationId === seg[2] && x.userId === user.id)
    if (p) p.pinned = !p.pinned
    save()
    return json({ ok: true, pinned: !!p?.pinned })
  }
  if (seg[0] === 'api' && seg[1] === 'conversations' && seg.length === 3 && method === 'PATCH') {
    const convo = w.conversations.find((c) => c.id === seg[2])
    if (!convo) return err('conversation not found', 404)
    if (body.name !== undefined) convo.name = String(body.name).slice(0, 48)
    if (body.raiseLimit) convo.limitRaised = true
    if (body.tempExpiryMinutes !== undefined && convo.kind === 'DM') convo.tempExpiryMinutes = body.tempExpiryMinutes
    save()
    return json({ conversation: { id: convo.id, kind: convo.kind, name: convo.name, limitRaised: !!convo.limitRaised, tempExpiryMinutes: convo.tempExpiryMinutes ?? null } })
  }
  if (seg[0] === 'api' && seg[1] === 'conversations' && seg[3] === 'members') {
    const convo = w.conversations.find((c) => c.id === seg[2])
    if (!convo || convo.kind !== 'GROUP') return err('group not found', 404)
    if (method === 'POST') {
      const target = userById(String(body.userId ?? ''))
      if (!target) return err('who?', 404)
      const count = w.participants.filter((p) => p.conversationId === convo.id).length
      if (!convo.limitRaised && count >= 5) return json({ error: 'limit', code: 'limit' }, 409)
      if (count >= 50) return err('this group is full', 409)
      if (!w.participants.some((p) => p.conversationId === convo.id && p.userId === target.id)) {
        w.participants.push({ id: uid('p'), conversationId: convo.id, userId: target.id, hidden: false, pinned: false })
      }
      save()
      busEmit('conversation:new', {})
      return json({ ok: true, memberCount: w.participants.filter((p) => p.conversationId === convo.id).length })
    }
    if (seg[4] === 'me' && method === 'DELETE') {
      w.participants = w.participants.filter((p) => !(p.conversationId === convo.id && p.userId === user.id))
      save()
      return json({ ok: true })
    }
  }

  /* ---------- friends / blocks / mutes ---------- */
  if (path === '/api/friends' && method === 'GET') {
    const rows = w.friendships.filter((f) => f.requesterId === user.id || f.addresseeId === user.id)
    const shape = (f: Row) => {
      const isRequester = f.requesterId === user.id
      const other = userById(isRequester ? f.addresseeId : f.requesterId) ?? { username: 'ghost', avatarColor: '#333', id: 'x', createdAt: nowIso() }
      return {
        friendshipId: f.id, user: publicUser(other), direction: isRequester ? 'outgoing' : 'incoming',
        nickname: (isRequester ? f.requesterLabel : f.addresseeLabel) ?? null,
        expiresAt: f.status === 'ACCEPTED' && f.expiresAt ? f.expiresAt : null,
        createdAt: f.createdAt,
      }
    }
    return json({
      friends: rows.filter((f) => f.status === 'ACCEPTED').map(shape),
      incoming: rows.filter((f) => f.status === 'PENDING' && f.addresseeId === user.id).map(shape),
      outgoing: rows.filter((f) => f.status === 'PENDING' && f.requesterId === user.id).map(shape),
    })
  }
  if (path === '/api/friends' && method === 'POST') {
    const username = String(body.username ?? '').toLowerCase().trim()
    const target = userByName(username)
    if (!target) return err('no user with that username', 404)
    if (target.id === user.id) return err('you cannot friend yourself')
    if (w.blocks.some((b) => (b.blockerId === user.id && b.blockedId === target.id) || (b.blockerId === target.id && b.blockedId === user.id))) {
      return err('you cannot friend this user', 403)
    }
    const reverse = w.friendships.find((f) => f.requesterId === target.id && f.addresseeId === user.id)
    if (reverse) {
      if (reverse.status === 'ACCEPTED') return err('you are already friends', 409)
      reverse.status = 'ACCEPTED'
      reverse.updatedAt = nowIso()
      if (body.temporaryHours) reverse.expiresAt = new Date(Date.now() + body.temporaryHours * 3600000).toISOString()
      save()
      busEmit('friends:update', {})
      return json({ friendship: { id: reverse.id, status: 'ACCEPTED' } }, 201)
    }
    const existing = w.friendships.find((f) => f.requesterId === user.id && f.addresseeId === target.id)
    if (existing) return err(existing.status === 'ACCEPTED' ? 'you are already friends' : 'request already sent', 409)
    const friendship = {
      id: uid('f'), requesterId: user.id, addresseeId: target.id, status: 'PENDING',
      requesterLabel: null, addresseeLabel: null,
      expiresAt: body.temporaryHours ? new Date(Date.now() + body.temporaryHours * 3600000).toISOString() : null,
      createdAt: nowIso(), updatedAt: nowIso(),
    }
    w.friendships.push(friendship)
    save()
    busEmit('friends:update', {})
    return json({ friendship: { id: friendship.id, status: 'PENDING' } }, 201)
  }
  if (seg[0] === 'api' && seg[1] === 'friends' && seg.length === 3) {
    const friendship = w.friendships.find((f) => f.id === seg[2])
    if (!friendship) return err('friendship not found', 404)
    const involved = friendship.requesterId === user.id || friendship.addresseeId === user.id
    if (!involved) return err('that is not your friendship', 403)
    if (method === 'POST') {
      if (friendship.addresseeId !== user.id) return err('only the recipient can accept', 403)
      friendship.status = 'ACCEPTED'
      friendship.updatedAt = nowIso()
      save()
      busEmit('friends:update', {})
      return json({ ok: true })
    }
    if (method === 'PATCH') {
      if (friendship.status !== 'ACCEPTED') return err('accept the request first', 403)
      const isRequester = friendship.requesterId === user.id
      if (typeof body.nickname === 'string') {
        const nick = body.nickname.trim().slice(0, 32)
        friendship[isRequester ? 'requesterLabel' : 'addresseeLabel'] = nick || null
      }
      if (body.temporary === true) {
        const hours = Math.min(Math.max(Number(body.hours ?? 24) || 24, 1), 720)
        friendship.expiresAt = new Date(Date.now() + hours * 3600000).toISOString()
      } else if (body.temporary === false) {
        friendship.expiresAt = null
      }
      save()
      busEmit('friends:update', {})
      return json({ ok: true })
    }
    if (method === 'DELETE') {
      w.friendships = w.friendships.filter((f) => f !== friendship)
      save()
      busEmit('friends:update', {})
      return json({ ok: true })
    }
  }
  if (path === '/api/blocks' && method === 'GET') {
    return json({ blocked: w.blocks.filter((b) => b.blockerId === user.id).map((b) => userById(b.blockedId)).filter((u): u is Row => !!u).map(publicUser) })
  }
  if (path === '/api/blocks' && method === 'POST') {
    const target = body.username ? userByName(String(body.username)) : userById(String(body.userId ?? ''))
    if (!target || target.id === user.id) return err('who?', 404)
    if (!w.blocks.some((b) => b.blockerId === user.id && b.blockedId === target.id)) {
      w.blocks.push({ id: uid('blk'), blockerId: user.id, blockedId: target.id, createdAt: nowIso() })
      w.friendships = w.friendships.filter((f) => !((f.requesterId === user.id && f.addresseeId === target.id) || (f.requesterId === target.id && f.addresseeId === user.id)))
      save()
      busEmit('friends:update', {})
    }
    return json({ ok: true, user: publicUser(target) })
  }
  if (seg[0] === 'api' && seg[1] === 'blocks' && method === 'DELETE') {
    w.blocks = w.blocks.filter((b) => !(b.blockerId === user.id && b.blockedId === seg[2]))
    save()
    return json({ ok: true })
  }
  if (path === '/api/mutes' && method === 'POST') {
    const existing = w.mutes.find((m) => m.userId === user.id && m.scopeKey === body.scope)
    if (existing) w.mutes = w.mutes.filter((m) => m !== existing)
    else w.mutes.push({ id: uid('mu'), userId: user.id, scopeKey: body.scope, createdAt: nowIso() })
    save()
    return json({ muted: !existing })
  }

  /* ---------- read / search / sync ---------- */
  if (path === '/api/read' && method === 'POST') {
    const scope = String(body.scope ?? '')
    const room = scope.startsWith('conversation:') ? scope : scope
    const read = w.reads.find((r) => r.userId === user.id && r.scopeKey === room)
    if (read) read.lastReadAt = nowIso()
    else w.reads.push({ id: uid('r'), userId: user.id, scopeKey: room, lastReadAt: nowIso() })
    save()
    if (room.startsWith('conversation:')) {
      const conversationId = room.slice('conversation:'.length)
      for (const p of w.participants.filter((x) => x.conversationId === conversationId && x.userId !== user.id)) {
        busEmit('read:update', { conversationId, userId: user.id, lastReadAt: nowIso() })
      }
    }
    return json({ ok: true, lastReadAt: nowIso() })
  }
  if (path === '/api/search' && method === 'GET') {
    const q = (currentUrl?.searchParams.get('q') ?? '').toLowerCase()
    const myServerIds = w.members.filter((m) => m.userId === user.id).map((m) => m.serverId)
    const rows = w.messages
      .filter((m) => (m.channelId && myServerIds.includes(m.serverId ?? '')) || (m.conversationId && w.participants.some((p) => p.conversationId === m.conversationId && p.userId === user.id)))
      .filter((m) => !m.whisperTargetId || m.whisperTargetId === user.id || m.authorId === user.id)
      .filter((m) => (m.content ?? '').toLowerCase().includes(q))
      .slice(-30)
      .reverse()
    return json({ messages: rows.map((m) => ({ ...toClientMessage(m), channelName: w.channels.find((c) => c.id === m.channelId)?.name ?? null })) })
  }
  if (path === '/api/sync' && method === 'GET') {
    const onlineUserIds = w.users.map((u) => u.id)
    const presenceStatuses: Record<string, string> = {}
    for (const u of w.users) presenceStatuses[u.id] = u.presence === 'invisible' ? 'offline' : u.presence
    const room = currentUrl?.searchParams.get('room') ?? ''
    const roomLast = w.messages
      .filter((m) => m.room === room)
      .filter((m) => !m.whisperTargetId || m.whisperTargetId === user.id || m.authorId === user.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-1)[0]
    const myServerIds = w.members.filter((m) => m.userId === user.id).map((m) => m.serverId)
    const conversationStamps = w.participants
      .filter((p) => p.userId === user.id)
      .flatMap((p) => {
        const convo = w.conversations.find((c) => c.id === p.conversationId)
        if (!convo) return []
        const rows = w.messages.filter((m) => m.conversationId === convo.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        const last = rows[rows.length - 1]
        const others = w.participants.filter((x) => x.conversationId === convo.id && x.userId !== user.id)
        const otherRead = w.reads.find((r) => r.userId === others[0]?.id && r.scopeKey === `conversation:${convo.id}`)
        const myRead = w.reads.find((r) => r.userId === user.id && r.scopeKey === `conversation:${convo.id}`)
        return {
          conversationId: convo.id, lastMessageId: last?.id ?? null, lastMessageAt: last?.createdAt ?? null,
          otherLastReadAt: otherRead?.lastReadAt ?? null, hidden: !!p.hidden,
          unreadCount: myRead ? rows.filter((m) => m.authorId !== user.id && m.createdAt > myRead.lastReadAt).length : 0,
        }
      })
    const channelUnread: Record<string, number> = {}
    for (const sid of myServerIds) {
      for (const c of w.channels.filter((ch) => ch.serverId === sid)) {
        const read = w.reads.find((r) => r.userId === user.id && r.scopeKey === `channel:${c.id}`)
        const count = read ? w.messages.filter((m) => m.channelId === c.id && m.authorId !== user.id && m.createdAt > read.lastReadAt).length : 0
        if (count > 0) channelUnread[c.id] = count
      }
    }
    return json({
      onlineUserIds, presenceStatuses, awaySince: {},
      serverStamps: myServerIds.map((sid) => ({
        serverId: sid,
        memberCount: w.members.filter((m) => m.serverId === sid).length,
        channelCount: w.channels.filter((c) => c.serverId === sid).length,
        lastMessageAt: w.messages.filter((m) => m.serverId === sid).slice(-1)[0]?.createdAt ?? null,
      })),
      conversationStamps,
      channelUnread, channelMentions: {},
      roomLastMessage: roomLast ? { id: roomLast.id, createdAt: roomLast.createdAt } : null,
      blockedUserIds: w.blocks.filter((b) => b.blockerId === user.id).map((b) => b.blockedId),
      mutedScopes: w.mutes.filter((m) => m.userId === user.id).map((m) => m.scopeKey),
    })
  }

  /* ---------- bookmarks / scheduled / reminders ---------- */
  if (path === '/api/bookmarks' && method === 'GET') {
    const rows = w.bookmarks.filter((b) => b.userId === user.id)
    return json({
      bookmarks: rows.map((b) => {
        const m = w.messages.find((x) => x.id === b.messageId)
        return m ? { id: b.id, note: b.note, createdAt: b.createdAt, message: toClientMessage(m), scope: null } : null
      }).filter(Boolean),
    })
  }
  if (path === '/api/bookmarks' && method === 'POST') {
    const messageId = String(body.messageId ?? '')
    const existing = w.bookmarks.find((b) => b.userId === user.id && b.messageId === messageId)
    if (body.remove) {
      w.bookmarks = w.bookmarks.filter((b) => b !== existing)
      save()
      return json({ saved: false })
    }
    if (!existing) {
      w.bookmarks.push({ id: uid('bm'), userId: user.id, messageId, note: body.note ?? '', createdAt: nowIso() })
      save()
    }
    return json({ saved: true })
  }
  if (path === '/api/scheduled' && method === 'GET') {
    return json({
      scheduled: w.scheduled
        .filter((r) => r.authorId === user.id && !r.sentAt)
        .map((r) => {
          const chan = w.channels.find((c) => c.id === r.scopeKey.slice(8))
          const convo = w.conversations.find((c) => c.id === r.scopeKey.slice(13))
          const scopeName = r.scopeKey.startsWith('channel:')
            ? (chan?.name ?? 'channel')
            : (convo?.name ?? 'direct message')
          return { id: r.id, scopeKey: r.scopeKey, scopeName, content: r.content, sendAt: r.sendAt, createdAt: r.createdAt }
        }),
    })
  }
  if (path === '/api/scheduled' && method === 'POST') {
    const row = {
      id: uid('sc'), authorId: user.id, scopeKey: String(body.scopeKey ?? ''), content: String(body.content ?? ''),
      sendAt: String(body.sendAt ?? nowIso()), sentAt: null, createdAt: nowIso(),
    }
    w.scheduled.push(row)
    save()
    return json({ scheduled: { id: row.id, scopeKey: row.scopeKey, scopeName: 'somewhere', content: row.content, sendAt: row.sendAt, createdAt: row.createdAt } }, 201)
  }
  if (path === '/api/scheduled' && method === 'DELETE') {
    w.scheduled = w.scheduled.filter((r) => r.id !== body.id)
    save()
    return json({ ok: true })
  }
  if (path === '/api/reminders' && method === 'GET') {
    return json({
      reminders: w.reminders
        .filter((r) => r.userId === user.id && !r.firedAt)
        .map((r) => {
          const m = w.messages.find((x) => x.id === r.messageId)
          return {
            id: r.id, messageId: r.messageId, remindAt: r.remindAt,
            message: {
              id: r.messageId, room: m?.room ?? 'unknown',
              contentPreview: (m?.content ?? '').slice(0, 120) || null,
              authorUsername: userById(m?.authorId ?? '')?.username ?? 'ghost',
            },
          }
        }),
    })
  }
  if (path === '/api/reminders' && method === 'POST') {
    const row = { id: uid('rm'), userId: user.id, messageId: String(body.messageId ?? ''), remindAt: String(body.remindAt ?? nowIso()), firedAt: null, createdAt: nowIso() }
    w.reminders.push(row)
    save()
    return json({ reminder: { id: row.id, messageId: row.messageId, remindAt: row.remindAt } }, 201)
  }
  if (path === '/api/reminders' && method === 'DELETE') {
    w.reminders = w.reminders.filter((r) => r.id !== body.id)
    save()
    return json({ ok: true })
  }

  /* ---------- admin ---------- */
  if (path === '/api/admin/users' && method === 'GET') {
    if (user.role !== 'ADMIN') return err('admins only', 403)
    const q = (currentUrl?.searchParams.get('q') ?? '').toLowerCase()
    return json({
      users: w.users
        .filter((u) => u.username.includes(q))
        .map((u) => ({
          id: u.id, username: u.username, displayName: u.displayName, role: u.role, presence: u.presence,
          avatarUrl: u.avatarUrl, avatarColor: u.avatarColor, bannedUntil: u.bannedUntil ?? null,
          banReason: u.banReason ?? null, createdAt: u.createdAt,
        })),
    })
  }
  if (seg[0] === 'api' && seg[1] === 'admin' && seg[2] === 'users' && seg[4] === 'ban') {
    if (user.role !== 'ADMIN') return err('admins only', 403)
    const target = userById(seg[3])
    if (!target) return err('who?', 404)
    if (method === 'POST') {
      const days = body.days === null || body.days === undefined ? null : Math.min(Number(body.days), 3650)
      target.bannedUntil = days === null ? '2999-12-31T00:00:00.000Z' : new Date(Date.now() + days * 86400000).toISOString()
      target.banReason = String(body.reason ?? '').slice(0, 200) || null
      save()
      return json({ ok: true, bannedUntil: target.bannedUntil })
    }
    if (method === 'DELETE') {
      target.bannedUntil = null
      target.banReason = null
      save()
      return json({ ok: true })
    }
  }

  /* ---------- gifs ---------- */
  if (path === '/api/gifs' && method === 'GET') {
    const q = (currentUrl?.searchParams.get('q') ?? '').trim().toLowerCase()
    const offset = Math.max(0, Math.min(999, Number(currentUrl?.searchParams.get('offset')) || 0))
    if (q) {
      const hits = gifPool.filter((g) => g.title.toLowerCase().includes(q))
      return json({ gifs: hits.slice(offset, offset + 40), provider: 'catalog', more: offset + 40 < hits.length })
    }
    const sample = gifSample()
    return json({
      gifs: sample.slice(offset, offset + 40),
      provider: 'catalog',
      more: offset + 40 < sample.length,
    })
  }

  /* ---------- saved gifs (kept from other people's messages) ---------- */
  if (seg[0] === 'api' && seg[1] === 'gifs' && seg[2] === 'saved') {
    w.savedGifs = w.savedGifs ?? []
    if (method === 'GET') {
      const mine = w.savedGifs
        .filter((g) => g.userId === user.id)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map((g) => ({ id: g.id, url: g.url, title: g.title }))
      return json({ gifs: mine })
    }
    if (method === 'POST') {
      const url2 = String(body.url ?? '')
      if (!/^https?:\/\/\S+$/i.test(url2)) return err('that gif cannot be saved', 400)
      const title = String(body.title ?? 'gif').slice(0, 120) || 'gif'
      const existing = w.savedGifs.find((g) => g.userId === user.id && g.url === url2)
      if (existing) {
        existing.title = title
      } else {
        w.savedGifs.push({ id: uid('gif'), userId: user.id, url: url2, title, createdAt: nowIso() })
      }
      save()
      const row = w.savedGifs.find((g) => g.userId === user.id && g.url === url2)!
      return json({ gif: { id: row.id, url: row.url, title: row.title } })
    }
    if (method === 'DELETE') {
      const target = currentUrl?.searchParams.get('url') ?? ''
      const before = w.savedGifs.length
      w.savedGifs = w.savedGifs.filter((g) => !(g.userId === user.id && g.url === target))
      save()
      if (w.savedGifs.length === before) return err('that gif is not saved', 404)
      return json({ ok: true })
    }
  }

  return err(`the standalone backend does not implement ${method} ${path}`, 404)
}

/* ---------- upload (data URLs, small files only) ---------- */

async function handleUpload(init: RequestInit): Promise<Response> {
  const user = me()
  if (!user) return err('sign in first', 401)
  try {
    const fd = (init.body as FormData) ?? new FormData()
    const file = fd.get('file')
    if (!(file instanceof File)) return err('no file')
    const buf = await file.arrayBuffer()
    if (buf.byteLength > 900_000) return err('the standalone file keeps uploads under 900 KB')
    const url = `data:${file.type || 'application/octet-stream'};base64,${arrayBufferToBase64(buf)}`
    return json({ url, name: file.name, size: buf.byteLength, type: file.type || 'application/octet-stream' }, 201)
  } catch {
    return err('that upload did not work')
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/* ---------- gifs sample (bundled catalog slice) ---------- */

let gifPool: { id: string; url: string; title: string }[] = []

export function registerGifPool(pool: { id: string; url: string; title: string }[]): void {
  gifPool = pool
}

function gifSample(): { id: string; url: string; title: string }[] {
  if (gifPool.length === 0) return []
  const day = Math.floor(Date.now() / 86400000)
  const start = (day * 23) % gifPool.length
  const out: { id: string; url: string; title: string }[] = []
  for (let i = 0; i < Math.min(40, gifPool.length); i++) {
    out.push(gifPool[(start + i) % gifPool.length])
  }
  return out
}

/* ---------- the scheduler (scheduled delivery + sweeps) ---------- */

let schedulerStarted = false

export function startStandaloneScheduler(): void {
  if (schedulerStarted) return
  schedulerStarted = true
  setInterval(() => {
    const w = load()
    const now = nowIso()
    let changed = false

    // deliver due scheduled messages
    for (const row of w.scheduled.filter((r) => !r.sentAt && r.sendAt <= now)) {
      const isChannel = row.scopeKey.startsWith('channel:')
      const id = row.scopeKey.slice(isChannel ? 8 : 13)
      const member = isChannel ? w.members.find((m) => m.userId === row.authorId && m.serverId === w.channels.find((c) => c.id === id)?.serverId) : true
      const participant = !isChannel ? w.participants.find((p) => p.conversationId === id && p.userId === row.authorId) : true
      if (member && participant) {
        const message = {
          id: uid('msg'),
          channelId: isChannel ? id : null,
          serverId: isChannel ? w.channels.find((c) => c.id === id)?.serverId ?? null : null,
          conversationId: isChannel ? null : id,
          authorId: row.authorId, content: row.content, imageUrl: null, attachments: null,
          replyToId: null, createdAt: nowIso(), reactions: [], room: row.scopeKey,
        }
        w.messages.push(message)
        emitMessage(message)
      }
      row.sentAt = nowIso()
      changed = true
    }

    // temporary-message expiry
    const expired = w.messages.filter((m) => m.expiresAt && m.expiresAt <= now)
    if (expired.length) {
      w.messages = w.messages.filter((m) => !expired.includes(m))
      for (const m of expired) busEmit('message:delete', { messageId: m.id })
      changed = true
    }

    // temporary-friendship expiry
    const deadFriendships = w.friendships.filter((f) => f.status === 'ACCEPTED' && f.expiresAt && f.expiresAt <= now)
    if (deadFriendships.length) {
      w.friendships = w.friendships.filter((f) => !deadFriendships.includes(f))
      busEmit('friends:update', {})
      changed = true
    }

    if (changed) save()
  }, 15000)
}

/* ---------- the fetch interceptor ---------- */

let currentInit: RequestInit | undefined
let currentUrl: URL | null = null

export function installStandaloneBackend(): void {
  ensureSeed()
  // resume the session of this browser profile
  try {
    const token = localStorage.getItem('hyperchat-standalone-session')
    if (token) {
      const w = load()
      if (w.sessions[token]) {
        sessionToken = token
        currentUserId = w.sessions[token]
      }
    }
  } catch {
    /* no storage: fresh world each load */
  }
  // persist the token whenever it rotates
  const keepToken = () => {
    try {
      if (sessionToken) localStorage.setItem('hyperchat-standalone-session', sessionToken)
    } catch {
      /* ignore */
    }
  }
  setInterval(keepToken, 2000)

  const realFetch = window.fetch.bind(window)
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const pathOnly = url.split('?')[0]
    if (pathOnly === '/api/upload' && (init?.method ?? 'POST') === 'POST') {
      const res = await handleUpload(init ?? {})
      keepToken()
      return res
    }
    if (pathOnly.startsWith('/api/')) {
      currentInit = init
      try {
        currentUrl = new URL(url, window.location.href)
      } catch {
        currentUrl = null
      }
      const method = (init?.method ?? 'GET').toUpperCase()
      const result = route(method, pathOnly)
      keepToken()
      return result instanceof Response ? result : json(result)
    }
    return realFetch(input as RequestInfo, init)
  }) as typeof fetch

  // everyone in the local world is alive; the store learns them on connect
  const announce = () => {
    const w = load()
    const online = w.users.filter((u) => u.presence !== 'invisible').map((u) => u.id)
    const statuses: Record<string, string> = {}
    const away: Record<string, number> = {}
    for (const u of w.users) {
      statuses[u.id] = u.presence === 'invisible' ? 'offline' : u.presence
      if (u.presence === 'idle') away[u.id] = Date.now() - 6 * 60000
    }
    busEmit('presence:init', { onlineUserIds: online, statuses, awaySince: away })
  }
  setTimeout(announce, 300)
  window.addEventListener('focus', announce)
}
