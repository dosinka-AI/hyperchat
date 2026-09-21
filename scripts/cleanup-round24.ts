/* Round-24 final cleanup: remove the qa24a/qa24b/qa24c throwaway accounts
 * and ONLY what they solely owned. Hard guard (the autobot lesson): real
 * users (blazar, kkkkwwwaaaa, quasar, autobot) are never touched, and a
 * conversation is only deleted when EVERY participant is a qa24 throwaway. */
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

const THROWAWAY_RE = /^qa24[a-z]?[0-9]*$/
const REAL = ['blazar', 'kkkkwwwaaaa', 'quasar', 'autobot']

async function main() {
  const real = await db.user.findMany({ where: { username: { in: REAL } }, select: { id: true, username: true } })
  if (real.length !== REAL.length) throw new Error('real user guard failed: refusing to run')
  const realIds = new Set(real.map((u) => u.id))

  const candidates = await db.user.findMany({
    where: { username: { startsWith: 'qa24' } },
    select: { id: true, username: true },
  })
  const users = candidates.filter((u) => THROWAWAY_RE.test(u.username))
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

  // conversations whose participants are ALL throwaways (their DMs, the
  // round-24 test group). Anything involving a real user never matches.
  const convos = await db.conversation.findMany({ include: { participants: { select: { userId: true } } } })
  const doomed: string[] = []
  for (const c of convos) {
    if (c.participants.length === 0) continue
    const allThrowaway = c.participants.every((p) => ids.has(p.userId))
    if (allThrowaway) doomed.push(c.id)
  }
  console.log('removing conversations:', doomed.length)
  await db.conversation.deleteMany({ where: { id: { in: doomed } } })

  // the users themselves (messages/reactions/etc cascade)
  await db.user.deleteMany({ where: { id: { in: [...ids] } } })

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
