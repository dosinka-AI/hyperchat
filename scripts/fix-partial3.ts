import { PrismaClient } from '@prisma/client'
const cur = new PrismaClient()
async function main() {
  await cur.conversation.delete({ where: { id: 'cmtzze08u0002p6dq6kxtjlze' } })
  console.log('partial convo deleted')
}
main().finally(() => cur.$disconnect())
