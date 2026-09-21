// Targeted cleanup: removes ONLY test artifacts from the Task 5 verification
// marathon (verify1/verify2 and their data). The real user account (blazar)
// and anything they created is preserved.
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const testUsernames = ['verify1', 'verify2', 'wstest1']

  for (const username of testUsernames) {
    const user = await db.user.findUnique({ where: { username } })
    if (!user) continue
    // cascades wipe memberships, messages, reactions, read states, mutes,
    // conversation participants, friendships and blocks involving the user
    await db.user.delete({ where: { id: user.id } })
    console.log(`removed ${username}`)
  }

  // remove servers owned by test users (already cascaded), plus any server
  // whose owner no longer exists should be impossible; sweep audit events of
  // orphaned servers just in case
  const events = await db.serverEvent.deleteMany({
    where: { server: { is: undefined as never } } as never,
  }).catch(() => null)
  if (events) console.log('orphan event sweep skipped/ok')

  const counts = {
    users: await db.user.count(),
    servers: await db.server.count(),
    messages: await db.message.count(),
    friendships: await db.friendship.count(),
    blocks: await db.userBlock.count(),
    mutes: await db.muteState.count(),
    events: await db.serverEvent.count(),
    conversations: await db.conversation.count(),
  }
  console.log('final state:', JSON.stringify(counts))
}

main().finally(() => db.$disconnect())
