import type {
  AuditEventSummary,
  BanSummary,
  BookmarkSummary,
  ClientMessage,
  ConversationSummary,
  ForumTagSummary,
  FriendSummary,
  PublicUser,
  ReminderSummary,
  RoleSummary,
  ScheduledSummary,
  ServerDetail,
  ServerMemberSummary,
  ServerSummary,
  SessionUser,
  StickerSummary,
  SyncResponse,
  UserPresenceChoice,
  WhisperListSummary,
} from '@/lib/types'
import type { SoundboardSoundSummary } from './soundboard'

export class ApiError extends Error {
  status: number
  /** machine-readable error kind from the server (e.g. 'limit' for the
   *  group member cap) so the UI can branch on it */
  code?: string
  /** raw error body when the server sent extra fields */
  data?: unknown
  constructor(message: string, status: number, code?: string, data?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.data = data
  }
}

/** Sandbox gateway port-forwarding: when the page itself was loaded through
 *  the ?XTransformPort= convention (this app instance served on a non-default
 *  port behind the gateway), every relative API fetch must carry the same
 *  query parameter, or the gateway routes them to the default port instead
 *  of this instance. Inert everywhere else (no param on the page URL -> no
 *  suffix), and purely additive when a path already carries its own query. */
const GATEWAY_PORT_PARAM = 'XTransformPort'
let cachedGatewaySuffix: string | null = null
function gatewaySuffix(path: string): string {
  if (typeof window === 'undefined') return ''
  if (cachedGatewaySuffix === null) {
    const port = new URLSearchParams(window.location.search).get(GATEWAY_PORT_PARAM)
    cachedGatewaySuffix = port ? `${GATEWAY_PORT_PARAM}=${encodeURIComponent(port)}` : ''
  }
  if (!cachedGatewaySuffix) return ''
  return path.includes('?') ? `&${cachedGatewaySuffix}` : `?${cachedGatewaySuffix}`
}

