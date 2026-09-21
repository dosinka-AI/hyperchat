/* Remove the round-24-e throwaway accounts and ONLY what they solely owned.
 * Hard guard: real users (blazar, kkkkwwwaaaa, quasar, autobot) are never
 * touched. Accounts are only deleted when the username matches
 * ^qa24e[0-9]+$, so nothing else can ever be swept. Conversations go only
 * when every participant is a throwaway or the round-24 qa helper account
 * (qa24a), and at least one participant is a throwaway, so the real DMs and
 * the restored autobot group are structurally untouchable. */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

const THROWAWAY_RE = /^qa24e[0-9]+$/
const REAL = ['blazar', 'kkkkwwwaaaa', 'quasar', 'autobot']
/** round-24 qa helper account (not a real user; created for this QA round) */
const QA_HELPER = ['qa24a']

async function main() {
  const real = await db.user.findMany({ where: { username: { in: REAL } }, select: { id: true, username: true } })
  const realIds = new Set(real.map((u) => u.id))
  console.log('guard: real users present =', real.map((u) => u.username).join(','))
  if (real.length !== REAL.length) {
    throw new Error('real user guard failed: refusing to run')
  }

  const candidates = await db.user.findMany({
    where: { username: { startsWith: 'qa24e' } },
    select: { id: true, username: true },
  })
  const users = candidates.filter((u) => THROWAWAY_RE.test(u.username))
  const ids = new Set(users.map((u) => u.id))
  console.log('removing:', users.map((u) => u.username).join(',') || '(none)')

  const helpers = await db.user.findMany({ where: { username: { in: QA_HELPER } }, select: { id: true } })
  const okIds = new Set([...ids, ...helpers.map((h) => h.id)])

  if (ids.size === 0) {
    console.log('nothing to remove; done.')
    return
  }

  // servers owned by them (they own none, but guard anyway)
  const servers = await db.server.findMany({ where: { ownerId: { in: [...ids] } }, select: { name: true } })
  console.log('removing servers:', servers.map((s) => s.name))
  await db.server.deleteMany({ where: { ownerId: { in: [...ids] } } })

  // conversations whose participants are all throwaway/qa24a (their DM);
  // any conversation involving a real user can never match
  const convos = await db.conversation.findMany({
    include: { participants: { select: { userId: true } } },
  })
  const doomed: string[] = []
  for (const c of convos) {
    const parts = c.participants.map((p) => p.userId)
    if (parts.length > 0 && parts.some((p) => ids.has(p)) && parts.every((p) => okIds.has(p))) doomed.push(c.id)
  }
  console.log('removing conversations (throwaway/helper only):', doomed.length)
  for (const id of doomed) {
    const c = await db.conversation.findUnique({ where: { id }, select: { kind: true, name: true } })
    console.log('  -', c?.kind, c?.name ?? id.slice(0, 8))
  }
  await db.conversation.deleteMany({ where: { id: { in: doomed } } })

  // their messages anywhere (the test rows in real rooms, if any)
  const msgs = await db.message.count({ where: { authorId: { in: [...ids] } } })
  console.log('removing their messages:', msgs)
  await db.message.deleteMany({ where: { authorId: { in: [...ids] } } })

  // reactions, bookmarks, saved gifs, friendships, read states, mutes
  await db.reaction.deleteMany({ where: { userId: { in: [...ids] } } })
  await db.bookmark.deleteMany({ where: { userId: { in: [...ids] } } })
  await db.savedGif.deleteMany({ where: { userId: { in: [...ids] } } })
  await db.friendship.deleteMany({ where: { OR: [{ requesterId: { in: [...ids] } }, { addresseeId: { in: [...ids] } }] } })
  await db.readState.deleteMany({ where: { userId: { in: [...ids] } } })
  await db.muteState.deleteMany({ where: { userId: { in: [...ids] } } })
  await db.reminder.deleteMany({ where: { userId: { in: [...ids] } } })
  await db.scheduledMessage.deleteMany({ where: { authorId: { in: [...ids] } } })
  await db.userBlock.deleteMany({ where: { OR: [{ blockerId: { in: [...ids] } }, { blockedId: { in: [...ids] } }] } })

  // the accounts
  await db.user.deleteMany({ where: { id: { in: [...ids] } } })

  // VERIFY the real data survived
  const remaining = await db.user.findMany({ select: { username: true } })
  console.log('remaining users:', remaining.map((u) => u.username).sort().join(','))
  for (const gone of REAL) {
    if (!remaining.some((u) => u.username === gone)) throw new Error(`REAL USER ${gone} WAS DELETED - INVESTIGATE`)
  }
  const bot = await db.user.findUnique({ where: { username: 'autobot' } })
  console.log('autobot msgs:', bot ? await db.message.count({ where: { authorId: bot.id } }) : 'GONE!')
  const grp = await db.conversation.findFirst({ where: { name: 'furry wife discussion' } })
  console.log('group intact:', !!grp, '| participants:', grp ? await db.conversationParticipant.count({ where: { conversationId: grp.id } }) : 0)
  console.log('total messages:', await db.message.count())
  void realIds
}
main().catch((e) => { console.error('CLEANUP FAILED', e); process.exit(1) }).finally(() => db.$disconnect())
