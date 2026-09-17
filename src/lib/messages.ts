import { randomBytes } from 'crypto'
import { db } from '@/lib/db'
import type { ClientMessage, MessageAttachment, ReactionGroup } from '@/lib/types'

// in-memory per-user window for the marker payload; the swap itself always
// applies, the celebration at most once per user every 10 minutes
const markerWindow = new Map<string, number>()
const MARKER_COOLDOWN_MS = 10 * 60_000

/** Swap the hidden token for its marker form. Returns the cleaned content
 *  and whether this send may celebrate (rate-limited per user). */
export function applyMarkerSwap(content: string, userId: string): { content: string; celebrate: boolean } {
  const TOKEN = ':fniger:'
  if (!content.toLowerCase().includes(TOKEN)) return { content, celebrate: false }
  const swapped = content.replace(/:fniger:/gi, '???')
  const now = Date.now()
  const last = markerWindow.get(userId) ?? -Infinity
  const celebrate = now - last >= MARKER_COOLDOWN_MS
  if (celebrate) markerWindow.set(userId, now)
  return { content: swapped, celebrate }
}

/** Parse the attachments JSON column; malformed data degrades to null. */
export function parseAttachments(raw: string | null | undefined): MessageAttachment[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    return parsed
      .filter((a): a is MessageAttachment =>
        !!a && typeof a.url === 'string' && typeof a.name === 'string')
      .map((a) => {
        const out: MessageAttachment = {
          url: a.url,
          name: a.name,
          size: typeof a.size === 'number' ? a.size : 0,
          mime: typeof a.mime === 'string' ? a.mime : 'application/octet-stream',
        }
        // voice-note payload rides along only on voice attachments
        if (a.kind === 'voice') {
          out.kind = 'voice'
          if (typeof a.duration === 'number' && Number.isFinite(a.duration)) {
            out.duration = a.duration
          }
          if (Array.isArray(a.waveform)) {
            const bars = a.waveform.filter((v) => typeof v === 'number' && Number.isFinite(v))
            if (bars.length > 0) out.waveform = bars
          }
        }
        return out
      })
  } catch {
    return null
  }
}

/** Validate + serialize the request-body attachments into the JSON column. */
export function normalizeAttachments(input: unknown): string | null {
  if (!Array.isArray(input) || input.length === 0) return null
  const cleaned = input
    .filter((a): a is MessageAttachment =>
      !!a && typeof a === 'object' &&
      typeof a.url === 'string' && a.url.startsWith('/api/files/') && a.url.length < 200 &&
      typeof a.name === 'string' && a.name.length > 0 && a.name.length <= 120)
    .slice(0, 5)
    .map((a) => {
      const out: MessageAttachment = {
        url: a.url,
        name: a.name,
        size: typeof a.size === 'number' && Number.isFinite(a.size) ? Math.max(0, Math.min(a.size, 50 * 1024 * 1024)) : 0,
        mime: typeof a.mime === 'string' && a.mime.length <= 80 ? a.mime : 'application/octet-stream',
      }
      // voice-note payload: kept only on voice attachments, clamped so the
      // column can never carry junk
      if (a.kind === 'voice') {
        out.kind = 'voice'
        if (typeof a.duration === 'number' && Number.isFinite(a.duration)) {
          out.duration = Math.max(0, Math.min(a.duration, 600))
        }
        if (Array.isArray(a.waveform)) {
          const bars = a.waveform
            .filter((v) => typeof v === 'number' && Number.isFinite(v))
            .slice(0, 40)
            .map((v) => Math.max(0, Math.min(100, Math.round(v))))
          if (bars.length > 0) out.waveform = bars
        }
      }
      return out
    })
  return cleaned.length > 0 ? JSON.stringify(cleaned) : null
}

/** Reaction rows carry their stamps when the query selects them, so the
 *  chip order can be made deterministic even where Prisma forbids array
 *  orderBy on nested relations. */
type ReactionRow = { emoji: string; userId: string; createdAt?: Date; id?: string }

