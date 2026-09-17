'use client'

import { create } from 'zustand'
import { apiClient, ApiError } from './api'
import { toast } from '@/hooks/use-toast'
import { sounds } from './sounds'
import { notifications } from './notifications'
import { setActiveServerEmoji, type ServerEmojiSummary } from './serverEmoji'
import type {
  BookmarkSummary,
  ClientMessage,
  ConversationSummary,
  ForumPostSummary,
  FriendSummary,
  MessageAttachment,
  PublicUser,
  ReactionGroup,
  ReminderSummary,
  RoleSummary,
  ScheduledSummary,
  ServerMemberSummary,
  ServerSummary,
  SessionUser,
  SyncResponse,
  UserPresenceChoice,
  VisiblePresence,
  VoiceParticipantSummary,
} from '@/lib/types'
import { extractMentions } from './markdown'
import { carryYouTubeEmbed } from './yt-registry'
import { destroyMediaHost } from './media-host'
import { saveAccount, removeAccount } from './accounts'
import { voiceEngine } from './voice'
import { callEngine, type CallSignalData } from './call'
import { getSocket } from './socket'
import { publishCallTabEvent, ensureCallTabSync } from './call-tab-sync'

/** one live call participant as the sidecar reports it */
export type CallParticipantSummary = {
  userId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  avatarColor: string
  muted: boolean
  deafened: boolean
  video: boolean
  screen: boolean
}

export type View = 'landing' | 'login' | 'register' | 'privacy' | 'terms' | 'app' | 'suspended'

/** true inside the single-file standalone build (login-first, local backend) */
export const STANDALONE = typeof window !== 'undefined' && !!(window as unknown as { HYPERCHAT_STANDALONE?: boolean }).HYPERCHAT_STANDALONE

export type RoomState = {
  messages: ClientMessage[]
  hasMore: boolean
  oldestCursor: string | null
  loadingMore: boolean
  loaded: boolean
  myReadAt: string | null
  /** set while a permalink jump has the room parked on an older window;
   *  true means newer messages exist below the visible page */
  hasNewer: boolean
}

/** one open thread: the root row plus its replies, cached per root id */
export type ThreadState = {
  root: ClientMessage | null
  messages: ClientMessage[]
  loaded: boolean
  count: number
}

const emptyRoom: RoomState = {
  messages: [],
  hasMore: false,
  oldestCursor: null,
  loadingMore: false,
  loaded: false,
  myReadAt: null,
  hasNewer: false,
}

export type TypingInfo = { username: string; at: number }

interface ChatStore {
  booted: boolean
  me: SessionUser | null
  view: View
  /** site-level suspension shown on the blocked screen after a ban */
  suspension: { reason: string | null; until: string | null } | null

  servers: ServerSummary[]
  activeServerId: string | null
  activeChannelId: string | null
  activeConversationId: string | null
  /** dedicated friends page replaces the main column when open */
  friendsViewOpen: boolean
  serverMembers: Record<string, ServerMemberSummary[]>
  serverRoles: Record<string, RoleSummary[]>
  /** custom emoji per server, loaded when a server becomes active */
  serverEmoji: Record<string, ServerEmojiSummary[]>
  /** message drafts per room, so switching channels never loses a half-typed message */
  drafts: Record<string, string>
  /** count of unread messages that mention me, per channel */
  channelMentions: Record<string, number>

  conversations: ConversationSummary[]
  rooms: Record<string, RoomState>
  /** open threads, keyed by root message id (the panel reads these) */
  threads: Record<string, ThreadState>
  openThreadId: string | null
  /** the message being forwarded (the picker dialog reads it) */
  forwardTarget: ClientMessage | null
  /** per-message translations (mid -> result), shown under the original */
  translations: Record<string, { loading: boolean; text: string | null }>

  onlineUserIds: Record<string, boolean>
  presenceStatuses: Record<string, VisiblePresence>
  /** epoch ms of when each idle user went away, for "away for X" displays */
  awaySince: Record<string, number>
  /** ISO stamp of when each offline user was last seen, for "last online X"
 *  displays; absent entry = never seen (or currently online) */
  lastSeen: Record<string, string>
  typing: Record<string, Record<string, TypingInfo>>
  connected: boolean

  channelUnread: Record<string, number>
  otherReadAt: Record<string, string | null>
  /** group chat read receipts: conversationId -> userId -> lastReadAt ISO */
  groupReadAt: Record<string, Record<string, string>>

  friends: FriendSummary[]
  incomingRequests: FriendSummary[]
  outgoingRequests: FriendSummary[]
  blockedUserIds: Record<string, boolean>
  mutedScopes: Record<string, boolean>

  replyTo: ClientMessage | null
  editRequest: { messageId: string; at: number } | null

  /** personal saved messages + scheduled + reminders (novel features) */
  bookmarks: BookmarkSummary[]
  savedOpen: boolean
  scheduled: ScheduledSummary[]
  scheduledOpen: boolean
  reminders: ReminderSummary[]
  /** focus mode: suppress notification sounds until this epoch ms */
  focusUntil: number | null

  accountOpen: boolean
  profileEditorOpen: boolean
  profileUser: (PublicUser & { mutualServers?: { id: string; name: string; iconUrl: string | null }[] }) | null
  profileOpen: boolean
  jumpTarget: { room: string; messageId: string; at: number } | null
  /** the pins overlay for the open room (system rows + header both open it) */
  pinsOpen: boolean
  setPinsOpen: (open: boolean) => void
  /** the reminders manager dialog */
  remindersOpen: boolean
  setRemindersOpen: (open: boolean) => void
  /** sidebar context menus ask the composer to paste something (server invites) */
  pendingInsert: { room: string; text: string; at: number } | null
  requestInsert: (room: string, text: string) => void

  boot: () => Promise<void>
  setView: (view: View) => void
  onAccountSuspended: (reason: string | null, until: string | null) => void
  doLogin: (identifier: string, password: string) => Promise<void>
  doRegister: (username: string, email: string | undefined, password: string) => Promise<void>
  doLogout: () => Promise<void>
  /** swap the active session to another account saved in the local vault */
  switchAccount: (token: string) => Promise<void>
  /** replace the cached `me` snapshot (email verify returns a fresh user) */
  applyMe: (user: import('@/lib/types').SessionUser) => void

  setAccountOpen: (open: boolean) => void
  setProfileEditorOpen: (open: boolean) => void
  openProfile: (username: string) => Promise<void>
  closeProfile: () => void
  jumpTo: (room: string, messageId: string) => void
  /** full permalink jump: resolves the message's room, loads a window
   *  around it when the history is deep, then scrolls + flashes the row */
  jumpToMessage: (messageId: string) => Promise<void>
  /** leave a jumped history window and return to the newest page */
  requestPresent: (room: string) => void
  /** highlight a row inside the open thread panel */
  threadJump: { rootId: string; messageId: string; at: number } | null
  /** fired when a jumped room returns to the newest page: scrolls to bottom */
  presentRequest: { room: string; at: number } | null

  /** mini media player: a video/audio attachment popped out of chat. Lives
   *  at app level so it KEEPS PLAYING when the user switches rooms/DMs; the
   *  video element never unmounts. Collapsible to audio-only.
   *  `roomId` is the room the media started in: while the user is IN that
   *  room the panel docks to its original fixed spot (not movable); only a
   *  session that is still unfinished AND has been left behind floats. */
  mediaPlayer:
    | { kind: 'file'; url: string; mime: string; name: string; at: number; roomId: string | null; popped?: boolean }
    | { kind: 'youtube'; videoId: string; name: string; startAt: number; at: number; roomId: string | null; popped?: boolean }
    | null
  openMediaPlayer: (url: string, mime: string, name: string, roomId?: string | null) => void
  openYouTubePlayer: (videoId: string, startAt?: number, name?: string, roomId?: string | null) => void
  closeMediaPlayer: () => void
  /** hand the inline embed's playback to the floating mini player (and
   *  back): the media keeps playing either way, only the surface moves */
  setMediaPopped: (popped: boolean) => void

  // ---- voice channels ----
  voiceConnected: { serverId: string; channelId: string } | null
  voiceSelf: { muted: boolean; deafened: boolean }
  voiceUnavailable: boolean
  /** live participants per voice channel, enriched from member caches */
  voiceParticipants: Record<string, VoiceParticipantSummary[]>
  joinVoice: (channelId: string, serverId: string) => Promise<boolean>
  leaveVoice: () => void
  toggleVoiceMute: () => void
  toggleVoiceDeafen: () => void
  onVoiceState: (payload: { channelId: string; participants: { userId: string; username: string; sessionId: string; muted: boolean; deafened: boolean }[] }) => void
  onVoiceSpeaking: (userId: string, speaking: boolean, volume: number) => void

  // ---- calls (1:1 + groups) ----
  /** an incoming ring waiting on me */
  incomingCall: {
    callId: string
    conversationId: string
    from: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }
    video: boolean
    createdAt: number
  } | null
  /** friend ringing me into a server voice channel */
  incomingVoiceRing: {
    inviteId: string
    channelId: string
    serverId: string
    serverName: string
    serverIconUrl: string | null
    channelName: string
    from: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }
    createdAt: number
  } | null
  /** the call I'm in (or placed and am waiting on). null when idle */
  activeCall: {
    callId: string
    conversationId: string
    createdBy: string
    createdAt: number
    acceptedAt: number | null
    /** 'ringing' while nobody has answered yet (outgoing view) */
    state: 'ringing' | 'active'
    participants: CallParticipantSummary[]
  } | null
  callSelf: { muted: boolean; deafened: boolean; cameraOn: boolean; screenOn: boolean }
  startCall: (conversationId: string, withVideo: boolean) => Promise<void>
  acceptIncomingCall: () => Promise<void>
  declineIncomingCall: () => void
  /** dismiss the incoming screen; the caller keeps ringing their end */
  letRingIncomingCall: () => void
  cancelOutgoingCall: () => void
  /** leave the call myself; it continues for everyone still in it */
  hangupCall: () => void
  toggleCallMute: () => void
  toggleCallDeafen: () => void
  toggleCallCamera: () => Promise<void>
  toggleCallScreen: () => Promise<void>
  ringFriendIntoVoice: (toUserId: string) => void
  acceptVoiceRing: () => Promise<void>
  declineVoiceRing: () => void
  onCallRing: (payload: { callId: string; conversationId: string; from: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }; video: boolean; createdAt: number }) => void
  onCallState: (payload: { callId: string; conversationId: string; state: 'ringing' | 'active'; createdBy: string; createdAt: number; participants: CallParticipantSummary[] }) => void
  onCallAccepted: (payload: { callId: string; userId: string; username: string }) => void
  onCallDeclined: (payload: { callId: string; userId: string; username: string }) => void
  onCallPeerLeft: (payload: { callId: string; userId: string }) => void
  onCallEnded: (payload: { callId: string; conversationId: string; reason: string }) => void
  onCallSignal: (payload: { from: string; callId: string; data: unknown }) => void
  onVoiceRing: (payload: {
    inviteId: string
    channelId: string
    serverId: string
    serverName: string
    serverIconUrl: string | null
    channelName: string
    from: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }
    createdAt: number
  }) => void
  onVoiceRingEnded: (payload: { inviteId: string; reason: string; channelId?: string; serverId?: string }) => void
  /** wire same-browser tab sync once (called from socket connect) */
  bindCallTabSync: () => void

  // ---- forum channels ----
  forumPostsByChannel: Record<string, ForumPostSummary[]>
  forumLoaded: Record<string, boolean>
  openForumPostId: string | null
  loadForumPosts: (channelId: string, sort?: 'latest' | 'new') => Promise<void>
  openForumPost: (postId: string) => void
  closeForumPost: () => void
  createForumPost: (channelId: string, payload: { title: string; content?: string }) => Promise<void>
  updateForumPost: (postId: string, payload: { title?: string; pinned?: boolean; locked?: boolean }) => Promise<void>
  deleteForumPost: (postId: string) => Promise<void>
  sendForumReply: (postId: string, content: string) => Promise<void>
  onForumPostNew: (post: ForumPostSummary) => void
  onForumPostUpdate: (post: ForumPostSummary) => void
  onForumPostDelete: (postId: string) => void

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
  }) => Promise<void>
  changePassword: (currentPassword: string, newPassword: string, code: string) => Promise<void>
  setMyPresence: (presence: UserPresenceChoice) => Promise<void>

  refreshFriends: () => Promise<void>
  sendFriendRequest: (username: string, temporaryHours?: number) => Promise<void>
  acceptFriendRequest: (friendshipId: string) => Promise<void>
  removeFriendship: (friendshipId: string) => Promise<void>
  /** my private label for a friend; empty string clears it */
  setFriendNickname: (friendshipId: string, nickname: string) => Promise<void>
  /** flip a friendship between temporary (auto-expiring) and forever */
  setFriendTemporary: (friendshipId: string, temporary: boolean, hours?: number) => Promise<void>

  blockUser: (username: string) => Promise<void>
  unblockUser: (userId: string) => Promise<void>

  toggleMute: (scope: string) => Promise<void>

  setReplyTo: (msg: ClientMessage | null) => void
  requestEdit: (messageId: string) => void

  // bookmarks / scheduled / reminders / focus mode
  setSavedOpen: (open: boolean) => void
  refreshBookmarks: () => Promise<void>
  toggleBookmark: (messageId: string) => Promise<boolean>
  /** gifs kept from chat, url-keyed; shared by the in-chat save banners,
   *  the lightbox and the picker's saved tab so every view flips together.
   *  toggling is optimistic: the icon flips instantly and reverts after ~2s
   *  if the server never confirms. */
  savedGifs: { id: string; url: string; title: string }[]
  refreshSavedGifs: () => Promise<void>
  toggleSavedGif: (url: string, title: string) => Promise<void>
  setScheduledOpen: (open: boolean) => void
  refreshScheduled: () => Promise<void>
  scheduleMessage: (scopeKey: string, content: string, sendAt: Date) => Promise<void>
  cancelScheduled: (id: string) => Promise<void>
  refreshReminders: () => Promise<void>
  createReminder: (messageId: string, remindAt: Date) => Promise<void>
  cancelReminder: (id: string) => Promise<void>
  tickReminders: () => void
  setFocus: (minutes: number | null) => void

  selectHome: () => void
  openFriendsView: () => void
  selectServer: (serverId: string) => Promise<void>
  selectChannel: (channelId: string) => Promise<void>
  selectConversation: (conversationId: string) => Promise<void>

  openDM: (userId: string) => Promise<void>
  hideConversation: (conversationId: string) => Promise<void>
  pinConversation: (conversationId: string) => Promise<void>

  // groups
  createGroup: (name: string, memberIds: string[]) => Promise<void>
  /** throws ApiError with code 'limit' (status 409) when the member limit is
   *  hit, so the UI can offer the raise-to-50 unlock */
  addGroupMember: (conversationId: string, userId: string) => Promise<void>
  raiseGroupLimit: (conversationId: string) => Promise<void>
  /** owner-only: kick a member out of a group (toasts 'kicked' or the
   *  server error) */
  kickGroupMember: (conversationId: string, userId: string) => Promise<void>
  /** owner-only: raise or lower a group's member limit (5 <-> 50); errors
   *  pass through so callers can toast them */
  setGroupLimit: (conversationId: string, raised: boolean) => Promise<void>
  setGroupPolicies: (conversationId: string, editPolicy: 'ALL' | 'OWNER', invitePolicy: 'ALL' | 'OWNER') => Promise<void>
  /** leave a group; the group disappears from the sidebar */
  leaveGroup: (conversationId: string) => Promise<void>
  renameGroup: (conversationId: string, name: string) => Promise<void>
  /** upload a group photo and set it; a null file clears the photo back to
   *  the stacked-members icon */
  setGroupPhoto: (conversationId: string, file: File | null) => Promise<void>
  /** open a group conversation (same flow as any conversation) */
  openGroupDM: (conversationId: string) => Promise<void>

  // temporary messages in 1:1 DMs (either side can toggle)
  setTempExpiry: (conversationId: string, minutes: number | null) => Promise<void>

  createServer: (name: string, description?: string) => Promise<ServerSummary>
  joinServer: (inviteCode: string) => Promise<{ server: ServerSummary; alreadyMember: boolean }>
  deleteServer: (serverId: string) => Promise<void>
  leaveServer: (serverId: string) => Promise<void>
  updateServer: (
    serverId: string,
    payload: { name?: string; description?: string; iconUrl?: string | null; regenerateInvite?: boolean; blockedWords?: string }
  ) => Promise<void>
  createChannel: (serverId: string, name: string, topic?: string, type?: 'text' | 'voice' | 'forum') => Promise<void>
  createCategory: (serverId: string, name: string) => Promise<void>
  /** rename a channel category (moderators) */
  renameCategory: (serverId: string, categoryId: string, name: string) => Promise<void>
  /** delete a category; its channels fall back to the uncategorized block */
  deleteCategory: (serverId: string, categoryId: string) => Promise<void>
  /** drag-and-drop category reorder: full ordered id list */
  reorderCategories: (serverId: string, orderedIds: string[]) => Promise<void>
  updateChannel: (
    channelId: string,
    payload: { name?: string; topic?: string; slowmodeSeconds?: number; locked?: boolean; private?: boolean; accessRoleIds?: string[] }
  ) => Promise<void>
  deleteChannel: (channelId: string) => Promise<void>
  moveChannel: (serverId: string, channelId: string, direction: -1 | 1) => Promise<void>
  /** drag-and-drop reorder: full ordered channel id list for the server */
  reorderChannels: (serverId: string, orderedIds: string[]) => Promise<void>
  setMemberRole: (serverId: string, userId: string, role: 'ADMIN' | 'MEMBER') => Promise<void>
  setMemberCustomRole: (serverId: string, userId: string, roleId: string | null) => Promise<void>
  setMemberNickname: (serverId: string, userId: string, nickname: string | null) => Promise<void>
  timeoutMember: (serverId: string, userId: string, minutes: number | null) => Promise<void>
  kickMember: (serverId: string, userId: string, reason?: string) => Promise<void>
  banMember: (serverId: string, userId: string, reason?: string) => Promise<void>
  unbanUser: (serverId: string, userId: string) => Promise<void>
  createRole: (serverId: string, payload: { name: string; color?: string; permissions?: number }) => Promise<RoleSummary>
  updateRole: (serverId: string, roleId: string, payload: { name?: string; color?: string; permissions?: number; direction?: 1 | -1 }) => Promise<void>
  deleteRole: (serverId: string, roleId: string) => Promise<void>
  purgeChannel: (channelId: string, count: number, userId?: string) => Promise<number>
  setDraft: (room: string, content: string) => void

  refreshServers: () => Promise<void>
  refreshServerDetail: (serverId: string) => Promise<void>
  refreshServerEmoji: (serverId: string) => Promise<void>
  refreshConversations: () => Promise<void>

  loadOlder: (room: string) => Promise<void>
  sendMessage: (payload: { content?: string; imageUrl?: string; attachments?: MessageAttachment[]; whisperTo?: string }) => Promise<void>
  /** optimistic send lifecycle: locally echoed rows are swapped for server rows */
  retryMessage: (room: string, tempId: string) => Promise<void>
  discardMessage: (room: string, tempId: string) => void
  editMessage: (room: string, messageId: string, content: string) => Promise<void>
  deleteMessage: (room: string, messageId: string) => Promise<void>
  toggleReaction: (room: string, messageId: string, emoji: string) => Promise<void>
  togglePin: (room: string, messageId: string, pinned: boolean) => Promise<void>

  // threads
  openThread: (rootId: string) => Promise<void>
  closeThread: () => void
  sendThreadMessage: (rootId: string, payload: { content?: string; imageUrl?: string }) => Promise<void>

  // forwarding
  setForwardTarget: (msg: ClientMessage | null) => void
  forwardMessage: (messageId: string, targetType: 'channel' | 'conversation', targetId: string) => Promise<void>

  // translation
  translateMessage: (messageId: string, text: string) => Promise<void>

  markRead: (scope: string) => Promise<void>

  // realtime handlers (called by the socket module)
  onConnected: (connected: boolean) => void
  onPresenceInit: (userIds: string[], statuses?: Record<string, VisiblePresence>, awaySince?: Record<string, number>, lastSeen?: Record<string, string>) => void
  onPresenceOnline: (userId: string, status?: VisiblePresence, awaySince?: number | null) => void
  onPresenceOffline: (userId: string, lastSeenAt?: string | null) => void
  /** a profile changed (name, avatar, status quote...): patch every cached
   *  view of that user instead of refetching whole lists */
  onUserUpdate: (user: PublicUser) => void
  /** merge a profile patch (from the global user:profile broadcast or a
   *  local optimistic image apply) into every cached surface of that user:
   *  me, dm partners, group participants, friends, server member columns,
   *  message authors, the open profile card. one pass per surface. */
  applyUserProfilePatch: (
    userId: string,
    patch: Partial<
      Pick<
        PublicUser,
        'username' | 'displayName' | 'avatarUrl' | 'avatarColor' | 'bio' | 'customStatus' | 'pronouns' | 'bannerColor' | 'bannerUrl'
      >
    >
  ) => void
  onPresenceStatus: (userId: string, status: VisiblePresence, awaySince?: number | null) => void
  onTyping: (room: string, userId: string, username: string, typing: boolean) => void
  pruneTyping: () => void
  onMessageNew: (msg: ClientMessage) => void
  onMessageUpdate: (msg: ClientMessage) => void
  onMessageDelete: (payload: { messageId: string }) => void
  onMessagesPurge: (ids: string[]) => void
  onMessageReaction: (payload: { messageId: string; room: string; reactions: ReactionGroup[] }) => void
  onReadUpdate: (payload: { conversationId: string; userId: string; lastReadAt: string }) => void
  onServerRefresh: (serverId: string) => void
  onServerDeleted: (serverId: string) => void
  onConversationNew: () => void

  // sync fallback
  syncNow: () => Promise<void>
}

