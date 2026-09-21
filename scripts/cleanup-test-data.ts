// Removes all verification test data, restoring a pristine launch database
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const users = await db.user.findMany({
    select: { id: true, username: true, ownedServers: { select: { id: true, name: true } } },
  })
  console.log('existing users:', users.map((u) => u.username).join(', ') || '(none)')
  for (const u of users) {
    for (const s of u.ownedServers) {
      await db.server.delete({ where: { id: s.id } })
      console.log('deleted server:', s.name)
    }
    await db.user.delete({ where: { id: u.id } })
    console.log('deleted user:', u.username)
  }
  const remaining = await db.user.count()
  const servers = await db.server.count()
  const messages = await db.message.count()
  const convos = await db.conversation.count()
  console.log(`remaining: ${remaining} users, ${servers} servers, ${messages} messages, ${convos} conversations`)
}

main().finally(() => db.$disconnect())
