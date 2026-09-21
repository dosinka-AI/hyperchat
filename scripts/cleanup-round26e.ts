/**
 * Round 26-e cleanup (voice messages + gif ordering QA).
 *
 * GUARDED: only usernames matching ^qa26e[0-9a-z]+$ are ever deleted, and
 * conversations only when EVERY participant is such a throwaway. The real
 * users (blazar, kkkkwwwaaaa, quasar, autobot) are asserted present before
 * and after; any unexpected user is left untouched and reported.
 */
import { db } from '../src/lib/db'
import { readdir, unlink } from 'fs/promises'
import path from 'path'

const THROWAWAY = /^qa26e[0-9a-z]+$/
const REAL_USERS = ['blazar', 'kkkkwwwaaaa', 'quasar', 'autobot']

async function main() {
  const before = await db.user.findMany({ select: { username: true } })
  const beforeNames = before.map((u) => u.username).sort()
  console.log('users before:', beforeNames.join(', '))

  for (const name of REAL_USERS) {
    if (!beforeNames.includes(name)) throw new Error(`real user missing: ${name}`)
  }

  // 1. conversations whose every participant is a throwaway (none expected:
  //    the QA ran in a server channel, but keep the rule as the guard)
  const convos = await db.conversation.findMany({
    select: { id: true, participants: { select: { user: { select: { username: true } } } } },
  })
  for (const c of convos) {
    const names = c.participants.map((p) => p.user.username)
    if (names.length > 0 && names.every((n) => THROWAWAY.test(n))) {
      await db.conversation.delete({ where: { id: c.id } })
      console.log(`deleted conversation ${c.id} (${names.join(', ')})`)
    }
  }

  // 2. throwaway users (their servers, channels, messages, saved gifs and
  //    read states cascade from the user delete)
  const doomed = before.filter((u) => THROWAWAY.test(u.username))
  for (const u of doomed) {
    await db.user.delete({ where: { username: u.username } })
    console.log(`deleted user ${u.username}`)
  }

  // 3. orphaned upload files: uploads referenced by no message attachment
  //    (round 26-e QA webm blobs + the interrupted first attempt's blobs)
  const rows = await db.message.findMany({ select: { attachments: true } })
  const referenced = new Set<string>()
  for (const r of rows) {
    if (!r.attachments) continue
    try {
      const parsed = JSON.parse(r.attachments) as { url?: string }[]
      for (const a of parsed) {
        if (a.url?.startsWith('/api/files/')) referenced.add(a.url.slice('/api/files/'.length))
      }
    } catch {
      /* malformed row: leave it alone */
    }
  }
  const files = await readdir(path.join(process.cwd(), 'uploads')).catch(() => [] as string[])
  for (const f of files) {
    if (f.endsWith('.webm') && !referenced.has(f)) {
      await unlink(path.join(process.cwd(), 'uploads', f)).catch(() => {})
      console.log(`deleted orphaned upload ${f}`)
    }
  }

  const after = await db.user.findMany({ select: { username: true } })
  const afterNames = after.map((u) => u.username).sort()
  console.log('users after:', afterNames.join(', '))
  for (const name of REAL_USERS) {
    if (!afterNames.includes(name)) throw new Error(`REAL USER LOST: ${name}`)
  }
  const leftovers = afterNames.filter((n) => THROWAWAY.test(n))
  if (leftovers.length) throw new Error(`throwaways left behind: ${leftovers.join(', ')}`)
  console.log('cleanup ok')
}

main()
  .catch((e) => {
    console.error('CLEANUP FAILED:', e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
