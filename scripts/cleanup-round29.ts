/** Round 29 QA cleanup: remove the throwaway accounts qa29x1/qa29x2 and
 *  everything they created. Refuses to touch anything else. */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()
const THROWAWAYS = ['qa29x1', 'qa29x2']

async function main() {
  for (const username of THROWAWAYS) {
    if (!/^qa29x[0-9]$/.test(username)) throw new Error(`refusing to delete ${username}`)
  }
  const before = {
    users: await db.user.count(),
    posts: await db.post.count(),
    stories: await db.story.count(),
    follows: await db.follow.count(),
    messages: await db.message.count(),
  }
  for (const username of THROWAWAYS) {
    const user = await db.user.findUnique({ where: { username }, select: { id: true } })
    if (!user) { console.log(`(absent: ${username})`); continue }
    await db.user.delete({ where: { id: user.id } })
    console.log(`deleted ${username} (cascades: posts, comments, likes, stories, follows, conversations)`)
  }
  const after = {
    users: await db.user.count(),
    posts: await db.post.count(),
    stories: await db.story.count(),
    follows: await db.follow.count(),
    messages: await db.message.count(),
  }
  console.log('users', before.users, '->', after.users)
  console.log('posts', before.posts, '->', after.posts)
  console.log('stories', before.stories, '->', after.stories)
  console.log('follows', before.follows, '->', after.follows)
  console.log('messages', before.messages, '->', after.messages)
  const remaining = await db.user.findMany({ select: { username: true } })
  console.log('remaining users:', remaining.map((u) => u.username).sort().join(', '))
}

main()
  .catch((err) => { console.error(err); process.exit(1) })
  .finally(() => db.$disconnect())
