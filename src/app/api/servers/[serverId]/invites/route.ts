import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, forbidden, serverError, unauthorized } from '@/lib/realtime'
import { generateInviteCode } from '@/lib/messages'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'
import type { InviteSummary } from '@/lib/types'

type Params = { params: Promise<{ serverId: string }> }

const EXPIRY_CHOICES_H: (number | null)[] = [null, 1, 24, 168, 720] // never, 1h, 1d, 7d, 30d
const USE_CHOICES: (number | null)[] = [null, 1, 5, 10, 25, 100]

function summaryOf(
  row: {
    id: string
    code: string
    serverId: string
    createdById: string
    expiresAt: Date | null
    maxUses: number | null
    uses: number
    targetChannelId: string | null
    createdAt: Date
  },
  createdByUsername: string | null,
  targetChannelName: string | null = null
): InviteSummary {
  return {
    id: row.id,
    code: row.code,
    serverId: row.serverId,
    createdById: row.createdById,
    createdByUsername,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    maxUses: row.maxUses,
    uses: row.uses,
    targetChannelId: row.targetChannelId,
    targetChannelName,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_SERVER)) {
      return forbidden('Only moderators can manage invites.')
    }

    const rows = await db.invite.findMany({
      where: { serverId },
      orderBy: { createdAt: 'desc' },
      include: {
        createdBy: { select: { username: true } },
        targetChannel: { select: { name: true } },
      },
    })
    return NextResponse.json({
      invites: rows.map((r) => summaryOf(r, r.createdBy?.username ?? null, r.targetChannel?.name ?? null)),
    })
  } catch {
    return serverError()
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_SERVER)) {
      return forbidden('Only moderators can create invites.')
    }

    const body = await req.json()
    const expiresInHours =
      body.expiresInHours === undefined || body.expiresInHours === null ? null : body.expiresInHours
    if (!EXPIRY_CHOICES_H.includes(expiresInHours)) {
      return badRequest('Expiry must be never, 1 hour, 1 day, 7 days or 30 days.')
    }
    const maxUses = body.maxUses === undefined || body.maxUses === null ? null : body.maxUses
    if (!USE_CHOICES.includes(maxUses)) {
      return badRequest('Max uses must be no limit, 1, 5, 10, 25 or 100.')
    }

    // optional landing channel: joiners open straight into it instead of
    // the server default. Must be a text/forum channel of this server (a
    // voice channel has no message feed to open).
    let targetChannelId: string | null = null
    if (body.targetChannelId !== undefined && body.targetChannelId !== null && body.targetChannelId !== '') {
      if (typeof body.targetChannelId !== 'string') return badRequest('targetChannelId must be a channel id.')
      const channel = await db.channel.findUnique({
        where: { id: body.targetChannelId },
        select: { id: true, serverId: true, type: true },
      })
      if (!channel || channel.serverId !== serverId) {
        return badRequest('That channel is not in this server.')
      }
      if (channel.type !== 'text' && channel.type !== 'forum') {
        return badRequest('Invite links can only target text or forum channels.')
      }
      targetChannelId = channel.id
    }

    // generate a collision-free code (checks invite rows AND legacy codes)
    let code = ''
    for (let attempt = 0; attempt < 6 && !code; attempt++) {
      const candidate = generateInviteCode()
      const clashRow = await db.invite.findUnique({ where: { code: candidate }, select: { id: true } })
      const clashLegacy = await db.server.findUnique({ where: { inviteCode: candidate }, select: { id: true } })
      if (!clashRow && !clashLegacy) code = candidate
    }
    if (!code) return serverError()

    const row = await db.invite.create({
      data: {
        code,
        serverId,
        createdById: me.id,
        expiresAt: expiresInHours !== null ? new Date(Date.now() + expiresInHours * 3_600_000) : null,
        maxUses,
        targetChannelId,
      },
      include: {
        createdBy: { select: { username: true } },
        targetChannel: { select: { name: true } },
      },
    })

    await logServerEvent({
      serverId,
      type: 'invite_create',
      actorId: me.id,
      data: { code, expiresInHours, maxUses, targetChannelId },
    })
    return NextResponse.json(
      { invite: summaryOf(row, row.createdBy?.username ?? null, row.targetChannel?.name ?? null) },
      { status: 201 }
    )
  } catch {
    return serverError()
  }
}
