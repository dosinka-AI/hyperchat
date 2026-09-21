import { PrismaClient } from '@prisma/client'
const old = new PrismaClient({ datasources: { db: { url: 'file:/tmp/db-90f2648.db' } } })
const cur = new PrismaClient()
async function main() {
  const botOld = await old.user.findFirst({ where: { username: 'autobot' } })
  if (!botOld) throw new Error('no autobot in old db')
  console.log('autobot id:', botOld.id)
  // conversations to restore
  const convIds = ['cmtza3xl', 'cmtzayuv'] // will match by prefix
  const oldConvs = await old.conversation.findMany({})
  const targets = oldConvs.filter(c => convIds.some(p => c.id.startsWith(p)))
  console.log('old conversations to restore:', targets.map(c => `${c.kind}:${c.name}(${c.id})`))
  for (const c of targets) {
    const msgs = await old.message.findMany({ where: { conversationId: c.id }, select: { id: true, authorId: true, createdAt: true } })
    const curMsgs = await cur.message.findMany({ where: { conversationId: c.id }, select: { id: true } })
    console.log(`  convo ${c.id}: old msgs=${msgs.length} cur msgs=${curMsgs.length} authors=${[...new Set(msgs.map(m=>m.authorId))].join(',')}`)
  }
  // autobot server messages
  const botServerMsgs = await old.message.findMany({ where: { authorId: botOld.id, channelId: { not: null } }, select: { id: true, channelId: true } })
  console.log('autobot server-channel msgs:', botServerMsgs.map(m => `${m.id.slice(0,8)}@${m.channelId.slice(0,8)}`).join(', '))
  for (const ch of [...new Set(botServerMsgs.map(m => m.channelId!))]) {
    const curCh = await cur.channel.findFirst({ where: { id: { startsWith: ch.slice(0,8) } }, select: { id: true, name: true } })
    console.log(`  channel ${ch} still exists in cur:`, curCh ? `${curCh.id} (${curCh.name})` : 'NO')
  }
  // check cur messages by these old msg ids
  const allOldMsgIds = botServerMsgs.map(m => m.id)
  const existing = await cur.message.findMany({ where: { id: { in: allOldMsgIds } }, select: { id: true } })
  console.log('autobot server msgs still in cur:', existing.length)
  // reactions by autobot / on autobot msgs
  const rxByBot = await old.reaction.findMany({ where: { userId: botOld.id }, select: { id: true, messageId: true } })
  console.log('reactions BY autobot in old:', rxByBot.length)
  // friendships involving autobot
  const fr = await old.friendship.findMany({ where: { OR: [{ requesterId: botOld.id }, { addresseeId: botOld.id }] }, select: { id: true, status: true } })
  console.log('friendships involving autobot in old:', fr.map(f => `${f.id.slice(0,8)}:${f.status}`).join(', '))
  // readstates/mutes for autobot
  console.log('readstates autobot:', await old.readState.count({ where: { userId: botOld.id } }))
  console.log('saved gifs autobot:', await old.savedGif.count({ where: { userId: botOld.id } }))
  // does cur have autobot? and do target convos exist in cur?
  console.log('cur has autobot:', !!(await cur.user.findFirst({ where: { username: 'autobot' } })))
  for (const c of targets) {
    console.log('cur has convo', c.id.slice(0,8), ':', !!(await cur.conversation.findFirst({ where: { id: c.id } })))
  }
  // group convo messages detail: authors breakdown
  const grp = targets.find(t => t.kind === 'GROUP')!
  const grpMsgs = await old.message.findMany({ where: { conversationId: grp.id }, orderBy: { createdAt: 'asc' }, select: { id: true, authorId: true, content: true, createdAt: true } })
  const users = await old.user.findMany({ select: { id: true, username: true } })
  for (const m of grpMsgs) console.log(`  GRP ${new Date(m.createdAt).toISOString().slice(11,19)} ${users.find(u=>u.id===m.authorId)?.username}: ${(m.content||'').slice(0,60).replace(/\n/g,' ')}`)
}
main().catch(e => console.error('ERR', e)).finally(async () => { await old.$disconnect(); await cur.$disconnect() })
