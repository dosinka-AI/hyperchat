import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
async function main() {
  const users = await db.user.findMany({ select: { id: true, username: true, displayName: true, role: true, email: true } })
  console.log('USERS:', JSON.stringify(users.map(u => ({ id: u.id.slice(0,8), u: u.username, dn: u.displayName, role: u.role })), null, 1))
  const servers = await db.server.findMany({ select: { id: true, name: true } })
  console.log('SERVERS:', JSON.stringify(servers.map(s => ({ id: s.id.slice(0,8), name: s.name }))))
  const channels = await db.channel.findMany({ select: { id: true, name: true, type: true } })
  console.log('CHANNELS:', JSON.stringify(channels.map(c => ({ id: c.id.slice(0,8), name: c.name, type: c.type }))))
  console.log('TOTAL MESSAGES:', await db.message.count())
  console.log('GROUP MSGS:', await db.message.count({ where: { channel: { type: 'GROUP' } } }))
  console.log('GROUP CHATS:', await db.conversation.count({ where: { type: 'GROUP' } }))
  console.log('DM CHATS:', await db.conversation.count({ where: { type: 'DIRECT' } }))
  const convs = await db.conversation.findMany({ select: { id: true, type: true, name: true } })
  console.log('CONVOS:', JSON.stringify(convs.map(c => ({ id: c.id.slice(0,8), type: c.type, name: c.name }))))
}
main().catch(e => console.error(e.message)).finally(() => db.$disconnect())
