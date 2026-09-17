import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { toServerSummary } from '@/lib/serialize'
import { logServerEvent } from '@/lib/audit'
import { ADMIN_BASE_PERMS, PERM } from '@/lib/perm'

/** Hide private channels a member cannot read from the join response. */
function visibleChannels(server, role, roleId, isOwner) {
  const perms = isOwner ? PERM.ADMINISTRATOR : role === 'ADMIN' ? ADMIN_BASE_PERMS : 0
  const mod = (perms & (PERM.ADMINISTRATOR | PERM.MANAGE_MESSAGES)) !== 0
  return server.channels.filter((ch) => {
    if (!ch.private) return true
    if (mod) return true
    return roleId ? ch.access.some((a) => a.roleId === roleId) : false
  })
}

export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json()
    const raw = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : ''
    if (!raw) return badRequest('Enter an invite code.')

    let server = await db.server.findUnique({
      where: { inviteCode: raw },
      include: {
        channels: {
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
          include: { access: { select: { roleId: true } } },
        },
        categories: { orderBy: { position: 'asc' } },
        _count: { select: { members: true } },
      },
    })
    if (!server) {
      // typed codes often drift in case; SQLite LIKE narrows the scan and the
      // strict compare keeps partial matches from joining
      const candidates = await db.server.findMany({
        where: { inviteCode: { contains: raw } },
        include: {
          channels: {
            orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
            include: { access: { select: { roleId: true } } },
          },
          categories: { orderBy: { position: 'asc' } },
          _count: { select: { members: true } },
        },
      })
      const lower = raw.toLowerCase()
      const hit = candidates.find((c) => c.inviteCode.toLowerCase() === lower)
      if (hit) server = hit
    }
    if (!server) return notFound('No server matches that invite code.')

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

    // Email gate: joining a SECOND server (all-time, past servers count via
    // ServerJoinLog — leaving does not reset it) requires a verified email.
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