type MessageWithAuthor = {
  id: string
  content: string | null
  imageUrl: string | null
  attachments: string | null
  createdAt: Date
  editedAt: Date | null
  pinned: boolean
  pinnedAt: Date | null
  pingsEveryone?: boolean
  whisperTargetId?: string | null
  whisperTargetName?: string | null
  systemKind?: string | null
  systemData?: string | null
  replyToId: string | null
  threadOfId?: string | null
  forwardedFromName?: string | null
  editHistory?: string | null
  authorId: string
  author: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    avatarColor: string
  }
  reactions?: ReactionRow[]
  replyTo?: {
    id: string
    authorId: string
    content: string | null
    imageUrl: string | null
    author: { id: string; username: string; displayName: string | null }
  } | null
}

/** Per-server decoration applied to channel messages: nicknames and role colors. */
export type AuthorDecorator = (authorId: string) => { nickname: string | null; roleColor: string | null }

/** Load a decorator for every member of a server (nicknames + custom role colors). */
export async function serverAuthorDecorator(serverId: string): Promise<AuthorDecorator> {
  const members = await db.serverMember.findMany({
    where: { serverId },
    select: { userId: true, nickname: true, customRole: { select: { color: true } } },
  })
  const map = new Map<string, { nickname: string | null; roleColor: string | null }>()
  for (const m of members) {
    map.set(m.userId, { nickname: m.nickname, roleColor: m.customRole?.color ?? null })
  }
  return (authorId) => map.get(authorId) ?? { nickname: null, roleColor: null }
}

export function groupReactions(rows: ReactionRow[] | undefined): ReactionGroup[] {
  if (!rows || rows.length === 0) return []
  // oldest reaction first (createdAt, id as the last-resort tiebreak): the
  // chip row reads left-to-right as first-used order, so a freshly added
  // reaction always lands on the right edge. Each group carries the per-user
  // stamps aligned with userIds, so hover lists can show who reacted when
  const sorted = [...rows].sort((a, b) => {
    if (a.createdAt && b.createdAt) {
      const d = a.createdAt.getTime() - b.createdAt.getTime()
      if (d !== 0) return d
    }
    if (a.id && b.id) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    return 0
  })
  const groups = new Map<string, { userIds: string[]; at: string[] }>()
  for (const r of sorted) {
    const list = groups.get(r.emoji) ?? { userIds: [], at: [] }
    list.userIds.push(r.userId)
    list.at.push(r.createdAt ? r.createdAt.toISOString() : new Date(0).toISOString())
    groups.set(r.emoji, list)
  }
  return Array.from(groups.entries()).map(([emoji, g]) => ({ emoji, userIds: g.userIds, at: g.at }))
}

