import { PrismaClient } from '@prisma/client'
const cur = new PrismaClient()
async function main() {
  // remove the wrongly-id'd partial rows created by the failed run
  const badConv = await cur.conversation.findFirst({ where: { participants: { none: {} } } })
  if (badConv) { await cur.conversation.delete({ where: { id: badConv.id } }); console.log('deleted partial convo', badConv.id) }
  const badUser = await cur.user.findFirst({ where: { username: 'autobot' } })
  if (badUser) { await cur.user.delete({ where: { id: badUser.id } }); console.log('deleted partial user', badUser.id) }
  console.log('users now:', (await cur.user.findMany({ select: { username: true } })).map(u => u.username).join(', '))
}
main().catch(e => console.error(e)).finally(() => cur.$disconnect())
