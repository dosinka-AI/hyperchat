import { NextResponse } from 'next/server'
import { getSessionUser, type SessionUser } from '@/lib/auth'

/**
 * Site-admin access control (Task 6-c).
 *
 * The owner's flag lives on User.siteAdmin (set once, by the owner-approved
 * bootstrap of this task: username 'blazar'). EVERY /api/admin/* route gates
 * through requireSiteAdmin() — the legacy role === 'ADMIN' check is retired
 * from the admin surface (the flag is the single source of truth now).
 */

/** The session user, but only when they carry the site-admin flag. */
export async function getSiteAdmin(): Promise<SessionUser | null> {
  const me = await getSessionUser()
  if (!me || !me.siteAdmin) return null
  return me
}

/** Either the admin (ok: true) or the exact response to return (ok: false). */
export type SiteAdminGate =
  | { ok: true; me: SessionUser }
  | { ok: false; response: NextResponse }

/** Gate for /api/admin/* routes: 401 for anonymous callers, 403 for signed-in
 *  non-admins. Usage:
 *    const gate = await requireSiteAdmin()
 *    if (!gate.ok) return gate.response
 *    // ... gate.me is the admin
 */
export async function requireSiteAdmin(): Promise<SiteAdminGate> {
  const me = await getSiteAdmin()
  if (me) return { ok: true, me }
  const hasSession = !!(await getSessionUser())
  if (!hasSession) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 }),
    }
  }
  return {
    ok: false,
    response: NextResponse.json({ error: 'Site admins only.' }, { status: 403 }),
  }
}
