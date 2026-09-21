import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { serverError, unauthorized } from '@/lib/realtime'

/** Mark pokes as seen: all of mine, or one specific row. */
export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json().catch(() => ({}))
    const pokeId = typeof body.pokeId === 'string' ? body.pokeId : null
    if (pokeId) {
      await db.poke.updateMany({
        where: { id: pokeId, toUserId: me.id, readAt: null },
        data: { readAt: new Date() },
      })
    } else {
      await db.poke.updateMany({
        where: { toUserId: me.id, readAt: null },
        data: { readAt: new Date() },
      })
    }
    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
