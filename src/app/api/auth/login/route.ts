import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword, setSessionCookie, createSessionToken } from '@/lib/auth'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const identifier = typeof body.identifier === 'string' ? body.identifier.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    if (!identifier || !password) {
      return NextResponse.json({ error: 'Enter your email or username and password.' }, { status: 400 })
    }

    const user = await db.user.findFirst({
      where: { OR: [{ email: identifier }, { username: identifier }] },
      include: { siteBan: { select: { reason: true } } },
    })
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return NextResponse.json({ error: 'Wrong credentials. Check your login and password.' }, { status: 401 })
    }

    // site ban (Task 6-c): a UserBan row means the account is suspended —
    // no new session, no token minted
    if (user.siteBan) {
      return NextResponse.json(
        {
          error: 'account suspended',
          reason: user.siteBan.reason ?? null,
        },
        { status: 403 }
      )
    }

    // suspended accounts cannot start a new session
    if (user.bannedUntil && user.bannedUntil.getTime() > Date.now()) {
      return NextResponse.json(
        {
          error: 'This account is suspended.',
          reason: user.banReason ?? null,
          until: user.bannedUntil.toISOString(),
        },
        { status: 403 }
      )
    }

    await setSessionCookie({ id: user.id, username: user.username })
    // raw token for the client-side account switcher vault
    const token = await createSessionToken({ id: user.id, username: user.username })
    return NextResponse.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        emailVerifiedAt: user.emailVerifiedAt,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        avatarColor: user.avatarColor,
        bio: user.bio,
        role: user.role,
        siteAdmin: user.siteAdmin,
        customStatus: user.customStatus,
        pronouns: user.pronouns,
        presence: user.presence,
        bannerColor: user.bannerColor,
        bannerUrl: user.bannerUrl,
        createdAt: user.createdAt,
      },
      token,
    })
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
