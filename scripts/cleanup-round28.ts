/** Remove throwaway QA users from this round. Guards: exact usernames only. */
const REAL = new Set(['blazar', 'kkkkwwwaaaa', 'quasar', 'autobot'])
const TARGETS = ['qacalla', 'qacallb', 'qa28x', 'qa27bsmoke', 'qa14a1234']
import { db } from '../src/lib/db'

async function main() {
  for (const name of TARGETS) {
    if (REAL.has(name)) throw new Error('refusing to touch ' + name)
    const u = await db.user.findUnique({ where: { username: name }, select: { id: true, username: true } })
    if (!u) { console.log('skip', name, '(missing)'); continue }
    await db.user.delete({ where: { id: u.id } })
    console.log('deleted', name)
  }
  const remaining = await db.user.findMany({ select: { username: true } })
  console.log('remaining users:', remaining.map((r) => r.username).join(', '))
}
void main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
