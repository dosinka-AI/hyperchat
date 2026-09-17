import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { consumeEmailCode } from '@/lib/email'

/** Verify ownership of an email with a 6-digit code and attach it to the
 *  signed-in account (marking it verified). MX validation happened when the
 *  code was issued; this proves the user could read the code. */
export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  try {
    const body = await req.json()
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const code = typeof body.code === 'string' ? body.code.trim() : ''

    if (!email || !/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: 'Enter the 6-digit code from the request.' }, { status: 400 })
    }

    const clash = await db.user.findUnique({ where: { email } })
    if (clash && clash.id !== me.id) {
      return NextResponse.json({ error: 'An account with that email already exists.' }, { status: 409 })
    }

    const result = await consumeEmailCode({ email, purpose: 'verify', code, userId: me.id })
    if (result === 'none' || result === 'expired') {
      return NextResponse.json({ error: 'That code expired. Request a new one.' }, { status: 400 })
    }
    if (result === 'owner' || result === 'wrong') {
      return NextResponse.json({ error: 'Wrong code. Check the digits and try again.' }, { status: 400 })
    }

    const user = await db.user.update({
      where: { id: me.id },
      data: { email, emailVerifiedAt: new Date() },
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
        createdAt: true,
      },
    })

    return NextResponse.json({ user })
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
