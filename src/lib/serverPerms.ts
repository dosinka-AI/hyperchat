import { db } from './db'
import { ADMIN_BASE_PERMS, PERM, hasPerm } from './perm'

/** Everything the API routes need to know about one member of one server. */
export type MemberContext = {
  userId: string
  serverId: string
  ownerId: string
  baseRole: 'OWNER' | 'ADMIN' | 'MEMBER'
  /** effective permission bits (owner = ADMINISTRATOR) */
  perms: number
  roleId: string | null
  roleName: string | null
  roleColor: string | null
  nickname: string | null
  timeoutUntil: Date | null
  /** true while a moderation timeout is in effect */
  timedOut: boolean
  /** roles whose channels this member can read (for private channel gates) */
  canReadChannel: (channel: { private: boolean; access: { roleId: string }[] }) => boolean
}

export async function getMemberContext(serverId: string, userId: string): Promise<MemberContext | null> {
  const membership = await db.serverMember.findUnique({
    where: { userId_serverId: { userId, serverId } },
    include: { customRole: true },
  })
  if (!membership) return null
  const server = await db.server.findUnique({ where: { id: serverId }, select: { ownerId: true } })
  if (!server) return null

  const isOwner = server.ownerId === userId
  const baseRole = membership.role as MemberContext['baseRole']
  const perms = isOwner ? PERM.ADMINISTRATOR : baseRole === 'ADMIN' ? ADMIN_BASE_PERMS : membership.customRole?.permissions ?? 0
  const timedOut = !!membership.timeoutUntil && membership.timeoutUntil.getTime() > Date.now()

  return {
    userId,
    serverId,
    ownerId: server.ownerId,
    baseRole,
    perms,
    roleId: membership.customRole?.id ?? null,
    roleName: membership.customRole?.name ?? null,
    roleColor: membership.customRole?.color ?? null,
    nickname: membership.nickname,
    timeoutUntil: membership.timeoutUntil,
    timedOut,
    canReadChannel: (channel) => {
      if (!channel.private) return true
      if (hasPerm(perms, PERM.MANAGE_MESSAGES) || hasPerm(perms, PERM.ADMINISTRATOR)) return true
      if (!membership.customRole) return false
      return channel.access.some((a) => a.roleId === membership.customRole!.id)
    },
  }
}

/** Permission gate helper for routes: returns a context or null when not a member. */
export async function requirePerm(
  serverId: string,
  userId: string,
  perm: number
): Promise<{ ctx: MemberContext } | { error: 'not-member' | 'forbidden'; ctx: null }> {
  const ctx = await getMemberContext(serverId, userId)
  if (!ctx) return { error: 'not-member', ctx: null }
  if (!hasPerm(ctx.perms, perm)) return { error: 'forbidden', ctx: null }
  return { ctx }
}
