/* Surgical restore of the autobot account + its conversations + server messages
 * from git snapshot 90f2648 (db/custom.db @ 14:41, before the round-22 sweep).
 * All rows keep their ORIGINAL ids so cross-references survive. */
import { PrismaClient } from '@prisma/client'

const old = new PrismaClient({ datasources: { db: { url: 'file:/tmp/db-90f2648.db' } } })
const cur = new PrismaClient()

async function main() {
  const bot = await old.user.findUniqueOrThrow({ where: { username: 'autobot' } })
  // 1. the account (original id, full row incl. passwordHash)
  if (!(await cur.user.findUnique({ where: { id: bot.id } }))) {
    await cur.user.create({ data: { ...bot, messages: undefined } as any })
    console.log('✔ user autobot restored', bot.id)
  }
  // 2. friendships
  const frs = await old.friendship.findMany({ where: { OR: [{ requesterId: bot.id }, { addresseeId: bot.id }] } })
  for (const fr of frs) {
    if (await cur.friendship.findUnique({ where: { id: fr.id } })) continue
    if (!await cur.user.findUnique({ where: { id: fr.requesterId } }) || !await cur.user.findUnique({ where: { id: fr.addresseeId } })) continue
    await cur.friendship.create({ data: fr as any })
    console.log('✔ friendship restored', fr.status)
  }
  // 3. conversations + participants
  const convIds = ['cmtza3xl', 'cmtzayuv']
  const oldConvs = (await old.conversation.findMany()).filter(c => convIds.some(p => c.id.startsWith(p)))
  const dmConv = oldConvs.find(c => c.id.startsWith('cmtza3xl'))!
  for (const c of oldConvs) {
    if (await cur.conversation.findUnique({ where: { id: c.id } })) { console.log('· convo exists', c.id); continue }
    const data: any = { ...c }
    if (c.ownerId && !await cur.user.findUnique({ where: { id: c.ownerId } })) data.ownerId = null
    await cur.conversation.create({ data })
    console.log('✔ conversation restored', c.kind, c.name, c.id)
    const parts = await old.conversationParticipant.findMany({ where: { conversationId: c.id } })
    for (const p of parts) {
      if (!await cur.user.findUnique({ where: { id: p.userId } })) continue
      await cur.conversationParticipant.create({ data: p as any })
      console.log('  ✔ participant', p.userId.slice(0, 8), 'hidden=', p.hidden)
    }
    // 4. messages in chronological order (replyTo/threadOf FKs resolve)
    const msgs = await old.message.findMany({ where: { conversationId: c.id }, orderBy: { createdAt: 'asc' } })
    let n = 0
    for (const m of msgs) {
      if (await cur.message.findUnique({ where: { id: m.id } })) continue
      await cur.message.create({ data: m as any })
      n++
    }
    console.log(`✔ ${n} messages restored into ${c.kind}:${c.name}`)
  }
  // 5. autobot's server-channel messages
  const serverMsgs = await old.message.findMany({ where: { authorId: bot.id, channelId: { not: null } }, orderBy: { createdAt: 'asc' } })
  let sn = 0
  for (const m of serverMsgs) {
    if (await cur.message.findUnique({ where: { id: m.id } })) continue
    if (!await cur.channel.findUnique({ where: { id: m.channelId! } })) { console.log('  · skip (channel gone)', m.channelId); continue }
    await cur.message.create({ data: m as any })
    sn++
  }
  console.log(`✔ ${sn} server messages restored`)
  // 6. reactions: by autobot + on restored messages
  const dmMsgIds = (await old.message.findMany({ where: { conversationId: dmConv.id }, select: { id: true } })).map(m => m.id)
  const allRx = [...await old.reaction.findMany({ where: { userId: bot.id } }), ...await old.reaction.findMany({ where: { messageId: { in: dmMsgIds } } })]
  for (const r of allRx) {
    if (await cur.reaction.findUnique({ where: { id: r.id } })) continue
    if (!await cur.message.findUnique({ where: { id: r.messageId } })) continue
    if (!await cur.user.findUnique({ where: { id: r.userId } })) continue
    await cur.reaction.create({ data: r as any })
    console.log('✔ reaction restored on', r.messageId.slice(0, 8))
  }
  // 7. bookmarks on restored messages
  const bms = await old.bookmark.findMany({ where: { messageId: { in: dmMsgIds } } })
  for (const b of bms) {
    if (await cur.bookmark.findUnique({ where: { id: b.id } })) continue
    if (!await cur.user.findUnique({ where: { id: b.userId } })) continue
    if (!await cur.message.findUnique({ where: { id: b.messageId } })) continue
    await cur.bookmark.create({ data: b as any })
    console.log('✔ bookmark restored')
  }
  // 8. autobot read states for surviving rooms
  const rs = await old.readState.findMany({ where: { userId: bot.id } })
  for (const r of rs) {
    if (await cur.readState.findUnique({ where: { id: r.id } })) continue
    if (r.channelId && !await cur.channel.findUnique({ where: { id: r.channelId } })) continue
    if (r.conversationId && !await cur.conversation.findUnique({ where: { id: r.conversationId } })) continue
    await cur.readState.create({ data: r as any })
    console.log('✔ readState restored')
  }
  // VERIFY
  console.log('=== VERIFY ===')
  console.log('autobot exists:', !!(await cur.user.findUnique({ where: { id: bot.id } })))
  console.log('autobot messages:', await cur.message.count({ where: { authorId: bot.id } }), '(expected 70 incl. 6 server)')
  console.log('DM messages:', await cur.message.count({ where: { conversationId: dmConv.id } }), '(expected 133)')
  const grp = oldConvs.find(c => c.kind === 'GROUP')!
  console.log('GROUP convo exists:', !!(await cur.conversation.findUnique({ where: { id: grp.id } })), '| participants:', await cur.conversationParticipant.count({ where: { conversationId: grp.id } }))
  console.log('DM participants:', await cur.conversationParticipant.count({ where: { conversationId: dmConv.id } }))
  console.log('friendship:', await cur.friendship.count({ where: { requesterId: bot.id } }))
}
main().catch(e => { console.error('RESTORE FAILED:', e.message); process.exit(1) }).finally(async () => { await old.$disconnect(); await cur.$disconnect() })
