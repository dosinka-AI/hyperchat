import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { getBootstrapUrl, resolveServerAddress } from '@/lib/bootstrap'

/**
 * GET /api/bootstrap — what clients will read from the owner's github txt
 * (the optional discovery check; see src/lib/bootstrap.ts). Session-authed.
 *
 * The txt itself is CLIENT-side discovery — the owner updates it by hand
 * with the current tunnel address and clients read it directly. This
 * endpoint is the admin panel's window onto "did my manual edit land?".
 * `configured: false` (no txt URL set) is a neutral state, not an error.
 *
 * Cheap by design: a resolve younger than 60s is served from the AppSetting
 * cache; only a stale one re-fetches the txt (cache-busted, 8s timeout).
 */
export async function GET() {
  const me = await getSessionUser()
  if (!me) {
    return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 })
  }
  const state = await resolveServerAddress()
  return NextResponse.json({
    configured: state.configured,
    bootstrapUrl: state.url,
    address: state.address,
    addressAt: state.addressAt,
    ok: state.ok,
    ...(state.error ? { error: state.error } : {}),
  })
}
