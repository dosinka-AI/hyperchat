import type { CategorySummary, ChannelSummary, ChannelType, ServerMemberSummary, ServerSummary } from '@/lib/types'
import { ADMIN_BASE_PERMS, PERM } from '@/lib/perm'

type ChannelRow = {
  id: string
  serverId: string
  name: string
  topic: string | null
  position: number
  categoryId: string | null
  type?: string | null
  slowmodeSeconds?: number
  locked?: boolean
  private?: boolean
  access?: { roleId: string }[]
}

type CategoryRow = {
  id: string
  name: string
  position: number
}

type MemberRow = {
  role: string
  joinedAt: Date
  nickname?: string | null
  timeoutUntil?: Date | null
  customRole?: { id: string; name: string; color: string } | null
  user: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    avatarColor: string
    bio?: string
    role?: string
    customStatus?: string | null
  }
}

export function toChannelSummary(c: ChannelRow): ChannelSummary {
  const type = c.type === 'voice' || c.type === 'forum' ? c.type : 'text'
  return {
    id: c.id,
    serverId: c.serverId,
    name: c.name,
    topic: c.topic,
    position: c.position,
    categoryId: c.categoryId,
    type: type as ChannelType,
    slowmodeSeconds: c.slowmodeSeconds ?? 0,
    locked: c.locked ?? false,
    private: c.private ?? false,
    accessRoleIds: (c.access ?? []).map((a) => a.roleId),
  }
}

export function toCategorySummary(cat: CategoryRow): CategorySummary {
  return { id: cat.id, name: cat.name, position: cat.position }
}

export function toMemberSummary(m: MemberRow): ServerMemberSummary {
  return {
    id: m.user.id,
    username: m.user.username,
    displayName: m.user.displayName,
    avatarUrl: m.user.avatarUrl,
    avatarColor: m.user.avatarColor,
    bio: m.user.bio ?? '',
    role: m.role as ServerMemberSummary['role'],
    joinedAt: m.joinedAt.toISOString(),
    nickname: m.nickname ?? null,
    roleId: m.customRole?.id ?? null,
    roleName: m.customRole?.name ?? null,
    roleColor: m.customRole?.color ?? null,
    timeoutUntil: m.timeoutUntil ? m.timeoutUntil.toISOString() : null,
    customStatus: m.user.customStatus ?? null,
    siteAdmin: m.user.role === 'ADMIN',
  }
}

type ServerRow = {
  id: string
  name: string
  description: string
  iconUrl: string | null
  bannerColor?: string | null
  inviteCode: string
  ownerId: string
  channels: ChannelRow[]
  categories?: CategoryRow[]
  _count?: { members: number }
}

export function toServerSummary(
  server: ServerRow,
  memberCount: number,
  myRole: string,
  myPerms?: number
): ServerSummary {
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    iconUrl: server.iconUrl,
    bannerColor: server.bannerColor ?? null,
    inviteCode: server.inviteCode,
    ownerId: server.ownerId,
    memberCount,
    myRole: myRole as ServerSummary['myRole'],
    myPerms: myPerms ?? (myRole === 'OWNER' ? PERM.ADMINISTRATOR : myRole === 'ADMIN' ? ADMIN_BASE_PERMS : 0),
    channels: server.channels.map(toChannelSummary),
    categories: (server.categories ?? []).map(toCategorySummary),
  }
}

/** Permission helpers shared by every server management route. */
export function canManage(role: string | null | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN'
}

export function isOwner(role: string | null | undefined): boolean {
  return role === 'OWNER'
}
