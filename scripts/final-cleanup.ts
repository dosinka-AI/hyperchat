// Final cleanup: remove leftover verification users/servers, keep real data
// (blazar, kkkkwwwaaaa, "test server"). Idempotent - safe to re-run.
import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'
import path from 'node:path'

const db = new PrismaClient()

const TEST_USERNAMES = ['verifyone', 'verifytwo', 'quasar', 'e2efinal', 'e2efinalb']
const TEST_SERVER_NAMES = ['Verification HQ', 'E2E Final Lab']

async function main() {
  const users = await db.user.findMany({
    where: { username: { in: TEST_USERNAMES } },
    include: {
      ownedServers: true,
      memberships: true,
      messages: { select: { attachments: true, imageUrl: true } },
    },
  })

  // collect upload urls to delete from disk
  const urls: string[] = []
  const parseAtt = (raw: string | null): { url: string }[] => {
    if (!raw) return []
    try {
      const v = JSON.parse(raw)
      return Array.isArray(v) ? v : []
    } catch {
      return []
    }
  }
  for (const u of users) {
    for (const m of u.messages) {
      if (m.imageUrl) urls.push(m.imageUrl)
      for (const a of parseAtt(m.attachments)) if (a?.url) urls.push(a.url)
    }
    if (u.avatarUrl) urls.push(u.avatarUrl)
    if (u.bannerUrl) urls.push(u.bannerUrl)
  }

  const servers = await db.server.findMany({
    where: { name: { in: TEST_SERVER_NAMES } },
    include: {
      channels: { include: { messages: { select: { attachments: true, imageUrl: true } } } },
    },
  })
  for (const s of servers) {
    for (const c of s.channels) {
      for (const m of c.messages) {
        if (m.imageUrl) urls.push(m.imageUrl)
        for (const a of parseAtt(m.attachments)) if (a?.url) urls.push(a.url)
      }
    }
    if (s.iconUrl) urls.push(s.iconUrl)
  }

  // delete DB rows (order matters for FKs; channels+messages cascade)
  for (const s of servers) {
    await db.serverEvent.deleteMany({ where: { serverId: s.id } })
    await db.serverBan.deleteMany({ where: { serverId: s.id } })
    await db.role.deleteMany({ where: { serverId: s.id } })
    await db.channelCategory.deleteMany({ where: { serverId: s.id } })
    await db.serverMember.deleteMany({ where: { serverId: s.id } })
    await db.channel.deleteMany({ where: { serverId: s.id } })
    await db.server.delete({ where: { id: s.id } })
    console.log(`deleted server: ${s.name}`)
  }

  for (const u of users) {
    await db.message.deleteMany({ where: { authorId: u.id } })
    await db.readState.deleteMany({ where: { userId: u.id } })
    await db.conversationParticipant.deleteMany({ where: { userId: u.id } })
    await db.friendship.deleteMany({ where: { OR: [{ requesterId: u.id }, { addresseeId: u.id }] } })
    await db.userBlock.deleteMany({ where: { OR: [{ blockerId: u.id }, { blockedId: u.id }] } })
    await db.serverMember.deleteMany({ where: { userId: u.id } })
    await db.reaction.deleteMany({ where: { userId: u.id } })
    await db.bookmark.deleteMany({ where: { userId: u.id } })
    await db.reminder.deleteMany({ where: { userId: u.id } })
    await db.scheduledMessage.deleteMany({ where: { authorId: u.id } })
    await db.server.deleteMany({ where: { ownerId: u.id } })
    await db.user.delete({ where: { id: u.id } })
    console.log(`deleted user: ${u.username}`)
  }

  // delete orphan uploads on disk
  let removed = 0
  for (const url of urls) {
    const m = url.match(/\/([^/?]+)$/)
    if (!m) continue
    const p = path.join(process.cwd(), 'uploads', path.basename(m[1]))
    if (fs.existsSync(p)) {
      fs.unlinkSync(p)
      removed++
    }
  }

  // orphan conversations (zero participants)
  const orphans = await db.conversation.findMany({
    include: { _count: { select: { participants: true } } },
  })
  for (const c of orphans) {
    if (c._count.participants === 0) {
      await db.message.deleteMany({ where: { conversationId: c.id } })
      await db.conversation.delete({ where: { id: c.id } })
      console.log(`deleted orphan conversation ${c.id}`)
    }
  }

  console.log(`uploads removed: ${removed}`)
  const [uc, sc, mc] = await Promise.all([
    db.user.count(),
    db.server.count(),
    db.message.count(),
  ])
  console.log(`FINAL: ${uc} users, ${sc} servers, ${mc} messages`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
