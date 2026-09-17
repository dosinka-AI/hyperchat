/** Permission bitfield shared by the API routes and the client UI.
 *  Pure constants: importable from server and browser code alike.
 *
 *  How permissions are computed for a member of a server:
 *  - the server owner holds ADMINISTRATOR (everything, always)
 *  - the base rank ADMIN holds ADMIN_BASE_PERMS (everything except MANAGE_ROLES,
 *    mirroring the original "admins cannot change roles" rule)
 *  - everyone else gets the permissions of their custom role, if any
 */

export const PERM = {
  ADMINISTRATOR: 1 << 0,
  MANAGE_SERVER: 1 << 1,
  MANAGE_CHANNELS: 1 << 2,
  MANAGE_ROLES: 1 << 3,
  KICK_MEMBERS: 1 << 4,
  BAN_MEMBERS: 1 << 5,
  TIMEOUT_MEMBERS: 1 << 6,
  MANAGE_MESSAGES: 1 << 7,
  MENTION_EVERYONE: 1 << 8,
  MANAGE_NICKNAMES: 1 << 9,
  FANCY_FORMAT: 1 << 10,
} as const

export type PermKey = keyof typeof PERM

export const PERM_LABELS: Record<PermKey, string> = {
  ADMINISTRATOR: 'administrator',
  MANAGE_SERVER: 'manage server',
  MANAGE_CHANNELS: 'manage channels',
  MANAGE_ROLES: 'manage roles',
  KICK_MEMBERS: 'kick members',
  BAN_MEMBERS: 'ban members',
  TIMEOUT_MEMBERS: 'timeout members',
  MANAGE_MESSAGES: 'manage messages',
  MENTION_EVERYONE: 'mention everyone',
  MANAGE_NICKNAMES: 'manage nicknames',
  FANCY_FORMAT: 'rich formatting',
}

export const PERM_DESCRIPTIONS: Record<PermKey, string> = {
  ADMINISTRATOR: 'every permission below, bypasses private channel restrictions.',
  MANAGE_SERVER: 'rename the server, change icon, description, invite code and automod words.',
  MANAGE_CHANNELS: 'create, edit, delete and reorder channels and categories, set slowmode.',
  MANAGE_ROLES: 'create and edit roles, assign roles to members.',
  KICK_MEMBERS: 'remove members from the server. they can rejoin with an invite.',
  BAN_MEMBERS: 'ban members from the server and lift existing bans.',
  TIMEOUT_MEMBERS: 'temporarily stop a member from sending messages.',
  MANAGE_MESSAGES: 'delete other people\'s messages, purge in bulk, pin, and bypass slowmode and locks.',
  MENTION_EVERYONE: 'ping the whole server with @everyone and @here.',
  MANAGE_NICKNAMES: 'change other members\' server nicknames.',
  FANCY_FORMAT: 'send colored and resized text in this server (always allowed in dms and group chats).',
}

/** All the granular bits (excluding ADMINISTRATOR itself). */
export const GRANULAR_PERMS: PermKey[] = [
  'MANAGE_SERVER',
  'MANAGE_CHANNELS',
  'MANAGE_ROLES',
  'KICK_MEMBERS',
  'BAN_MEMBERS',
  'TIMEOUT_MEMBERS',
  'MANAGE_MESSAGES',
  'MENTION_EVERYONE',
  'MANAGE_NICKNAMES',
  'FANCY_FORMAT',
]

/** Everything a base-rank admin can do: all granular perms except MANAGE_ROLES. */
export const ADMIN_BASE_PERMS = GRANULAR_PERMS.reduce(
  (acc, key) => (key === 'MANAGE_ROLES' ? acc : acc | PERM[key]),
  0
)

export function hasPerm(perms: number, perm: number): boolean {
  return (perms & PERM.ADMINISTRATOR) !== 0 || (perms & perm) !== 0
}

export function permCount(perms: number): number {
  let count = 0
  if ((perms & PERM.ADMINISTRATOR) !== 0) return GRANULAR_PERMS.length + 1
  for (const key of GRANULAR_PERMS) {
    if ((perms & PERM[key]) !== 0) count++
  }
  return count
}

/** Preset swatches for the role editor: grayscale plus the one blue accent. */
export const ROLE_COLORS = [
  '#f5f5f5',
  '#9a9a9a',
  '#5a5a5a',
  '#547cff',
  '#4f9e63',
  '#c9a54e',
  '#c96e50',
  '#b05ac9',
  '#5ab8c9',
  '#c95a7a',
]
