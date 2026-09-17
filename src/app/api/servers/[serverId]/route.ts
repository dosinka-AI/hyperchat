import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom, badRequest } from '@/lib/realtime'
import { logServerEvent } from '@/lib/audit'
import { toCategorySummary, toChannelSummary, toMemberSummary } from '@/lib/serialize'
import { generateInviteCode } from '@/lib/messages'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'

type Params = { params: Promise<{ serverId: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of that server.')

    const server = await db.server.findUnique({
      where: { id: serverId },
      include: {
        channels: { orderBy: [{ position: 'asc' }, { createdAt: 'asc' }], include: { access: { select: { roleId: true } } } },
        categories: { orderBy: { position: 'asc' } },
        roles: { orderBy: [{ position: 'desc' }, { createdAt: 'asc' }], include: { _count: { select: { members: true } } } },
        members: {
          orderBy: { joinedAt: 'asc' },
          include: {
            customRole: { select: { id: true, name: true, color: true } },
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true,
                avatarColor: true,
                bio: true,
                role: true,
                customStatus: true,
              },
            },
          },
        },
      },
    })
    if (!server) return notFound('Server not found.')

    // hide private channels the viewer cannot read
    const mod = hasPerm(ctx.perms, PERM.MANAGE_MESSAGES) || hasPerm(ctx.perms, PERM.ADMINISTRATOR)
    const channels = server.channels.filter((ch) => {
      if (!ch.private) return true
      if (mod) return true
      return ctx.roleId ? ch.access.some((a) => a.roleId === ctx.roleId) : false
    })

    return NextResponse.json({
      server: {
        id: server.id,
        name: server.name,
        description: server.description,
        iconUrl: server.iconUrl,
        bannerColor: server.bannerColor,
        inviteCode: server.inviteCode,
        ownerId: server.ownerId,
        createdAt: server.createdAt.toISOString(),
        blockedWords: server.blockedWords,
      },
      channels: channels.map(toChannelSummary),
      categories: server.categories.map(toCategorySummary),
      members: server.members.map(toMemberSummary),
      roles: server.roles.map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        permissions: r.permissions,
        position: r.position,
        memberCount: r._count.members,
      })),
      myRole: ctx.baseRole,
      myPerms: ctx.perms,
      visibility: server.visibility,
    })
  } catch {
    return serverError()
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const ctx = await getMemberContext(serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_SERVER)) {
      return forbidden('Only moderators with the Manage Server permission can change server settings.')
    }

    const body = await req.json()
    const data: { name?: string; description?: string; iconUrl?: string | null; bannerColor?: string | null; blockedWords?: string; visibility?: string } = {}
    if (typeof body.name === 'string') {
      const name = body.name.trim()
      if (name.length < 2 || name.length > 40) {
        return NextResponse.json({ error: 'Server name must be 2 to 40 characters.' }, { status: 400 })
      }
      data.name = name
    }
    if (typeof body.description === 'string') {
      data.description = body.description.trim().slice(0, 300)
    }
    if (body.iconUrl !== undefined) {
      const url = body.iconUrl === null ? null : typeof body.iconUrl === 'string' ? body.iconUrl : ''
      if (url === null || /^\/api\/files\/[a-zA-Z0-9\-]+\.(png|jpg|jpeg|gif|webp)$/.test(url)) {
        data.iconUrl = url
      } else {
        return NextResponse.json({ error: 'Use an image uploaded through HyperChat.' }, { status: 400 })
      }
    }
    if (body.blockedWords !== undefined) {
      if (typeof body.blockedWords !== 'string') {
        return NextResponse.json({ error: 'blockedWords must be text.' }, { status: 400 })
      }
      data.blockedWords = body.blockedWords.split(/[\n,]+/).map((w) => w.trim().slice(0, 40)).filter(Boolean).slice(0, 100).join(',')
    }
    if (body.visibility !== undefined) {
      if (body.visibility !== 'PRIVATE' && body.visibility !== 'PUBLIC') {
        return NextResponse.json({ error: 'Visibility must be private or public.' }, { status: 400 })
      }
      data.visibility = body.visibility
    }
    if (body.bannerColor !== undefined) {
      const bannerColor = body.bannerColor === null ? null : typeof body.bannerColor === 'string' ? body.bannerColor : ''
      if (bannerColor === null || /^#[0-9a-fA-F]{6}$/.test(bannerColor)) {
        data.bannerColor = bannerColor
      } else {
        return badRequest('Banner color must be a hex value like #547cff.')
      }
    }
    if (body.regenerateInvite === true) {
      if (ctx.baseRole !== 'OWNER') {
        return forbidden('Only the owner can regenerate the invite code.')
      }
    }

    const server = await db.server.update({
      where: { id: serverId },
      data: {
        ...data,
        ...(body.regenerateInvite === true ? { inviteCode: generateInviteCode() } : {}),
      },
    })

    await logServerEvent({
      serverId,
      type: 'server_update',
      actorId: me.id,
      data: {
        ...data,
        ...(body.regenerateInvite === true ? { inviteRegenerated: true } : {}),
      },
    })

    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await emitToRooms(
      members.map((m) => userRoom(m.userId)),
      'server:refresh',
      { serverId }
    )

    return NextResponse.json({
      server: {
        id: server.id,
        name: server.name,
        description: server.description,
        iconUrl: server.iconUrl,
        bannerColor: server.bannerColor,
        inviteCode: server.inviteCode,
        ownerId: server.ownerId,
        createdAt: server.createdAt.toISOString(),
        blockedWords: server.blockedWords,
        visibility: server.visibility,
      },
    })
  } catch {
    return serverError()
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const server = await db.server.findUnique({ where: { id: serverId }, select: { ownerId: true } })
    if (!server) return notFound('Server not found.')
    if (server.ownerId !== me.id) return forbidden('Only the server owner can delete it.')

    const members = await db.serverMember.findMany({ where: { serverId }, select: { userId: true } })
    await db.server.delete({ where: { id: serverId } })
    await emitToRooms(
      members.map((m) => userRoom(m.userId)),
      'server:deleted',
      { serverId }
    )
    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
