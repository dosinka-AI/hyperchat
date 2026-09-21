import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { verifySessionToken } from '@/lib/auth'

/** Bearer token for the realtime sidecar handshake. The socket.io client
 *  cannot read the httpOnly session cookie, and some contexts (embedded
 *  preview iframes, browsers with third-party cookie restrictions) never
 *  deliver it on the handshake request either - so the client asks this
 *  same-origin route for the token and sends it in the socket's auth
 *  payload, where no cookie policy can touch it. The token is the very
 *  same signed session JWT the cookie carries (verified here before it is
 *  handed out, and verified again by the sidecar on every handshake). */
export async function GET() {
  const store = await cookies()
  const token = store.get('hyperchat_session')?.value
  if (!token) return NextResponse.json({ error: 'not signed in' }, { status: 401 })
  const userId = await verifySessionToken(token)
  if (!userId) return NextResponse.json({ error: 'session expired' }, { status: 401 })
  return NextResponse.json(
    { token },
    // never cached: the token rotates on every login
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
