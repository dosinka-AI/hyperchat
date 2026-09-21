import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, forbidden, notFound, serverError, unauthorized, userRoom, emitToRooms } from '@/lib/realtime'

type Params = { params: Promise<{ username: string }> }

/** One poke per pair per 30 seconds: the nudge stays special. */
const pokeWindows = new Map<string, number>()

export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { username } = await params
    if (username.toLowerCase() === me.username.toLowerCase()) {
      return badRequest('You cannot poke yourself.')
    }
    const target = await db.user.findUnique({
      where: { username: username.toLowerCase() },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        avatarColor: true,
        blocking: { select: { blockedId: true } },
        blockedBy: { select: { blockerId: true } },
      },
    })
    if (!target) return notFound('That person does not exist.')
    if (target.blocking.some((b) => b.blockedId === me.id) || target.blockedBy.some((b) => b.blockerId === me.id)) {
      return forbidden('You cannot poke that person.')
    }

    const body = await req.json().catch(() => ({}))
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, 120) : ''

    // rate limit: one poke per pair per 30s (self-pruning window)
    const key = `${me.id}:${target.id}`
    const now = Date.now()
    const last = pokeWindows.get(key) ?? -Infinity
    if (now - last < 30_000) {
      return NextResponse.json({ error: 'Give them a moment before poking again.' }, { status: 429 })
    }
    pokeWindows.set(key, now)
    if (pokeWindows.size > 2000) {
      for (const [k, t] of pokeWindows) {
        if (now - t >= 30_000) pokeWindows.delete(k)
      }
    }

    const poke = await db.poke.create({
      data: { fromUserId: me.id, toUserId: target.id, message },
      select: { id: true, createdAt: true },
    })

    // the toast lands instantly for online targets
    await emitToRooms([userRoom(target.id)], 'poke:new', {
      id: poke.id,
      message,
      createdAt: poke.createdAt.toISOString(),
      from: {
        id: me.id,
        username: me.username,
        displayName: me.displayName,
        avatarUrl: me.avatarUrl,
        avatarColor: me.avatarColor,
      },
    })

    return NextResponse.json({ ok: true }, { status: 201 })
  } catch {
    return serverError()
  }
}
