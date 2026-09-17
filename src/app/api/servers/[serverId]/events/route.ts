import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import type { AuditEventSummary } from '@/lib/types'

type Params = { params: Promise<{ serverId: string }> }

const NAME_SELECT = { id: true, username: true, displayName: true } as const

/** Server audit log: the official record of who did what. Owner/admin only. */
export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return notFound('Server not found.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_SERVER) && !hasPerm(ctx.perms, PERM.MANAGE_MESSAGES)) {
      return forbidden('Only moderators can read the audit log.')
    }

    const events = await db.serverEvent.findMany({
      where: { serverId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        actor: { select: NAME_SELECT },
        targetUser: { select: NAME_SELECT },
      },
    })

    const payload: AuditEventSummary[] = events.map((e) => ({
      id: e.id,
      type: e.type,
      actor: e.actor ? { ...e.actor } : null,
      targetUser: e.targetUser ? { ...e.targetUser } : null,
      data: safeJson(e.data),
      createdAt: e.createdAt.toISOString(),
    }))

    return NextResponse.json({ events: payload })
  } catch {
    return serverError()
  }
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
