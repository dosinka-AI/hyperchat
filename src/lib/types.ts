// Shared types between API routes and client components

export type PublicUser = {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  avatarColor: string
  bio?: string
  role?: string
  customStatus?: string | null
  pronouns?: string | null
  bannerColor?: string | null
  bannerUrl?: string | null
  createdAt?: string
}

export type SessionUser = {
  id: string
  username: string
  email: string | null
  emailVerifiedAt: string | null
  displayName: string | null
  avatarUrl: string | null
  avatarColor: string
  bio: string
  role: string
  /** gates the admin panel + every /api/admin/* route (Task 6-c) */
  siteAdmin: boolean
  customStatus: string | null
  pronouns: string | null
  presence: UserPresenceChoice
  bannerColor: string | null
  bannerUrl: string | null
  createdAt: string
}

/** The status a user CHOOSES to have (persisted). */
export type UserPresenceChoice = 'online' | 'idle' | 'busy' | 'dnd' | 'invisible'

/** What other viewers can see for a user. */
export type VisiblePresence = 'online' | 'idle' | 'busy' | 'dnd' | 'offline'

export type MemberRole = 'OWNER' | 'ADMIN' | 'MEMBER'

export type ServerMemberSummary = PublicUser & {
  role: MemberRole
  joinedAt: string
  nickname: string | null
  roleId: string | null
  roleName: string | null
  roleColor: string | null
  timeoutUntil: string | null
  /** true when this person administers the whole Hyperion platform,
   *  distinct from any server-level rank */
  siteAdmin?: boolean
}

export type RoleSummary = {
  id: string
  name: string
  color: string
  permissions: number
  position: number
  memberCount: number
}

export type ChannelType = 'text' | 'voice' | 'forum'

export type ChannelSummary = {
  id: string
  serverId: string
  name: string
  topic: string | null
  position: number
  categoryId: string | null
  type: ChannelType
  slowmodeSeconds: number
  locked: boolean
  private: boolean
  accessRoleIds: string[]
}

export type CategorySummary = {
  id: string
  name: string
  position: number
}

export type ServerSummary = {
  id: string
  name: string
  description: string
  iconUrl: string | null
  bannerColor: string | null
  inviteCode: string
  ownerId: string
  memberCount: number
  myRole: MemberRole
  myPerms: number
  channels: ChannelSummary[]
  categories: CategorySummary[]
  /** admins can disable call channels in this server's voice channels */
  callChannelsEnabled: boolean
  /** may members ring people who are NOT server members into voice channels
   *  (guests: they join the voice stage but never read the server) */
  allowGuestRings: boolean
}

export type ServerDetail = {
  server: {
    id: string
    name: string
    description: string
    iconUrl: string | null
    inviteCode: string
    ownerId: string
    createdAt: string
    blockedWords: string
    callChannelsEnabled: boolean
    allowGuestRings: boolean
  }
  channels: ChannelSummary[]
  categories: CategorySummary[]
  members: ServerMemberSummary[]
  roles: RoleSummary[]
  myRole: MemberRole
  myPerms: number
}

export type BanSummary = {
  id: string
  user: PublicUser
  reason: string | null
  createdAt: string
}

export type ReactionGroup = {
  emoji: string
  userIds: string[]
  /** per-reaction timestamps aligned with userIds (oldest first); carried by
   *  the reaction broadcast so hover lists can show who reacted when */
  at?: string[]
}

export type ReplySummary = {
  id: string
  authorId: string
  authorUsername: string
  authorDisplayName: string | null
  contentPreview: string | null
  hasImage: boolean
}

export type MessageAttachment = {
  url: string
  name: string
  size: number
  mime: string
  /** voice note captured in the composer: rendered as a play bubble instead of a file chip */
  kind?: 'voice'
  /** recorded length in seconds, rounded to 1 decimal */
  duration?: number
  /** exactly 40 amplitude bars, integers 0..100 (peak RMS per bucket) */
  waveform?: number[]
}