/** Parse the edit-history JSON column; malformed data degrades to null. */
function parseEditHistory(raw: string | null | undefined): { content: string; at: string }[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const out: { content: string; at: string }[] = []
    for (const v of parsed) {
      if (!!v && typeof v === 'object' && typeof (v as { content?: unknown }).content === 'string' && typeof (v as { at?: unknown }).at === 'string') {
        out.push({ content: (v as { content: string }).content, at: (v as { at: string }).at })
      }
    }
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

export function toClientMessage(msg: MessageWithAuthor, room: string, decorate?: AuthorDecorator): ClientMessage {
  const decoration = decorate?.(msg.authorId) ?? { nickname: null, roleColor: null }
  let systemData: ClientMessage['systemData'] = null
  if (msg.systemData) {
    try {
      const parsed = JSON.parse(msg.systemData)
      if (parsed && typeof parsed === 'object') {
        systemData = {
          messageId: typeof parsed.messageId === 'string' ? parsed.messageId : undefined,
          byUsername: typeof parsed.byUsername === 'string' ? parsed.byUsername : undefined,
        }
      }
    } catch {
      systemData = null
    }
  }
  return {
    id: msg.id,
    content: msg.content,
    imageUrl: msg.imageUrl,
    attachments: parseAttachments(msg.attachments),
    createdAt: msg.createdAt.toISOString(),
    editedAt: msg.editedAt ? msg.editedAt.toISOString() : null,
    pinned: msg.pinned,
    pinnedAt: msg.pinnedAt ? msg.pinnedAt.toISOString() : null,
    pingsEveryone: msg.pingsEveryone ?? false,
    whisperTargetId: msg.whisperTargetId ?? null,
    whisperTargetName: msg.whisperTargetName ?? null,
    systemKind: (msg.systemKind === 'pin' || msg.systemKind === 'unpin') ? msg.systemKind : null,
    systemData,
    replyToId: msg.replyToId ?? null,
    replyTo: msg.replyTo
      ? {
          id: msg.replyTo.id,
          authorId: msg.replyTo.authorId,
          authorUsername: msg.replyTo.author.username,
          authorDisplayName: msg.replyTo.author.displayName,
          contentPreview: (msg.replyTo.content ?? '').slice(0, 120) || null,
          hasImage: !!msg.replyTo.imageUrl,
        }
      : null,
    threadOfId: msg.threadOfId ?? null,
    forwardedFromName: msg.forwardedFromName ?? null,
    editHistory: parseEditHistory(msg.editHistory),
    authorId: msg.authorId,
    author: {
      id: msg.author.id,
      username: msg.author.username,
      displayName: msg.author.displayName,
      avatarUrl: msg.author.avatarUrl,
      avatarColor: msg.author.avatarColor,
    },
    authorNickname: decoration.nickname,
    authorRoleColor: decoration.roleColor,
    room,
    reactions: groupReactions(msg.reactions),
  }
}

/** Oldest reactions first (createdAt carries ms from the reaction route, id
 *  breaks exact ties): the chip row is ordered by first use, so the client's
 *  append-right always matches the server truth. Kept in a mutable-typed
 *  constant because Prisma's include expects a writable orderBy array. */
const REACTIONS_INCLUDE: { select: { emoji: true; userId: true; createdAt: true; id: true }; orderBy: { createdAt: 'asc' } } = {
  select: { emoji: true, userId: true, createdAt: true, id: true },
  orderBy: { createdAt: 'asc' },
}

/** The standard author include used by every message query. */
export const AUTHOR_INCLUDE = {
  author: {
    select: { id: true, username: true, displayName: true, avatarUrl: true, avatarColor: true },
  },
  reactions: REACTIONS_INCLUDE,
  replyTo: {
    select: {
      id: true,
      authorId: true,
      content: true,
      imageUrl: true,
      author: { select: { id: true, username: true, displayName: true } },
    },
  },
} as const

/** Detect an @everyone or @here ping in a message body. */
export function containsMassMention(content: string): boolean {
  return /(^|\s)@(everyone|here)(?=\s|$)/i.test(content)
}

export function generateInviteCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(8)
  let code = ''
  for (let i = 0; i < 8; i++) {
    code += alphabet[bytes[i] % alphabet.length]
  }
  return code
}

export function normalizeChannelName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

/** Validate a reply reference: it must point at a message in the same room.
 *  Returns the id when valid, null otherwise (replies degrade gracefully). */
export async function validReplyToId(
  replyToId: unknown,
  scope: { channelId?: string; conversationId?: string }
): Promise<string | null> {
  if (typeof replyToId !== 'string' || !replyToId) return null
  try {
    const target = await db.message.findUnique({
      where: { id: replyToId },
      select: { channelId: true, conversationId: true },
    })
    if (!target) return null
    if (scope.channelId && target.channelId !== scope.channelId) return null
    if (scope.conversationId && target.conversationId !== scope.conversationId) return null
    return replyToId
  } catch {
    return null
  }
}

export async function fetchMessages(
  where: { channelId?: string; conversationId?: string },
  room: string,
  before?: string,
  limit = 50,
  after?: string,
  decorate?: AuthorDecorator
) {
  // unscoped variant: whisper rows are simply hidden from the listing
  return fetchMessagesScoped(where, room, before, limit, after, decorate, null)
}

