import { PrismaClient } from '@prisma/client'
const cur = new PrismaClient()
async function main() {
  const convs = await cur.conversation.findMany({ select: { id: true, kind: true, name: true, createdAt: true } })
  for (const c of convs) {
    const p = await cur.conversationParticipant.count({ where: { conversationId: c.id } })
    const m = await cur.message.count({ where: { conversationId: c.id } })
    console.log(`${c.id} ${c.kind}:${c.name || '-'} created=${c.createdAt.toISOString().slice(0,16)} parts=${p} msgs=${m}`)
  }
}
main().finally(() => cur.$disconnect())
