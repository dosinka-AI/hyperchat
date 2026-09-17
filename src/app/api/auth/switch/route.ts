import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifySessionToken, setSessionCookie, createSessionToken } from '@/lib/auth'

/** Account switcher endpoint: the client keeps raw session tokens in its
 *  local vault (returned by login/register). Switching hands a token back,
 *  we re-validate it against the DB (bans, existence) and mint it as the
 *  active session cookie. Returns the fresh snapshot so the vault can
 *  update its cached profile info. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const token = typeof body.token === 'string' ? body.token : ''
    if (!token) return NextResponse.json({ error: 'Missing account token.' }, { status: 400 })

    const userId = await verifySessionToken(token)
    if (!userId) {
      return NextResponse.json({ error: 'That saved login expired. Sign in again.' }, { status: 401 })
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        email: true,
        emailVerifiedAt: true,
        displayName: true,
        avatarUrl: true,
        avatarColor: true,
        bio: true,
        role: true,
        customStatus: true,
        pronouns: true,
        presence: true,
        bannerColor: true,
        bannerUrl: true,
        bannedUntil: true,
        banReason: true,
        createdAt: true,
      },
    })
    if (!user) {
      return NextResponse.json({ error: 'That account no longer exists.' }, { status: 401 })
    }
    if (user.bannedUntil && user.bannedUntil.getTime() > Date.now()) {
      return NextResponse.json({ error: 'This account is suspended.' }, { status: 403 })
    }

    await setSessionCookie({ id: user.id, username: user.username })
    const refreshed = await createSessionToken({ id: user.id, username: user.username })
    const { bannedUntil: _bu, banReason: _br, ...snapshot } = user
    return NextResponse.json({ user: snapshot, token: refreshed })
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
