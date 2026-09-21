import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'
import { hash, compare } from 'bcryptjs'
import { db } from '@/lib/db'

const secret = new TextEncoder().encode(process.env.JWT_SECRET || 'hyperion-dev-secret-9f4k2m8s1q7')
const COOKIE_NAME = 'hyperchat_session'
const THIRTY_DAYS = 60 * 60 * 24 * 30

export type SessionUser = {
  id: string
  username: string
  email: string | null
  emailVerifiedAt: Date | null
  displayName: string | null
  avatarUrl: string | null
  avatarColor: string
  bio: string
  role: string
  siteAdmin: boolean
  createdAt: Date
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, 10)
}

export function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return compare(password, passwordHash)
}

export async function createSessionToken(user: { id: string; username: string }): Promise<string> {
  return new SignJWT({ sub: user.id, username: user.username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secret)
}

export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret)
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

export async function setSessionCookie(user: { id: string; username: string }): Promise<void> {
  const token = await createSessionToken(user)
  const store = await cookies()
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: THIRTY_DAYS,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies()
  store.set(COOKIE_NAME, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 })
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies()
  const token = store.get(COOKIE_NAME)?.value
  if (!token) return null
  const userId = await verifySessionToken(token)
  if (!userId) return null
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
      siteAdmin: true,
      siteBan: { select: { userId: true } },
      createdAt: true,
    },
  })
  if (!user) return null

  // site ban (Task 6-c UserBan): a row existing at all kills the session
  // everywhere — login also 403s and the sidecar handshake refuses a socket
  if (user.siteBan) return null

  // site-level suspension gate: a future bannedUntil kills the session on the
  // spot; an expired one is lazily cleared so the account is active again
  if (user.bannedUntil) {
    if (user.bannedUntil.getTime() > Date.now()) return null
    if (user.banReason !== null) {
      void db.user
        .update({ where: { id: user.id }, data: { bannedUntil: null, banReason: null } })
        .catch(() => {
          /* lazy clear is best-effort */
        })
    }
  }

  return user
}

export const USERNAME_RE = /^[a-z0-9_]{3,20}$/
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
