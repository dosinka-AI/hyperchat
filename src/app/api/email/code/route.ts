import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { checkEmailDeliverable, createEmailCode, issueRateLimited, EMAIL_CODE_TTL_SECONDS } from '@/lib/email'

/** Issue a verification code for an email address. Always session-bound:
 *  codes exist only inside logged-in flows (adding/verifying an email,
 *  password changes). The address must pass format + real DNS MX checks,
 *  and must not belong to another account.
 *
 *  Delivery: this build has no SMTP transport, so the code is returned
 *  inline ({ delivery: 'inline', code }) and the dialog shows it. When a
 *  mailer is wired in production, send the code and return
 *  { delivery: 'email' } without the code in the body. */
export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  try {
    const body = await req.json()
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const purpose = body.purpose === 'password' ? 'password' : 'verify'

    if (!email) return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })

    const deliverable = await checkEmailDeliverable(email)
    if (deliverable) return NextResponse.json({ error: deliverable }, { status: 400 })

    const clash = await db.user.findUnique({ where: { email } })
    if (clash && clash.id !== me.id) {
      return NextResponse.json({ error: 'An account with that email already exists.' }, { status: 409 })
    }

    const cooldown = issueRateLimited(email, purpose)
    if (cooldown !== null) {
      return NextResponse.json(
        { error: `Wait ${cooldown}s before requesting another code.`, code: 'RATE', retryAfter: cooldown },
        { status: 429 }
      )
    }

    const { code, expiresAt } = await createEmailCode({ email, purpose, userId: me.id })

    // inline delivery: no mail transport exists in this environment
    return NextResponse.json({
      delivery: 'inline',
      code,
      expiresAt: expiresAt.toISOString(),
      ttlSeconds: EMAIL_CODE_TTL_SECONDS,
    })
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
