/** Remove this verification round's test data while preserving real users. */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const testUsernames = ['spacetest1', 'spacetest2']

  const users = await db.user.findMany({ where: { username: { in: testUsernames } }, select: { id: true, username: true } })
  if (users.length === 0) {
    console.log('no test users found')
    return
  }
  const ids = users.map((u) => u.id)

  // their servers
  const servers = await db.server.findMany({ where: { ownerId: { in: ids } }, select: { id: true, name: true } })
  for (const s of servers) {
    await db.server.delete({ where: { id: s.id } })
    console.log('deleted server', s.name)
  }

  // DM conversations involving them
  const convos = await db.conversation.findMany({
    where: { participants: { some: { userId: { in: ids } } } },
    select: { id: true },
  })
  for (const c of convos) {
    await db.conversation.delete({ where: { id: c.id } })
    console.log('deleted conversation', c.id)
  }

  // friendships
  await db.friendship.deleteMany({ where: { OR: [{ requesterId: { in: ids } }, { addresseeId: { in: ids } }] } })

  // the users themselves (cascades: messages, bookmarks, scheduled, reminders, memberships, blocks, read states, mutes)
  for (const u of users) {
    await db.user.delete({ where: { id: u.id } })
    console.log('deleted user', u.username)
  }

  const remaining = await db.user.count()
  const remainingServers = await db.server.count()
  const remainingMessages = await db.message.count()
  console.log(`final state: ${remaining} users, ${remainingServers} servers, ${remainingMessages} messages`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
