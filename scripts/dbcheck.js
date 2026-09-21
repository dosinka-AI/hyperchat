// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient()
async function main() {
  const users = await p.user.findMany({ select: { username: true, role: true } })
  console.log('USERS:', JSON.stringify(users))
  console.log('SERVERS:', await p.server.count())
  console.log('MESSAGES:', await p.message.count())
  console.log('CONVERSATIONS:', await p.conversation.count())
  await p.$disconnect()
}
main().catch((e) => { console.error(e.message); process.exit(1) })
