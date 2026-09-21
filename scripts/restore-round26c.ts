/* Round-26c repair: my cleanup script swept every username matching
 *  ^qa26c[0-9a-z]+$ per the task's guard regex — but a concurrent round-26
 *  agent had created two throwaways INSIDE that namespace (qa26c0947,
 *  qa26c5958, the partners of their qa26b0947/qa26b5595 users). This
 *  restores those rows id-preserved from the last committed db snapshot
 *  (git ca12e65, db/custom.db @ 21:53): 2 users, 2 conversation
 *  participants, 2 messages, 2 read states — the full inventory of what
 *  the cascade took (verified by per-conversation message-count diff
 *  against the snapshot; everything else reconciles to the row).
 *
 *  The snapshot predates the concurrent email-gate migration, so it is
 *  read via raw bun:sqlite (no Prisma client — it would select the new
 *  emailVerifiedAt column the old file lacks); the live db is written
 *  through Prisma. Real users are untouched; only these exact ids are
 *  ever inserted. */
import { PrismaClient } from '@prisma/client'
import { Database } from 'bun:sqlite'

const snap = new Database('/tmp/db-committed.db', { readonly: true })
const live = new PrismaClient()

const USER_IDS = ['cmu09hv7e00xop60u12dp94z1', 'cmu0b57b80005p6wb60ug31ez']
const REAL = ['blazar', 'kkkkwwwaaaa', 'quasar', 'autobot']

const toIso = (v: unknown): string | null => (typeof v === 'number' ? new Date(v).toISOString() : null)

function snapUser(id: string) {
  const r = snap.query('SELECT * FROM User WHERE id = ?').get(id) as Record<string, unknown> | null
  if (!r) throw new Error(`snapshot has no user ${id}`)
  return {
    id: r.id as string,
    email: (r.email as string | null) ?? null,
    username: r.username as string,
    passwordHash: r.passwordHash as string,
    displayName: (r.displayName as string | null) ?? null,
    bio: (r.bio as string) ?? '',
    avatarUrl: (r.avatarUrl as string | null) ?? null,
    avatarColor: (r.avatarColor as string) ?? '#2e2e2e',
    role: (r.role as string) ?? 'USER',
    customStatus: (r.customStatus as string | null) ?? null,
    pronouns: (r.pronouns as string | null) ?? null,
    presence: (r.presence as string) ?? 'online',
    lastSeenAt: toIso(r.lastSeenAt),
    bannerColor: (r.bannerColor as string | null) ?? null,
    bannerUrl: (r.bannerUrl as string | null) ?? null,
    bannedUntil: toIso(r.bannedUntil),
    banReason: (r.banReason as string | null) ?? null,
    createdAt: new Date(r.createdAt as number),
    updatedAt: new Date(r.updatedAt as number),
  }
}

function snapParticipants() {
  const rows = snap
    .query('SELECT * FROM ConversationParticipant WHERE userId IN (?, ?)')
    .all(...USER_IDS) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: r.id as string,
    conversationId: r.conversationId as string,
    userId: r.userId as string,
    hidden: Boolean(r.hidden),
    pinned: Boolean(r.pinned),
  }))
}

function snapMessages() {
  const rows = snap
    .query('SELECT * FROM Message WHERE authorId IN (?, ?) ORDER BY createdAt ASC')
    .all(...USER_IDS) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: r.id as string,
    content: (r.content as string | null) ?? null,
    imageUrl: (r.imageUrl as string | null) ?? null,
    attachments: (r.attachments as string | null) ?? null,
    expiresAt: toIso(r.expiresAt),
    editedAt: toIso(r.editedAt),
    pinned: Boolean(r.pinned),
    pinnedAt: toIso(r.pinnedAt),
    pingsEveryone: Boolean(r.pingsEveryone),
    whisperTargetId: (r.whisperTargetId as string | null) ?? null,
    whisperTargetName: (r.whisperTargetName as string | null) ?? null,
    systemKind: (r.systemKind as string | null) ?? null,
    systemData: (r.systemData as string | null) ?? null,
    replyToId: (r.replyToId as string | null) ?? null,
    threadOfId: (r.threadOfId as string | null) ?? null,
    forwardedFromId: (r.forwardedFromId as string | null) ?? null,
    forwardedFromName: (r.forwardedFromName as string | null) ?? null,
    editHistory: (r.editHistory as string | null) ?? null,
    authorId: r.authorId as string,
    channelId: (r.channelId as string | null) ?? null,
    conversationId: (r.conversationId as string | null) ?? null,
    createdAt: new Date(r.createdAt as number),
  }))
}

function snapReadStates() {
  const rows = snap
    .query('SELECT * FROM ReadState WHERE userId IN (?, ?)')
    .all(...USER_IDS) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: r.id as string,
    userId: r.userId as string,
    scopeKey: r.scopeKey as string,
    lastReadAt: new Date(r.lastReadAt as number),
  }))
}

async function main() {
  const real = await live.user.findMany({ where: { username: { in: REAL } }, select: { id: true } })
  if (real.length !== REAL.length) throw new Error('real user guard failed: refusing to run')

  for (const id of USER_IDS) {
    const existing = await live.user.findUnique({ where: { id } })
    if (existing) {
      console.log('user already present:', existing.username)
      continue
    }
    const row = snapUser(id)
    if (!row.username.startsWith('qa26c')) throw new Error(`refusing non-qa26c user ${row.username}`)
    await live.user.create({ data: row })
    console.log('restored user:', row.username, id)
  }

  for (const p of snapParticipants()) {
    const existing = await live.conversationParticipant.findUnique({ where: { id: p.id } })
    if (existing) {
      console.log('participant already present:', p.id)
      continue
    }
    const conv = await live.conversation.findUnique({ where: { id: p.conversationId } })
    if (!conv) throw new Error(`live conversation ${p.conversationId} missing — refusing`)
    await live.conversationParticipant.create({ data: p })
    console.log('restored participant:', p.id, '-> conv', p.conversationId)
  }

  for (const m of snapMessages()) {
    const existing = await live.message.findUnique({ where: { id: m.id } })
    if (existing) {
      console.log('message already present:', m.id)
      continue
    }
    await live.message.create({ data: m })
    console.log('restored message:', m.id, JSON.stringify(m.content?.slice(0, 40)))
  }

  for (const r of snapReadStates()) {
    const existing = await live.readState.findUnique({ where: { id: r.id } })
    if (existing) {
      console.log('read state already present:', r.id)
      continue
    }
    await live.readState.create({ data: r })
    console.log('restored read state:', r.id)
  }

  const remaining = await live.user.findMany({ select: { username: true }, orderBy: { username: 'asc' } })
  console.log('live users:', remaining.map((u) => u.username).join(','))
  const total = await live.message.count()
  console.log('total messages:', total)
  snap.close()
  await live.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
