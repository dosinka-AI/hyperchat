import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser, hashPassword, verifyPassword } from '@/lib/auth'
import { badRequest, serverError, unauthorized } from '@/lib/realtime'
import { consumeEmailCode } from '@/lib/email'

/** Password changes require a verified email on the account AND a fresh
 *  one-time code sent to it (purpose 'password'), on top of the current
 *  password. Emails are MX-checked at issue time, so a fake address can
 *  never get this far. */
export async function PATCH(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json()
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
    const code = typeof body.code === 'string' ? body.code.trim() : ''

    if (newPassword.length < 8) {
      return badRequest('The new password must be at least 8 characters.')
    }
    if (!me.email || !me.emailVerifiedAt) {
      return NextResponse.json(
        { error: 'Verify an email on your account first.', code: 'EMAIL_REQUIRED' },
        { status: 403 }
      )
    }
    if (!/^\d{6}$/.test(code)) {
      return badRequest('Enter the 6-digit code sent to your email.')
    }

    const codeResult = await consumeEmailCode({
      email: me.email,
      purpose: 'password',
      code,
      userId: me.id,
    })
    if (codeResult === 'none' || codeResult === 'expired') {
      return badRequest('That code expired. Request a new one.')
    }
    if (codeResult !== 'ok') {
      return badRequest('Wrong code. Check the digits and try again.')
    }

    const user = await db.user.findUnique({ where: { id: me.id } })
    if (!user) return unauthorized()
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      return NextResponse.json({ error: 'Your current password is wrong.' }, { status: 403 })
    }

    await db.user.update({
      where: { id: me.id },
      data: { passwordHash: await hashPassword(newPassword) },
    })

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
