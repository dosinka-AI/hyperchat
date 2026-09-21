/* Remove the e2e13 throwaway accounts and everything they touched.
 * Never touches blazar / kkkkwwwaaaa / quasar. */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const names = ['e2e13a', 'e2e13b']
const users = await db.user.findMany({ where: { username: { in: names } }, select: { id: true, username: true } })
const ids = users.map((u) => u.id)
console.log('removing users:', users.map((u) => u.username))

// servers owned by them (cascade wipes channels, categories, roles, events, memberships, bans)
const servers = await db.server.findMany({ where: { ownerId: { in: ids } }, select: { id: true, name: true } })
console.log('removing servers:', servers.map((s) => s.name))
await db.server.deleteMany({ where: { id: { in: servers.map((s) => s.id) } } })

// their messages anywhere (reactions cascade), saved gifs, friendships, blocks,
// bookmarks, reminders, scheduled, read states, mutes, conversations
await db.message.deleteMany({ where: { authorId: { in: ids } } })
await db.savedGif.deleteMany({ where: { userId: { in: ids } } })
await db.friendship.deleteMany({ where: { OR: [{ requesterId: { in: ids } }, { addresseeId: { in: ids } }] } })
await db.userBlock.deleteMany({ where: { OR: [{ blockerId: { in: ids } }, { blockedId: { in: ids } }] } })
await db.bookmark.deleteMany({ where: { userId: { in: ids } } })
await db.reminder.deleteMany({ where: { userId: { in: ids } } })
await db.scheduledMessage.deleteMany({ where: { authorId: { in: ids } } })
await db.readState.deleteMany({ where: { userId: { in: ids } } })
await db.muteState.deleteMany({ where: { userId: { in: ids } } })

// conversations they participated in (groups + DMs; cascades participants + messages)
const convos = await db.conversation.findMany({
  where: { participants: { some: { userId: { in: ids } } } },
  select: { id: true },
})
console.log('removing conversations:', convos.length)
await db.conversation.deleteMany({ where: { id: { in: convos.map((c) => c.id) } } })

// reactions they left on other people's messages
await db.reaction.deleteMany({ where: { userId: { in: ids } } })

// the accounts themselves (sessions cascade via token? they are cookie JWTs, stateless)
await db.user.deleteMany({ where: { id: { in: ids } } })

const remaining = await db.user.findMany({ select: { username: true } })
console.log('remaining users:', remaining.map((u) => u.username))
await db.$disconnect()
