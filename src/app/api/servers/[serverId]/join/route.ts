import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { toServerSummary } from '@/lib/serialize'
import { logServerEvent } from '@/lib/audit'
import { ADMIN_BASE_PERMS, PERM } from '@/lib/perm'

type Params = { params: Promise<{ serverId: string }> }

/** Same private-channel filter as the invite join route, for the summary. */
function visibleChannels(server, role, roleId, isOwner) {
  const perms = isOwner ? PERM.ADMINISTRATOR : role === 'ADMIN' ? ADMIN_BASE_PERMS : 0
  const mod = (perms & (PERM.ADMINISTRATOR | PERM.MANAGE_MESSAGES)) !== 0
  return server.channels.filter((ch) => {
    if (!ch.private) return true
    if (mod) return true
    return roleId ? ch.access.some((a) => a.roleId === roleId) : false
  })
}

/** Join a server straight from Discover: no invite needed, but the server
 *  must be PUBLIC and the caller must not be banned from it. */
export async function POST(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params

    const server = await db.server.findUnique({
      where: { id: serverId },
      include: {
        channels: {
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
          include: { access: { select: { roleId: true } } },
        },
        categories: { orderBy: { position: 'asc' } },
        _count: { select: { members: true } },
      },
    })
    if (!server) return notFound('Server not found.')
    if (server.visibility !== 'PUBLIC') return forbidden('This server is private.')

    const ban = await db.serverBan.findUnique({
      where: { userId_serverId: { userId: me.id, serverId: server.id } },
    })
    if (ban) {
      return forbidden('You are banned from this server.')
    }

    const existing = await db.serverMember.findUnique({
      where: { userId_serverId: { userId: me.id, serverId: server.id } },
      include: { customRole: { select: { id: true, permissions: true } } },
    })
    if (existing) {
      const perms = server.ownerId === me.id
        ? PERM.ADMINISTRATOR
        : existing.role === 'ADMIN'
          ? ADMIN_BASE_PERMS
          : existing.customRole?.permissions ?? 0
      const channels = visibleChannels(server, existing.role, existing.customRole?.id ?? null, server.ownerId === me.id)
      return NextResponse.json({
        server: toServerSummary({ ...server, channels }, server._count.members, existing.role, perms),
        alreadyMember: true,
      })
    }

    // Email gate (same rule as invite-code join): a second all-time server
    // requires a verified email. Past memberships count via ServerJoinLog.
    const joinLog = await db.serverJoinLog.findUnique({
      where: { userId_serverId: { userId: me.id, serverId: server.id } },
    })
    if (!joinLog) {
      const otherServers = await db.serverJoinLog.count({
        where: { userId: me.id, serverId: { not: server.id } },
      })
      if (otherServers >= 1 && !(me.email && me.emailVerifiedAt)) {
        return NextResponse.json(
          { error: 'Verify an email to join more than one server.', code: 'EMAIL_REQUIRED' },
          { status: 403 }
        )
      }
      await db.serverJoinLog.create({ data: { userId: me.id, serverId: server.id } })
    }

    await db.serverMember.create({
      data: { userId: me.id, serverId: server.id, role: 'MEMBER' },
    })

    await logServerEvent({
      serverId: server.id,
      type: 'member_join',
      actorId: me.id,
      targetUserId: me.id,
    })

    const members = await db.serverMember.findMany({ where: { serverId: server.id }, select: { userId: true } })
    await emitToRooms(
      members.map((m) => userRoom(m.userId)),
      'server:refresh',
      { serverId: server.id }
    )

    return NextResponse.json(
      {
        server: toServerSummary(
          { ...server, channels: visibleChannels(server, 'MEMBER', null, false) },
          server._count.members + 1,
          'MEMBER',
          0
        ),
        alreadyMember: false,
      },
      { status: 201 }
    )
  } catch {
    return serverError()
  }
}
