import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { logServerEvent } from '@/lib/audit'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'

type Params = { params: Promise<{ serverId: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.BAN_MEMBERS)) return forbidden('You need the Ban Members permission to see the ban list.')

    const bans = await db.serverBan.findMany({
      where: { serverId },
      include: {
        user: {
          select: { id: true, username: true, displayName: true, avatarUrl: true, avatarColor: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      bans: bans.map((b) => ({
        id: b.id,
        user: { ...b.user, bio: '' },
        reason: b.reason,
        createdAt: b.createdAt.toISOString(),
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
    if (!hasPerm(ctx.perms, PERM.BAN_MEMBERS)) {
      return forbidden('You need the Ban Members permission for that.')
    }

    const server = await db.server.findUnique({ where: { id: serverId }, select: { ownerId: true } })
    if (!server) return notFound('Server not found.')

    const body = await req.json()
    const userId = typeof body.userId === 'string' ? body.userId : ''
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : null
    if (!userId) return badRequest('Pick a member to ban.')
    if (userId === server.ownerId) return badRequest('The owner cannot be banned.')

    const target = await db.serverMember.findUnique({
      where: { userId_serverId: { userId, serverId } },
    })
    if (!target) return notFound('That user is not a member of this server.')
    // base-rank admins cannot ban other admins; only the owner can
    if (ctx.baseRole !== 'OWNER' && target.role === 'ADMIN') {
      return forbidden('Only the owner can ban an admin.')
    }

    await db.$transaction([
      db.serverMember.delete({ where: { id: target.id } }),
      db.serverBan.create({ data: { userId, serverId, reason } }),
    ])

    await logServerEvent({
      serverId,
      type: 'member_ban',
      actorId: me.id,
      targetUserId: userId,
      data: { reason },
    })

    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await emitToRooms(
      [...members.map((m) => userRoom(m.userId)), userRoom(userId)],
      'server:refresh',
      { serverId, bannedUserId: userId }
    )

    return NextResponse.json({ ok: true }, { status: 201 })
  } catch {
    return serverError()
  }
}
