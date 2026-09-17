import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM, GRANULAR_PERMS } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ serverId: string }> }

function sanitizeColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : null
}

function sanitizePerms(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return null
  // keep only known bits; never let a role grant ADMINISTRATOR
  let clean = 0
  for (const key of GRANULAR_PERMS) clean |= PERM[key]
  return raw & clean
}

export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')

    const roles = await db.role.findMany({
      where: { serverId },
      orderBy: [{ position: 'desc' }, { createdAt: 'asc' }],
      include: { _count: { select: { members: true } } },
    })
    return NextResponse.json({
      roles: roles.map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        permissions: r.permissions,
        position: r.position,
        memberCount: r._count.members,
      })),
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
    if (!hasPerm(ctx.perms, PERM.MANAGE_ROLES)) {
      return forbidden('Only the owner or role managers can create roles.')
    }

    const body = await req.json()
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 32) : ''
    if (name.length < 1) return badRequest('Role name must be 1 to 32 characters.')
    const color = sanitizeColor(body.color) ?? '#f5f5f5'
    const permissions = sanitizePerms(body.permissions) ?? 0

    const count = await db.role.count({ where: { serverId } })
    if (count >= 20) return badRequest('A server can have at most 20 custom roles.')

    const top = await db.role.findFirst({ where: { serverId }, orderBy: { position: 'desc' }, select: { position: true } })
    const role = await db.role.create({
      data: { serverId, name, color, permissions, position: (top?.position ?? 0) + 1 },
    })

    await logServerEvent({ serverId, type: 'role_create', actorId: me.id, data: { name: role.name } })

    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await emitToRooms(members.map((m) => userRoom(m.userId)), 'server:refresh', { serverId })

    return NextResponse.json({ role: { ...role, memberCount: 0 } }, { status: 201 })
  } catch {
    return serverError()
  }
}
