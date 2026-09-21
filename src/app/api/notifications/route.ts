import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, serverError, unauthorized } from '@/lib/realtime'

/** Notification settings beyond mute (Discord-style levels).
 *  GET  - my rows: { settings: [{ scopeKey, level, suppressEveryone }] }
 *  PUT  - upsert one scope: { scopeKey, level: 'ALL' | 'MENTIONS', suppressEveryone }
 *         (level ALL + suppressEveryone false deletes the row: that is the default)
 *  A hard mute stays a MuteState row (handled by /api/mutes); NONE here means
 *  "delete the NotificationSetting and mute the scope" for convenience. */
export async function GET() {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const rows = await db.notificationSetting.findMany({
      where: { userId: me.id },
      select: { scopeKey: true, level: true, suppressEveryone: true },
    })
    return NextResponse.json({ settings: rows })
  } catch {
    return serverError()
  }
}

export async function PUT(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json()
    const scopeKey = typeof body.scopeKey === 'string' ? body.scopeKey : ''
    if (!/^((channel|server):[a-z0-9]+)$/i.test(scopeKey)) {
      return badRequest('Pick a channel or a server.')
    }
    const level = body.level === 'ALL' ? 'ALL' : 'MENTIONS'
    const suppressEveryone = body.suppressEveryone === true

    if (level === 'ALL' && !suppressEveryone) {
      // back to the default: no row at all
      await db.notificationSetting.deleteMany({ where: { userId: me.id, scopeKey } })
      return NextResponse.json({ ok: true, level: 'ALL', suppressEveryone: false })
    }

    await db.notificationSetting.upsert({
      where: { userId_scopeKey: { userId: me.id, scopeKey } },
      create: { userId: me.id, scopeKey, level, suppressEveryone },
      update: { level, suppressEveryone },
    })
    return NextResponse.json({ ok: true, level, suppressEveryone })
  } catch {
    return serverError()
  }
}
