import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM, GRANULAR_PERMS } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ serverId: string; roleId: string }> }

function sanitizeColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : null
}

function sanitizePerms(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return null
  let clean = 0
  for (const key of GRANULAR_PERMS) clean |= PERM[key]
  return raw & clean
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId, roleId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_ROLES)) {
      return forbidden('Only the owner or role managers can edit roles.')
    }

    const role = await db.role.findUnique({ where: { id: roleId } })
    if (!role || role.serverId !== serverId) return notFound('Role not found.')

    const body = await req.json()
    const data: { name?: string; color?: string; permissions?: number; position?: number } = {}

    if (typeof body.name === 'string') {
      const name = body.name.trim().slice(0, 32)
      if (name.length < 1) return badRequest('Role name must be 1 to 32 characters.')
      data.name = name
    }
    if (body.color !== undefined) {
      const color = sanitizeColor(body.color)
      if (!color) return badRequest('Color must look like #547cff.')
      data.color = color
    }
    if (body.permissions !== undefined) {
      const permissions = sanitizePerms(body.permissions)
      if (permissions === null) return badRequest('Invalid permission set.')
      data.permissions = permissions
    }

    // move up/down among this server's roles
    if (body.direction === 1 || body.direction === -1) {
      const siblings = await db.role.findMany({
        where: { serverId },
        orderBy: [{ position: 'desc' }, { createdAt: 'asc' }],
        select: { id: true, position: true },
      })
      const index = siblings.findIndex((r) => r.id === roleId)
      const swapIndex = index + (body.direction === 1 ? -1 : 1) // up = toward the top = higher position
      if (index !== -1 && swapIndex >= 0 && swapIndex < siblings.length) {
        const other = siblings[swapIndex]
        const myPos = role.position
        await db.role.update({ where: { id: other.id }, data: { position: myPos } })
        data.position = other.position === myPos ? myPos + (body.direction === 1 ? 1 : -1) : other.position
      }
    }

    const updated = await db.role.update({ where: { id: roleId }, data })

    await logServerEvent({ serverId, type: 'role_update', actorId: me.id, data: { name: updated.name } })

    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await emitToRooms(members.map((m) => userRoom(m.userId)), 'server:refresh', { serverId })

    return NextResponse.json({ role: updated })
  } catch {
    return serverError()
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId, roleId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_ROLES)) {
      return forbidden('Only the owner or role managers can delete roles.')
    }

    const role = await db.role.findUnique({ where: { id: roleId } })
    if (!role || role.serverId !== serverId) return notFound('Role not found.')

    // members fall back to the default (no custom role); private channel grants die with the role
    await db.role.delete({ where: { id: roleId } })

    await logServerEvent({ serverId, type: 'role_delete', actorId: me.id, data: { name: role.name } })

    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await emitToRooms(members.map((m) => userRoom(m.userId)), 'server:refresh', { serverId })

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