function activeRoomOf(s: { activeChannelId: string | null; activeConversationId: string | null }): string | null {
  if (s.activeChannelId) return `channel:${s.activeChannelId}`
  if (s.activeConversationId) return `conversation:${s.activeConversationId}`
  return null
}

export function roomOfChannel(channelId: string): string {
  return `channel:${channelId}`
}

export function roomOfConversation(conversationId: string): string {
  return `conversation:${conversationId}`
}

/** A playing YouTube embed in the room being LEFT moves into the mini media
 *  player (at its last polled timestamp) instead of dying with the
 *  unmounting message row. Cheap when nothing is playing. The carried video
 *  keeps docking rights to the room it came from. */
function carryAwayYouTube(room?: string | null) {
  const carried = carryYouTubeEmbed()
  if (carried) {
    // no explicit room: the one being LEFT is still the active one here
    useChatStore.getState().openYouTubePlayer(carried.videoId, carried.time, undefined, room ?? activeRoomOf(useChatStore.getState()))
  }
}

function sortMessages(messages: ClientMessage[]): ClientMessage[] {
  // dedupe by id while sorting: socket echoes, sync tails and permalink
  // windows can all deliver the same row, and React keys demand uniqueness
  const seen = new Set<string>()
  const out: ClientMessage[] = []
  for (const m of [...messages].sort((a, b) => {
    const d = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    if (d !== 0) return d
    return a.id < b.id ? -1 : 1
  })) {
    if (m.id.startsWith('pending:') || !seen.has(m.id)) {
      seen.add(m.id)
      out.push(m)
    }
  }
  return out
}

/* ---------- queued reactions ---------- */

/** Reaction adds still flying to the server: messageId -> (emoji -> sent-at).
 *  Kept OUTSIDE zustand so tracking them never re-renders anything. They let
 *  onMessageReaction keep optimistic chips on screen while older broadcasts
 *  land, and guarantee in-flight reactions always render on the right edge,
 *  oldest first, exactly where the server will confirm them. */
const pendingReactionAdds = new Map<string, Map<string, number>>()

function trackPendingReactionAdd(messageId: string, emoji: string) {
  let perMessage = pendingReactionAdds.get(messageId)
  if (!perMessage) {
    perMessage = new Map()
    pendingReactionAdds.set(messageId, perMessage)
  }
  perMessage.set(emoji, Date.now())
}

function clearPendingReactionAdd(messageId: string, emoji: string) {
  const perMessage = pendingReactionAdds.get(messageId)
  if (!perMessage) return
  perMessage.delete(emoji)
  if (perMessage.size === 0) pendingReactionAdds.delete(messageId)
}

/** One in-flight POST per message, queued in click order: the server then
 *  confirms reactions in exactly the order they were added, so a burst of
 *  queued reactions lands rightmost oldest-first with no reshuffling. */
const reactionChains = new Map<string, Promise<void>>()

/** Race an action against a ~2s deadline: optimistic UI must not leave the
 *  user staring at a lie when the server is dead or slow. On timeout the
 *  caller reverts the optimistic flip (the underlying request is allowed to
 *  keep going; a later success is simply reconciled by refresh/sync). */
function withDeadline<T>(p: Promise<T>, ms = 2000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('deadline')), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** Shrink a picked photo to a 512x512 cover-cropped png (or passthrough for
 *  gifs/tiny files): group photos stay light and always render square. */
async function downscaleForIcon(file: File): Promise<Blob> {
  if (file.type === 'image/gif' || file.size <= 300 * 1024) return file
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image()
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('bad image'))
    el.src = URL.createObjectURL(file)
  }).catch(() => null)
  if (!img) return file
  const canvas = document.createElement('canvas')
  const size = 512
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return file
  const scale = Math.max(size / img.width, size / img.height)
  const w = img.width * scale
  const h = img.height * scale
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
  return new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? file), 'image/png'))
}

/** Find a message row anywhere it is rendered: the open rooms or threads.
 *  Used to build optimistic bookmark stubs. */
function findMessageRow(get: () => ChatStore, messageId: string): ClientMessage | null {
  for (const rs of Object.values(get().rooms)) {
    const m = rs.messages.find((x) => x.id === messageId)
    if (m) return m
  }
  for (const t of Object.values(get().threads)) {
    const m = t.messages.find((x) => x.id === messageId) ?? (t.root?.id === messageId ? t.root : null)
    if (m) return m
  }
  return null
}

/** Server truth first (already oldest-first), then any of my still-flying
 *  additions appended on the right in the order I clicked them. Queued adds
 *  carry the click time as their stamp so hover lists stay meaningful. */
function mergeQueuedReactions(messageId: string, meId: string | null, reactions: ReactionGroup[]): ReactionGroup[] {
  const perMessage = pendingReactionAdds.get(messageId)
  if (!perMessage || perMessage.size === 0 || !meId) return reactions
  const merged = reactions.map((r) => ({ emoji: r.emoji, userIds: [...r.userIds], at: r.at ? [...r.at] : undefined }))
  const queued = [...perMessage.entries()].sort((a, b) => a[1] - b[1])
  for (const [emoji, sentAt] of queued) {
    const stamp = new Date(sentAt).toISOString()
    const known = merged.find((r) => r.emoji === emoji)
    if (known) {
      if (!known.userIds.includes(meId)) {
        known.userIds.push(meId)
        known.at = [...(known.at ?? []), stamp]
      }
    } else {
      merged.push({ emoji, userIds: [meId], at: [stamp] })
    }
  }
  return merged
}

/* ---------- last visited room ---------- */

const LAST_ROOM_KEY = 'hyperchat-last-room'

function rememberLastRoom(room: string) {
  try {
    localStorage.setItem(LAST_ROOM_KEY, room)
  } catch {
    /* private mode: the app just forgets where it was */
  }
}

function recallLastRoom(): string | null {
  try {
    return localStorage.getItem(LAST_ROOM_KEY)
  } catch {
    return null
  }
}

/* ---------- message permalinks ---------- */

/** Read (and clear) a #msg=<id> permalink from the address bar. The hash is
 *  stripped with replaceState so reloading never re-triggers the jump. */
export function consumePermalinkHash(): string | null {
  if (typeof window === 'undefined') return null
  const m = /^#msg=([A-Za-z0-9_-]+)$/.exec(window.location.hash)
  if (!m) return null
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  } catch {
    /* replaceState can fail in odd embeds; the jump still runs */
  }
  return m[1]
}

/** Reopen the room the user was in when the app last closed (their last DM,
 *  or the server channel they were reading). Silently ignored when that room
 *  no longer exists or was never recorded. */
async function restoreLastRoom(get: () => ChatStore, set: (partial: Partial<ChatStore>) => void) {
  const room = recallLastRoom()
  if (!room) return
  try {
    if (room.startsWith('conversation:')) {
      const id = room.slice('conversation:'.length)
      if (get().conversations.some((c) => c.id === id)) await get().selectConversation(id)
    } else if (room.startsWith('channel:')) {
      const id = room.slice('channel:'.length)
      const server = get().servers.find((s) => s.channels.some((c) => c.id === id))
      if (server) {
        set({ activeServerId: server.id, activeConversationId: null })
        await get().selectChannel(id)
      }
    }
  } catch {
    /* a remembered room that fails to open just falls back to home */
  }
}

