import { hash } from 'bcryptjs'
import { db } from './db'

/**
 * Cherry-picked alpha mode (SEED_DEMO=true): on the first boot of an empty
 * database, create three fixed-credential tester accounts so the deployed
 * alpha is immediately usable - hand "tester1 / hyperion-alpha" to anyone
 * and they are chatting a minute later.
 *
 * Deliberately insecure by design (fixed password, documented in DEPLOY.md):
 * this exists for tester convenience only. Leave SEED_DEMO unset for a clean
 * slate where the first registered account becomes ADMIN.
 */

export const DEMO_PASSWORD = 'hyperion-alpha'

const DEMO_USERS = [
  { username: 'tester1', displayName: 'tester one' },
  { username: 'tester2', displayName: 'tester two' },
  { username: 'tester3', displayName: 'tester three' },
]

// mirrors AVATAR_COLORS + pickColor in the register route so demo accounts
// look exactly like natively registered ones (grayscale identity palette)
const AVATAR_COLORS = [
  '#e8e8e8', '#c9c9c9', '#a8a8a8', '#8a8a8a', '#6e6e6e',
  '#565656', '#424242', '#333333', '#262626', '#f5f5f5',
]

function pickColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0
  }
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

export async function seedDemoAccounts(): Promise<void> {
  // never touch a database that already has users: real data always wins,
  // so a long-running alpha that outgrows the demo accounts keeps them intact
  const userCount = await db.user.count()
  if (userCount > 0) {
    console.log(`[seed] ${userCount} account(s) already exist; skipping demo seed`)
    return
  }

  // same cost (10 rounds) as hashPassword in lib/auth, duplicated here so
  // instrumentation never has to import next/headers through that module
  const passwordHash = await hash(DEMO_PASSWORD, 10)

  for (const [index, user] of DEMO_USERS.entries()) {
    try {
      await db.user.create({
        data: {
          username: user.username,
          displayName: user.displayName,
          passwordHash,
          avatarColor: pickColor(user.username),
          // the first account on a fresh database becomes ADMIN, exactly
          // like the first registration through the UI
          role: index === 0 ? 'ADMIN' : 'USER',
        },
      })
    } catch {
      // serverless instances can race the seed on simultaneous cold starts:
      // losing the race just means the account already exists, which is
      // exactly the goal here
    }
  }
  console.log(`[seed] demo tester accounts ready: tester1..tester3 / ${DEMO_PASSWORD}`)
}
