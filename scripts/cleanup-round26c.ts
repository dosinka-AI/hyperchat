/* Round-26c cleanup: remove this subtask's throwaway accounts (the qa26c*
 *  prefix; the app's usernames are lowercase letters and digits, so no
 *  hyphen). Hard guards (the autobot lesson): real users (blazar,
 *  kkkkwwwaaaa, quasar, autobot) are never touched and must all exist or
 *  the script refuses to run; only usernames matching ^qa26c[0-9a-z]+$
 *  are ever eligible, so a concurrent round-26 agent's throwaways are
 *  never swept; a conversation is only deleted when every participant is
 *  a throwaway; then single-real-participant zero-message shells go too. */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

const THROWAWAY_RE = /^qa26c[0-9a-z]+$/
const REAL = ['blazar', 'kkkkwwwaaaa', 'quasar', 'autobot']

async function main() {
  const real = await db.user.findMany({ where: { username: { in: REAL } }, select: { id: true, username: true } })
  if (real.length !== REAL.length) throw new Error('real user guard failed: refusing to run')
  const realIds = new Set(real.map((u) => u.id))

  const candidates = await db.user.findMany({ where: { username: { startsWith: 'qa26c' } }, select: { id: true, username: true } })
  const users = candidates.filter((u) => THROWAWAY_RE.test(u.username))
  const skipped = candidates.filter((u) => !THROWAWAY_RE.test(u.username))
  if (skipped.length > 0) {
    console.log('refusing (not throwaway-shaped):', skipped.map((u) => u.username).join(',') || '(none)')
  }
  const ids = new Set(users.map((u) => u.id))
  console.log('removing users:', users.map((u) => u.username).join(',') || '(none)')
  if (ids.size === 0) {
    console.log('nothing to remove.')
    return
  }

  // servers owned by throwaways
  const servers = await db.server.findMany({ where: { ownerId: { in: [...ids] } }, select: { name: true } })
  console.log('removing servers:', servers.map((s) => s.name).join(',') || '(none)')
  await db.server.deleteMany({ where: { ownerId: { in: [...ids] } } })

  // conversations whose participants are ALL throwaways
  const convos = await db.conversation.findMany({ include: { participants: { select: { userId: true } }, _count: { select: { messages: true } } } })
  const doomed: string[] = []
  for (const c of convos) {
    if (c.participants.length === 0) continue
    if (c.participants.every((p) => ids.has(p.userId))) doomed.push(c.id)
  }
  console.log('removing conversations (all-throwaway):', doomed.length)
  await db.conversation.deleteMany({ where: { id: { in: doomed } } })

  // the users themselves (messages/reactions/etc cascade)
  await db.user.deleteMany({ where: { id: { in: [...ids] } } })

  // sweep shells: a conversation that now has exactly one (real) participant
  // and zero messages is an empty DM left behind by the throwaway
  const shells = await db.conversation.findMany({
    include: { participants: { select: { userId: true } }, _count: { select: { messages: true } } },
  })
  const shellIds: string[] = []
  for (const c of shells) {
    if (c.participants.length === 1 && c._count.messages === 0 && realIds.has(c.participants[0].userId)) {
      shellIds.push(c.id)
    }
  }
  console.log('removing empty shells:', shellIds.length)
  await db.conversation.deleteMany({ where: { id: { in: shellIds } } })

  const remaining = await db.user.findMany({ select: { username: true } })
  console.log('remaining users:', remaining.map((u) => u.username).join(','))
  const total = await db.message.count()
  console.log('total messages:', total)
  await db.$disconnect()
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
