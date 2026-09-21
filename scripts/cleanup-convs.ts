import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  await db.conversation.deleteMany({})
  const convos = await db.conversation.count()
  const messages = await db.message.count()
  const users = await db.user.count()
  console.log(`final state: ${users} users, ${convos} conversations, ${messages} messages`)
}
main().finally(() => db.$disconnect())
