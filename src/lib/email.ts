import { promises as dns } from 'node:dns'
import { hash, compare } from 'bcryptjs'
import { db } from '@/lib/db'
import { EMAIL_RE } from '@/lib/auth'

/** Email infrastructure for HyperChat.
 *
 *  Anti-fake-email policy: an address is only accepted if its domain can
 *  actually receive mail — we resolve the domain's MX records over real DNS
 *  before anything is stored. Domains like "totally-fake-xyz.example" never
 *  resolve, so throwaway addresses are rejected at the door.
 *
 *  Verification codes: 6 digits, bcrypt-hashed at rest, 10 minute expiry,
 *  max 5 attempts. This build has no SMTP transport, so the code is returned
 *  inline (delivery: 'inline') — swap the delivery branch for a real mailer
 *  in production and stop returning the code. */

const CODE_TTL_MS = 10 * 60 * 1000
const CODE_MAX_ATTEMPTS = 5
const MX_TIMEOUT_MS = 4000
const RESEND_COOLDOWN_MS = 30 * 1000

/** Format + MX validation. Returns an error string when invalid, null when ok. */
export async function checkEmailDeliverable(email: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase()
  if (!EMAIL_RE.test(normalized)) return 'Enter a valid email address.'
  const domain = normalized.split('@')[1]
  if (!domain) return 'Enter a valid email address.'
  try {
    const mx = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('mx-timeout')), MX_TIMEOUT_MS)),
    ])
    if (!mx || mx.length === 0) return 'That email domain cannot receive mail.'
    return null
  } catch {
    return 'That email domain cannot receive mail.'
  }
}

/** One code issue per (email, purpose) per cooldown window. */
const lastIssuedAt = new Map<string, number>()

export function issueRateLimited(email: string, purpose: string): number | null {
  const key = `${email}|${purpose}`
  const last = lastIssuedAt.get(key) ?? 0
  const elapsed = Date.now() - last
  if (elapsed < RESEND_COOLDOWN_MS) {
    return Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000)
  }
  lastIssuedAt.set(key, Date.now())
  return null
}

export function generateCode(): string {
  // 6 digits, uniform, no leading-zero bias games needed for a 1e6 space
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
}

export async function hashCode(code: string): Promise<string> {
  return hash(code, 8)
}

export async function compareCode(code: string, codeHash: string): Promise<boolean> {
  try {
    return await compare(code, codeHash)
  } catch {
    return false
  }
}

/** Create a fresh code row for email+purpose, superseding older ones. */
export async function createEmailCode(opts: {
  email: string
  purpose: 'verify' | 'password'
  userId?: string
}): Promise<{ code: string; expiresAt: Date }> {
  await db.emailCode.deleteMany({ where: { email: opts.email, purpose: opts.purpose } })
  const code = generateCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MS)
  await db.emailCode.create({
    data: {
      email: opts.email,
      purpose: opts.purpose,
      userId: opts.userId ?? null,
      codeHash: await hashCode(code),
      expiresAt,
    },
  })
  return { code, expiresAt }
}

/** Verify a code against the newest live row for email+purpose.
 *  Returns 'ok' | 'wrong' | 'expired' | 'none'. Consumes attempts on wrong. */
export async function consumeEmailCode(opts: {
  email: string
  purpose: 'verify' | 'password'
  code: string
  userId?: string
}): Promise<'ok' | 'wrong' | 'expired' | 'none' | 'owner'> {
  const row = await db.emailCode.findFirst({
    where: { email: opts.email, purpose: opts.purpose },
    orderBy: { createdAt: 'desc' },
  })
  if (!row) return 'none'
  if (opts.userId !== undefined && row.userId !== null && row.userId !== opts.userId) return 'owner'
  if (row.expiresAt.getTime() < Date.now()) return 'expired'
  if (row.attempts >= CODE_MAX_ATTEMPTS) return 'expired'
  if (!(await compareCode(opts.code, row.codeHash))) {
    await db.emailCode.update({ where: { id: row.id }, data: { attempts: row.attempts + 1 } })
    return 'wrong'
  }
  await db.emailCode.delete({ where: { id: row.id } })
  return 'ok'
}

export const EMAIL_CODE_TTL_SECONDS = CODE_TTL_MS / 1000
