import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ serverId: string; userId: string }> }

const TIMEOUT_CHOICES = [1, 5, 10, 60, 1440, 10080] // minutes: 1m 5m 10m 1h 1d 7d

async function notifyServer(serverId: string, extra?: Record<string, unknown>) {
  const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
  await emitToRooms(members.map((m) => userRoom(m.userId)), 'server:refresh', { serverId, ...extra })
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId, userId } = await params
    const mine = await getMemberContext(serverId, me.id)
    if (!mine) return forbidden('You are not a member of this server.')

    const target = await db.serverMember.findUnique({
      where: { userId_serverId: { userId, serverId } },
      include: { customRole: true },
    })
    if (!target) return notFound('That user is not a member of this server.')

    const body = await req.json()
    const data: {
      role?: string
      roleId?: string | null
      nickname?: string | null
      timeoutUntil?: Date | null
    } = {}

    // --- base rank (OWNER | ADMIN | MEMBER): owner only, never the owner ---
    if (typeof body.role === 'string') {
      if (mine.baseRole !== 'OWNER') return forbidden('Only the owner can change member ranks.')
      if (userId === mine.ownerId) return badRequest('The owner rank cannot be changed.')
      if (body.role !== 'ADMIN' && body.role !== 'MEMBER') return badRequest('Rank must be ADMIN or MEMBER.')
      data.role = body.role
    }

    // --- custom role assignment: MANAGE_ROLES ---
    if (body.roleId !== undefined) {
      if (!hasPerm(mine.perms, PERM.MANAGE_ROLES)) {
        return forbidden('Only the owner or role managers can assign roles.')
      }
      if (userId === mine.ownerId) return badRequest('The owner does not need a role.')
      if (body.roleId === null) {
        data.roleId = null
      } else if (typeof body.roleId === 'string') {
        const role = await db.role.findUnique({ where: { id: body.roleId } })
        if (!role || role.serverId !== serverId) return notFound('That role does not exist in this server.')
        data.roleId = role.id
      } else {
        return badRequest('roleId must be a role id or null.')
      }
    }

    // --- nickname: your own, or anyone's with MANAGE_NICKNAMES ---
    if (body.nickname !== undefined) {
      const isSelf = userId === me.id
      if (!isSelf && !hasPerm(mine.perms, PERM.MANAGE_NICKNAMES)) {
        return forbidden('You can only change your own nickname.')
      }
      if (userId === mine.ownerId && !isSelf) {
        return badRequest('Only the owner changes their own nickname.')
      }
      if (body.nickname === null) {
        data.nickname = null
      } else if (typeof body.nickname === 'string') {
        const nick = body.nickname.trim().slice(0, 32)
        data.nickname = nick || null
      } else {
        return badRequest('nickname must be text or null.')
      }
    }

    // --- moderation timeout: TIMEOUT_MEMBERS, admins cannot timeout admins ---
    if (body.timeoutMinutes !== undefined) {
      if (!hasPerm(mine.perms, PERM.TIMEOUT_MEMBERS)) {
        return forbidden('You need the Timeout Members permission for that.')
      }
      if (userId === mine.ownerId) return badRequest('The owner cannot be timed out.')
      if (mine.baseRole !== 'OWNER' && target.role === 'ADMIN') {
        return forbidden('Only the owner can timeout an admin.')
      }
      if (body.timeoutMinutes === null || body.timeoutMinutes === 0) {
        data.timeoutUntil = null
      } else if (typeof body.timeoutMinutes === 'number' && TIMEOUT_CHOICES.includes(body.timeoutMinutes)) {
        data.timeoutUntil = new Date(Date.now() + body.timeoutMinutes * 60_000)
      } else {
        return badRequest('Pick a timeout duration: 1m, 5m, 10m, 1h, 1d or 7d.')
      }
    }

    if (Object.keys(data).length === 0) return badRequest('Nothing to change.')

    const updated = await db.serverMember.update({ where: { id: target.id }, data })

    if (data.role !== undefined) {
      await logServerEvent({ serverId, type: 'role_change', actorId: me.id, targetUserId: userId, data: { role: data.role } })
    }
    if (data.roleId !== undefined) {
      const roleName = updated.roleId ? (await db.role.findUnique({ where: { id: updated.roleId }, select: { name: true } }))?.name : null
      await logServerEvent({
        serverId,
        type: 'role_assign',
        actorId: me.id,
        targetUserId: userId,
        data: { role: roleName ?? 'no role' },
      })
    }
    if (data.nickname !== undefined) {
      await logServerEvent({
        serverId,
        type: 'nickname_change',
        actorId: me.id,
        targetUserId: userId,
        data: { nickname: data.nickname ?? 'reset' },
      })
    }
    if (data.timeoutUntil !== undefined) {
      await logServerEvent({
        serverId,
        type: data.timeoutUntil ? 'member_timeout' : 'timeout_clear',
        actorId: me.id,
        targetUserId: userId,
        data: data.timeoutUntil ? { until: data.timeoutUntil.toISOString() } : {},
      })
    }

    await notifyServer(serverId, { changedUserId: userId })
    return NextResponse.json({ ok: true, role: updated.role, roleId: updated.roleId })
  } catch {
    return serverError()
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  // kick a member: KICK_MEMBERS, admins cannot kick admins, nobody kicks the owner
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId, userId } = await params
    const mine = await getMemberContext(serverId, me.id)
    if (!mine) return forbidden('You are not a member of this server.')
    if (!hasPerm(mine.perms, PERM.KICK_MEMBERS)) {
      return forbidden('You need the Kick Members permission for that.')
    }

    if (userId === mine.ownerId) return badRequest('The owner cannot be kicked.')

    const target = await db.serverMember.findUnique({ where: { userId_serverId: { userId, serverId } } })
    if (!target) return notFound('That user is not a member of this server.')
    if (mine.baseRole === 'ADMIN' && target.role === 'ADMIN') {
      return forbidden('Admins cannot kick other admins. Ask the owner.')
    }

    // optional reason in the body (kicks are DELETEs, but the body is allowed)
    let reason: string | null = null
    try {
      const body = await req.json()
      if (body && typeof body.reason === 'string') reason = body.reason.trim().slice(0, 200) || null
    } catch {
      reason = null
    }

    await db.serverMember.delete({ where: { id: target.id } })

    await logServerEvent({ serverId, type: 'member_kick', actorId: me.id, targetUserId: userId, data: reason ? { reason } : {} })

    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await emitToRooms(
      [...members.map((m) => userRoom(m.userId)), userRoom(userId)],
      'server:refresh',
      { serverId, kickedUserId: userId }
    )

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
