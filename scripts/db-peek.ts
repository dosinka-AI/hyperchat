import { PrismaClient } from '@prisma/client'
const url = process.argv[2]
const db = new PrismaClient({ datasources: { db: { url } } })
async function main() {
  const users = await db.user.findMany({ select: { id: true, username: true, displayName: true, role: true, email: true, createdAt: true } })
  console.log('USERS:', users.map(u => `${u.username}(${u.id.slice(0,8)},${u.role})`).join(', '))
  const servers = await db.server.findMany({ select: { id: true, name: true, ownerId: true } })
  console.log('SERVERS:', servers.map(s => `${s.name}(${s.id.slice(0,8)},owner=${s.ownerId.slice(0,8)})`).join(', '))
  const convos = await db.conversation.findMany({ select: { id: true, kind: true, name: true, ownerId: true } })
  console.log('CONVOS:', convos.map(c => `${c.kind}:${c.name||'unnamed'}(${c.id.slice(0,8)},owner=${c.ownerId?.slice(0,8)||'-'})`).join(', '))
  for (const c of convos) {
    const parts = await db.conversationParticipant.findMany({ where: { conversationId: c.id }, select: { userId: true } })
    const names = parts.map(p => users.find(u => u.id === p.userId)?.username || p.userId.slice(0,8))
    console.log(`CONVO ${c.kind}:${c.name||c.id.slice(0,8)} [${c.id.slice(0,8)}] participants: ${names.join(', ')}`)
  }
  console.log('TOTAL MESSAGES:', await db.message.count())
  const bot = users.find(u => /autobot/i.test(u.username))
  if (bot) {
    const botMsgs = await db.message.findMany({ where: { authorId: bot.id }, orderBy: { createdAt: 'asc' }, select: { id: true, channelId: true, conversationId: true, content: true, createdAt: true } })
    console.log('AUTOBOT MSG COUNT:', botMsgs.length)
    for (const m of botMsgs.slice(0, 80)) console.log(`  [${m.channelId?.slice(0,8)||m.conversationId?.slice(0,8)||'-'}] ${new Date(m.createdAt).toISOString().slice(11,19)} ${(m.content||'').slice(0,70).replace(/\n/g,' ')}`)
  }
}
main().catch(e => console.error('ERR', e.message)).finally(() => db.$disconnect())
