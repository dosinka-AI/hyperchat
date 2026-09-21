import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireSiteAdmin } from '@/lib/siteAdmin'
import { resolveServerAddress } from '@/lib/bootstrap'

/**
 * PUT /api/admin/bootstrap — site-admin control of the OPTIONAL discovery
 * check (what clients will read from the owner's github txt).
 *
 *   { bootstrapUrl }  → validate (http/https, ≤ 2000 chars), save to the
 *                       AppSetting 'bootstrapUrl' row, immediately re-resolve
 *   { bootstrapUrl: '' } → CLEAR the check (the server never needed it;
 *                       this just turns the panel card off)
 *   { refresh: true } → just re-resolve the current anchor (forced, bypasses
 *                       the 60s cache)
 *
 * The txt is updated by the owner BY HAND on github (he pastes the current
 * cloudflared temp link in as the first line); clients read it themselves.
 * Nothing on the server side depends on this setting — it exists purely so
 * the owner can sanity-check his own txt from the panel.
 */
const MAX_URL = 2000

export async function PUT(req: NextRequest) {
  const gate = await requireSiteAdmin()
  if (!gate.ok) return gate.response

  try {
    const body = (await req.json().catch(() => ({}))) as {
      bootstrapUrl?: unknown
      refresh?: unknown
    }

    const wantsRefresh = body.refresh === true
    let incoming: string | null = null
    let clearing = false
    if (typeof body.bootstrapUrl === 'string') {
      incoming = body.bootstrapUrl.trim()
      if (incoming === '') {
        clearing = true // explicit clear: stop checking the txt
      } else if (!/^https?:\/\/[^\s]+$/i.test(incoming) || incoming.length > MAX_URL) {
        return NextResponse.json(
          { error: 'Enter a valid http(s) URL (max 2000 characters).' },
          { status: 400 }
        )
      }
    }

    if (incoming === null && !wantsRefresh) {
      return NextResponse.json(
        { error: 'Provide a bootstrapUrl to save (or "" to clear), or refresh: true to re-resolve.' },
        { status: 400 }
      )
    }

    if (clearing) {
      await db.appSetting.delete({ where: { key: 'bootstrapUrl' } }).catch(() => {})
      return NextResponse.json({
        configured: false,
        bootstrapUrl: null,
        address: null,
        addressAt: null,
        ok: false,
      })
    }

    if (incoming) {
      await db.appSetting.upsert({
        where: { key: 'bootstrapUrl' },
        update: { value: incoming },
        create: { key: 'bootstrapUrl', value: incoming },
      })
    }

    // always force: a save (or an explicit refresh) means the owner wants a
    // fresh answer from the txt right now, cache be damned
    const state = await resolveServerAddress(true)
    return NextResponse.json({
      configured: state.configured,
      bootstrapUrl: state.url,
      address: state.address,
      addressAt: state.addressAt,
      ok: state.ok,
      ...(state.error ? { error: state.error } : {}),
    })
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