export const useChatStore = create<ChatStore>((set, get) => ({
  booted: false,
  me: null,
  view: 'landing',
  suspension: null,

  servers: [],
  activeServerId: null,
  activeChannelId: null,
  activeConversationId: null,
  friendsViewOpen: false,
  serverMembers: {},
  serverRoles: {},
  serverEmoji: {},
  drafts: {},
  channelMentions: {},

  conversations: [],
  rooms: {},
  threads: {},
  openThreadId: null,
  forwardTarget: null,
  translations: {},

  onlineUserIds: {},
  presenceStatuses: {},
  awaySince: {},
  lastSeen: {},
  typing: {},
  connected: false,

  channelUnread: {},
  otherReadAt: {},
  groupReadAt: {},

  friends: [],
  incomingRequests: [],
  outgoingRequests: [],
  blockedUserIds: {},
  mutedScopes: {},

  replyTo: null,
  editRequest: null,

  bookmarks: [],
  savedGifs: [],
  savedOpen: false,
  scheduled: [],
  scheduledOpen: false,
  reminders: [],
  focusUntil: null,

  accountOpen: false,
  profileEditorOpen: false,
  profileUser: null,
  profileOpen: false,
  jumpTarget: null,
  threadJump: null,
  presentRequest: null,
  pinsOpen: false,
  remindersOpen: false,
  pendingInsert: null,
  mediaPlayer: null,

  voiceConnected: null,
  voiceSelf: { muted: false, deafened: false },
  voiceUnavailable: false,
  voiceParticipants: {},

  incomingCall: null,
  incomingVoiceRing: null,
  activeCall: null,
  callSelf: { muted: false, deafened: false, cameraOn: false, screenOn: false },

  forumPostsByChannel: {},
  forumLoaded: {},
  openForumPostId: null,

  boot: async () => {
    try {
      const { user } = await apiClient.me()
      if (user) {
        set({ me: user, view: 'app' })
        await Promise.all([
          get().refreshServers(),
          get().refreshConversations(),
          get().refreshFriends(),
          get().refreshBookmarks(),
          get().refreshSavedGifs(),
          get().refreshScheduled(),
          get().refreshReminders(),
        ])
        await restoreLastRoom(get, set)
        // permalink deep link: #msg=<id> overrides the restored room
        const permalink = consumePermalinkHash()
        if (permalink) await get().jumpToMessage(permalink)
      } else {
        // the standalone html build skips the landing page: straight to login
        set({ view: STANDALONE ? 'login' : 'landing' })
      }
    } catch {
      set({ view: STANDALONE ? 'login' : 'landing' })
    } finally {
      set({ booted: true })
    }
  },

  setView: (view) => set({ view }),

  doLogin: async (identifier, password) => {
    const { user, token } = await apiClient.login({ identifier, password })
    saveAccount(user, token)
    set({ me: user, view: 'app' })
    await Promise.all([
      get().refreshServers(),
      get().refreshConversations(),
      get().refreshFriends(),
      get().refreshBookmarks(),
      get().refreshSavedGifs(),
      get().refreshScheduled(),
      get().refreshReminders(),
    ])
  },

  doRegister: async (username, email, password) => {
    const { user, token } = await apiClient.register({ username, email, password })
    saveAccount(user, token)
    set({ me: user, view: 'app' })
    await Promise.all([get().refreshServers(), get().refreshConversations(), get().refreshFriends()])
  },

  switchAccount: async (token) => {
    const { user, token: refreshed } = await apiClient.switchAccount(token)
    saveAccount(user, refreshed)
    // full boot with the new cookie: cleanest way to swap every cached list
    window.location.reload()
  },

  applyMe: (user) => {
    set({ me: { ...get().me!, ...user } })
  },

  doLogout: async () => {
    const me = get().me
    if (me) removeAccount(me.id) // keep the OTHER saved accounts in the vault
    try {
      await apiClient.logout()
    } finally {
      window.location.reload()
    }
  },

  /** The account was suspended by a site admin: drop everything and show
   *  the suspension screen. The cookie is already dead server-side. */
  onAccountSuspended: (reason: string | null, until: string | null) => {
    set({
      view: 'suspended',
      me: null,
      suspension: { reason, until },
      servers: [],
      conversations: [],
      friends: [],
      activeServerId: null,
      activeChannelId: null,
      activeConversationId: null,
      rooms: {},
      serverMembers: {},
      serverRoles: {},
      accountOpen: false,
      profileEditorOpen: false,
      profileOpen: false,
      profileUser: null,
    })
  },

  setAccountOpen: (open) => set({ accountOpen: open }),
  setProfileEditorOpen: (open) => set({ profileEditorOpen: open }),

  openProfile: async (username) => {
    try {
      const { user, mutualServers } = await apiClient.userProfile(username)
      set({ profileUser: { ...user, mutualServers }, profileOpen: true })
    } catch {
      /* profile lookups fail quietly */
    }
  },

  closeProfile: () => set({ profileOpen: false, profileUser: null }),

  jumpTo: (room, messageId) => set({ jumpTarget: { room, messageId, at: Date.now() } }),

  openMediaPlayer: (url, mime, name, roomId) => {
    const cur = get().mediaPlayer
    if (cur && cur.kind === 'file' && cur.url === url) {
      // same source: surface it where the user now stands without a
      // restart (the host element keeps its position, so only the room
      // stamp moves)
      set({ mediaPlayer: { ...cur, roomId: roomId ?? activeRoomOf(get()), popped: false } })
    } else {
      // switching source: the old host element has nothing left to offer
      if (cur && cur.kind === 'file') destroyMediaHost(cur.url)
      set({ mediaPlayer: { kind: 'file', url, mime, name, at: Date.now(), roomId: roomId ?? activeRoomOf(get()) } })
    }
    sounds.play('lightTick')
  },

  openYouTubePlayer: (videoId, startAt = 0, name, roomId) => {
    set({
      mediaPlayer: {
        kind: 'youtube',
        videoId,
        name: name ?? 'youtube video',
        startAt: Math.max(0, Math.floor(startAt)),
        at: Date.now(),
        roomId: roomId ?? activeRoomOf(get()),
      },
    })
    sounds.play('lightTick')
  },

  closeMediaPlayer: () => {
    const cur = get().mediaPlayer
    // a closed player is done: release the host element for good
    if (cur?.kind === 'file') destroyMediaHost(cur.url)
    set({ mediaPlayer: null })
  },

  setMediaPopped: (popped) => {
    const cur = get().mediaPlayer
    if (!cur) return
    if ((cur.popped ?? false) === popped) return
    set({ mediaPlayer: { ...cur, popped } })
  },

  jumpToMessage: async (messageId) => {
    // fast path: the row is already cached in some loaded room
    for (const [room, state] of Object.entries(get().rooms)) {
      if (state.loaded && state.messages.some((m) => m.id === messageId)) {
        if (room.startsWith('channel:')) {
          if (get().activeChannelId !== room.slice('channel:'.length)) await get().selectChannel(room.slice('channel:'.length))
        } else if (room.startsWith('conversation:')) {
          if (get().activeConversationId !== room.slice('conversation:'.length)) await get().selectConversation(room.slice('conversation:'.length))
        }
        get().jumpTo(room, messageId)
        return
      }
    }
    // thread rows live in thread caches, not room lists
    for (const [rootId, t] of Object.entries(get().threads)) {
      if (t.messages.some((m) => m.id === messageId)) {
        const room = t.root?.room
        if (room?.startsWith('channel:') && get().activeChannelId !== room.slice('channel:'.length)) {
          await get().selectChannel(room.slice('channel:'.length))
        } else if (room?.startsWith('conversation:') && get().activeConversationId !== room.slice('conversation:'.length)) {
          await get().selectConversation(room.slice('conversation:'.length))
        }
        await get().openThread(rootId)
        set({ threadJump: { rootId, messageId, at: Date.now() } })
        return
      }
    }
    // slow path: resolve the room, then decide between a plain jump and a
    // history window fetch
    let ctx
    try {
      ctx = await apiClient.messageContext(messageId)
    } catch {
      return
    }
    if (ctx.channelId) await get().selectChannel(ctx.channelId)
    else if (ctx.conversationId) await get().selectConversation(ctx.conversationId)
    if (ctx.threadOfId) {
      await get().openThread(ctx.threadOfId)
      set({ threadJump: { rootId: ctx.threadOfId, messageId, at: Date.now() } })
      return
    }
    const state = get().rooms[ctx.room]
    if (state?.messages.some((m) => m.id === messageId)) {
      get().jumpTo(ctx.room, messageId)
      return
    }
    try {
      const res = ctx.channelId
        ? await apiClient.channelMessages(ctx.channelId, undefined, undefined, messageId)
        : await apiClient.conversationMessages(ctx.conversationId!, undefined, undefined, messageId)
      set((s) => ({
        rooms: {
          ...s.rooms,
          [ctx.room]: {
            messages: sortMessages(res.messages),
            hasMore: res.hasMore,
            hasNewer: !!res.hasNewer,
            oldestCursor: res.oldestCursor,
            loadingMore: false,
            loaded: true,
            myReadAt: state?.myReadAt ?? null,
          },
        },
      }))
      get().jumpTo(ctx.room, messageId)
    } catch {
      /* the message vanished between resolve and fetch: nothing to jump to */
    }
  },

  requestPresent: (room) => {
    // swap the parked window back to the newest page, then scroll to bottom
    const channelId = room.startsWith('channel:') ? room.slice('channel:'.length) : null
    const conversationId = room.startsWith('conversation:') ? room.slice('conversation:'.length) : null
    void (async () => {
      try {
        const res = channelId
          ? await apiClient.channelMessages(channelId)
          : conversationId
            ? await apiClient.conversationMessages(conversationId)
            : null
        if (!res) return
        set((s) => ({
          rooms: {
            ...s.rooms,
            [room]: {
              messages: sortMessages(res.messages),
              hasMore: res.hasMore,
              hasNewer: false,
              oldestCursor: res.oldestCursor,
              loadingMore: false,
              loaded: true,
              myReadAt: s.rooms[room]?.myReadAt ?? null,
            },
          },
        }))
        set({ presentRequest: { room, at: Date.now() } })
      } catch {
        /* a failed reload keeps the window where it is */
      }
    })()
  },

  setPinsOpen: (open) => set({ pinsOpen: open }),
  setRemindersOpen: (open) => set({ remindersOpen: open }),
  requestInsert: (room, text) => set({ pendingInsert: { room, text, at: Date.now() } }),

  updateProfile: async (payload) => {
    const { user } = await apiClient.updateProfile(payload)
    set({ me: { ...get().me!, ...user } })
    // only identity changes (name / picture) ripple through every list;
    // lightweight fields (status quote, banner, pronouns, bio) update `me`
    // and let each surface refresh itself on open. Skipping the cascade
    // is what keeps the banner color picker from hitching the whole app.
    const heavy =
      payload.displayName !== undefined ||
      payload.avatarUrl !== undefined ||
      payload.avatarColor !== undefined
    if (!heavy) return
    await Promise.all([get().refreshServers(), get().refreshConversations(), get().refreshFriends()])
    for (const serverId of Object.keys(get().serverMembers)) {
      void get().refreshServerDetail(serverId)
    }
  },

  changePassword: async (currentPassword, newPassword, code) => {
    await apiClient.changePassword({ currentPassword, newPassword, code })
  },

  setMyPresence: async (presence) => {
    const me = get().me
    if (!me) return
    // optimistic: the dot changes instantly, the API save is background
    set({ me: { ...me, presence } })
    try {
      const { user } = await apiClient.updateProfile({ presence })
      set({ me: { ...get().me!, ...user } })
    } catch {
      toast({ title: 'could not save status', description: 'The change applies now but may not persist.' })
    }
  },

  refreshFriends: async () => {
    try {
      const { friends, incoming, outgoing } = await apiClient.friends()
      set({ friends, incomingRequests: incoming, outgoingRequests: outgoing })
    } catch {
      // friends are best-effort between syncs
    }
  },

  sendFriendRequest: async (username, temporaryHours) => {
    await apiClient.sendFriendRequest({ username, temporaryHours })
    await get().refreshFriends()
  },

  setFriendNickname: async (friendshipId, nickname) => {
    // optimistic: the row shows the new name before the round trip lands
    set((s) => ({
      friends: s.friends.map((f) =>
        f.friendshipId === friendshipId ? { ...f, nickname: nickname || null } : f
      ),
    }))
    try {
      await apiClient.updateFriendship(friendshipId, { nickname })
    } catch {
      await get().refreshFriends()
    }
  },

  setFriendTemporary: async (friendshipId, temporary, hours) => {
    try {
      await apiClient.updateFriendship(friendshipId, { temporary, hours })
      await get().refreshFriends()
    } catch {
      toast({ title: 'could not update friend' })
    }
  },

  acceptFriendRequest: async (friendshipId) => {
    await apiClient.acceptFriendRequest(friendshipId)
    await get().refreshFriends()
  },

  removeFriendship: async (friendshipId) => {
    await apiClient.removeFriendship(friendshipId)
    await get().refreshFriends()
  },

  blockUser: async (username) => {
    const { user } = await apiClient.blockUser({ username })
    set((s) => ({ blockedUserIds: { ...s.blockedUserIds, [user.id]: true } }))
    await get().refreshFriends()
    await get().refreshConversations()
  },

  unblockUser: async (userId) => {
    await apiClient.unblockUser(userId)
    set((s) => {
      const blockedUserIds = { ...s.blockedUserIds }
      delete blockedUserIds[userId]
      return { blockedUserIds }
    })
  },

  toggleMute: async (scope) => {
    const res = await apiClient.toggleMute(scope)
    set((s) => {
      const mutedScopes = { ...s.mutedScopes }
      if (res.muted) mutedScopes[scope] = true
      else delete mutedScopes[scope]
      return { mutedScopes }
    })
  },

  setReplyTo: (msg) => set({ replyTo: msg }),

  requestEdit: (messageId) => set({ editRequest: { messageId, at: Date.now() } }),

  // ---------- bookmarks / scheduled / reminders / focus mode ----------

  setSavedOpen: (open) => set({ savedOpen: open }),

  refreshBookmarks: async () => {
    try {
      const { bookmarks } = await apiClient.bookmarks()
      set({ bookmarks })
    } catch {
      // best-effort
    }
  },

  toggleBookmark: async (messageId) => {
    // Optimistic save: the bookmark icon flips the instant you click. The
    // server reconciles the row (id, scope tag) on success; if it never
    // confirms within ~2s the flip reverts so the icon never lies.
    const before = get().bookmarks
    const already = before.some((b) => b.message.id === messageId)
    const row = already ? null : findMessageRow(get, messageId)
    const stub = already
      ? before.find((b) => b.message.id === messageId)
      : row && {
          id: `tmp-${messageId}`,
          note: '',
          createdAt: new Date().toISOString(),
          message: row,
          scope: null,
        }
    if (already) {
      set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.message.id !== messageId) }))
    } else if (stub) {
      set((s) => ({ bookmarks: [stub as BookmarkSummary, ...s.bookmarks] }))
    }
    sounds.play('midTick')
    try {
      const res = await withDeadline(apiClient.toggleBookmark(messageId, already ? { remove: true } : undefined))
      await get().refreshBookmarks()
      return !!res.saved
    } catch {
      // revert to the pre-click truth
      set({ bookmarks: before })
      sounds.play('error')
      toast({ title: already ? 'could not remove' : 'could not save', description: 'the server did not respond' })
      return already
    }
  },

  refreshSavedGifs: async () => {
    try {
      const { gifs } = await apiClient.savedGifs()
      set({ savedGifs: gifs })
    } catch {
      // best-effort
    }
  },

  toggleSavedGif: async (url, title) => {
    // Optimistic, url-level and app-wide: every banner + the lightbox + the
    // picker's saved tab flip together the moment this runs.
    const before = get().savedGifs
    const has = before.some((g) => g.url === url)
    const row = has ? { ...(before.find((g) => g.url === url) as { id: string; url: string; title: string }) } : { id: `tmp-${url}`, url, title }
    set((s) => ({
      savedGifs: has ? s.savedGifs.filter((g) => g.url !== url) : [row, ...s.savedGifs],
    }))
    sounds.play('midTick')
    try {
      if (has) {
        await withDeadline(apiClient.removeSavedGif(url))
      } else {
        const { gif } = await withDeadline(apiClient.saveGif(url, title))
        set((s) => ({ savedGifs: s.savedGifs.map((g) => (g.id === `tmp-${url}` ? gif : g)) }))
      }
    } catch {
      set({ savedGifs: before })
      sounds.play('error')
      toast({ title: has ? 'could not remove' : 'could not save', description: 'the server did not respond' })
    }
  },

  setScheduledOpen: (open) => set({ scheduledOpen: open }),

  refreshScheduled: async () => {
    try {
      const { scheduled } = await apiClient.scheduled()
      set({ scheduled })
    } catch {
      // best-effort
    }
  },

  scheduleMessage: async (scopeKey, content, sendAt) => {
    await apiClient.scheduleMessage({ scopeKey, content, sendAt: sendAt.toISOString() })
    await get().refreshScheduled()
  },

  cancelScheduled: async (id) => {
    await apiClient.cancelScheduled(id)
    set((s) => ({ scheduled: s.scheduled.filter((r) => r.id !== id) }))
  },

  refreshReminders: async () => {
    try {
      const { reminders } = await apiClient.reminders()
      set({ reminders })
    } catch {
      // best-effort
    }
  },

  createReminder: async (messageId, remindAt) => {
    await apiClient.createReminder(messageId, remindAt.toISOString())
    await get().refreshReminders()
  },

  cancelReminder: async (id) => {
    await apiClient.cancelReminder(id)
    set((s) => ({ reminders: s.reminders.filter((r) => r.id !== id) }))
  },

  /** fires due reminders as toasts; called on an interval + on visibility.
   *  while the window is unfocused nothing decays: reminders hold their
   *  place and wait to fire until the user actually looks again. */
  tickReminders: () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    const now = Date.now()
    const due = get().reminders.filter((r) => new Date(r.remindAt).getTime() <= now)
    for (const r of due) {
      sounds.play('ping')
      toast({
        title: 'reminder',
        description: `${r.message.authorUsername}: ${r.message.contentPreview ?? 'a message you wanted to revisit'}`,
      })
      void apiClient.cancelReminder(r.id).then(() => {
        set((s) => ({ reminders: s.reminders.filter((x) => x.id !== r.id) }))
      })
    }
  },

  setFocus: (minutes) => {
    sounds.setEnabledOverride(minutes ? false : null)
    notifications.setEnabledOverride(minutes ? false : null)
    set({ focusUntil: minutes ? Date.now() + minutes * 60 * 1000 : null })
  },

  openFriendsView: () => {
    carryAwayYouTube()
    set({ activeServerId: null, activeChannelId: null, activeConversationId: null, friendsViewOpen: true })
    void get().refreshFriends()
  },

  selectHome: () => {
    carryAwayYouTube()
    set({ friendsViewOpen: false })
    const s = get()
    // landing back on Messages jumps straight into the most recent DM
    const recent = [...s.conversations].sort((a, b) => {
      const at = (c: ConversationSummary) =>
        c.lastMessage?.createdAt ? new Date(c.lastMessage.createdAt).getTime() : 0
      return at(b) - at(a)
    })[0]
    const pinnedFirst = [...s.conversations].filter((c) => c.pinned)[0]
    const target = pinnedFirst ?? recent
    if (target && s.conversations.some((c) => c.id === target.id)) {
      set({ activeServerId: null, activeChannelId: null, activeConversationId: target.id, friendsViewOpen: false })
      void get().selectConversation(target.id)
      return
    }
    set({ activeServerId: null, activeChannelId: null, activeConversationId: null, friendsViewOpen: false })
  },

  selectServer: async (serverId) => {
    carryAwayYouTube()
    set({ activeServerId: serverId, activeConversationId: null, activeChannelId: null, friendsViewOpen: false, openThreadId: null })
    void get().refreshServerEmoji(serverId)
    const server = get().servers.find((s) => s.id === serverId)
    if (server && server.channels.length > 0) {
      const first = server.channels[0]
      set({ activeChannelId: first.id })
      await get().selectChannel(first.id)
    }
    void get().refreshServerDetail(serverId)
  },

  selectChannel: async (channelId) => {
    const prevRoom = activeRoomOf(get())
    set({ activeConversationId: null, activeChannelId: channelId, friendsViewOpen: false, openThreadId: null })
    // channels can be opened from a different server context than the rail
    // (quick switcher, alt+arrows, jump): the emoji registry follows the
    // channel's actual server
    const owner = get().servers.find((s) => s.channels.some((c) => c.id === channelId))
    if (owner && owner.id !== get().activeServerId) {
      set({ activeServerId: owner.id })
      void get().refreshServerEmoji(owner.id)
    } else if (owner && !get().serverEmoji[owner.id]) {
      void get().refreshServerEmoji(owner.id)
    }
    const room = roomOfChannel(channelId)
    if (prevRoom !== room) carryAwayYouTube(prevRoom)
    rememberLastRoom(room)

    // voice and forum channels have no message stream: their surfaces
    // (VoiceRoom / ForumView) replace MessageList + composer, so the text
    // feed is never loaded (or marked read) for them
    const channel = owner?.channels.find((c) => c.id === channelId)
    if (channel && channel.type !== 'text') {
      if (channel.type === 'forum') void get().loadForumPosts(channelId)
      return
    }

    void get().markRead(`channel:${channelId}`)
    const state = get().rooms[room]
    if (!state?.loaded) {
      try {
        const res = await apiClient.channelMessages(channelId)
        set((s) => ({
          rooms: {
            ...s.rooms,
            [room]: {
              messages: sortMessages(res.messages),
              hasMore: res.hasMore,
              oldestCursor: res.oldestCursor,
              loadingMore: false,
              loaded: true,
              hasNewer: false,
              myReadAt: res.myReadAt,
            },
          },
        }))
      } catch {
        set((s) => ({ rooms: { ...s.rooms, [room]: { ...emptyRoom, loaded: true } } }))
      }
    }
  },

  selectConversation: async (conversationId) => {
    const prevRoom = activeRoomOf(get())
    set({ activeServerId: null, activeChannelId: null, activeConversationId: conversationId, friendsViewOpen: false, openThreadId: null })
    setActiveServerEmoji([])
    const room = roomOfConversation(conversationId)
    if (prevRoom !== room) carryAwayYouTube(prevRoom)
    rememberLastRoom(room)
    void get().markRead(`conversation:${conversationId}`)
    const state = get().rooms[room]
    if (!state?.loaded) {
      try {
        const res = await apiClient.conversationMessages(conversationId)
        set((s) => ({
          rooms: {
            ...s.rooms,
            [room]: {
              messages: sortMessages(res.messages),
              hasMore: res.hasMore,
              oldestCursor: res.oldestCursor,
              loadingMore: false,
              loaded: true,
              hasNewer: false,
              myReadAt: res.myReadAt,
            },
          },
        }))
      } catch {
        set((s) => ({ rooms: { ...s.rooms, [room]: { ...emptyRoom, loaded: true } } }))
      }
    }
  },

  openDM: async (userId) => {
    const { conversationId } = await apiClient.createConversation(userId)
    await get().refreshConversations()
    await get().selectConversation(conversationId)
  },

  hideConversation: async (conversationId) => {
    await apiClient.hideConversation(conversationId)
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== conversationId),
      ...(s.activeConversationId === conversationId
        ? { activeConversationId: null }
        : {}),
    }))
  },

  pinConversation: async (conversationId) => {
    const { pinned } = await apiClient.pinConversation(conversationId)
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, pinned } : c)),
    }))
  },

  createGroup: async (name, memberIds) => {
    const { conversationId } = await apiClient.createGroup(name, memberIds)
    await get().refreshConversations()
    await get().selectConversation(conversationId)
  },

  addGroupMember: async (conversationId, userId) => {
    try {
      await apiClient.addGroupMember(conversationId, userId)
    } catch (err) {
      // surface the cap error untouched: the header shows the raise dialog
      if (err instanceof ApiError && err.code === 'limit') throw err
      throw err
    }
    await get().refreshConversations()
  },

  raiseGroupLimit: async (conversationId) => {
    await apiClient.updateConversation(conversationId, { raiseLimit: true })
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId ? { ...c, limitRaised: true } : c
      ),
    }))
    await get().refreshConversations()
  },

  kickGroupMember: async (conversationId, userId) => {
    try {
      await apiClient.kickGroupMember(conversationId, userId)
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not kick',
        description: err instanceof ApiError ? err.message : 'Try again.',
      })
      return
    }
    // optimistic row removal; the refresh reconciles and other members hear
    // the same news through the conversation:new broadcast
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, participants: (c.participants ?? []).filter((p) => p.id !== userId) }
          : c
      ),
    }))
    toast({ title: 'kicked' })
    await get().refreshConversations()
  },

  setGroupLimit: async (conversationId, raised) => {
    await apiClient.setGroupLimit(conversationId, raised)
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId ? { ...c, limitRaised: raised } : c
      ),
    }))
    await get().refreshConversations()
  },

  setGroupPolicies: async (conversationId, editPolicy, invitePolicy) => {
    // optimistic: every member's header/settings reflect the flip at once
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId ? { ...c, editPolicy, invitePolicy } : c
      ),
    }))
    try {
      await apiClient.setGroupPolicies(conversationId, editPolicy, invitePolicy)
      await get().refreshConversations()
    } catch (err) {
      // revert on failure
      set((s) => ({ conversations: s.conversations }))
      await get().refreshConversations()
      throw err
    }
  },

  leaveGroup: async (conversationId) => {
    await apiClient.leaveGroup(conversationId)
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== conversationId),
      ...(s.activeConversationId === conversationId
        ? { activeConversationId: null }
        : {}),
    }))
  },

  renameGroup: async (conversationId, name) => {
    await apiClient.updateConversation(conversationId, { name })
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, name } : c)),
    }))
    await get().refreshConversations()
  },

  setGroupPhoto: async (conversationId, file) => {
    if (!file) {
      await apiClient.updateConversation(conversationId, { iconUrl: null })
      set((s) => ({
        conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, iconUrl: null } : c)),
      }))
      await get().refreshConversations()
      return
    }
    // downscale raster photos in the browser (square crop, 512px) so huge
    // camera dumps do not bloat the room; gifs and small files pass through
    const blob = await downscaleForIcon(file)
    const { url } = await apiClient.uploadImage(blob)
    await apiClient.updateConversation(conversationId, { iconUrl: url })
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === conversationId ? { ...c, iconUrl: url } : c)),
    }))
    await get().refreshConversations()
  },

  openGroupDM: async (conversationId) => {
    await get().selectConversation(conversationId)
  },

  setTempExpiry: async (conversationId, minutes) => {
    await apiClient.updateConversation(conversationId, { tempExpiryMinutes: minutes })
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId ? { ...c, tempExpiryMinutes: minutes } : c
      ),
    }))
  },

  createServer: async (name, description) => {
    const { server } = await apiClient.createServer({ name, description })
    set((s) => ({ servers: [...s.servers, server] }))
    void get().refreshServerDetail(server.id)
    return server
  },

  joinServer: async (inviteCode) => {
    const res = await apiClient.joinServer(inviteCode)
    if (!res.alreadyMember) {
      set((s) => ({ servers: [...s.servers, res.server] }))
      void get().refreshServerDetail(res.server.id)
    }
    return res
  },

  deleteServer: async (serverId) => {
    await apiClient.deleteServer(serverId)
    set((s) => {
      const servers = s.servers.filter((sv) => sv.id !== serverId)
      const wasActive = s.activeServerId === serverId
      return {
        servers,
        ...(wasActive ? { activeServerId: null, activeChannelId: null } : {}),
      }
    })
    const members = { ...get().serverMembers }
    delete members[serverId]
    set({ serverMembers: members })
  },

  leaveServer: async (serverId) => {
    await apiClient.leaveServer(serverId)
    set((s) => {
      const servers = s.servers.filter((sv) => sv.id !== serverId)
      const wasActive = s.activeServerId === serverId
      return {
        servers,
        ...(wasActive ? { activeServerId: null, activeChannelId: null } : {}),
      }
    })
    const members = { ...get().serverMembers }
    delete members[serverId]
    set({ serverMembers: members })
  },

  updateServer: async (serverId, payload) => {
    await apiClient.updateServer(serverId, payload)
    await get().refreshServers()
    await get().refreshServerDetail(serverId)
  },

  createChannel: async (serverId, name, topic, type) => {
    await apiClient.createChannel(serverId, { name, topic, ...(type ? { type } : {}) })
    await get().refreshServers()
    const server = get().servers.find((s) => s.id === serverId)
    const created = server?.channels.find((c) => c.name === name.toLowerCase().replace(/\s+/g, '-'))
    if (created) {
      await get().selectChannel(created.id)
    }
  },

  createCategory: async (serverId, name) => {
    await apiClient.createCategory(serverId, name)
    await get().refreshServers()
    await get().refreshServerDetail(serverId)
  },

  renameCategory: async (serverId, categoryId, name) => {
    await apiClient.updateCategory(categoryId, { name })
    await get().refreshServers()
    await get().refreshServerDetail(serverId)
  },

  deleteCategory: async (serverId, categoryId) => {
    await apiClient.deleteCategory(categoryId)
    await get().refreshServers()
    await get().refreshServerDetail(serverId)
  },

  reorderCategories: async (serverId, orderedIds) => {
    await apiClient.reorderCategories(serverId, orderedIds)
    await get().refreshServers()
    await get().refreshServerDetail(serverId)
  },

  updateChannel: async (channelId, payload) => {
    await apiClient.updateChannel(channelId, payload)
    await get().refreshServers()
    const server = get().servers.find((s) => s.channels.some((c) => c.id === channelId))
    if (server) await get().refreshServerDetail(server.id)
  },

  deleteChannel: async (channelId) => {
    await apiClient.deleteChannel(channelId)
    set((s) => {
      if (s.activeChannelId !== channelId) return {}
      const server = s.servers.find((sv) => sv.channels.some((c) => c.id === channelId))
      const fallback = server?.channels.find((c) => c.id !== channelId)
      return { activeChannelId: fallback?.id ?? null }
    })
    await get().refreshServers()
    const activeServerId = get().activeServerId
    if (activeServerId) {
      await get().refreshServerDetail(activeServerId)
      const server = get().servers.find((s) => s.id === activeServerId)
      const current = get().activeChannelId
      if (!current && server && server.channels.length > 0) {
        await get().selectChannel(server.channels[0].id)
      }
    }
  },

  moveChannel: async (serverId, channelId, direction) => {
    const server = get().servers.find((s) => s.id === serverId)
    if (!server) return
    const ids = server.channels.map((c) => c.id)
    const from = ids.indexOf(channelId)
    const to = from + direction
    if (from === -1 || to < 0 || to >= ids.length) return
    ;[ids[from], ids[to]] = [ids[to], ids[from]]
    await apiClient.reorderChannels(serverId, ids)
    await get().refreshServers()
    await get().refreshServerDetail(serverId)
  },

  reorderChannels: async (serverId, orderedIds) => {
    await apiClient.reorderChannels(serverId, orderedIds)
    await get().refreshServers()
    await get().refreshServerDetail(serverId)
  },

  setMemberRole: async (serverId, userId, role) => {
    await apiClient.setMemberRole(serverId, userId, role)
    await get().refreshServerDetail(serverId)
  },

  setMemberCustomRole: async (serverId, userId, roleId) => {
    await apiClient.setMemberCustomRole(serverId, userId, roleId)
    await get().refreshServerDetail(serverId)
  },

  setMemberNickname: async (serverId, userId, nickname) => {
    await apiClient.setMemberNickname(serverId, userId, nickname)
    await get().refreshServerDetail(serverId)
  },

  timeoutMember: async (serverId, userId, minutes) => {
    await apiClient.timeoutMember(serverId, userId, minutes)
    await get().refreshServerDetail(serverId)
  },

  kickMember: async (serverId, userId, reason) => {
    await apiClient.kickMember(serverId, userId, reason)
    await get().refreshServerDetail(serverId)
    await get().refreshServers()
  },

  banMember: async (serverId, userId, reason) => {
    await apiClient.banMember(serverId, userId, reason)
    await get().refreshServerDetail(serverId)
    await get().refreshServers()
  },

  unbanUser: async (serverId, userId) => {
    await apiClient.unbanUser(serverId, userId)
  },

  createRole: async (serverId, payload) => {
    const { role } = await apiClient.createRole(serverId, payload)
    await get().refreshServerDetail(serverId)
    return role
  },

  updateRole: async (serverId, roleId, payload) => {
    await apiClient.updateRole(serverId, roleId, payload)
    await get().refreshServerDetail(serverId)
  },

  deleteRole: async (serverId, roleId) => {
    await apiClient.deleteRole(serverId, roleId)
    await get().refreshServerDetail(serverId)
  },

  purgeChannel: async (channelId, count, userId) => {
    const res = await apiClient.purgeChannel(channelId, count, userId)
    // our own copy of the room is trimmed to match; the socket event
    // handles everyone else
    const room = `channel:${channelId}`
    set((s) => {
      const state = s.rooms[room]
      if (!state) return {}
      const messages = [...state.messages]
      let removed = 0
      for (let i = messages.length - 1; i >= 0 && removed < res.deleted; i--) {
        if (userId && messages[i].authorId !== userId) continue
        messages.splice(i, 1)
        removed++
      }
      return { rooms: { ...s.rooms, [room]: { ...state, messages } } }
    })
    return res.deleted
  },

  setDraft: (room, content) => {
    set((s) => {
      if ((s.drafts[room] ?? '') === content) return {}
      const drafts = { ...s.drafts }
      if (content) drafts[room] = content
      else delete drafts[room]
      return { drafts }
    })
  },

  refreshServers: async () => {
    try {
      const { servers } = await apiClient.servers()
      set({ servers })
    } catch {
      // keep the old list on failure
    }
  },

  refreshServerDetail: async (serverId) => {
    try {
      const detail = await apiClient.serverDetail(serverId)
      set((s) => {
        const members = { ...s.serverMembers }
        members[serverId] = detail.members
        const roles = { ...s.serverRoles }
        roles[serverId] = detail.roles
        const servers = s.servers.map((sv) =>
          sv.id === serverId
            ? {
                ...sv,
                channels: detail.channels,
                categories: detail.categories,
                inviteCode: detail.server.inviteCode,
                name: detail.server.name,
                description: detail.server.description,
                iconUrl: detail.server.iconUrl,
                myRole: detail.myRole,
                myPerms: detail.myPerms,
              }
            : sv
        )
        return { serverMembers: members, serverRoles: roles, servers }
      })
    } catch {
      // server may have been deleted between refreshes
    }
  },

  refreshServerEmoji: async (serverId) => {
    try {
      const { emoji } = await apiClient.serverEmoji(serverId)
      set((s) => ({ serverEmoji: { ...s.serverEmoji, [serverId]: emoji } }))
      // the registry serves the ACTIVE server only
      if (get().activeServerId === serverId) {
        setActiveServerEmoji(emoji)
      }
    } catch {
      // not a member (anymore): drop the cache and the registry share
      set((s) => {
        const serverEmoji = { ...s.serverEmoji }
        delete serverEmoji[serverId]
        return { serverEmoji }
      })
      if (get().activeServerId === serverId) setActiveServerEmoji([])
    }
  },

  refreshConversations: async () => {
    try {
      const { conversations } = await apiClient.conversations()
      set((s) => {
        const otherReadAt = { ...s.otherReadAt }
        for (const c of conversations) {
          otherReadAt[c.id] = c.otherLastReadAt
        }
        // a conversation that left the list while open (kicked from a
        // group): drop it from the main column instead of a dead room
        const activeGone =
          !!s.activeConversationId &&
          s.conversations.some((c) => c.id === s.activeConversationId) &&
          !conversations.some((c) => c.id === s.activeConversationId)
        return {
          conversations,
          otherReadAt,
          ...(activeGone ? { activeConversationId: null } : {}),
        }
      })
    } catch {
      // keep the old list on failure
    }
  },

  loadOlder: async (room) => {
    const state = get().rooms[room]
    if (!state?.loaded || state.loadingMore || !state.hasMore || !state.oldestCursor) return
    set((s) => ({
      rooms: { ...s.rooms, [room]: { ...(s.rooms[room] || emptyRoom), loadingMore: true } },
    }))
    try {
      if (room.startsWith('channel:')) {
        const channelId = room.slice('channel:'.length)
        const res = await apiClient.channelMessages(channelId, state.oldestCursor)
        set((s) => ({
          rooms: {
            ...s.rooms,
            [room]: {
              messages: sortMessages([...res.messages, ...(s.rooms[room]?.messages || [])]),
              hasMore: res.hasMore,
              oldestCursor: res.oldestCursor,
              loadingMore: false,
              loaded: true,
              hasNewer: s.rooms[room]?.hasNewer ?? false,
              myReadAt: s.rooms[room]?.myReadAt ?? null,
            },
          },
        }))
      } else {
        const conversationId = room.slice('conversation:'.length)
        const res = await apiClient.conversationMessages(conversationId, state.oldestCursor)
        set((s) => ({
          rooms: {
            ...s.rooms,
            [room]: {
              messages: sortMessages([...res.messages, ...(s.rooms[room]?.messages || [])]),
              hasMore: res.hasMore,
              oldestCursor: res.oldestCursor,
              loadingMore: false,
              loaded: true,
              hasNewer: s.rooms[room]?.hasNewer ?? false,
              myReadAt: s.rooms[room]?.myReadAt ?? null,
            },
          },
        }))
      }
    } catch {
      set((s) => ({
        rooms: { ...s.rooms, [room]: { ...(s.rooms[room] || emptyRoom), loadingMore: false } },
      }))
    }
  },

  /** Optimistic send, Discord-style: the message renders the instant Enter is
   *  hit (dimmed with a clock), the HTTP round trip happens behind it, and
   *  the local row is swapped for the server row on ack. The socket echo is
   *  deduped by id. On failure the row turns red with retry / discard. */
  sendMessage: async (payload) => {
    const { activeChannelId, activeConversationId, replyTo, me } = get()
    const room = activeChannelId
      ? `channel:${activeChannelId}`
      : activeConversationId
        ? `conversation:${activeConversationId}`
        : null
    if (!room || !me) return
    const replyToId =
      replyTo?.room === room ? replyTo.id : undefined

    // 1. local echo: a temp row appears immediately with pending state
    const tempId = `pending:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    const echo: ClientMessage = {
      id: tempId,
      content: payload.content ?? null,
      imageUrl: payload.imageUrl ?? null,
      attachments: payload.attachments ?? null,
      createdAt: new Date().toISOString(),
      editedAt: null,
      pinned: false,
      pinnedAt: null,
      pingsEveryone: false,
      whisperTargetId: payload.whisperTo ? 'me' : null,
      whisperTargetName: payload.whisperTo ?? null,
      replyToId: replyToId ?? null,
      replyTo: null,
      authorId: me.id,
      author: {
        id: me.id,
        username: me.username,
        displayName: me.displayName,
        avatarUrl: me.avatarUrl,
        avatarColor: me.avatarColor,
      },
      authorNickname: null,
      authorRoleColor: null,
      room,
      reactions: [],
      pending: true,
      nonce: tempId,
    }
    set((s) => {
      const state = s.rooms[room]
      if (!state?.loaded) return { replyTo: null }
      return {
        rooms: { ...s.rooms, [room]: { ...state, messages: [...state.messages, echo] } },
        replyTo: null,
      }
    })
    // the send voice fires the moment the row lands, not after the server
    // round trip: the confirmation swap is silent and invisible
    sounds.play('send')
    try {
      const { message } = room.startsWith('channel:')
        ? await apiClient.sendChannelMessage(room.slice('channel:'.length), { ...payload, replyToId, nonce: tempId })
        : await apiClient.sendConversationMessage(room.slice('conversation:'.length), { ...payload, replyToId, nonce: tempId })
      // 3. swap: drop the temp row, add the real one (socket echo may have
      // already done the swap via the nonce; dedupe by real id either way)
      set((s) => {
        const state = s.rooms[room]
        if (!state?.loaded) return {}
        const withoutTemp = state.messages.filter((m) => m.id !== tempId)
        const hasReal = withoutTemp.some((m) => m.id === message.id)
        return {
          rooms: {
            ...s.rooms,
            [room]: { ...state, messages: hasReal ? withoutTemp : sortMessages([...withoutTemp, message]) },
          },
        }
      })
      if (room.startsWith('channel:')) {
        const channelId = room.slice('channel:'.length)
        set((s) => {
          const channelUnread = { ...s.channelUnread }
          delete channelUnread[channelId]
          const channelMentions = { ...s.channelMentions }
          delete channelMentions[channelId]
          return { channelUnread, channelMentions }
        })
      }
    } catch {
      // 4. failure: keep the row, flag it, offer retry / discard
      set((s) => {
        const state = s.rooms[room]
        if (!state?.loaded) return {}
        return {
          rooms: {
            ...s.rooms,
            [room]: {
              ...state,
              messages: state.messages.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m)),
            },
          },
        }
      })
      sounds.play('error')
      throw new Error('send-failed')
    }
  },

  retryMessage: async (room, tempId) => {
    const state = get().rooms[room]
    const row = state?.messages.find((m) => m.id === tempId)
    if (!row || !get().me) return
    const me = get().me!
    // flip back to pending, then replay through the normal path minus the echo
    set((s) => {
      const st = s.rooms[room]
      if (!st?.loaded) return {}
      return {
        rooms: {
          ...s.rooms,
          [room]: { ...st, messages: st.messages.filter((m) => m.id !== tempId) },
        },
      }
    })
    const payload: { content?: string; imageUrl?: string; attachments?: MessageAttachment[] } = {}
    if (row.content) payload.content = row.content
    if (row.imageUrl) payload.imageUrl = row.imageUrl
    if (row.attachments) payload.attachments = row.attachments
    // reuse sendMessage but keep the same room explicitly (not just active)
    const wasActive = activeRoomOf(get()) === room
    if (!wasActive) {
      // retrying from a non-active room (rare): send directly without echo
      try {
        if (room.startsWith('channel:')) {
          await apiClient.sendChannelMessage(room.slice('channel:'.length), payload)
        } else {
          await apiClient.sendConversationMessage(room.slice('conversation:'.length), payload)
        }
      } catch {
        sounds.play('error')
      }
      return
    }
    try {
      await get().sendMessage(payload)
    } catch {
      // sendMessage already flagged the fresh echo as failed
    }
    void me
  },

  discardMessage: (room, tempId) => {
    set((s) => {
      const state = s.rooms[room]
      let threadsChanged = false
      const threads = { ...s.threads }
      for (const [rootId, t] of Object.entries(s.threads)) {
        if (t.messages.some((m) => m.id === tempId)) {
          threadsChanged = true
          threads[rootId] = { ...t, messages: t.messages.filter((m) => m.id !== tempId) }
        }
      }
      if (!state?.loaded) return threadsChanged ? { threads } : {}
      return threadsChanged
        ? {
            threads,
            rooms: { ...s.rooms, [room]: { ...state, messages: state.messages.filter((m) => m.id !== tempId) } },
          }
        : { rooms: { ...s.rooms, [room]: { ...state, messages: state.messages.filter((m) => m.id !== tempId) } } }
    })
  },

  editMessage: async (room, messageId, content) => {
    const { message } = await apiClient.editMessage(messageId, content)
    get().onMessageUpdate(message)
  },

  deleteMessage: async (room, messageId) => {
    // instant removal: the row is gone from the UI before the request lands,
    // silently, with no sound and no spinner
    set((s) => {
      const state = s.rooms[room]
      let threadsChanged = false
      const threads = { ...s.threads }
      for (const [rootId, t] of Object.entries(s.threads)) {
        if (t.messages.some((m) => m.id === messageId)) {
          threadsChanged = true
          threads[rootId] = { ...t, messages: t.messages.filter((m) => m.id !== messageId), count: Math.max(0, t.count - 1) }
        }
        if (rootId === messageId) {
          // the root itself: drop the cache and close the panel
          delete threads[rootId]
          threadsChanged = true
        }
      }
      const openThreadId = s.openThreadId && !threads[s.openThreadId] ? null : s.openThreadId
      const roomsPatch = state
        ? { rooms: { ...s.rooms, [room]: { ...state, messages: state.messages.filter((m) => m.id !== messageId) } } }
        : {}
      return threadsChanged ? { ...roomsPatch, threads, openThreadId } : roomsPatch
    })
    try {
      await apiClient.deleteMessage(messageId)
    } catch {
      // already gone server-side or network hiccup: keep it deleted locally,
      // the periodic sync is the source of truth and will reconcile
    }
  },

  toggleReaction: async (room, messageId, emoji) => {
    const meId = get().me?.id
    if (!meId) return
    // Optimistic reactions: the chip renders the instant you click. If the
    // request never reaches the server, it silently disappears again.
    const applyMine = (adding: boolean) =>
      set((s) => {
        const rs = s.rooms[room]
        const stamp = new Date().toISOString()
        const patchRow = (m: ClientMessage): ClientMessage => {
          if (m.id !== messageId) return m
          const reactions = (m.reactions ?? []).map((r) => ({ emoji: r.emoji, userIds: [...r.userIds], at: r.at ? [...r.at] : undefined }))
          const idx = reactions.findIndex((r) => r.emoji === emoji)
          if (adding) {
            if (idx >= 0) {
              if (!reactions[idx].userIds.includes(meId)) {
                reactions[idx].userIds.push(meId)
                reactions[idx].at = [...(reactions[idx].at ?? []), stamp]
              }
            } else {
              reactions.push({ emoji, userIds: [meId], at: [stamp] })
            }
          } else if (idx >= 0) {
            const pos = reactions[idx].userIds.indexOf(meId)
            reactions[idx].userIds = reactions[idx].userIds.filter((id) => id !== meId)
            if (pos >= 0 && reactions[idx].at) reactions[idx].at = reactions[idx].at.filter((_, i) => i !== pos)
            if (reactions[idx].userIds.length === 0) reactions.splice(idx, 1)
          }
          return { ...m, reactions }
        }
        // optimistic chips land in the room rows AND any thread that holds the row
        let threadsChanged = false
        const threads = { ...s.threads }
        for (const [rootId, t] of Object.entries(s.threads)) {
          if (t.messages.some((m) => m.id === messageId)) {
            threadsChanged = true
            threads[rootId] = { ...t, messages: t.messages.map(patchRow) }
          }
        }
        if (!rs) return threadsChanged ? { threads } : {}
        const messages = rs.messages.map(patchRow)
        return threadsChanged
          ? { rooms: { ...s.rooms, [room]: { ...rs, messages } }, threads }
          : { rooms: { ...s.rooms, [room]: { ...rs, messages } } }
      })

    const before =
      get().rooms[room]?.messages.find((m) => m.id === messageId)?.reactions ??
      Object.values(get().threads).find((t) => t.messages.some((m) => m.id === messageId))?.messages.find((m) => m.id === messageId)?.reactions
    const wasMine = !!before?.find((r) => r.emoji === emoji)?.userIds.includes(meId)
    // a queued add is tracked so intermediate server payloads never drop the
    // chip and it always reconciles on the right edge, oldest first
    if (!wasMine) trackPendingReactionAdd(messageId, emoji)
    applyMine(!wasMine)

    const run = async () => {
      try {
        const res = await apiClient.toggleReaction(messageId, emoji)
        clearPendingReactionAdd(messageId, emoji)
        get().onMessageReaction(res)
      } catch {
        clearPendingReactionAdd(messageId, emoji)
        applyMine(wasMine)
      }
    }
    // serialize per message: requests leave in click order, so the server's
    // oldest-first truth can never disagree with the order they were added
    const prev = reactionChains.get(messageId) ?? Promise.resolve()
    const next = prev.then(run, run)
    reactionChains.set(messageId, next)
    void next.then(() => {
      if (reactionChains.get(messageId) === next) reactionChains.delete(messageId)
    })
    await next
  },

  togglePin: async (room, messageId, pinned) => {
    // `pinned` is the message's CURRENT state: pinned -> unpin, unpinned -> pin.
    // Optimistic: the header row's pin state flips immediately and reverts
    // within ~2s if the server never confirms.
    const patch = (p: boolean) =>
      set((s) => {
        const rs = s.rooms[room]
        if (!rs) return {}
        return {
          rooms: {
            ...s.rooms,
            [room]: { ...rs, messages: rs.messages.map((m) => (m.id === messageId ? { ...m, pinned: p } : m)) },
          },
        }
      })
    patch(!pinned)
    try {
      const { message } = pinned
        ? await withDeadline(apiClient.unpinMessage(messageId))
        : await withDeadline(apiClient.pinMessage(messageId))
      get().onMessageUpdate(message)
    } catch {
      patch(pinned)
      sounds.play('error')
      toast({ title: 'could not pin', description: 'the server did not respond' })
    }
  },

  // ---- threads ----

  openThread: async (rootId) => {
    set({ openThreadId: rootId })
    const existing = get().threads[rootId]
    if (existing?.loaded) return
    // placeholder while it loads so the panel can render immediately
    set((s) => ({
      threads: { ...s.threads, [rootId]: existing ?? { root: null, messages: [], loaded: false, count: 0 } },
    }))
    try {
      const res = await apiClient.threadMessages(rootId)
      // the root may have been deleted while loading
      if (get().openThreadId !== rootId && !get().threads[rootId]) return
      set((s) => ({
        threads: {
          ...s.threads,
          [rootId]: { root: res.root, messages: sortMessages(res.messages), loaded: true, count: res.count },
        },
      }))
      // keep the root's bar count in sync with server truth
      const room = res.root.room
      set((s) => {
        const rs = s.rooms[room]
        if (!rs?.loaded) return {}
        return {
          rooms: {
            ...s.rooms,
            [room]: {
              ...rs,
              messages: rs.messages.map((m) =>
                m.id === rootId ? { ...m, threadCount: res.count, threadUsers: m.threadUsers } : m
              ),
            },
          },
        }
      })
    } catch {
      set((s) => {
        const threads = { ...s.threads }
        delete threads[rootId]
        return { threads, openThreadId: s.openThreadId === rootId ? null : s.openThreadId }
      })
    }
  },

  closeThread: () => set({ openThreadId: null }),

  sendThreadMessage: async (rootId, payload) => {
    const me = get().me
    const thread = get().threads[rootId]
    const root = thread?.root
    if (!me || !root) return
    const room = root.room
    const isChannel = room.startsWith('channel:')
    const targetId = room.slice(room.indexOf(':') + 1)

    const tempId = `pending:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    const echo: ClientMessage = {
      id: tempId,
      content: payload.content ?? null,
      imageUrl: payload.imageUrl ?? null,
      attachments: null,
      createdAt: new Date().toISOString(),
      editedAt: null,
      pinned: false,
      pinnedAt: null,
      pingsEveryone: false,
      whisperTargetId: null,
      whisperTargetName: null,
      replyToId: null,
      replyTo: null,
      threadOfId: rootId,
      authorId: me.id,
      author: {
        id: me.id,
        username: me.username,
        displayName: me.displayName,
        avatarUrl: me.avatarUrl,
        avatarColor: me.avatarColor,
      },
      authorNickname: null,
      authorRoleColor: null,
      room,
      reactions: [],
      pending: true,
      nonce: tempId,
    }
    set((s) => {
      const t = s.threads[rootId]
      if (!t) return {}
      return { threads: { ...s.threads, [rootId]: { ...t, messages: [...t.messages, echo] } } }
    })
    // instant send voice at echo time, never after the round trip
    sounds.play('send')

    try {
      const { message } = isChannel
        ? await apiClient.sendChannelMessage(targetId, { ...payload, threadOfId: rootId, nonce: tempId })
        : await apiClient.sendConversationMessage(targetId, { ...payload, threadOfId: rootId, nonce: tempId })
      // did the socket echo already land the real row? (it also updated the bar)
      const socketPlacedIt = !!get().threads[rootId]?.messages.some((m) => m.id === message.id)
      set((s) => {
        const t = s.threads[rootId]
        if (!t) return {}
        const withoutTemp = t.messages.filter((m) => m.id !== tempId)
        const hasReal = withoutTemp.some((m) => m.id === message.id)
        return {
          threads: {
            ...s.threads,
            [rootId]: { ...t, messages: hasReal ? withoutTemp : sortMessages([...withoutTemp, message]) },
          },
        }
      })
      // the response carries the absolute thread size: set the bar to it
      // (covers both the socket-dead fallback and the HTTP-beats-echo race)
      if (!socketPlacedIt && typeof message.threadTotal === 'number') {
        set((s) => {
          const rs = s.rooms[room]
          if (!rs?.loaded) return {}
          return {
            rooms: {
              ...s.rooms,
              [room]: {
                ...rs,
                messages: rs.messages.map((m) =>
                  m.id === rootId ? { ...m, threadCount: message.threadTotal } : m
                ),
              },
            },
          }
        })
      }
    } catch {
      set((s) => {
        const t = s.threads[rootId]
        if (!t) return {}
        return {
          threads: {
            ...s.threads,
            [rootId]: { ...t, messages: t.messages.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m)) },
          },
        }
      })
      sounds.play('error')
      throw new Error('send-failed')
    }
  },

  // ---- forwarding ----

  setForwardTarget: (msg) => set({ forwardTarget: msg }),

  forwardMessage: async (messageId, targetType, targetId) => {
    await apiClient.forwardMessage(messageId, { targetType, targetId })
    set({ forwardTarget: null })
  },

  // ---- translation ----

  translateMessage: async (messageId, text) => {
    // cached: translating again toggles it off
    const current = get().translations[messageId]
    if (current && !current.loading && current.text !== null) {
      set((s) => {
        const translations = { ...s.translations }
        delete translations[messageId]
        return { translations }
      })
      return
    }
    if (current?.loading) return
    set((s) => ({ translations: { ...s.translations, [messageId]: { loading: true, text: null } } }))
    try {
      const { text: translated } = await apiClient.translate(text)
      set((s) => ({ translations: { ...s.translations, [messageId]: { loading: false, text: translated } } }))
    } catch {
      set((s) => {
        const translations = { ...s.translations }
        delete translations[messageId]
        return { translations }
      })
      sounds.play('error')
    }
  },

  markRead: async (scope) => {
    try {
      await apiClient.markRead(scope)
      set((s) => {
        if (scope.startsWith('channel:')) {
          const channelId = scope.slice('channel:'.length)
          if (s.channelUnread[channelId] === undefined) return {}
          const channelUnread = { ...s.channelUnread }
          delete channelUnread[channelId]
          const channelMentions = { ...s.channelMentions }
          delete channelMentions[channelId]
          return { channelUnread, channelMentions }
        }
        const conversationId = scope.slice('conversation:'.length)
        const conversations = s.conversations.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c))
        return { conversations }
      })
    } catch {
      // read states are best-effort
    }
  },

  onConnected: (connected) => set({ connected }),

  onPresenceInit: (userIds, statuses, awaySince, lastSeen) => {
    const map: Record<string, boolean> = {}
    for (const id of userIds) map[id] = true
    set({ onlineUserIds: map, presenceStatuses: statuses ?? {}, awaySince: awaySince ?? {}, lastSeen: lastSeen ?? {} })
  },

  onPresenceOnline: (userId, status, awaySince) => {
    set((s) => {
      if (s.onlineUserIds[userId] && (s.presenceStatuses[userId] ?? 'online') === (status ?? 'online')) return {}
      const presenceStatuses = { ...s.presenceStatuses }
      const away = { ...s.awaySince }
      if (status) presenceStatuses[userId] = status
      else delete presenceStatuses[userId]
      if (awaySince) away[userId] = awaySince
      else delete away[userId]
      // they are back: "last online" stops applying until the next drop
      const seen = { ...s.lastSeen }
      delete seen[userId]
      return { onlineUserIds: { ...s.onlineUserIds, [userId]: true }, presenceStatuses, awaySince: away, lastSeen: seen }
    })
  },

  onPresenceStatus: (userId, status, awaySince) => {
    set((s) => {
      const away = { ...s.awaySince }
      if (status === 'idle' && awaySince) away[userId] = awaySince
      else delete away[userId]
      return { presenceStatuses: { ...s.presenceStatuses, [userId]: status }, awaySince: away }
    })
  },

  onPresenceOffline: (userId, lastSeenAt) => {
    set((s) => {
      // remember when they went dark so "last online X ago" can render; a
      // missing stamp (older emitters) keeps whatever init/sync knew
      const hasStamp = typeof lastSeenAt === 'string' && !!lastSeenAt
      const seen = { ...s.lastSeen }
      if (hasStamp) seen[userId] = lastSeenAt
      const wasOnline = !!s.onlineUserIds[userId]
      if (!wasOnline && (!hasStamp || s.lastSeen[userId] === seen[userId])) return {}
      const next = { ...s.onlineUserIds }
      delete next[userId]
      return { onlineUserIds: next, lastSeen: seen }
    })
  },

  onUserUpdate: (user) => {
    // patch a user's face everywhere it is cached: me, conversation lists,
    // server member lists, message author snapshots, the open profile card.
    // pure local merge: no refetch storm, works even when only one client
    // is online to receive it
    const patch = <T extends { id: string }>(list: T[] | undefined): T[] | undefined =>
      !list ? list : list.map((p) => (p.id === user.id ? { ...p, ...user } : p))
    const patchFriend = (f: FriendSummary): FriendSummary =>
      f.user.id === user.id ? { ...f, user: { ...f.user, ...user } } : f

    set((s) => {
      const me = s.me?.id === user.id ? { ...s.me, ...user } : s.me
      const profileUser = s.profileUser?.id === user.id ? { ...s.profileUser, ...user } : s.profileUser
      const conversations = s.conversations.map((c) => {
        if (c.otherUser?.id === user.id) {
          return { ...c, otherUser: { ...c.otherUser, ...user } }
        }
        const participants = c.participants ? patch(c.participants) : undefined
        return participants === c.participants ? c : { ...c, participants }
      })
      const serverMembers: typeof s.serverMembers = {}
      for (const [serverId, members] of Object.entries(s.serverMembers)) {
        const next = patch(members)
        serverMembers[serverId] = next === members ? members : next!
      }
      const friends = s.friends.map(patchFriend)
      const incomingRequests = s.incomingRequests.map(patchFriend)
      const outgoingRequests = s.outgoingRequests.map(patchFriend)
      // message author snapshots live inside room + thread caches
      const rooms = { ...s.rooms }
      for (const [room, state] of Object.entries(s.rooms)) {
        if (!state.messages.some((m) => m.author.id === user.id)) continue
        rooms[room] = {
          ...state,
          messages: state.messages.map((m) =>
            m.author.id === user.id ? { ...m, author: { ...m.author, ...user } } : m
          ),
        }
      }
      const threads = { ...s.threads }
      for (const [rootId, t] of Object.entries(s.threads)) {
        const inReplies = t.messages.some((m) => m.author.id === user.id)
        const inRoot = t.root?.author.id === user.id
        if (!inReplies && !inRoot) continue
        threads[rootId] = {
          ...t,
          root: inRoot && t.root ? { ...t.root, author: { ...t.root.author, ...user } } : t.root,
          messages: t.messages.map((m) =>
            m.author.id === user.id ? { ...m, author: { ...m.author, ...user } } : m
          ),
        }
      }
      return {
        me,
        profileUser,
        conversations,
        serverMembers,
        friends,
        incomingRequests,
        outgoingRequests,
        rooms,
        threads,
      }
    })
  },

  applyUserProfilePatch: (userId, patch) => {
    // merge a profile change into EVERY cached surface of that user: me,
    // dm partners, group participants, friends lists, server member
    // columns, message authors in loaded rooms and threads, and the open
    // profile card. one pass per surface, immutable objects, no refetch:
    // a profile edit lands on every screen the moment it happens.
    const next: Record<string, unknown> = {}
    for (const key of [
      'username',
      'displayName',
      'avatarUrl',
      'avatarColor',
      'bio',
      'customStatus',
      'pronouns',
      'bannerColor',
      'bannerUrl',
    ] as const) {
      if (patch[key] !== undefined) next[key] = patch[key]
    }
    if (Object.keys(next).length === 0) return

    // a locally applied optimistic image url (carrying a ?v=<ts> cache
    // buster) beats an incoming clean url that points at the same file:
    // the <img> that already painted must not re-request and flicker
    const keepsBust = (current: unknown, incoming: unknown): boolean => {
      if (typeof current !== 'string' || typeof incoming !== 'string' || current === incoming) return false
      const [base, query] = current.split('?')
      return base === incoming.split('?')[0] && (query ?? '').startsWith('v=')
    }
    const merge = <T extends { id: string; avatarUrl?: string | null; bannerUrl?: string | null }>(hit: T): T => {
      const out = { ...hit, ...next } as T
      if (keepsBust(hit.avatarUrl, next.avatarUrl)) out.avatarUrl = hit.avatarUrl
      if (keepsBust(hit.bannerUrl, next.bannerUrl)) out.bannerUrl = hit.bannerUrl
      return out
    }
    const patchList = <T extends { id: string; avatarUrl?: string | null; bannerUrl?: string | null }>(
      list: T[] | undefined
    ): T[] | undefined => (!list ? list : list.map((p) => (p.id === userId ? merge(p) : p)))

    set((s) => {
      const me = s.me && s.me.id === userId ? merge(s.me) : s.me
      const profileUser = s.profileUser && s.profileUser.id === userId ? merge(s.profileUser) : s.profileUser
      const conversations = s.conversations.map((c) => {
        if (c.otherUser && c.otherUser.id === userId) {
          return { ...c, otherUser: merge(c.otherUser) }
        }
        const participants = c.participants ? patchList(c.participants) : undefined
        return participants === c.participants ? c : { ...c, participants }
      })
      const serverMembers: typeof s.serverMembers = {}
      for (const [serverId, members] of Object.entries(s.serverMembers)) {
        const patched = patchList(members)
        serverMembers[serverId] = patched === members ? members : patched!
      }
      const patchFriend = (f: FriendSummary): FriendSummary =>
        f.user.id === userId ? { ...f, user: merge(f.user) } : f
      const friends = s.friends.map(patchFriend)
      const incomingRequests = s.incomingRequests.map(patchFriend)
      const outgoingRequests = s.outgoingRequests.map(patchFriend)
      // message author snapshots live inside room + thread caches
      const rooms = { ...s.rooms }
      for (const [room, state] of Object.entries(s.rooms)) {
        if (!state.messages.some((m) => m.author.id === userId)) continue
        rooms[room] = {
          ...state,
          messages: state.messages.map((m) => (m.author.id === userId ? { ...m, author: merge(m.author) } : m)),
        }
      }
      const threads = { ...s.threads }
      for (const [rootId, t] of Object.entries(s.threads)) {
        const inReplies = t.messages.some((m) => m.author.id === userId)
        const inRoot = t.root?.author.id === userId
        if (!inReplies && !inRoot) continue
        threads[rootId] = {
          ...t,
          root: inRoot && t.root ? { ...t.root, author: merge(t.root.author) } : t.root,
          messages: t.messages.map((m) => (m.author.id === userId ? { ...m, author: merge(m.author) } : m)),
        }
      }
      return {
        me,
        profileUser,
        conversations,
        serverMembers,
        friends,
        incomingRequests,
        outgoingRequests,
        rooms,
        threads,
      }
    })
  },

  onTyping: (room, userId, username, typing) => {
    set((s) => {
      const roomTyping = { ...(s.typing[room] || {}) }
      if (typing) {
        roomTyping[userId] = { username, at: Date.now() }
      } else {
        delete roomTyping[userId]
      }
      return { typing: { ...s.typing, [room]: roomTyping } }
    })
  },

  pruneTyping: () => {
    const now = Date.now()
    set((s) => {
      let changed = false
      const next: Record<string, Record<string, TypingInfo>> = {}
      for (const [room, users] of Object.entries(s.typing)) {
        const kept: Record<string, TypingInfo> = {}
        for (const [userId, info] of Object.entries(users)) {
          if (now - info.at < 4000) {
            kept[userId] = info
          } else {
            changed = true
          }
        }
        if (Object.keys(kept).length > 0) next[room] = kept
      }
      return changed ? { typing: next } : {}
    })
  },

  onMessageNew: (msg) => {
    const state = get()
    const isActiveRoom =
      activeRoomOf(state) === msg.room && typeof document !== 'undefined' && document.visibilityState === 'visible'

    // the send-route flag on my own echo: the marker swap fired this send
    if (msg.fx && state.me && msg.authorId === state.me.id) {
      void import('./confetti').then(({ burstConfetti }) => burstConfetti())
    }

    // does this message mention me? (@username, or a permitted @everyone/@here)
    const mentionsMe =
      !!state.me &&
      msg.authorId !== state.me.id &&
      !!msg.content &&
      (extractMentions(msg.content).some(
        (name) => name.toLowerCase() === state.me!.username.toLowerCase()
      ) ||
        (msg.pingsEveryone && /(^|\s)@(everyone|here)(?=\s|$)/i.test(msg.content)))

    set((s) => {
      const rooms = { ...s.rooms }
      let threads = s.threads

      // thread rows never touch the main feed: they land in the thread cache
      // and update the root's bar instead. threadTotal (stamped by the send
      // routes) makes the bar set absolute — duplicate echoes are idempotent
      if (msg.threadOfId) {
        const t = s.threads[msg.threadOfId]
        let gained = false
        if (t) {
          let messages = t.messages
          if (msg.nonce && messages.some((m) => m.id === msg.nonce)) {
            messages = messages.map((m) => (m.id === msg.nonce ? msg : m))
            gained = true
          } else if (!messages.some((m) => m.id === msg.id)) {
            messages = sortMessages([...messages, msg])
            gained = true
          }
          if (gained) {
            threads = { ...s.threads, [msg.threadOfId]: { ...t, messages, count: Math.max(t.count, messages.length) } }
          }
        }
        const roomState = rooms[msg.room]
        if (roomState?.loaded) {
          const absolute = typeof msg.threadTotal === 'number' && msg.threadTotal > 0
          const bumpFace = {
            id: msg.author.id,
            username: msg.author.username,
            displayName: msg.author.displayName,
            avatarUrl: msg.author.avatarUrl,
            avatarColor: msg.author.avatarColor,
          }
          rooms[msg.room] = {
            ...roomState,
            messages: roomState.messages.map((m) => {
              if (m.id !== msg.threadOfId) return m
              const nextCount = absolute ? msg.threadTotal! : (gained ? (m.threadCount ?? 0) + 1 : m.threadCount ?? 0)
              const faces = gained
                ? [bumpFace, ...(m.threadUsers ?? []).filter((f) => f.id !== bumpFace.id)].slice(0, 3)
                : m.threadUsers
              return { ...m, threadCount: nextCount, threadUsers: faces }
            }),
          }
        }
      } else {
        const roomState = rooms[msg.room]
        if (roomState?.loaded) {
          if (roomState.messages.some((m) => m.id === msg.id)) {
            return {}
          }
          // optimistic-send swap: a nonce-carrying message replaces the pending
          // local echo instead of stacking a duplicate row on top of it
          const swapped = msg.nonce
            ? roomState.messages.some((m) => m.id === msg.nonce)
            : false
          if (swapped && msg.nonce) {
            rooms[msg.room] = {
              ...roomState,
              messages: roomState.messages.map((m) => (m.id === msg.nonce ? msg : m)),
            }
          } else {
            rooms[msg.room] = { ...roomState, messages: sortMessages([...roomState.messages, msg]) }
          }
        }
      }

      // unread bookkeeping
      const channelUnread = { ...s.channelUnread }
      const channelMentions = { ...s.channelMentions }
      if (msg.room.startsWith('channel:') && !isActiveRoom) {
        const channelId = msg.room.slice('channel:'.length)
        channelUnread[channelId] = (channelUnread[channelId] ?? 0) + 1
        if (mentionsMe) channelMentions[channelId] = (channelMentions[channelId] ?? 0) + 1
      }

      // keep the DM list fresh: reorder, update preview, un-hide
      let conversations = s.conversations
      if (msg.room.startsWith('conversation:')) {
        const conversationId = msg.room.slice('conversation:'.length)
        const existing = conversations.find((c) => c.id === conversationId)
        const updated: ConversationSummary = {
          id: conversationId,
          kind: existing?.kind ?? 'DM',
          name: existing?.name ?? null,
          ownerId: existing?.ownerId ?? null,
          limitRaised: existing?.limitRaised ?? false,
          tempExpiryMinutes: existing?.tempExpiryMinutes ?? null,
          otherUser: existing?.otherUser ?? {
            id: msg.authorId,
            username: msg.author.username,
            displayName: msg.author.displayName,
            avatarUrl: msg.author.avatarUrl,
            avatarColor: msg.author.avatarColor,
            bio: msg.author.bio ?? '',
          },
          participants: existing?.participants,
          hidden: false,
          pinned: existing?.pinned ?? false,
          lastMessage: {
            id: msg.id,
            content: msg.content,
            imageUrl: msg.imageUrl,
            createdAt: msg.createdAt,
            authorId: msg.authorId,
          },
          otherLastReadAt: existing?.otherLastReadAt ?? null,
          unreadCount: isActiveRoom ? 0 : (existing?.unreadCount ?? 0) + (msg.authorId === s.me?.id ? 0 : 1),
        }
        conversations = [updated, ...conversations.filter((c) => c.id !== conversationId)]
      }

      return { rooms, threads, channelUnread, channelMentions, conversations }
    })

    // viewing the room means reading it
    if (isActiveRoom) {
      void get().markRead(msg.room)
    }
  },

  onMessageUpdate: (msg) => {
    // messages can move between rooms only in the sense of room key change; keep it simple
    set((s) => {
      const rooms = { ...s.rooms }
      let threadsChanged = false
      const threads = { ...s.threads }
      for (const [room, state] of Object.entries(s.rooms)) {
        if (state.messages.some((m) => m.id === msg.id)) {
          rooms[room] = {
            ...state,
            messages: state.messages.map((m) => (m.id === msg.id ? { ...m, ...msg, room: m.room } : m)),
          }
        }
      }
      for (const [rootId, t] of Object.entries(s.threads)) {
        if (t.messages.some((m) => m.id === msg.id)) {
          threadsChanged = true
          threads[rootId] = {
            ...t,
            messages: t.messages.map((m) => (m.id === msg.id ? { ...m, ...msg, room: m.room } : m)),
          }
        }
        if (t.root?.id === msg.id) {
          threadsChanged = true
          threads[rootId] = { ...t, root: { ...t.root, ...msg } }
        }
      }
      return threadsChanged ? { rooms, threads } : { rooms }
    })
  },

  onMessageDelete: ({ messageId }) => {
    set((s) => {
      const rooms = { ...s.rooms }
      const threads = { ...s.threads }
      let threadsChanged = false
      for (const [room, state] of Object.entries(s.rooms)) {
        if (state.messages.some((m) => m.id === messageId)) {
          rooms[room] = { ...state, messages: state.messages.filter((m) => m.id !== messageId) }
        }
        // the root died: its whole thread (and the open panel) goes with it
        if (threads[messageId]) {
          delete threads[messageId]
          threadsChanged = true
        }
        // a thread row died: pull it from the cache and step the bar down
        for (const [rootId, t] of Object.entries(s.threads)) {
          if (t.messages.some((m) => m.id === messageId)) {
            threadsChanged = true
            const messages = t.messages.filter((m) => m.id !== messageId)
            threads[rootId] = { ...t, messages, count: Math.max(0, t.count - 1) }
            const roomState = rooms[room]
            if (roomState?.loaded) {
              rooms[room] = {
                ...roomState,
                messages: roomState.messages.map((m) =>
                  m.id === rootId ? { ...m, threadCount: Math.max(0, (m.threadCount ?? 1) - 1) } : m
                ),
              }
            }
          }
        }
      }
      // a deleted thread cache also closes the panel that showed it
      const openThreadId =
        s.openThreadId && !threads[s.openThreadId] ? null : s.openThreadId
      return threadsChanged ? { rooms, threads, openThreadId } : { rooms }
    })
  },

  onMessagesPurge: (ids) => {
    const set2 = new Set(ids)
    set((s) => {
      const rooms = { ...s.rooms }
      for (const [room, state] of Object.entries(s.rooms)) {
        if (state.messages.some((m) => set2.has(m.id))) {
          rooms[room] = { ...state, messages: state.messages.filter((m) => !set2.has(m.id)) }
        }
      }
      return { rooms }
    })
  },

  onMessageReaction: ({ messageId, reactions }) => {
    const meId = get().me?.id ?? null
    // server truth is oldest-first; my in-flight adds merge on the right edge
    const merged = mergeQueuedReactions(messageId, meId, reactions)
    set((s) => {
      const rooms = { ...s.rooms }
      let threadsChanged = false
      const threads = { ...s.threads }
      for (const [room, state] of Object.entries(s.rooms)) {
        if (state.messages.some((m) => m.id === messageId)) {
          rooms[room] = {
            ...state,
            messages: state.messages.map((m) => (m.id === messageId ? { ...m, reactions: merged } : m)),
          }
        }
      }
      for (const [rootId, t] of Object.entries(s.threads)) {
        if (t.messages.some((m) => m.id === messageId)) {
          threadsChanged = true
          threads[rootId] = {
            ...t,
            messages: t.messages.map((m) => (m.id === messageId ? { ...m, reactions: merged } : m)),
          }
        }
      }
      return threadsChanged ? { rooms, threads } : { rooms }
    })
  },

  onReadUpdate: ({ conversationId, userId, lastReadAt }) => {
    const me = get().me
    if (!me || userId === me.id) return
    const conversation = get().conversations.find((c) => c.id === conversationId)
    const isGroup = conversation?.kind === 'GROUP'
    if (isGroup) {
      set((s) => ({
        groupReadAt: {
          ...s.groupReadAt,
          [conversationId]: {
            ...(s.groupReadAt[conversationId] ?? {}),
            [userId]: lastReadAt,
          },
        },
      }))
      return
    }
    set((s) => ({
      otherReadAt: { ...s.otherReadAt, [conversationId]: lastReadAt },
    }))
  },

  onServerRefresh: (serverId) => {
    const wasMember = get().servers.some((s) => s.id === serverId)
    const knownName = get().servers.find((s) => s.id === serverId)?.name
    void get().refreshServers().then(() => {
      const s = get()
      // a kick, ban or delete removed the server from our list: stop viewing it
      if (
        wasMember &&
        (s.activeServerId === serverId || s.servers.some((sv) => sv.id === serverId && sv.channels.some((c) => c.id === s.activeChannelId))) &&
        !s.servers.some((sv) => sv.id === serverId)
      ) {
        set({ activeServerId: null, activeChannelId: null })
        if (knownName && typeof window !== 'undefined') {
          toast({
            title: `Removed from ${knownName}`,
            description: 'A moderator removed you, or the server was deleted.',
          })
        }
      }
    })
    if (get().servers.some((s) => s.id === serverId) || get().activeServerId === serverId) {
      void get().refreshServerDetail(serverId)
      // emoji changes broadcast the same event: pull the fresh list
      if (get().activeServerId === serverId || get().serverEmoji[serverId]) {
        void get().refreshServerEmoji(serverId)
      }
    }
  },

  onServerDeleted: (serverId) => {
    set((s) => {
      const servers = s.servers.filter((sv) => sv.id !== serverId)
      const wasActive = s.activeServerId === serverId
      const members = { ...s.serverMembers }
      delete members[serverId]
      return {
        servers,
        serverMembers: members,
        ...(wasActive ? { activeServerId: null, activeChannelId: null } : {}),
      }
    })
  },

  onConversationNew: () => {
    void get().refreshConversations()
  },

  // ---- voice ----

  joinVoice: async (channelId, serverId) => {
    const me = get().me
    if (!me) return false
    try {
      await voiceEngine.join(channelId, serverId, me.id)
      set({ voiceConnected: { serverId, channelId }, voiceUnavailable: voiceEngine.getState().unavailable })
      if (voiceEngine.getState().unavailable) return true
      // initial sidebar participants before the socket's voice:state lands
      try {
        const { participants } = await apiClient.channelVoice(channelId)
        get().onVoiceState({ channelId, participants })
      } catch {
        // socket state is the source of truth; the fetch is best-effort
      }
      return true
    } catch (err) {
      if (err instanceof Error && err.message === 'mic-denied') {
        toast({ title: 'microphone unavailable' })
      } else {
        toast({ title: 'could not join voice' })
      }
      return false
    }
  },

  leaveVoice: () => {
    voiceEngine.leave()
    set({ voiceConnected: null, voiceSelf: { muted: false, deafened: false }, voiceUnavailable: false })
  },

  toggleVoiceMute: () => {
    if (!get().voiceConnected) return
    voiceEngine.toggleMute()
  },

  toggleVoiceDeafen: () => {
    if (!get().voiceConnected) return
    voiceEngine.toggleDeafen()
  },

  onVoiceState: ({ channelId, participants }) => {
    const state = get()
    const server = state.servers.find((s) => s.channels.some((c) => c.id === channelId))
    const members = server ? state.serverMembers[server.id] ?? [] : []
    const enriched: VoiceParticipantSummary[] = participants.map((p) => {
      const member = members.find((m) => m.id === p.userId)
      const prev = state.voiceParticipants[channelId]?.find((v) => v.userId === p.userId)
      return {
        userId: p.userId,
        username: member?.username ?? p.username,
        displayName: member?.displayName ?? null,
        avatarUrl: member?.avatarUrl ?? null,
        avatarColor: member?.avatarColor ?? '#2e2e2e',
        sessionId: p.sessionId,
        muted: p.muted,
        deafened: p.deafened,
        speaking: prev?.speaking ?? false,
        volume: prev?.volume ?? 0,
      }
    })
    const meId = state.me?.id
    const mine = meId ? enriched.find((p) => p.userId === meId) : undefined
    set((s) => ({
      voiceParticipants: { ...s.voiceParticipants, [channelId]: enriched },
      voiceSelf: mine ? { muted: mine.muted, deafened: mine.deafened } : s.voiceSelf,
    }))
    // the engine reconciles its WebRTC mesh from the same state
    voiceEngine.onRemoteState(participants)
  },

  onVoiceSpeaking: (userId, speaking, volume) => {
    const state = get()
    const channelId = state.voiceConnected?.channelId
    if (!channelId) return
    const list = state.voiceParticipants[channelId]
    if (!list) return
    set((s) => ({
      voiceParticipants: {
        ...s.voiceParticipants,
        [channelId]: list.map((p) => (p.userId === userId ? { ...p, speaking, volume } : p)),
      },
    }))
  },

  // ---- calls ----

  bindCallTabSync: () => {
    ensureCallTabSync((event) => {
      const state = get()
      if (event.type === 'dismiss-incoming' || event.type === 'call-ended') {
        if (state.incomingCall?.callId === event.callId) {
          sounds.stopRingLoop('callRingIn')
          set({ incomingCall: null })
        }
        if (event.type === 'call-ended' && state.activeCall?.callId === event.callId) {
          sounds.stopRingLoop('callRingOut')
          callEngine.teardown()
          set({
            activeCall: null,
            callSelf: { muted: false, deafened: false, cameraOn: false, screenOn: false },
          })
        }
      } else if (event.type === 'accepted-here') {
        if (state.incomingCall?.callId === event.callId) {
          sounds.stopRingLoop('callRingIn')
          set({ incomingCall: null })
        }
      } else if (event.type === 'left-call') {
        if (state.activeCall?.callId === event.callId) {
          callEngine.teardown()
          set({
            activeCall: null,
            callSelf: { muted: false, deafened: false, cameraOn: false, screenOn: false },
          })
        }
      } else if (event.type === 'voice-ring-dismiss') {
        if (state.incomingVoiceRing?.inviteId === event.inviteId) {
          sounds.stopRingLoop('callRingIn')
          set({ incomingVoiceRing: null })
        }
      }
    })
  },

  startCall: async (conversationId, withVideo) => {
    const me = get().me
    const sock = getSocket()
    if (!me || !sock) return
    if (get().activeCall || get().incomingCall) {
      toast({ title: 'already in a call' })
      return
    }
    // participants ride the start event so the sidecar can ring everyone's
    // personal room (members who never opened this conversation included)
    const conversation = get().conversations.find((c) => c.id === conversationId)
    const participantIds = conversation?.participants?.map((p) => p.id) ?? []
    if (conversation?.otherUser && !participantIds.includes(conversation.otherUser.id)) {
      participantIds.push(conversation.otherUser.id)
    }
    // the sidecar registers the caller and broadcasts call:state (ringing)
    // back; onCallState triggers the engine join for the caller
    sock.emit('call:start', {
      conversationId,
      video: withVideo,
      profile: {
        displayName: me.displayName,
        avatarUrl: me.avatarUrl,
        avatarColor: me.avatarColor,
      },
      participantIds,
    })
  },

  acceptIncomingCall: async () => {
    const state = get()
    const me = state.me
    const incoming = state.incomingCall
    if (!me || !incoming) return
    sounds.stopRingLoop('callRingIn')
    publishCallTabEvent({ type: 'accepted-here', callId: incoming.callId })
    set({ incomingCall: null })
    try {
      await callEngine.join(incoming.callId, incoming.conversationId, me.id, { accept: true })
      sounds.play('callEnter')
      set({
        activeCall: {
          callId: incoming.callId,
          conversationId: incoming.conversationId,
          createdBy: incoming.from.userId,
          createdAt: incoming.createdAt,
          acceptedAt: Date.now(),
          state: 'active',
          participants: [],
        },
        callSelf: { ...get().callSelf, cameraOn: callEngine.getMediaState().cameraOn },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      if (msg === 'mic-denied') toast({ title: 'microphone unavailable' })
      else toast({ title: 'could not join the call' })
    }
  },

  declineIncomingCall: () => {
    const incoming = get().incomingCall
    if (!incoming) return
    sounds.stopRingLoop('callRingIn')
    publishCallTabEvent({ type: 'dismiss-incoming', callId: incoming.callId })
    const sock = getSocket()
    sock?.emit('call:decline', { callId: incoming.callId })
    set({ incomingCall: null })
  },

  letRingIncomingCall: () => {
    const incoming = get().incomingCall
    if (!incoming) return
    // the ring dies on my end only: the caller keeps hearing theirs
    sounds.stopRingLoop('callRingIn')
    publishCallTabEvent({ type: 'dismiss-incoming', callId: incoming.callId })
    const sock = getSocket()
    sock?.emit('call:let-ring', { callId: incoming.callId })
    set({ incomingCall: null })
  },

  cancelOutgoingCall: () => {
    const active = get().activeCall
    if (!active) return
    sounds.stopRingLoop('callRingOut')
    publishCallTabEvent({ type: 'call-ended', callId: active.callId })
    const sock = getSocket()
    sock?.emit('call:cancel', { callId: active.callId })
    callEngine.teardown()
    set({ activeCall: null, callSelf: { muted: false, deafened: false, cameraOn: false, screenOn: false } })
  },

  hangupCall: () => {
    const active = get().activeCall
    if (!active) return
    // leave only: the call keeps running for everyone still in it
    const sock = getSocket()
    sock?.emit('call:hangup', { callId: active.callId })
    publishCallTabEvent({ type: 'left-call', callId: active.callId })
    callEngine.teardown()
    sounds.play('callLeave')
    set({ activeCall: null, callSelf: { muted: false, deafened: false, cameraOn: false, screenOn: false } })
  },

  toggleCallMute: () => {
    if (!get().activeCall) return
    callEngine.toggleMute()
  },

  toggleCallDeafen: () => {
    if (!get().activeCall) return
    callEngine.toggleDeafen()
  },

  toggleCallCamera: async () => {
    if (!get().activeCall) return
    const on = !callEngine.getMediaState().cameraOn
    try {
      await callEngine.setCamera(on)
    } catch {
      toast({ title: 'camera unavailable' })
    }
  },

  toggleCallScreen: async () => {
    if (!get().activeCall) return
    const on = !callEngine.getMediaState().screenOn
    try {
      await callEngine.setScreen(on)
    } catch {
      /* user dismissed the share picker; nothing to report */
    }
  },

  ringFriendIntoVoice: (toUserId) => {
    const me = get().me
    const sock = getSocket()
    const voice = get().voiceConnected
    if (!me || !sock || !voice) {
      toast({ title: 'join voice first' })
      return
    }
    const server = get().servers.find((s) => s.id === voice.serverId)
    const channel = server?.channels.find((c) => c.id === voice.channelId)
    if (!server || !channel) return
    const friend = get().friends.find((f) => f.user.id === toUserId)
    if (!friend) {
      toast({ title: 'only friends can be rung in' })
      return
    }
    sock.emit('voice:ring', {
      channelId: voice.channelId,
      serverId: voice.serverId,
      serverName: server.name,
      serverIconUrl: server.iconUrl,
      channelName: channel.name,
      toUserId,
      profile: {
        displayName: me.displayName,
        avatarUrl: me.avatarUrl,
        avatarColor: me.avatarColor,
      },
    })
    toast({ title: `ringing ${friend.user.displayName || friend.user.username}` })
  },

  acceptVoiceRing: async () => {
    const ring = get().incomingVoiceRing
    const me = get().me
    if (!ring || !me) return
    sounds.stopRingLoop('callRingIn')
    publishCallTabEvent({ type: 'voice-ring-dismiss', inviteId: ring.inviteId })
    const sock = getSocket()
    sock?.emit('voice:ring-accept', { inviteId: ring.inviteId })
    set({ incomingVoiceRing: null })
    await get().selectServer(ring.serverId)
    await get().selectChannel(ring.channelId)
    await get().joinVoice(ring.channelId, ring.serverId)
  },

  declineVoiceRing: () => {
    const ring = get().incomingVoiceRing
    if (!ring) return
    sounds.stopRingLoop('callRingIn')
    publishCallTabEvent({ type: 'voice-ring-dismiss', inviteId: ring.inviteId })
    const sock = getSocket()
    sock?.emit('voice:ring-decline', { inviteId: ring.inviteId })
    set({ incomingVoiceRing: null })
  },

  onCallRing: ({ callId, conversationId, from, video, createdAt }) => {
    const state = get()
    if (state.incomingCall || state.activeCall) return
    if (from.userId === state.me?.id) return
    set({
      incomingCall: {
        callId,
        conversationId,
        from,
        video,
        createdAt: createdAt ?? Date.now(),
      },
    })
    sounds.startRingLoop('callRingIn')
  },

  onCallState: ({ callId, conversationId, state, createdBy, createdAt, participants }) => {
    const me = get().me
    if (!me) return
    const mine = participants.find((p) => p.userId === me.id)
    const current = get().activeCall
    const incoming = get().incomingCall

    // the caller's own broadcast arriving back: join media for the first time
    if (mine && !current && createdBy === me.id) {
      void (async () => {
        try {
          await callEngine.join(callId, conversationId, me.id, { withVideo: mine.video })
          sounds.startRingLoop('callRingOut')
          set({
            activeCall: {
              callId,
              conversationId,
              createdBy,
              createdAt,
              acceptedAt: null,
              state,
              participants,
            },
            callSelf: { ...get().callSelf, cameraOn: callEngine.getMediaState().cameraOn },
          })
          // someone may have accepted while we were setting up
          callEngine.onParticipants(participants)
          for (const p of participants) {
            if (p.userId !== me.id) callEngine.onMediaFlags(p.userId, p.video, p.screen)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : ''
          if (msg === 'mic-denied') toast({ title: 'microphone unavailable' })
          else toast({ title: 'could not start the call' })
          const sock = getSocket()
          sock?.emit('call:cancel', { callId })
        }
      })()
      return
    }

    // accepted on another tab/device of mine: clear the incoming shell here
    if (incoming && incoming.callId === callId && mine) {
      sounds.stopRingLoop('callRingIn')
      set({ incomingCall: null })
      // this tab is not the media owner; stay quiet unless the user joins
    }

    // call went active (or ended for ringing) while I still had an incoming UI
    // and I am NOT a participant: someone else took a 1:1, or the group call
    // is live and I can still join later from the chat. Clear expired rings.
    if (incoming && incoming.callId === callId && !mine && state === 'active') {
      const conversation = get().conversations.find((c) => c.id === conversationId)
      const isGroup = conversation?.kind === 'GROUP'
      if (!isGroup) {
        sounds.stopRingLoop('callRingIn')
        set({ incomingCall: null })
      }
    }

    if (current && current.callId === callId) {
      set({ activeCall: { ...current, state, participants } })
      callEngine.onParticipants(participants)
      for (const p of participants) {
        if (p.userId !== me.id) callEngine.onMediaFlags(p.userId, p.video, p.screen)
      }
      // ringing -> active transition: kill the outgoing ring, play connect
      if (state === 'active' && current.state === 'ringing') {
        sounds.stopRingLoop('callRingOut')
        sounds.play('callEnter')
      }
    }
  },

  onCallAccepted: ({ callId, userId }) => {
    const current = get().activeCall
    const incoming = get().incomingCall
    // another of my tabs accepted: drop the ring shell here
    if (incoming && incoming.callId === callId && userId === get().me?.id) {
      sounds.stopRingLoop('callRingIn')
      set({ incomingCall: null })
    }
    if (!current || current.callId !== callId) return
    sounds.stopRingLoop('callRingOut')
    if (current.state === 'ringing') {
      sounds.play('callEnter')
      set({ activeCall: { ...current, state: 'active', acceptedAt: Date.now() } })
    }
  },

  onCallDeclined: ({ callId }) => {
    const current = get().activeCall
    if (!current || current.callId !== callId) return
    // my outgoing call was declined before anyone accepted
    if (current.state === 'ringing') {
      sounds.stopRingLoop('callRingOut')
      sounds.play('callLeave')
      callEngine.teardown()
      set({ activeCall: null, callSelf: { muted: false, deafened: false, cameraOn: false, screenOn: false } })
    }
  },

  onCallPeerLeft: ({ callId }) => {
    const current = get().activeCall
    if (!current || current.callId !== callId) return
    sounds.play('callLeave')
  },

  onCallEnded: ({ callId, conversationId }) => {
    const state = get()
    const wasActive = state.activeCall?.callId === callId
    const wasIncoming = state.incomingCall?.callId === callId
    if (!wasActive && !wasIncoming) return
    sounds.stopRingLoop('callRingIn')
    sounds.stopRingLoop('callRingOut')
    publishCallTabEvent({ type: 'call-ended', callId })
    if (wasActive) {
      sounds.play('callLeave')
      callEngine.teardown()
    }
    set({
      activeCall: null,
      incomingCall: null,
      callSelf: { muted: false, deafened: false, cameraOn: false, screenOn: false },
    })
    void conversationId
  },

  onCallSignal: (payload) => {
    callEngine.handleSignal(payload as { from: string; data: CallSignalData })
  },

  onVoiceRing: (payload) => {
    const state = get()
    if (state.incomingVoiceRing || state.incomingCall || state.activeCall) return
    if (payload.from.userId === state.me?.id) return
    if (state.voiceConnected?.channelId === payload.channelId) return
    set({ incomingVoiceRing: payload })
    sounds.startRingLoop('callRingIn')
  },

  onVoiceRingEnded: ({ inviteId, reason, channelId, serverId }) => {
    const ring = get().incomingVoiceRing
    if (ring?.inviteId === inviteId) {
      sounds.stopRingLoop('callRingIn')
      set({ incomingVoiceRing: null })
    }
    void reason
    void channelId
    void serverId
  },

  // ---- forum ----

  loadForumPosts: async (channelId, sort = 'latest') => {
    try {
      const { posts } = await apiClient.forumPosts(channelId, { sort })
      set((s) => ({
        forumPostsByChannel: { ...s.forumPostsByChannel, [channelId]: posts },
        forumLoaded: { ...s.forumLoaded, [channelId]: true },
      }))
    } catch {
      set((s) => ({ forumLoaded: { ...s.forumLoaded, [channelId]: true } }))
    }
  },

  openForumPost: (postId) => {
    const state = get()
    const post = Object.values(state.forumPostsByChannel).flat().find((p) => p.id === postId)
    set({ openForumPostId: postId })
    if (post) {
      // mark read locally + server-side so the "new" badge clears
      void get().markRead(`post:${postId}`)
      set((s) => {
        const list = s.forumPostsByChannel[post.channelId]
        if (!list) return {}
        return {
          forumPostsByChannel: {
            ...s.forumPostsByChannel,
            [post.channelId]: list.map((p) => (p.id === postId ? { ...p, readAt: new Date().toISOString() } : p)),
          },
        }
      })
      // load the thread lazily into the existing thread cache (without
      // opening ThreadPanel — the forum post view reads this cache directly)
      if (post.firstMessageId) {
        const rootId = post.firstMessageId
        const existing = get().threads[rootId]
        if (!existing?.loaded) {
          set((s) => ({
            threads: { ...s.threads, [rootId]: existing ?? { root: null, messages: [], loaded: false, count: 0 } },
          }))
          void (async () => {
            try {
              const res = await apiClient.threadMessages(rootId)
              if (get().openForumPostId !== postId) return
              set((s) => ({
                threads: {
                  ...s.threads,
                  [rootId]: { root: res.root, messages: sortMessages(res.messages), loaded: true, count: res.count },
                },
              }))
            } catch {
              set((s) => {
                const threads = { ...s.threads }
                delete threads[rootId]
                return { threads }
              })
            }
          })()
        }
      }
    }
  },

  closeForumPost: () => {
    set({ openForumPostId: null })
  },

  createForumPost: async (channelId, payload) => {
    const { post } = await apiClient.createForumPost(channelId, payload)
    get().onForumPostNew(post)
  },

  updateForumPost: async (postId, payload) => {
    const { post } = await apiClient.updateForumPost(postId, payload)
    get().onForumPostUpdate(post)
  },

  deleteForumPost: async (postId) => {
    await apiClient.deleteForumPost(postId)
    get().onForumPostDelete(postId)
    if (get().openForumPostId === postId) set({ openForumPostId: null })
  },

  sendForumReply: async (postId, content) => {
    // the reply is a thread row under the post's root message; the server
    // echoes 'message:new' (thread cache update) and 'forum:post:update'
    // (reply count + last activity), so this just posts and merges the row
    const { message } = await apiClient.sendForumReply(postId, { content })
    get().onMessageNew(message)
  },

  onForumPostNew: (post) => {
    set((s) => {
      const list = s.forumPostsByChannel[post.channelId] ?? []
      const merged = { ...post, readAt: new Date().toISOString() }
      return {
        forumPostsByChannel: { ...s.forumPostsByChannel, [post.channelId]: [merged, ...list.filter((p) => p.id !== post.id)] },
      }
    })
  },

  onForumPostUpdate: (post) => {
    set((s) => {
      const list = s.forumPostsByChannel[post.channelId] ?? []
      const existing = list.find((p) => p.id === post.id)
      const merged = { ...post, readAt: existing?.readAt ?? post.readAt ?? null }
      const next = existing
        ? list.map((p) => (p.id === post.id ? merged : p))
        : [merged, ...list]
      // pinned posts float to the top
      next.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        const ka = a.lastReplyAt ?? a.createdAt
        const kb = b.lastReplyAt ?? b.createdAt
        return ka < kb ? 1 : ka > kb ? -1 : a.id < b.id ? -1 : 1
      })
      return { forumPostsByChannel: { ...s.forumPostsByChannel, [post.channelId]: next } }
    })
  },

  onForumPostDelete: (postId) => {
    set((s) => {
      const next: Record<string, ForumPostSummary[]> = {}
      for (const [channelId, list] of Object.entries(s.forumPostsByChannel)) {
        if (list.some((p) => p.id === postId)) {
          next[channelId] = list.filter((p) => p.id !== postId)
        } else {
          next[channelId] = list
        }
      }
      return { forumPostsByChannel: next, openForumPostId: s.openForumPostId === postId ? null : s.openForumPostId }
    })
  },

  syncNow: async () => {
    const state = get()
    if (!state.me || state.view !== 'app') return
    const room = activeRoomOf(state) ?? ''

    let sync: SyncResponse
    try {
      sync = await apiClient.sync(room)
    } catch {
      return
    }

    // presence + read receipts + unread + blocks + mutes: apply immediately
    const onlineUserIds: Record<string, boolean> = {}
    for (const id of sync.onlineUserIds) onlineUserIds[id] = true
    const otherReadAt = { ...get().otherReadAt }
    for (const stamp of sync.conversationStamps) {
      otherReadAt[stamp.conversationId] = stamp.otherLastReadAt
    }
    const blockedUserIds: Record<string, boolean> = {}
    for (const id of sync.blockedUserIds) blockedUserIds[id] = true
    const mutedScopes: Record<string, boolean> = {}
    for (const scope of sync.mutedScopes) mutedScopes[scope] = true
    // mentions reconcile with the server's authoritative count: unread rooms
    // I am not subscribed to only learn about mentions through this sync
    const channelMentions: Record<string, number> = { ...sync.channelMentions }
    set({
      onlineUserIds,
      presenceStatuses: sync.presenceStatuses ?? {},
      awaySince: sync.awaySince ?? {},
      lastSeen: sync.lastSeen ?? {},
      otherReadAt,
      channelUnread: { ...sync.channelUnread },
      channelMentions,
      blockedUserIds,
      mutedScopes,
    })

    // conversations changed?
    const current = get()
    const visibleStampIds = sync.conversationStamps.filter((c) => !c.hidden).map((c) => c.conversationId)
    let refreshConvos = visibleStampIds.length !== current.conversations.length
    if (!refreshConvos) {
      for (const c of current.conversations) {
        const stamp = sync.conversationStamps.find((st) => st.conversationId === c.id)
        if (!stamp || stamp.lastMessageId !== c.lastMessage?.id) {
          refreshConvos = true
          break
        }
      }
    }
    if (refreshConvos) void get().refreshConversations()

    // servers changed?
    let refreshServers = false
    for (const stamp of sync.serverStamps) {
      const local = current.servers.find((sv) => sv.id === stamp.serverId)
      const memberCount = current.serverMembers[stamp.serverId]?.length
      if (
        !local ||
        local.channels.length !== stamp.channelCount ||
        (memberCount !== undefined && memberCount !== stamp.memberCount)
      ) {
        refreshServers = true
        break
      }
    }
    // a server we still hold locally vanished from the stamps: we were removed
    if (current.servers.some((sv) => !sync.serverStamps.some((st) => st.serverId === sv.id))) {
      refreshServers = true
    }
    if (refreshServers) {
      await get().refreshServers()
      const activeServerId = get().activeServerId
      if (activeServerId && !get().servers.some((sv) => sv.id === activeServerId)) {
        set({ activeServerId: null, activeChannelId: null })
      } else if (activeServerId) {
        void get().refreshServerDetail(activeServerId)
      }
    }

    // missed messages in the open room?
    if (room && sync.roomLastMessage) {
      const roomState = get().rooms[room]
      // optimistic rows (pending / failed) are LOCAL ONLY: the deletion
      // detector must compare the server against real messages, or a failed
      // send would look like "everything after it was purged" and wipe the
      // room cache out from under the retry UI
      const realMessages = (roomState?.messages ?? []).filter((m) => !m.pending && !m.failed)
      const newest = realMessages[realMessages.length - 1]
      if (roomState?.loaded) {
        if (!newest) {
          // cache is empty but the server has messages: full load
          void get().selectChannel(room.slice('channel:'.length))
        } else if (newest.id !== sync.roomLastMessage.id) {
          if (new Date(sync.roomLastMessage.createdAt).getTime() < new Date(newest.createdAt).getTime() - 1000) {
            // the server's newest is OLDER than ours: messages were deleted
            // (purge or moderation). Reload the room from scratch.
            set((st) => {
              const rooms = { ...st.rooms }
              delete rooms[room]
              return { rooms }
            })
            void (room.startsWith('channel:')
              ? get().selectChannel(room.slice('channel:'.length))
              : get().selectConversation(room.slice('conversation:'.length)))
          } else {
            // normal case: the server has newer messages than we do
            try {
              const res = room.startsWith('channel:')
                ? await apiClient.channelMessages(room.slice('channel:'.length), undefined, newest.createdAt)
                : await apiClient.conversationMessages(room.slice('conversation:'.length), undefined, newest.createdAt)
              if (res.messages.length > 0) {
                const fresh = get().rooms[room]
                set((st) => ({
                  rooms: {
                    ...st.rooms,
                    [room]: {
                      ...(fresh ?? emptyRoom),
                      messages: sortMessages([...(fresh?.messages ?? []), ...res.messages]),
                    },
                  },
                }))
                if (document.visibilityState === 'visible') void get().markRead(room)
              }
            } catch {
              // the next poll retries
            }
          }
        }
      }
    }
  },
}))

// Wire the VoiceEngine's media observations into the store: speaking/volume
// flow here, and the local mute/deafen flags mirror the engine's live state.
voiceEngine.onActivity((userId, speaking, volume) => {
  useChatStore.getState().onVoiceSpeaking(userId, speaking, volume)
})
voiceEngine.onState((state) => {
  const store = useChatStore.getState()
  if (store.voiceConnected) {
    useChatStore.setState({
      voiceSelf: { muted: state.muted, deafened: state.deafened },
      voiceUnavailable: state.unavailable,
    })
  }
})

// helpers for components

export function useActiveRoom(): string | null {
  return useChatStore((s) => (s.activeChannelId ? `channel:${s.activeChannelId}` : s.activeConversationId ? `conversation:${s.activeConversationId}` : null))
}

export function activeRoomOfState(s: { activeChannelId: string | null; activeConversationId: string | null }): string | null {
  return activeRoomOf(s)
}

export { extractMentions }
