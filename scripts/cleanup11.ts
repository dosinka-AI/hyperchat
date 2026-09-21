import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()

async function main() {
  const u = await db.user.findUnique({ where: { username: 'e2e11x' } })
  if (!u) { console.log('e2e11x already gone'); return }
  // their DM with blazar
  const convos = await db.conversationParticipant.findMany({ where: { userId: u.id }, select: { conversationId: true } })
  for (const c of convos) {
    const others = await db.conversationParticipant.findMany({ where: { conversationId: c.conversationId, userId: { not: u.id } } })
    // only delete conversations that would be empty without them (the fresh DM)
    if (others.length === 0) {
      await db.message.deleteMany({ where: { conversationId: c.conversationId } })
      await db.conversation.delete({ where: { id: c.conversationId } }).catch(() => {})
      console.log('deleted empty conversation', c.conversationId)
    } else if (others.length === 1) {
      // 1:1 DM created by the test: remove it entirely
      await db.message.deleteMany({ where: { conversationId: c.conversationId } })
      await db.conversation.delete({ where: { id: c.conversationId } }).catch(() => {})
      console.log('deleted test DM', c.conversationId)
    }
  }
  // their messages anywhere (cascade would also do it, but be explicit)
  await db.message.deleteMany({ where: { authorId: u.id } })
  await db.reminder.deleteMany({ where: { userId: u.id } })
  await db.user.delete({ where: { id: u.id } })
  console.log('e2e11x deleted')
  const remaining = await db.user.findMany({ select: { username: true } })
  console.log('users left:', remaining.map((r) => r.username).join(', '))
  const sys = await db.message.count({ where: { systemKind: { not: null } } })
  console.log('system rows left (should be 0):', sys)
}

main().finally(() => db.$disconnect())