export type ClientMessage = {
  id: string
  content: string | null
  imageUrl: string | null
  attachments: MessageAttachment[] | null
  createdAt: string
  editedAt: string | null
  pinned: boolean
  pinnedAt: string | null
  pingsEveryone: boolean
  /** whisper: only the author and this target ever see the row */
  whisperTargetId?: string | null
  whisperTargetName?: string | null
  /** sticker message: content is null, the big image + name ride these */
  stickerName?: string | null
  stickerUrl?: string | null
  /** system rows ("x pinned a message", "x started a call"): content is null, kind carries meaning */
  systemKind?: 'pin' | 'unpin' | 'call' | null
  systemData?: {
    messageId?: string
    byUsername?: string
    /** call rows: the shared display name for the caller */
    by?: string
    byUserId?: string
    video?: boolean
    startedAt?: number
    /** set once the call ended: how long it ran */
    durationSec?: number | null
    /** set when nobody ever answered */
    missed?: boolean
  } | null
  replyToId: string | null
  replyTo: ReplySummary | null
  /** thread: set on rows that live inside a thread; the value is the root message id */
  threadOfId?: string | null
  /** thread bar on the root: how many replies live in the thread */
  threadCount?: number
  /** ephemeral: absolute thread size stamped by the send routes so the root
   *  bar can be set (not incremented) — idempotent across duplicate echoes */
  threadTotal?: number
  /** thread bar on the root: the last few distinct participants, newest first */
  threadUsers?: { id: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }[]
  /** forward: original author username snapshot ("forwarded from @x") */
  forwardedFromName?: string | null
  /** edit history: prior versions, newest last */
  editHistory?: { content: string; at: string }[] | null
  /** THE VAULT: the ephemeral chunked file this row carries (file-only sends
   *  have null content). expiresAt drives the live countdown and the flip to
   *  the expired state once it passes; warnings/scanStatus drive the safety
   *  chips (amber "careful", "scanning…", "scanned clean", "flagged") */
  file?: {
    id: string
    filename: string
    mime: string
    size: number
    status: string
    /** short codes from the server-side sniff: 'executable' | 'script' |
     *  'double-extension' | 'mime-mismatch' | 'archive' */
    warnings?: string[] | null
    /** null = never queued | 'pending' | 'clean' | 'detected' | 'failed' | 'skipped' */
    scanStatus?: string | null
    expiresAt: string
  } | null
  authorId: string
  author: PublicUser
  /** server-scoped decoration for channel messages */
  authorNickname: string | null
  authorRoleColor: string | null
  room: string // 'channel:<id>' or 'conversation:<id>'
  reactions: ReactionGroup[]
  /** client-only: optimistic send lifecycle, never sent by the server */
  pending?: boolean
  failed?: boolean
  /** client-generated id echoed back by the send routes, used to swap the
   *  optimistic row for the real one when the socket beats the HTTP response */
  nonce?: string | null
  /** send-route flag riding only the socket echo of the author's own row:
   *  the marker swap fired and this send may celebrate */
  fx?: boolean
  /** temporary-message auto-delete stamp (conversation GETs carry it); null /
   *  absent = permanent */
  expiresAt?: string | null
}

/** A message saved to the personal collection. */
export type BookmarkSummary = {
  id: string
  note: string
  createdAt: string
  message: ClientMessage
  scope: { kind: 'channel' | 'conversation'; name: string } | null
}

/** A message composed now, delivered later. */
export type ScheduledSummary = {
  id: string
  scopeKey: string
  scopeName: string
  content: string
  sendAt: string
  createdAt: string
}

/** A personal "remind me about this message" nudge. */
export type ReminderSummary = {
  id: string
  messageId: string
  remindAt: string
  message: {
    id: string
    room: string
    contentPreview: string | null
    authorUsername: string
  }
}

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'

export type FriendSummary = {
  friendshipId: string
  user: PublicUser
  direction: 'incoming' | 'outgoing'
  /** my private nickname for this friend ("note" in Discord terms) */
  nickname?: string | null
  /** temporary friendship: auto-expires after this stamp */
  expiresAt?: string | null
  createdAt: string
}

export type AuditEventSummary = {
  id: string
  type: string
  actor: { id: string; username: string; displayName: string | null } | null
  targetUser: { id: string; username: string; displayName: string | null } | null
  data: Record<string, unknown>
  createdAt: string
}