async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init || {}
  const res = await fetch(path + gatewaySuffix(path), {
    ...rest,
    headers: {
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(rest.headers || {}),
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok) {
    const dataObj = data && typeof data === 'object' ? (data as Record<string, unknown>) : null
    const message =
      dataObj && typeof dataObj.error === 'string' ? dataObj.error : 'Something went wrong. Try again.'
    const code = dataObj && typeof dataObj.code === 'string' ? dataObj.code : undefined
    throw new ApiError(message, res.status, code, data)
  }
  return data as T
}

export type SearchResult = ClientMessage & { channelName?: string | null }

/** Admin panel row: one site account (Task 6-c). */
export type AdminUserSummary = {
  id: string
  username: string
  displayName: string | null
  email: string | null
  verified: boolean
  siteAdmin: boolean
  avatarUrl: string | null
  avatarColor: string
  createdAt: string
  serverCount: number
  messageCount: number
  lastMessageAt: string | null
  banned: { reason: string | null; bannedAt: string; bannedBy: string | null } | null
}

/** Admin panel row: one vault upload (Task 6-c). */
export type AdminVaultUpload = {
  id: string
  filename: string
  size: number
  mime: string
  status: string
  expiresAt: string
  downloadCount: number
  createdAt: string
  conversationId: string | null
  uploader: { username: string; avatarUrl: string | null; avatarColor: string } | null
}

/** Admin panel row: one audit event (Task 6-c). */
export type AdminAuditEvent = {
  id: string
  type: string
  serverId: string
  serverName: string
  actor: string | null
  target: string | null
  data: string
  createdAt: string
}

export const apiClient = {
  me: () => api<{ user: SessionUser | null }>('/api/auth/me'),

  register: (payload: { username: string; email?: string; password: string }) =>
    api<{ user: SessionUser; token: string }>('/api/auth/register', { method: 'POST', json: payload }),

  registerHint: () => api<{ emailRequired: boolean }>('/api/auth/register-hint'),

  login: (payload: { identifier: string; password: string }) =>
    api<{ user: SessionUser; token: string }>('/api/auth/login', { method: 'POST', json: payload }),

  switchAccount: (token: string) =>
    api<{ user: SessionUser; token: string }>('/api/auth/switch', { method: 'POST', json: { token } }),

  logout: () => api<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  sendEmailCode: (payload: { email: string; purpose: 'verify' | 'password' }) =>
    api<{ delivery: 'inline' | 'email'; code?: string; expiresAt: string; ttlSeconds: number }>(
      '/api/email/code',
      { method: 'POST', json: payload }
    ),

  verifyEmail: (payload: { email: string; code: string }) =>
    api<{ user: SessionUser }>('/api/email/verify', { method: 'POST', json: payload }),

  // profile
  updateProfile: (payload: {
    displayName?: string | null
    bio?: string
    avatarUrl?: string | null
    avatarColor?: string
    customStatus?: string | null
    pronouns?: string | null
    presence?: UserPresenceChoice
    bannerColor?: string | null
    bannerUrl?: string | null
  }) => api<{ user: SessionUser }>('/api/users/me', { method: 'PATCH', json: payload }),

  changePassword: (payload: { currentPassword: string; newPassword: string; code: string }) =>
    api<{ ok: boolean }>('/api/users/me/password', { method: 'PATCH', json: payload }),

  userProfile: (username: string) =>
    api<{ user: PublicUser; mutualServers: string[] }>(`/api/users/${encodeURIComponent(username)}`),

  searchUsers: (q: string) => api<{ users: PublicUser[] }>(`/api/users?q=${encodeURIComponent(q)}`),

  // servers
  servers: () => api<{ servers: ServerSummary[] }>('/api/servers'),

  createServer: (payload: { name: string; description?: string }) =>
    api<{ server: ServerSummary }>('/api/servers', { method: 'POST', json: payload }),

  joinServer: (inviteCode: string) =>
    api<{ server: ServerSummary; alreadyMember: boolean }>('/api/servers/join', {
      method: 'POST',
      json: { inviteCode },
    }),

  serverDetail: (serverId: string) => api<ServerDetail>(`/api/servers/${serverId}`),

  updateServer: (
    serverId: string,
    payload: { name?: string; description?: string; iconUrl?: string | null; regenerateInvite?: boolean; blockedWords?: string; visibility?: 'PRIVATE' | 'PUBLIC'; bannerColor?: string | null; callChannelsEnabled?: boolean; allowGuestRings?: boolean }
  ) => api<{ server: ServerDetail['server'] }>(`/api/servers/${serverId}`, { method: 'PATCH', json: payload }),

  /** public servers for the Discover browser */
  browseServers: (q: string) =>
    api<{ servers: { id: string; name: string; description: string; iconUrl: string | null; memberCount: number }[] }>(
      `/api/servers/browse?q=${encodeURIComponent(q)}`
    ),

  /** join a public server straight from the browser (no invite needed) */
  joinServerById: (serverId: string) =>
    api<{ server: ServerSummary; alreadyMember: boolean }>(`/api/servers/${serverId}/join`, { method: 'POST' }),

  deleteServer: (serverId: string) => api<{ ok: boolean }>(`/api/servers/${serverId}`, { method: 'DELETE' }),

  leaveServer: (serverId: string) => api<{ ok: boolean }>(`/api/servers/${serverId}/leave`, { method: 'POST' }),

  // members
  setMemberRole: (serverId: string, userId: string, role: 'ADMIN' | 'MEMBER') =>
    api<{ ok: boolean; role: string }>(`/api/servers/${serverId}/members/${userId}`, {
      method: 'PATCH',
      json: { role },
    }),

  setMemberCustomRole: (serverId: string, userId: string, roleId: string | null) =>
    api<{ ok: boolean }>(`/api/servers/${serverId}/members/${userId}`, {
      method: 'PATCH',
      json: { roleId },
    }),

  setMemberNickname: (serverId: string, userId: string, nickname: string | null) =>
    api<{ ok: boolean }>(`/api/servers/${serverId}/members/${userId}`, {
      method: 'PATCH',
      json: { nickname },
    }),

  timeoutMember: (serverId: string, userId: string, minutes: number | null) =>
    api<{ ok: boolean }>(`/api/servers/${serverId}/members/${userId}`, {
      method: 'PATCH',
      json: { timeoutMinutes: minutes },
    }),

  kickMember: (serverId: string, userId: string, reason?: string) =>
    api<{ ok: boolean }>(`/api/servers/${serverId}/members/${userId}`, {
      method: 'DELETE',
      json: reason ? { reason } : undefined,
    }),

  // roles
  serverRoles: (serverId: string) =>
    api<{ roles: RoleSummary[] }>(`/api/servers/${serverId}/roles`),

  createRole: (serverId: string, payload: { name: string; color?: string; permissions?: number }) =>
    api<{ role: RoleSummary }>(`/api/servers/${serverId}/roles`, { method: 'POST', json: payload }),

  updateRole: (
    serverId: string,
    roleId: string,
    payload: { name?: string; color?: string; permissions?: number; direction?: 1 | -1 }
  ) => api<{ role: { id: string } }>(`/api/servers/${serverId}/roles/${roleId}`, { method: 'PATCH', json: payload }),

  deleteRole: (serverId: string, roleId: string) =>
    api<{ ok: boolean }>(`/api/servers/${serverId}/roles/${roleId}`, { method: 'DELETE' }),

  // bans
  bans: (serverId: string) => api<{ bans: BanSummary[] }>(`/api/servers/${serverId}/bans`),

  banMember: (serverId: string, userId: string, reason?: string) =>
    api<{ ok: boolean }>(`/api/servers/${serverId}/bans`, { method: 'POST', json: { userId, reason } }),

  unbanUser: (serverId: string, userId: string) =>
    api<{ ok: boolean }>(`/api/servers/${serverId}/bans/${userId}`, { method: 'DELETE' }),

  // channels and categories
  createChannel: (serverId: string, payload: { name: string; topic?: string; categoryId?: string | null; type?: 'text' | 'voice' | 'forum' }) =>
    api<{ channel: ServerSummary['channels'][number] }>(`/api/servers/${serverId}/channels`, {
      method: 'POST',
      json: payload,
    }),

  createCategory: (serverId: string, name: string) =>
    api<{ category: { id: string; name: string; position: number } }>(`/api/servers/${serverId}/channels`, {
      method: 'PUT',
      json: { name },
    }),

  updateChannel: (
    channelId: string,
    payload: {
      name?: string
      topic?: string
      slowmodeSeconds?: number
      locked?: boolean
      private?: boolean
      accessRoleIds?: string[]
    }
  ) =>
    api<{ channel: ServerSummary['channels'][number] }>(`/api/channels/${channelId}`, {
      method: 'PATCH',
      json: payload,
    }),

  purgeChannel: (channelId: string, count: number, userId?: string) =>
    api<{ ok: boolean; deleted: number }>(`/api/channels/${channelId}/purge`, {
      method: 'POST',
      json: { count, userId },
    }),

  deleteChannel: (channelId: string) =>
    api<{ ok: boolean }>(`/api/channels/${channelId}`, { method: 'DELETE' }),

  reorderChannels: (serverId: string, orderedIds: string[]) =>
    api<{ ok: boolean }>(`/api/servers/${serverId}/channels/reorder`, {
      method: 'POST',
      json: { orderedIds },
    }),

  /** rename a channel category */
  updateCategory: (categoryId: string, payload: { name: string }) =>
    api<{ category: { id: string; name: string; position: number } }>(`/api/categories/${categoryId}`, {
      method: 'PATCH',
      json: payload,
    }),

  deleteCategory: (categoryId: string) =>
    api<{ ok: boolean }>(`/api/categories/${categoryId}`, { method: 'DELETE' }),

  reorderCategories: (serverId: string, orderedIds: string[]) =>
    api<{ ok: boolean }>(`/api/servers/${serverId}/categories/reorder`, {
      method: 'POST',
      json: { orderedIds },
    }),

  // audit log
  serverEvents: (serverId: string) =>
    api<{ events: AuditEventSummary[] }>(`/api/servers/${serverId}/events`),

  // custom server emoji
  serverEmoji: (serverId: string) =>
    api<{ emoji: { id: string; serverId: string; name: string; url: string; addedById: string }[] }>(
      `/api/servers/${serverId}/emoji`
    ),

  addServerEmoji: (serverId: string, payload: { name: string; url: string }) =>
    api<{ emoji: { id: string; serverId: string; name: string; url: string; addedById: string } }>(
      `/api/servers/${serverId}/emoji`,
      { method: 'POST', json: payload }
    ),

  removeServerEmoji: (serverId: string, emojiId: string) =>
    api<{ ok: boolean }>(`/api/servers/${serverId}/emoji/${emojiId}`, { method: 'DELETE' }),

  // server soundboard (admin-uploaded sound files)
  serverSounds: (serverId: string) =>
    api<{ sounds: SoundboardSoundSummary[] }>(`/api/servers/${serverId}/soundboard`),

  addServerSound: (serverId: string, payload: { name: string; url: string; size: number; mime: string }) =>
    api<{ sound: SoundboardSoundSummary }>(`/api/servers/${serverId}/soundboard`, {
      method: 'POST',
      json: payload,
    }),

  removeServerSound: (serverId: string, soundId: string) =>
    api<{ ok: boolean }>(`/api/servers/${serverId}/soundboard/${soundId}`, { method: 'DELETE' }),

  // server stickers (admin-uploaded big reaction images)
  serverStickers: (serverId: string) =>
    api<{ stickers: StickerSummary[] }>(`/api/servers/${serverId}/stickers`),

  addServerSticker: (serverId: string, payload: { name: string; url: string; size: number; mime: string }) =>
    api<{ sticker: StickerSummary }>(`/api/servers/${serverId}/stickers`, {
      method: 'POST',
      json: payload,
    }),

  removeServerSticker: (serverId: string, stickerId: string) =>
    api<{ ok: boolean }>(`/api/servers/${serverId}/stickers/${stickerId}`, { method: 'DELETE' }),

  // saved whisper lists (named multi-whisper presets)
  whisperLists: () =>
    api<{ lists: WhisperListSummary[] }>('/api/whisper-lists'),

  addWhisperList: (payload: { name: string; memberIds: string[] }) =>
    api<{ list: WhisperListSummary }>('/api/whisper-lists', {
      method: 'POST',
      json: payload,
    }),

  removeWhisperList: (listId: string) =>
    api<{ ok: boolean }>(`/api/whisper-lists/${listId}`, { method: 'DELETE' }),

  // friends
  friends: () =>
    api<{ friends: FriendSummary[]; incoming: FriendSummary[]; outgoing: FriendSummary[] }>('/api/friends'),

  sendFriendRequest: (payload: { username: string; temporaryHours?: number }) =>
    api<{ friendship: { id: string; status: string } }>('/api/friends', { method: 'POST', json: payload }),

  /** private nickname or temporary/permanent flip on an accepted friendship */
  updateFriendship: (
    friendshipId: string,
    payload: { nickname?: string; temporary?: boolean; hours?: number }
  ) => api<{ ok: boolean }>(`/api/friends/${friendshipId}`, { method: 'PATCH', json: payload }),

  acceptFriendRequest: (friendshipId: string) =>
    api<{ ok: boolean }>(`/api/friends/${friendshipId}`, { method: 'POST' }),

  removeFriendship: (friendshipId: string) =>
    api<{ ok: boolean }>(`/api/friends/${friendshipId}`, { method: 'DELETE' }),

  // blocks
  blockedUsers: () => api<{ blocked: PublicUser[] }>('/api/blocks'),

  blockUser: (payload: { username?: string; userId?: string }) =>
    api<{ ok: boolean; user: PublicUser }>('/api/blocks', { method: 'POST', json: payload }),

  unblockUser: (userId: string) =>
    api<{ ok: boolean }>(`/api/blocks/${userId}`, { method: 'DELETE' }),

  // mutes
  toggleMute: (scope: string) =>
    api<{ muted: boolean }>('/api/mutes', { method: 'POST', json: { scope } }),

  // messages
  channelMessages: (channelId: string, before?: string, after?: string, anchor?: string) =>
    api<{ messages: ClientMessage[]; hasMore: boolean; hasNewer?: boolean; oldestCursor: string | null; myReadAt: string | null; friendReadAt?: Record<string, string> }>(
      `/api/channels/${channelId}/messages${before ? `?before=${encodeURIComponent(before)}` : after ? `?after=${encodeURIComponent(after)}` : anchor ? `?anchor=${encodeURIComponent(anchor)}` : ''}`
    ),

  sendChannelMessage: (
    channelId: string,
    payload: { content?: string; imageUrl?: string; replyToId?: string; nonce?: string; whisperTo?: string; threadOfId?: string; stickerId?: string; attachments?: { url: string; name: string; size: number; mime: string }[] }
  ) =>
    api<{ message: ClientMessage }>(`/api/channels/${channelId}/messages`, { method: 'POST', json: payload }),

  conversationMessages: (conversationId: string, before?: string, after?: string, anchor?: string) =>
    api<{ messages: ClientMessage[]; hasMore: boolean; hasNewer?: boolean; oldestCursor: string | null; myReadAt: string | null }>(
      `/api/conversations/${conversationId}/messages${before ? `?before=${encodeURIComponent(before)}` : after ? `?after=${encodeURIComponent(after)}` : anchor ? `?anchor=${encodeURIComponent(anchor)}` : ''}`
    ),

  messageContext: (messageId: string) =>
    api<{ room: string; channelId?: string; conversationId?: string; threadOfId?: string | null }>(
      `/api/messages/${messageId}/context`
    ),

  sendConversationMessage: (
    conversationId: string,
    payload: { content?: string; imageUrl?: string; replyToId?: string; nonce?: string; whisperTo?: string; threadOfId?: string; attachments?: { url: string; name: string; size: number; mime: string }[]; fileId?: string }
  ) =>
    api<{ message: ClientMessage }>(`/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      json: payload,
    }),

  // THE VAULT: ephemeral chunked file sends (init → raw chunk PUTs → complete)
  vaultInit: (payload: { filename: string; size: number; mime?: string; conversationId: string }) =>
    api<{ id: string; chunkSize: number; totalChunks: number; expiresAt: string }>('/api/files/init', {
      method: 'POST',
      json: payload,
    }),

  vaultComplete: (uploadId: string) =>
    api<{
      file: {
        id: string
        filename: string
        mime: string
        size: number
        sha256: string | null
        status: string
        expiresAt: string
      }
    }>(`/api/files/${uploadId}/complete`, { method: 'POST' }),

  /** uploader-only early kill: wipes the chunk files + rows */
  vaultDeleteFile: (uploadId: string) =>
    api<{ ok: boolean }>(`/api/files/${uploadId}`, { method: 'DELETE' }),

  /** whole thread: the root row plus every reply under it */
  threadMessages: (messageId: string) =>
    api<{ root: ClientMessage; messages: ClientMessage[]; count: number }>(`/api/messages/${messageId}/thread`),

  // forum channels
  channelVoice: (channelId: string) =>
    api<{ participants: import('@/lib/types').VoiceParticipantSummary[] }>(`/api/channels/${channelId}/voice`),

  forumPosts: (channelId: string, opts?: { cursor?: string; limit?: number; sort?: 'latest' | 'new' }) =>
    api<{ posts: import('@/lib/types').ForumPostSummary[] }>(
      `/api/channels/${channelId}/posts${opts?.cursor ? `?cursor=${encodeURIComponent(opts.cursor)}` : ''}${opts?.sort ? `${opts?.cursor ? '&' : '?'}sort=${opts.sort}` : ''}${opts?.limit ? `${opts?.cursor || opts?.sort ? '&' : '?'}limit=${opts.limit}` : ''}`
    ),

  createForumPost: (channelId: string, payload: { title: string; content?: string; tags?: string[] }) =>
    api<{ post: import('@/lib/types').ForumPostSummary }>(`/api/channels/${channelId}/posts`, {
      method: 'POST',
      json: payload,
    }),

  updateForumPost: (postId: string, payload: { title?: string; pinned?: boolean; locked?: boolean; tags?: string[] }) =>
    api<{ post: import('@/lib/types').ForumPostSummary }>(`/api/posts/${postId}`, {
      method: 'PATCH',
      json: payload,
    }),

  deleteForumPost: (postId: string) => api<{ ok: boolean }>(`/api/posts/${postId}`, { method: 'DELETE' }),

  sendForumReply: (postId: string, payload: { content: string }) =>
    api<{ message: ClientMessage }>(`/api/posts/${postId}/replies`, { method: 'POST', json: payload }),

  // forum channel tags (colored chips, admin-managed per channel)
  forumTags: (channelId: string) =>
    api<{ tags: ForumTagSummary[] }>(`/api/channels/${channelId}/forum-tags`),

  addForumTag: (channelId: string, payload: { name: string; color: string }) =>
    api<{ tag: ForumTagSummary }>(`/api/channels/${channelId}/forum-tags`, {
      method: 'POST',
      json: payload,
    }),

  removeForumTag: (channelId: string, tagId: string) =>
    api<{ ok: boolean }>(`/api/channels/${channelId}/forum-tags/${tagId}`, { method: 'DELETE' }),

  /** copy a message into another room with "forwarded from" attribution */
  forwardMessage: (messageId: string, payload: { targetType: 'channel' | 'conversation'; targetId: string }) =>
    api<{ message: ClientMessage }>(`/api/messages/${messageId}/forward`, { method: 'POST', json: payload }),

  /** translate a message body into English (LLM-backed) */
  translate: (text: string) =>
    api<{ text: string }>('/api/translate', { method: 'POST', json: { text } }),

  editMessage: (messageId: string, content: string) =>
    api<{ message: ClientMessage }>(`/api/messages/${messageId}`, { method: 'PATCH', json: { content } }),

  deleteMessage: (messageId: string) => api<{ ok: boolean }>(`/api/messages/${messageId}`, { method: 'DELETE' }),

  toggleReaction: (messageId: string, emoji: string) =>
    api<{ messageId: string; room: string; reactions: { emoji: string; userIds: string[] }[] }>(
      `/api/messages/${messageId}/reactions`,
      { method: 'POST', json: { emoji } }
    ),

  // saved gifs (kept from other people's messages)
  savedGifs: () => api<{ gifs: { id: string; url: string; title: string }[] }>('/api/gifs/saved'),

  saveGif: (url: string, title: string) =>
    api<{ gif: { id: string; url: string; title: string } }>('/api/gifs/saved', {
      method: 'POST',
      json: { url, title },
    }),

  removeSavedGif: (url: string) =>
    api<{ ok: boolean }>(`/api/gifs/saved?url=${encodeURIComponent(url)}`, { method: 'DELETE' }),

  pinMessage: (messageId: string) =>
    api<{ message: ClientMessage }>(`/api/messages/${messageId}/pin`, { method: 'POST' }),

  unpinMessage: (messageId: string) =>
    api<{ message: ClientMessage }>(`/api/messages/${messageId}/pin`, { method: 'DELETE' }),

  channelPins: (channelId: string) =>
    api<{ messages: ClientMessage[] }>(`/api/channels/${channelId}/pins`),

  conversationPins: (conversationId: string) =>
    api<{ messages: ClientMessage[] }>(`/api/conversations/${conversationId}/pins`),

  // read states
  markRead: (scope: string) => api<{ ok: boolean; lastReadAt: string }>('/api/read', { method: 'POST', json: { scope } }),

  // conversations
  conversations: () => api<{ conversations: ConversationSummary[] }>('/api/conversations'),

  createConversation: (userId: string) =>
    api<{ conversationId: string; existing: boolean }>('/api/conversations', { method: 'POST', json: { userId } }),

  /** create a group conversation: me + 2-4 members */
  createGroup: (name: string, memberIds: string[]) =>
    api<{ conversationId: string; existing: boolean }>('/api/conversations', {
      method: 'POST',
      json: { kind: 'GROUP', name, memberIds },
    }),

  hideConversation: (conversationId: string) =>
    api<{ ok: boolean }>(`/api/conversations/${conversationId}/hide`, { method: 'POST' }),

  pinConversation: (conversationId: string) =>
    api<{ ok: boolean; pinned: boolean }>(`/api/conversations/${conversationId}/pin`, { method: 'POST' }),

  /** rename a group, set its photo (null = back to stacked members), raise
   *  its member limit 5 -> 50, or set the DM temporary-message window */
  updateConversation: (
    conversationId: string,
    payload: { name?: string; iconUrl?: string | null; raiseLimit?: boolean; tempExpiryMinutes?: number | null }
  ) =>
    api<{ conversation: { id: string; kind: string; name: string | null; limitRaised: boolean; tempExpiryMinutes: number | null } }>(
      `/api/conversations/${conversationId}`,
      { method: 'PATCH', json: payload }
    ),

  /** add a member to a group; a 409 { code: 'limit' } means the cap was hit */
  addGroupMember: (conversationId: string, userId: string) =>
    api<{ ok: boolean; memberCount: number }>(`/api/conversations/${conversationId}/members`, {
      method: 'POST',
      json: { userId },
    }),

  /** leave a group (the participant row is actually removed) */
  leaveGroup: (conversationId: string) =>
    api<{ ok: boolean }>(`/api/conversations/${conversationId}/members/me`, { method: 'DELETE' }),

  /** kick a member from a group (owner only; the kicked user is notified) */
  kickGroupMember: (conversationId: string, userId: string) =>
    api<{ ok: boolean }>(`/api/conversations/${conversationId}/members/${userId}`, { method: 'DELETE' }),

  /** raise or lower a group's member limit between 5 and 50 (owner only) */
  setGroupLimit: (conversationId: string, raised: boolean) =>
    api<{ conversation: { id: string; kind: string; name: string | null; ownerId: string | null; limitRaised: boolean; tempExpiryMinutes: number | null } }>(
      `/api/conversations/${conversationId}`,
      { method: 'PATCH', json: { limitRaised: raised } }
    ),

  /** group settings (owner only): who can edit the name/photo and invite */
  setGroupPolicies: (conversationId: string, editPolicy: 'ALL' | 'OWNER', invitePolicy: 'ALL' | 'OWNER') =>
    api<{ conversation: { id: string; kind: string; name: string | null; ownerId: string | null; editPolicy: string; invitePolicy: string } }>(
      `/api/conversations/${conversationId}`,
      { method: 'PATCH', json: { editPolicy, invitePolicy } }
    ),

  /** group call setting (owner only): may members ring non-members into
   *  this group's calls ("cross-ringing")? */
  setGroupCrossRing: (conversationId: string, allowed: boolean) =>
    api<{ conversation: { id: string; kind: string; name: string | null; ownerId: string | null; allowCrossRing: boolean } }>(
      `/api/conversations/${conversationId}`,
      { method: 'PATCH', json: { allowCrossRing: allowed } }
    ),

  // search
  searchMessages: (q: string, opts?: { serverId?: string; conversationId?: string; conversationsOnly?: boolean }) =>
    api<{ messages: SearchResult[] }>(
      `/api/search?q=${encodeURIComponent(q)}${opts?.serverId ? `&serverId=${opts.serverId}` : ''}${opts?.conversationId ? `&conversationId=${opts.conversationId}` : ''}${opts?.conversationsOnly ? `&scope=conversations` : ''}`
    ),

  // ai summary of the most recent messages in a room (30s per-user cooldown
  // server-side; a too-soon run rejects with 429 { error, retryAfter })
  summarize: (room: string, count: number) =>
    api<{ summary: string; summarized: number; from: string; to: string; took: number }>('/api/summarize', {
      method: 'POST',
      json: { room, count },
    }),

  // sync fallback
  sync: (room: string) => api<SyncResponse>(`/api/sync?room=${encodeURIComponent(room)}`),

  // call log rows ("x started a call" system messages)
  createCallLog: (conversationId: string, opts?: { video?: boolean }) =>
    api<{ message: ClientMessage }>(`/api/conversations/${conversationId}/call-log`, {
      method: 'POST',
      json: { video: opts?.video === true },
    }),
  patchCallLog: (
    conversationId: string,
    payload: { messageId: string; durationSec?: number | null; missed?: boolean }
  ) =>
    api<{ message: ClientMessage }>(`/api/conversations/${conversationId}/call-log`, {
      method: 'PATCH',
      json: payload,
    }),

  // bookmarks (personal saved messages)
  bookmarks: () => api<{ bookmarks: BookmarkSummary[] }>('/api/bookmarks'),
  toggleBookmark: (messageId: string, opts?: { note?: string; remove?: boolean }) =>
    api<{ saved: boolean; note?: string }>('/api/bookmarks', {
      method: 'POST',
      json: { messageId, ...opts },
    }),

  // scheduled messages
  scheduled: () => api<{ scheduled: ScheduledSummary[] }>('/api/scheduled'),
  scheduleMessage: (payload: { scopeKey: string; content: string; sendAt: string }) =>
    api<{ scheduled: ScheduledSummary }>('/api/scheduled', { method: 'POST', json: payload }),
  cancelScheduled: (id: string) => api<{ ok: boolean }>('/api/scheduled', { method: 'DELETE', json: { id } }),

  // reminders
  reminders: () => api<{ reminders: ReminderSummary[] }>('/api/reminders'),
  createReminder: (messageId: string, remindAt: string) =>
    api<{ reminder: { id: string; messageId: string; remindAt: string } }>('/api/reminders', {
      method: 'POST',
      json: { messageId, remindAt },
    }),
  cancelReminder: (id: string) => api<{ ok: boolean }>('/api/reminders', { method: 'DELETE', json: { id } }),

  // client discovery check: the github txt the owner updates by hand —
  // clients read it directly; this is the panel's optional sanity window
  bootstrap: () =>
    api<{ configured: boolean; bootstrapUrl: string | null; address: string | null; addressAt: string | null; ok: boolean; error?: string }>(
      '/api/bootstrap'
    ),

  adminSetBootstrap: (payload: { bootstrapUrl?: string; refresh?: boolean }) =>
    api<{ configured: boolean; bootstrapUrl: string | null; address: string | null; addressAt: string | null; ok: boolean; error?: string }>(
      '/api/admin/bootstrap',
      { method: 'PUT', json: payload }
    ),

  // site admin panel (Task 6-c)
  adminOverview: () =>
    api<{
      users: { total: number; verified: number; newLast7d: number }
      messages: { total: number; last24h: number }
      servers: { total: number }
      vault: { uploads: number; readyBytes: number; uploading: number; expiredSoon: number; diskUsageBytes: number }
      onlineNow: number
    }>('/api/admin/overview'),

  adminUsers: (query: string, page = 1) =>
    api<{ users: AdminUserSummary[]; page: number; pageSize: number; total: number }>(
      `/api/admin/users?query=${encodeURIComponent(query)}&page=${page}`
    ),

  adminUserAction: (userId: string, action: 'verify' | 'admin' | 'ban' | 'unban', reason?: string) =>
    api<{ user: AdminUserSummary }>(`/api/admin/users/${userId}`, {
      method: 'PUT',
      json: { action, reason },
    }),

  adminVault: (page = 1) =>
    api<{ uploads: AdminVaultUpload[]; page: number; pageSize: number; total: number }>(
      `/api/admin/vault?page=${page}`
    ),

  adminVaultExpire: (uploadId: string) =>
    api<{ ok: boolean }>(`/api/admin/vault/${uploadId}`, { method: 'DELETE' }),

  adminAudit: () =>
    api<{ events: AdminAuditEvent[] }>('/api/admin/audit'),

  // upload
  uploadImage: async (blob: Blob): Promise<{ url: string; name: string; size: number; type: string }> => {
    const form = new FormData()
    const ext = blob.type.split('/')[1] || 'png'
    form.append('file', blob, `upload.${ext}`)
    return api<{ url: string; name: string; size: number; type: string }>('/api/upload', { method: 'POST', body: form })
  },

  /** Upload any attachment kind (keeps the original filename for the chip). */
  uploadFile: async (file: File): Promise<{ url: string; name: string; size: number; type: string }> => {
    const form = new FormData()
    form.append('file', file, file.name)
    return api<{ url: string; name: string; size: number; type: string }>('/api/upload', { method: 'POST', body: form })
  },

  // profile system: extended profile, posts, likes, comments, follows, stories
  profileShow: (username: string) =>
    api<{
      user: {
        id: string
        username: string
        displayName: string | null
        avatarUrl: string | null
        avatarColor: string
        bio: string
        role: string
        customStatus: string | null
        pronouns: string | null
        bannerColor: string | null
        bannerUrl: string | null
        createdAt: string
      }
      stats: { posts: number; followers: number; following: number }
      isFollowing: boolean
      hasActiveStory: boolean
      hasUnwatchedStory: boolean
      stories: { id: string; imageUrl: string; createdAt: string; expiresAt: string; viewed: boolean }[]
    }>(`/api/users/${encodeURIComponent(username)}/profile`),

  profilePosts: (username: string, offset: number) =>
    api<{
      posts: { id: string; imageUrl: string; caption: string; likeCount: number; commentCount: number; createdAt: string }[]
      nextOffset: number | null
    }>(`/api/posts?username=${encodeURIComponent(username)}&offset=${offset}`),

  createProfilePost: (payload: { imageUrl: string; caption: string }) =>
    api<{ post: { id: string; imageUrl: string; caption: string; likeCount: number; commentCount: number; createdAt: string } }>(
      '/api/posts',
      { method: 'POST', json: payload }
    ),

  profilePost: (postId: string) =>
    api<{
      post: {
        id: string
        imageUrl: string
        caption: string
        createdAt: string
        likeCount: number
        commentCount: number
        likedByMe: boolean
        author: ProfileUserBrief
      }
      comments: { id: string; text: string; createdAt: string; author: ProfileUserBrief }[]
    }>(`/api/posts/${encodeURIComponent(postId)}`),

  deleteProfilePost: (postId: string) =>
    api<{ ok: boolean }>(`/api/posts/${encodeURIComponent(postId)}`, { method: 'DELETE' }),

  setProfilePostLike: (postId: string, liked: boolean) =>
    api<{ liked: boolean; likeCount: number }>(`/api/posts/${encodeURIComponent(postId)}/like`, {
      method: liked ? 'POST' : 'DELETE',
    }),

  profilePostComments: (postId: string, cursor?: { before: string; beforeId: string }) =>
    api<{
      comments: { id: string; text: string; createdAt: string; author: ProfileUserBrief }[]
      more: boolean
      nextBefore: { before: string; beforeId: string } | null
    }>(
      `/api/posts/${encodeURIComponent(postId)}/comments${
        cursor ? `?before=${encodeURIComponent(cursor.before)}&beforeId=${encodeURIComponent(cursor.beforeId)}` : ''
      }`
    ),

  addProfilePostComment: (postId: string, text: string) =>
    api<{ comment: { id: string; text: string; createdAt: string; author: ProfileUserBrief } }>(
      `/api/posts/${encodeURIComponent(postId)}/comments`,
      { method: 'POST', json: { text } }
    ),

  deleteProfilePostComment: (postId: string, commentId: string) =>
    api<{ ok: boolean }>(`/api/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}`, {
      method: 'DELETE',
    }),

  followUser: (username: string) =>
    api<{ following: boolean; followersCount: number }>(`/api/users/${encodeURIComponent(username)}/follow`, {
      method: 'POST',
    }),

  unfollowUser: (username: string) =>
    api<{ following: boolean; followersCount: number }>(`/api/users/${encodeURIComponent(username)}/follow`, {
      method: 'DELETE',
    }),

  followList: (username: string, list: 'followers' | 'following') =>
    api<{ list: string; users: ProfileUserBrief[] }>(
      `/api/users/${encodeURIComponent(username)}/follow?list=${list}`
    ),

  createStory: (imageUrl: string) =>
    api<{ story: { id: string; imageUrl: string; createdAt: string; expiresAt: string } }>('/api/stories', {
      method: 'POST',
      json: { imageUrl },
    }),

  storyFeed: () =>
    api<{ groups: { user: ProfileUserBrief; allViewed: boolean; latestAt: string; stories: { id: string; imageUrl: string; createdAt: string; expiresAt: string; viewed: boolean }[] }[] }>(
      '/api/stories/feed'
    ),

  viewStory: (storyId: string) =>
    api<{ ok: boolean }>(`/api/stories/${encodeURIComponent(storyId)}/view`, { method: 'POST' }),
}

/** Minimal user shape the profile system surfaces in comments, story trays
 *  and follow lists. Kept here (next to the apiClient methods that return it)
 *  so no other module needs editing. */
export type ProfileUserBrief = {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  avatarColor: string
}