/** Full variant: pass the requesting user id so whisper rows scoped to them
 *  (or authored by them) are included while everyone else's stay hidden. */
export async function fetchMessagesFor(
  meId: string | null,
  where: { channelId?: string; conversationId?: string },
  room: string,
  before?: string,
  limit = 50,
  after?: string,
  decorate?: AuthorDecorator
) {
  return fetchMessagesScoped(where, room, before, limit, after, decorate, meId)
}

async function fetchMessagesScoped(
  where: { channelId?: string; conversationId?: string },
  room: string,
  before?: string,
  limit = 50,
  after?: string,
  decorate?: AuthorDecorator,
  meId?: string | null
) {
  // thread rows only render inside the thread panel: the main feed never shows them
  const mainFeed = { ...where, threadOfId: null }
  const scope =
    !meId
      ? mainFeed
      : {
          ...mainFeed,
          OR: [{ whisperTargetId: null }, { whisperTargetId: meId }, { authorId: meId }],
        }
  if (after) {
    // incremental tail fetch used by the sync fallback
    const messages = await db.message.findMany({
      where: {
        ...scope,
        createdAt: { gt: new Date(after) },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: AUTHOR_INCLUDE,
    })
    const listed = messages.map((m) => toClientMessage(m, room, decorate))
    await attachThreadInfo(listed)
    return {
      messages: listed,
      hasMore: false as boolean,
      oldestCursor: null as string | null,
    }
  }

  const messages = await db.message.findMany({
    where: {
      ...scope,
      ...(before ? { createdAt: { lt: new Date(before) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    include: AUTHOR_INCLUDE,
  })

  const hasMore = messages.length > limit
  const page = hasMore ? messages.slice(0, limit) : messages
  const listed = page.reverse().map((m) => toClientMessage(m, room, decorate))
  await attachThreadInfo(listed)
  return {
    messages: listed,
    hasMore,
    oldestCursor: page.length ? page[0].createdAt.toISOString() : null,
  }
}

/** Stamp thread bars on the root messages of a loaded page: reply counts
 *  plus the last few distinct participants, so the bar can show faces. */
export async function attachThreadInfo(messages: ClientMessage[]): Promise<void> {
  type ThreadFace = NonNullable<ClientMessage['threadUsers']>[number]
  const rootIds = messages.filter((m) => !m.threadOfId && !m.systemKind).map((m) => m.id)
  if (rootIds.length === 0) return
  const rows = await db.message.findMany({
    where: { threadOfId: { in: rootIds } },
    orderBy: { createdAt: 'asc' },
    select: {
      threadOfId: true,
      authorId: true,
      author: { select: { id: true, username: true, displayName: true, avatarUrl: true, avatarColor: true } },
    },
  })
  if (rows.length === 0) return
  const counts = new Map<string, number>()
  const participants = new Map<string, Map<string, ThreadFace>>()
  for (const r of rows) {
    const root = r.threadOfId!
    counts.set(root, (counts.get(root) ?? 0) + 1)
    let list = participants.get(root)
    if (!list) {
      list = new Map()
      participants.set(root, list)
    }
    if (!list.has(r.author.id)) list.set(r.author.id, r.author)
  }
  for (const m of messages) {
    const count = counts.get(m.id)
    if (!count) continue
    m.threadCount = count
    const list = participants.get(m.id)
    if (list) {
      // newest participants first (insertion order is oldest-first)
      m.threadUsers = Array.from(list.values()).slice(-3).reverse()
    }
  }
}

/** Load a whole thread: the root row plus every reply under it. Access is
 *  checked by the route, this helper only fetches. */
export async function fetchThread(
  rootId: string,
  meId: string | null,
  decorate?: AuthorDecorator
): Promise<{ root: ClientMessage; messages: ClientMessage[] } | null> {
  const root = await db.message.findUnique({ where: { id: rootId }, include: AUTHOR_INCLUDE })
  if (!root) return null
  if (root.threadOfId) {
    // someone asked for a thread of a thread: serve the actual root instead
    return fetchThread(root.threadOfId, meId, decorate)
  }
  const room = root.channelId ? `channel:${root.channelId}` : root.conversationId ? `conversation:${root.conversationId}` : ''
  const scope =
    !meId
      ? {}
      : { OR: [{ whisperTargetId: null }, { whisperTargetId: meId }, { authorId: meId }] }
  const replies = await db.message.findMany({
    where: { threadOfId: rootId, ...scope },
    orderBy: { createdAt: 'asc' },
    take: 200,
    include: AUTHOR_INCLUDE,
  })
  return {
    root: toClientMessage(root, room, decorate),
    messages: replies.map((m) => toClientMessage(m, room, decorate)),
  }
}

/** Window of main-feed messages centered on an anchor id, for permalink
 *  jumps deep into history. Returns null when the anchor is missing,
 *  belongs to another room, is a thread row, or is a whisper the caller
 *  cannot see. hasNewer tells the client a jump-to-present bar is owed. */
export async function fetchMessagesAround(
  meId: string | null,
  where: { channelId?: string; conversationId?: string },
  anchorId: string,
  room: string,
  half = 12,
  decorate?: AuthorDecorator
): Promise<{ messages: ClientMessage[]; hasMore: boolean; hasNewer: boolean; oldestCursor: string | null } | null> {
  const anchor = await db.message.findUnique({
    where: { id: anchorId },
    select: { id: true, createdAt: true, channelId: true, conversationId: true, threadOfId: true, whisperTargetId: true, authorId: true },
  })
  if (!anchor) return null
  if (where.channelId && anchor.channelId !== where.channelId) return null
  if (where.conversationId && anchor.conversationId !== where.conversationId) return null
  if (anchor.threadOfId) return null
  if (anchor.whisperTargetId && anchor.whisperTargetId !== meId && anchor.authorId !== meId) return null

  const base: { channelId?: string; conversationId?: string; threadOfId: null } = { ...where, threadOfId: null }
  const scope = !meId
    ? base
    : {
        ...base,
        OR: [{ whisperTargetId: null }, { whisperTargetId: meId }, { authorId: meId }],
      }

  const [olderRaw, newerRaw, anchorFull] = await Promise.all([
    db.message.findMany({
      where: { ...scope, createdAt: { lt: anchor.createdAt } },
      orderBy: { createdAt: 'desc' },
      take: half + 1,
      include: AUTHOR_INCLUDE,
    }),
    db.message.findMany({
      where: { ...scope, createdAt: { gt: anchor.createdAt } },
      orderBy: { createdAt: 'asc' },
      take: half + 1,
      include: AUTHOR_INCLUDE,
    }),
    db.message.findUnique({ where: { id: anchorId }, include: AUTHOR_INCLUDE }),
  ])
  if (!anchorFull) return null

  const hasMore = olderRaw.length > half
  const hasNewer = newerRaw.length > half
  const windowRows = [...olderRaw.slice(0, half).reverse(), anchorFull, ...newerRaw.slice(0, half)]
  const listed = windowRows.map((m) => toClientMessage(m, room, decorate))
  await attachThreadInfo(listed)
  return {
    messages: listed,
    hasMore,
    hasNewer,
    oldestCursor: windowRows.length ? windowRows[0].createdAt.toISOString() : null,
  }
}

/** Rich-text tokens ([c=#hex]...[/c] color, [s=px]...[/s] size) are
 *  free in dms and group chats but mod-gated in servers. Channel senders
 *  without the rich formatting permission keep their words and lose the
 *  styling: the tokens unwrap, the body text stays. */
export function stripRichTokens(content: string): string {
  return content
    .replace(/\[c=#?[0-9a-fA-F]{3,8}\]((?:[^[]|\[(?!\/c\]))*?)\[\/c\]/gi, '$1')
    .replace(/\[s=\d{1,2}\]((?:[^[]|\[(?!\/s\]))*?)\[\/s\]/gi, '$1')
}
