import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { db } from '@/lib/db'
import { hashPassword, setSessionCookie, createSessionToken, USERNAME_RE, EMAIL_RE } from '@/lib/auth'
import { checkEmailDeliverable } from '@/lib/email'

// Grayscale identity palette: avatars stay monochrome, profile pictures add the color
const AVATAR_COLORS = [
  '#e8e8e8', '#c9c9c9', '#a8a8a8', '#8a8a8a', '#6e6e6e',
  '#565656', '#424242', '#333333', '#262626', '#f5f5f5',
]

/** Device-level signup counter. When a browser has already made one account,
 *  every further signup silently requires an email (no explanation shown —
 *  the field is simply there and required, per product decision). */
const REG_COUNT_COOKIE = 'hc_accounts_made'
const ONE_YEAR = 60 * 60 * 24 * 365

function pickColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0
  }
  const idx = Math.abs(h) % AVATAR_COLORS.length
  return AVATAR_COLORS[idx]
}

const USER_SELECT = {
  id: true,
  username: true,
  email: true,
  emailVerifiedAt: true,
  displayName: true,
  avatarUrl: true,
  avatarColor: true,
  bio: true,
  role: true,
  siteAdmin: true,
  customStatus: true,
  pronouns: true,
  presence: true,
  bannerColor: true,
  bannerUrl: true,
  createdAt: true,
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    if (!USERNAME_RE.test(username)) {
      return NextResponse.json(
        { error: 'Username must be 3 to 20 characters: lowercase letters, numbers, underscores.' },
        { status: 400 }
      )
    }
    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
    }

    // Device gate: a browser that already created an account must provide an
    // email for every further one. The UI learns this from /api/auth/register-hint
    // so the field is shown upfront; here it is enforced server-side.
    const store = await cookies()
    const priorAccounts = Number(store.get(REG_COUNT_COOKIE)?.value ?? '0') || 0
    const emailRequired = priorAccounts > 0

    if (emailRequired && !email) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })
    }

    if (email) {
      if (!EMAIL_RE.test(email)) {
        return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })
      }
      const deliverable = await checkEmailDeliverable(email)
      if (deliverable) {
        return NextResponse.json({ error: deliverable }, { status: 400 })
      }
      const existingEmail = await db.user.findUnique({ where: { email } })
      if (existingEmail) {
        return NextResponse.json({ error: 'An account with that email already exists.' }, { status: 409 })
      }
    }

    const existingName = await db.user.findUnique({ where: { username } })
    if (existingName) {
      return NextResponse.json({ error: 'That username is taken.' }, { status: 409 })
    }

    // The first account ever registered runs the whole site: it gets ADMIN.
    const userCount = await db.user.count()
    const role = userCount === 0 ? 'ADMIN' : 'USER'

    const user = await db.user.create({
      data: {
        username,
        email: email || null,
        passwordHash: await hashPassword(password),
        avatarColor: pickColor(username),
        role,
        // the first account on a fresh install owns the admin panel too
        siteAdmin: userCount === 0,
      },
      select: USER_SELECT,
    })

    await setSessionCookie({ id: user.id, username: user.username })
    // count this device's signup so the next one demands an email
    store.set(REG_COUNT_COOKIE, String(priorAccounts + 1), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: ONE_YEAR,
    })

    // the raw token goes back for the client-side account switcher vault
    const token = await createSessionToken({ id: user.id, username: user.username })
    return NextResponse.json({ user, token }, { status: 201 })
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
