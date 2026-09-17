import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, serverError, unauthorized } from '@/lib/realtime'

/** Toggle mute for a channel or a whole server. Muted scopes play no sounds
 *  and dim their unread badges; messages still arrive. */
export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json()
    const scope = typeof body.scope === 'string' ? body.scope : ''
    if (!/^((channel|server):[a-z0-9]+)$/i.test(scope)) {
      return badRequest('Invalid mute scope.')
    }

    const existing = await db.muteState.findUnique({
      where: { userId_scopeKey: { userId: me.id, scopeKey: scope } },
    })
    if (existing) {
      await db.muteState.delete({ where: { id: existing.id } })
      return NextResponse.json({ muted: false })
    }

    await db.muteState.create({ data: { userId: me.id, scopeKey: scope } })
    return NextResponse.json({ muted: true })
  } catch {
    return serverError()
  }
}