export type ConversationSummary = {
  id: string
  kind: 'DM' | 'GROUP'
  name: string | null
  /** optional group photo; null/absent keeps the stacked-members icon */
  iconUrl?: string | null
  /** group owner (server-resolved: legacy groups without a stored owner
   *  report their oldest member); null/absent for DMs */
  ownerId?: string | null
  limitRaised?: boolean
  /** group: who can rename / change the group photo = ALL | OWNER */
  editPolicy?: 'ALL' | 'OWNER'
  /** group: who can add members = ALL | OWNER */
  invitePolicy?: 'ALL' | 'OWNER'
  /** group: may members ring non-members into calls? owner can disable */
  allowCrossRing?: boolean
  /** auto-delete window for 1:1 DMs: 60 | 1440 | 10080, or null when off */
  tempExpiryMinutes?: number | null
  /** the other side of a 1:1 DM; for GROUPs the first other participant
   *  (kept non-null so existing consumers keep compiling) */
  otherUser: PublicUser
  /** full member list for GROUP conversations (absent for DMs) */
  participants?: {
    id: string
    username: string
    displayName: string | null
    avatarUrl: string | null
    avatarColor: string
  }[]
  hidden: boolean
  pinned: boolean
  lastMessage: {
    id: string
    content: string | null
    imageUrl: string | null
    createdAt: string
    authorId: string
  } | null
  otherLastReadAt: string | null
  /** group read receipts: every OTHER participant's read stamp keyed by
   *  userId (absent for plain DMs; empty object = nobody else has read) */
  othersReadAt?: Record<string, string>
  unreadCount: number
}

/** A live participant in a voice channel. Session-level flags (muted /
 *  deafened) come from the realtime service; speaking / volume are local
 *  media observations from the VoiceEngine. */
export type VoiceParticipantSummary = {
  userId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  avatarColor: string
  sessionId: string
  muted: boolean
  deafened: boolean
  speaking: boolean
  volume: number
  /** capturing this channel's audio (drives the red REC badge) */
  recording: boolean
  /** streaming their camera (the tile shows video) */
  video: boolean
  /** sharing their screen (audio included) */
  screen: boolean
}

/** A forum post (Discord-style forum channel). The post's thread reuses the
 *  existing Message threadOfId machinery: firstMessageId points at the root
 *  message, replies are thread rows. */
export type ForumPostSummary = {
  id: string
  channelId: string
  title: string
  pinned: boolean
  locked: boolean
  tags: string[]
  createdAt: string
  updatedAt: string
  firstMessageId: string | null
  author: PublicUser
  replyCount: number
  lastReplyAt: string | null
  /** my read stamp for this post (for the "new" badge); null = never read */
  readAt: string | null
}

/** a forum channel tag: colored chip posts can carry (names unique per channel) */
export type ForumTagSummary = {
  id: string
  channelId: string
  name: string
  /** 6-digit hex like #f5f5f5 */
  color: string
  createdAt: string
}

/** a server sticker: big reaction image an admin uploaded (no default set) */
export type StickerSummary = {
  id: string
  serverId: string | null
  name: string
  url: string
  size: number
  mime: string
  addedById: string
  createdAt: string
}

/** a saved whisper list: a named group I can whisper to in one click
 *  (memberNames is a username snapshot taken when the list was saved) */
export type WhisperListSummary = {
  id: string
  name: string
  memberIds: string[]
  memberNames: string[]
  createdAt: string
}

export type SyncResponse = {
  onlineUserIds: string[]
  presenceStatuses: Record<string, PresenceStatus>
  awaySince: Record<string, number>
  /** ISO stamp per offline-but-seen user, for "last online X" displays */
  lastSeen: Record<string, string>
  /** live calls in my conversations (sidebar indicators, join buttons) */
  liveCalls?: {
    conversationId: string
    callId: string
    state: 'ringing' | 'active'
    createdBy: string
    createdAt: number
    acceptedAt: number | null
    participants: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string; muted: boolean; deafened: boolean; video: boolean; screen: boolean; recording: boolean }[]
  }[]
  serverStamps: { serverId: string; memberCount: number; channelCount: number; lastMessageAt: string | null }[]
  conversationStamps: {
    conversationId: string
    lastMessageId: string | null
    lastMessageAt: string | null
    otherLastReadAt: string | null
    /** group read receipts: other participants' stamps keyed by userId
     *  (single-shape across DMs and groups; unused for DMs) */
    othersReadAt?: Record<string, string>
    hidden: boolean
    unreadCount: number
  }[]
  channelUnread: Record<string, number>
  channelMentions: Record<string, number>
  roomLastMessage: { id: string; createdAt: string } | null
  blockedUserIds: string[]
  mutedScopes: string[]
}

