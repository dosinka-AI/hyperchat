import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { generateInviteCode } from '@/lib/messages'
import { badRequest, serverError, unauthorized } from '@/lib/realtime'
import { toServerSummary } from '@/lib/serialize'
import { ADMIN_BASE_PERMS, PERM } from '@/lib/perm'

function permsOf(role: string, rolePerms: number | null | undefined, isOwner: boolean): number {
  if (isOwner) return PERM.ADMINISTRATOR
  if (role === 'ADMIN') return ADMIN_BASE_PERMS
  return rolePerms ?? 0
}

export async function GET() {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const memberships = await db.serverMember.findMany({
      where: { userId: me.id },
      include: {
        customRole: { select: { id: true, permissions: true } },
        server: {
          include: {
            channels: {
              orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
              include: { access: { select: { roleId: true } } },
            },
            categories: { orderBy: { position: 'asc' } },
            _count: { select: { members: true } },
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    })

    return NextResponse.json({
      servers: memberships.map((m) => {
        const myPerms = permsOf(m.role, m.customRole?.permissions, m.server.ownerId === me.id)
        // private channels stay hidden unless the member's role can read them or they moderate
        const mod = (myPerms & (PERM.ADMINISTRATOR | PERM.MANAGE_MESSAGES)) !== 0
        const roleId = m.customRole?.id ?? null
        const channels = m.server.channels.filter((ch) => {
          if (!ch.private) return true
          if (mod) return true
          return roleId ? ch.access.some((a) => a.roleId === roleId) : false
        })
        return toServerSummary({ ...m.server, channels }, m.server._count.members, m.role, myPerms)
      }),
    })
  } catch {
    return serverError()
  }
}

export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json()
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 300) : ''
    if (name.length < 2 || name.length > 40) {
      return badRequest('Server name must be 2 to 40 characters.')
    }

    // Email gate: creating counts as using a server. If this account has
    // ever been in any other server (all-time join log), a verified email
    // is required first.
    const priorServers = await db.serverJoinLog.count({ where: { userId: me.id } })
    if (priorServers >= 1 && !(me.email && me.emailVerifiedAt)) {
      return NextResponse.json(
        { error: 'Verify an email to join more than one server.', code: 'EMAIL_REQUIRED' },
        { status: 403 }
      )
    }

    const server = await db.server.create({
      data: {
        name,
        description,
        inviteCode: generateInviteCode(),
        ownerId: me.id,
        channels: {
          create: [{ name: 'general', position: 0 }],
        },
        members: {
          create: [{ userId: me.id, role: 'OWNER' }],
        },
        joinLogs: {
          create: [{ userId: me.id }],
        },
      },
      include: {
        channels: {
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
          include: { access: { select: { roleId: true } } },
        },
        categories: { orderBy: { position: 'asc' } },
        _count: { select: { members: true } },
      },
    })

    return NextResponse.json(
      { server: toServerSummary(server, server._count.members, 'OWNER', PERM.ADMINISTRATOR) },
      { status: 201 }
    )
  } catch (err) {
    console.error('[servers POST]', err)
    return serverError()
  }
}
