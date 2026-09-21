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
  ForumTagSummary,
  FriendSummary,
  MessageAttachment,
  PublicUser,
  ReactionGroup,
  ReminderSummary,
  RoleSummary,
  ScheduledSummary,
  ServerMemberSummary,
  ServerSummary,
  StickerSummary,
  SessionUser,
  SyncResponse,
  UserPresenceChoice,
  VisiblePresence,
  VoiceParticipantSummary,
  WhisperListSummary,
} from '@/lib/types'
import { extractMentions } from './markdown'
import { swapMarker } from '@/lib/marker'
import { carryYouTubeEmbed } from './yt-registry'
import { destroyMediaHost } from './media-host'
import { saveAccount, removeAccount } from './accounts'
import { voiceEngine } from './voice'
import type { SoundboardSoundSummary } from './soundboard'
import { callEngine, type CallSignalData } from './call'
import { pttPrefs, commitPttPrefs } from './ptt-prefs'
import { getSocket, subscribeRoom } from './socket'
import { baseConversationId, roomLabelOf, roomSlugFromName, roomSpaceId } from './call-space'
import { getReadGate, subscribeReadGate } from './read-gate'

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
  recording: boolean
}

/** someone being rung into a call or voice channel: the pinging tile
 *  everyone in the call/channel renders until they answer, decline or the
 *  ring times out */
export type RingingUserSummary = {
  userId: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  avatarColor: string
}

/** a live call in any of my conversations (awareness for sidebars, join
 *  buttons and call messages - includes my own call) */
export type LiveCallSummary = {
  callId: string
  conversationId: string
  state: 'ringing' | 'active'
  createdBy: string
  createdAt: number
  acceptedAt: number | null
  participants: CallParticipantSummary[]
}

/** THE VAULT: one chunked ephemeral upload in flight. Jobs live in the store
 * (not composer state) keyed by conversation, so switching rooms mid-upload
 * never orphans the transfer — the strip just follows the active room. */
export type VaultUploadJob = {
  key: string // local id
  conversationId: string
  uploadId: string | null // vault id once init answers
  name: string
  size: number
  mime: string
  state: 'uploading' | 'done' | 'error'
  uploadedBytes: number
  speed: number // bytes/sec, rolling
  startedAt: number
  expiresAt: string | null // tier preview from init, final from complete
  error?: string
  file: File // kept for retry
}

/** in-flight cancel handles for vault jobs (AbortControllers are not store data) */
const vaultAbort = new Map<string, AbortController>()

/** XHR-based chunk PUT. fetch() fires NO upload-progress events, so the vault
 *  strip used to freeze at 0% until an entire 4 MiB chunk landed — on a slow
 *  uplink that reads as "stuck" for several seconds (blazar watched it live).
 *  XHR gives us upload.onprogress → the bar ticks per-byte as bytes leave. */
function putChunkXhr(
  url: string,
  blob: Blob,
  signal: AbortSignal,
  onBytes: (loaded: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const onAbort = () => xhr.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => onBytes(e.loaded)
    xhr.onerror = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error('network error during upload'))
    }
    xhr.onabort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    xhr.onload = () => {
      signal.removeEventListener('abort', onAbort)
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
        return
      }
      let msg = `chunk upload failed (${xhr.status})`
      try {
        const data = JSON.parse(xhr.responseText) as { error?: string }
        if (data.error) msg = data.error
      } catch {
        /* keep the default message */
      }
      reject(new Error(msg))
    }
    xhr.send(blob)
  })
}

/** the call-log message I just posted, awaiting its callId binding: the
 *  sidecar mints ids, so the message lands here by conversation until the
 *  first call:state echo pairs them (module-level: bookkeeping, not UI) */
const pendingCallLogByConversation = new Map<string, string>()
/** callId -> the conversation's call-log message id (creator side; the one
 *  entitled to patch duration / missed and to be deleted quietly) */
const pendingCallLogs = new Map<string, string>()

/** rings that arrived while another one was already on screen: they queue
 *  here (module-level bookkeeping, capped) and reveal themselves as the
 *  current ring is declined, dismissed or taken — the stacked-calls model.
 *  A ring whose call ends while queued is dropped for good. */
const pendingRings: NonNullable<ChatStore['incomingCall']>[] = []
const MAX_PENDING_RINGS = 5

/** Reveal the next queued ring once the current one leaves the screen. */
function showNextPendingRing(): void {
  const next = pendingRings.shift()
  if (!next) return
  const s = useChatStore.getState()
  if (s.incomingCall) {
    // a new ring landed in the meantime: it goes first, the queued one back
    pendingRings.unshift(next)
    return
  }
  useChatStore.setState({ incomingCall: next })
  sounds.startRingLoop('callRingIn')
}

/** Leaving (or hopping from) a voice channel: silently stop watching every
 *  screen I was watching — the engine drops the audio pass-through and the
 *  sharers are told their audience shrank. State clears with the caller. */
function stopWatchingAllScreens(get: () => ChatStore): void {
  const state = get()
  const conn = state.voiceConnected
  for (const id of state.watchingScreens) {
    voiceEngine.setScreenWatch(id, false)
    if (conn) {
      getSocket()?.emit('voice:screen-watch', {
        channelId: conn.channelId,
        serverId: conn.serverId,
        targetUserId: id,
        watching: false,
        profile: null,
      })
    }
  }
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
  /** server stickers per server (admin uploads, no default set) */
  serverStickers: Record<string, StickerSummary[]>
  /** message drafts per room, so switching channels never loses a half-typed message */
  drafts: Record<string, string>
  /** count of unread messages that mention me, per channel */
  channelMentions: Record<string, number>

  conversations: ConversationSummary[]
  rooms: Record<string, RoomState>
  /** THE VAULT: chunked upload jobs across all conversations (composer strips
   *  filter by their room); uploads keep running through room switches */
  vaultJobs: VaultUploadJob[]
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
  /** group read receipts: conversationId -> userId -> ISO read stamp, so a
   *  group can show WHO read my messages (DMs keep the single otherReadAt) */
  groupReadAt: Record<string, Record<string, string>>
  /** channel read receipts (friends only): channelId -> friend userId -> ISO
   *  read stamp. Seeded on channel load, kept live by channel:read events;
   *  a friend's stamp covers all my messages up to that time. */
  channelFriendReadAt: Record<string, Record<string, string>>
  /** which rooms are currently bottom-parked, reported by the message list:
   *  a reader scrolled up into history is not reading the newest messages.
   *  the honest read gate consults this before marking anything read */
  roomAtBottom: Record<string, boolean>

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
  /** the site-admin panel overlay (Task 6-c; only opens for siteAdmin me) */
  adminPanelOpen: boolean
  profileEditorOpen: boolean
  profileUser: (PublicUser & { mutualServers?: string[] }) | null
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
  setAdminPanelOpen: (open: boolean) => void
  setProfileEditorOpen: (open: boolean) => void
  openProfile: (username: string) => Promise<void>
  closeProfile: () => void
  jumpTo: (room: string, messageId: string) => void
  /** where the viewer stood before a reply/permalink jump: powers the
   *  floating "back to where you were" pill in the message list */
  returnPoint: { room: string; scrollTop: number; at: number } | null
  setReturnPoint: (room: string, scrollTop: number) => void
  clearReturnPoint: () => void
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
  /** a GUEST voice session: I am connected to a voice channel whose server I
   *  am not a member of (rung in). The stage renders from the connection
   *  alone — the channel cannot be selected, so the name rides here. */
  voiceGuest: { channelId: string; serverId: string; channelName: string } | null
  voiceSelf: { muted: boolean; deafened: boolean; pttEnabled: boolean; pttActive: boolean; transmitting: boolean; recording: boolean; cameraOn: boolean; screenOn: boolean }
  voiceUnavailable: boolean
  /** push-to-talk preference (shared by voice rooms and calls): flip the
   *  shared pref; both engines react via onPttPrefsChanged */
  togglePushToTalk: () => void
  setPushToTalkKey: (key: string) => void
  /** live participants per voice channel, enriched from member caches */
  voiceParticipants: Record<string, VoiceParticipantSummary[]>
  /** who is being rung into each voice channel (keyed by channelId):
   *  everyone sitting in the channel renders their pinging tiles */
  voiceRingingUsers: Record<string, RingingUserSummary[]>
  /** the priority speaker per voice channel (keyed by channelId, presence
   *  = crowned): voice-stage moderation - while the crowned one transmits,
   *  every other participant's local output ducks so the crown cuts
   *  through. Session state only, rides voice:state */
  voicePriority: Record<string, string>
  /** whose screens I am currently WATCHING (opt-in per sharer: a share I
   *  have not clicked "watch" on stays a click-to-view tile and its audio
   *  stays silent). Reset whenever I leave the channel. */
  watchingScreens: string[]
  /** the voice stage lifts into a fullscreen takeover when true (mirrors
   *  callFullscreen for server voice channels) */
  voiceFullscreen: boolean
  setVoiceFullscreen: (fullscreen: boolean) => void
  /** who is watching MY screen share right now (the sharer's view): fed by
   *  voice:screen-watch events from each watcher; pruned when I stop
   *  sharing or leave the channel */
  myScreenWatchers: RingingUserSummary[]
  /** the server soundboards I have loaded (keyed by serverId): sound files
   *  the server's admins uploaded — the picker lists them, anyone plays
   *  them into the channel mix */
  soundboards: Record<string, SoundboardSoundSummary[]>
  joinVoice: (channelId: string, serverId: string) => Promise<boolean>
  /** hop between voice channels (base <-> call channels) without dropping
   *  what was live: mute, deafen, camera and screen share survive */
  switchVoiceSpace: (channelId: string, serverId: string) => Promise<boolean>
  leaveVoice: () => void
  toggleVoiceMute: () => void
  toggleVoiceDeafen: () => void
  /** turn my camera on/off in the voice channel I'm in */
  toggleVoiceCamera: () => Promise<void>
  /** start / stop sharing my screen (audio included) in the voice channel */
  toggleVoiceScreen: () => Promise<void>
  /** spin up (or hop into) a named "call channel" inside a server voice
   *  channel: a synthetic voice room (<channelId>~<slug>) that behaves like
   *  a group chat's call rooms */
  createVoiceCallChannel: (channelId: string, serverId: string, name: string) => Promise<void>
  /** start watching someone's screen share (opt-in): attaches the video
   *  tile and lets their share's audio through, and tells them I watch */
  watchScreen: (userId: string) => void
  /** stop watching: the tile reverts to click-to-view and their share's
   *  audio goes silent again; they are told I stopped watching */
  unwatchScreen: (userId: string) => void
  /** a watcher started/stopped watching MY screen (socket event) */
  onScreenWatch: (payload: { channelId: string; watcher: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }; watching: boolean }) => void
  /** load (or reload) a server's soundboard list from the API */
  refreshSoundboard: (serverId: string) => Promise<void>
  /** admin path: upload the audio file, then register it on the server's
   *  soundboard. Returns success so the picker can close its busy state. */
  addSoundboardSound: (serverId: string, file: File, name: string) => Promise<boolean>
  /** admin path: remove a sound from the server's soundboard */
  removeSoundboardSound: (serverId: string, soundId: string) => Promise<void>
  /** play one of MY server's sounds into the voice channel I'm in */
  playVoiceSound: (serverId: string, soundId: string) => Promise<void>
  onVoiceState: (payload: { channelId: string; participants: { userId: string; username: string; sessionId: string; muted: boolean; deafened: boolean; recording?: boolean; video?: boolean; screen?: boolean }[]; ringing?: string[]; priorityUserId?: string | null }) => void
  onVoiceSpeaking: (userId: string, speaking: boolean, volume: number) => void

  // ---- calls (1:1 + groups) ----
  /** an incoming ring waiting on me. `voice` marks a ring INTO a server
   *  voice channel ("server call"): accepting hops me into the channel.
   *  `voice.guest` marks a ring into a channel whose server I am NOT a
   *  member of — accepting joins the voice stage without navigating. */
  incomingCall: {
    callId: string
    conversationId: string
    from: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }
    video: boolean
    createdAt: number
    voice?: { channelId: string; serverId: string; channelName: string; guest?: boolean }
  } | null
  /** the call I'm in (or placed and am waiting on). null when idle.
   *  `guestOf` is set while I am a cross-rung GUEST: the conversation whose
   *  call I joined from outside the membership. It drives the send-only
   *  guest chat beside the call stage (I can send, never read). */
  activeCall: {
    callId: string
    conversationId: string
    createdBy: string
    createdAt: number
    acceptedAt: number | null
    /** 'ringing' while nobody has answered yet (outgoing view) */
    state: 'ringing' | 'active'
    participants: CallParticipantSummary[]
    guestOf?: string | null
  } | null
  callSelf: { muted: boolean; deafened: boolean; cameraOn: boolean; screenOn: boolean; pttEnabled: boolean; pttActive: boolean; transmitting: boolean }
  /** live calls across my conversations (keyed by conversation id): the
   *  awareness layer for sidebar chips, header join buttons and the call
   *  message's join affordance - includes the call I'm in, if any */
  liveCalls: Record<string, LiveCallSummary>
  /** who is being rung into each live call (keyed by callId): everyone in
   *  the call renders their pinging tiles */
  callRingingUsers: Record<string, RingingUserSummary[]>
  /** the call stage lifts into a fullscreen takeover when true (desktop
   *  opt-in; mobile is always fullscreen). Otherwise the desktop stage sits
   *  inline in the call's conversation, Discord-style */
  callFullscreen: boolean
  setCallFullscreen: (fullscreen: boolean) => void
  startCall: (conversationId: string, withVideo: boolean, opts?: { silent?: boolean }) => Promise<void>
  /** join (or quietly start) this conversation's call WITHOUT ringing
   *  anyone: the invitational path - the call simply exists for members to
   *  see and hop into */
  joinCall: (conversationId: string) => Promise<void>
  /** ring one specific person into the call I'm in ("add to call"): they
   *  get the incoming-call ring even when they are not in this
   *  conversation - joining gives them the call, not the messages */
  ringUserIntoCall: (userId: string) => void
  /** ring someone into a server voice channel I'm sitting in */
  ringUserIntoVoice: (channelId: string, serverId: string, targetUserId: string) => void
  /** call a person from anywhere (profile, right-click): opens (or reuses)
   *  the DM with them and rings it */
  callUser: (userId: string, video?: boolean) => Promise<void>
  /** spin up an extra named call room (a "channel" for calls) inside a
   *  group chat: a second, independent call space members can hop into */
  createCallRoom: (conversationId: string, name: string) => Promise<void>
  /** start / stop recording the call I'm in; stopping downloads the file */
  toggleCallRecording: () => void
  /** start / stop recording the voice channel I'm in; stopping downloads */
  toggleVoiceRecording: () => void
  /** crown (or uncrown, null) the priority speaker of the voice channel
   *  I'm in - voice-stage moderation; the crown rides voice:state back */
  setPrioritySpeaker: (targetUserId: string | null) => void
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
  onCallRing: (payload: { callId: string; conversationId: string; from: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }; video: boolean; createdAt: number; voice?: { channelId: string; serverId: string; channelName: string; guest?: boolean } }) => void
  onCallState: (payload: { callId: string; conversationId: string; state: 'ringing' | 'active'; createdBy: string; createdAt: number; acceptedAt?: number | null; participants: CallParticipantSummary[]; ringing?: string[] }) => void
  onCallAccepted: (payload: { callId: string; userId: string; username: string }) => void
  onCallDeclined: (payload: { callId: string; userId: string; username: string }) => void
  onCallPeerLeft: (payload: { callId: string; userId: string }) => void
  onCallEnded: (payload: { callId: string; conversationId: string; reason: string; acceptedAt?: number | null; durationSec?: number | null; late?: boolean }) => void
  onCallSignal: (payload: { from: string; callId: string; data: unknown }) => void
  /** the sidecar moved this account's call to another tab or device */
  onCallTakenOver: (payload: { callId: string; conversationId: string }) => void
  /** the sidecar moved this account's voice session to another tab or device */
  onVoiceTakenOver: (payload: { channelId: string; newChannelId?: string }) => void
  /** the sidecar dropped my GUEST voice session (the channel emptied / the
   *  last real member left): tear down cleanly and surface why */
  onVoiceDropped: (payload: { channelId: string }) => void

  /** ---- cross-rung call guest: send-only chat ---- */
  /** send a message into a conversation I am only a CALL GUEST of (never a
   *  member): optimistic row in the local guest room, server row via the
   *  normal POST (the route honors the guest ticket), reduced echo to the
   *  guest room. Throws on failure so the composer can flag the row. */
  sendGuestMessage: (conversationId: string, content: string) => Promise<void>

  // ---- whisper in calls / voice channels ----
  /** who I am whispering to right now: my mic routes ONLY to them (each
   *  other peer stops receiving my audio; I still hear everyone). null =
   *  my mic goes to the whole room again */
  callWhisperTarget: { userId: string; username: string } | null
  /** who is whispering TO me right now (they hear me, the rest does not) */
  callWhisperedBy: { userId: string; username: string; displayName: string | null } | null
  /** route my mic to one person only (null = everyone); the target learns
   *  about the private line through the call:whisper socket event */
  setCallWhisper: (userId: string | null) => void
  /** inbound: someone started / stopped whispering to me */
  onCallWhisper: (payload: { from: { userId: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }; active: boolean }) => void

  // ---- forum channels ----
  forumPostsByChannel: Record<string, ForumPostSummary[]>
  forumLoaded: Record<string, boolean>
  /** forum tags per channel (colored chips, admin-managed) */
  forumTags: Record<string, ForumTagSummary[]>
  openForumPostId: string | null
  loadForumPosts: (channelId: string, sort?: 'latest' | 'new') => Promise<void>
  refreshForumTags: (channelId: string) => Promise<void>
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

  // ---- saved whisper lists ----
  /** my named multi-whisper presets, loaded at boot */
  whisperLists: WhisperListSummary[]
  refreshWhisperLists: () => Promise<void>
  /** save the current selection as a preset (2-8 member ids); ApiErrors
   *  pass through so the picker can toast them */
  addWhisperList: (name: string, memberIds: string[]) => Promise<void>
  removeWhisperList: (listId: string) => Promise<void>

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
  /** group call setting (owner only): may members ring non-members into
   *  this group's calls ("cross-ringing")? */
  setGroupCrossRing: (conversationId: string, allowed: boolean) => Promise<void>
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
    payload: { name?: string; description?: string; iconUrl?: string | null; regenerateInvite?: boolean; blockedWords?: string; callChannelsEnabled?: boolean; allowGuestRings?: boolean }
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
  refreshServerStickers: (serverId: string) => Promise<void>
  /** admin path: upload the image, then register it as a server sticker */
  addServerSticker: (serverId: string, file: File, name: string) => Promise<boolean>
  /** admin path: remove a sticker from the server */
  removeServerSticker: (serverId: string, stickerId: string) => Promise<void>
  refreshConversations: () => Promise<void>

  loadOlder: (room: string) => Promise<void>
  sendMessage: (payload: { content?: string; imageUrl?: string; attachments?: MessageAttachment[]; whisperTo?: string; stickerId?: string; stickerName?: string; stickerUrl?: string; fileId?: string; file?: ClientMessage['file'] }) => Promise<void>

  // THE VAULT (chunked ephemeral DM file sends)
  /** start a chunked upload for a conversation (init → parallel chunk PUTs → complete) */
  vaultUploadFile: (conversationId: string, file: File) => Promise<void>
  /** abort + remove a job and best-effort DELETE its upload (cancel/error/discard) */
  vaultDropJob: (key: string) => void
  /** restart a failed job from scratch */
  vaultRetryJob: (key: string) => void
  /** remove a job whose message sent successfully (upload stays alive server-side) */
  vaultClearJob: (key: string) => void
  /** internal engine: init → parallel chunk PUTs → complete for one job */
  vaultRunJob: (key: string) => Promise<void>
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
  /** report a room's bottom-parking (from the message list's scroll state);
   *  no-ops when unchanged so scroll events never re-render */
  setRoomAtBottom: (room: string, atBottom: boolean) => void
  /** the honest read check: mark a room read only when the user is actually
   *  reading it — present (focus + recent input), the active room, and
   *  bottom-parked. anything else leaves the unread badge for later */
  maybeMarkRead: (room: string) => void

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
  /** a channel member read this channel: friends-only receipts ride the
   *  stamp under MY messages (non-friends are ignored client-side) */
  onChannelRead: (payload: { channelId: string; userId: string; lastReadAt: string }) => void
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
        // the member list / roles ride the server detail call: without this
        // a restored session showed an empty member list until the user
        // re-clicked the server in the rail
        void get().refreshServerDetail(server.id)
        await get().selectChannel(id)
      }
    }
  } catch {
    /* a remembered room that fails to open just falls back to home */
  }
}

/* ---------- ringing tiles ---------- */

/** Resolve a rung user's identity from whatever cache already knows them:
 *  conversation participants, friends, then any server's member list. The
 *  bare-id fallback only shows for users I share nothing with - the ring
 *  still reaches them, the tile just stays anonymous. */
function resolveRingingUser(
  state: { conversations: ConversationSummary[]; friends: FriendSummary[]; serverMembers: Record<string, ServerMemberSummary[]> },
  userId: string
): RingingUserSummary {
  for (const c of state.conversations) {
    const p = c.participants?.find((x) => x.id === userId)
    if (p) return { userId, username: p.username, displayName: p.displayName, avatarUrl: p.avatarUrl, avatarColor: p.avatarColor }
    if (c.otherUser?.id === userId) {
      return {
        userId,
        username: c.otherUser.username,
        displayName: c.otherUser.displayName,
        avatarUrl: c.otherUser.avatarUrl,
        avatarColor: c.otherUser.avatarColor,
      }
    }
  }
  const f = state.friends.find((x) => x.user.id === userId)
  if (f) return { userId, username: f.user.username, displayName: f.user.displayName, avatarUrl: f.user.avatarUrl, avatarColor: f.user.avatarColor }
  for (const members of Object.values(state.serverMembers)) {
    const m = members.find((x) => x.id === userId)
    if (m) return { userId, username: m.username, displayName: m.displayName, avatarUrl: m.avatarUrl, avatarColor: m.avatarColor }
  }
  return { userId, username: userId, displayName: null, avatarUrl: null, avatarColor: '#2e2e2e' }
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
  serverStickers: {},
  drafts: {},
  channelMentions: {},

  conversations: [],
  rooms: {},
  vaultJobs: [],
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
  channelFriendReadAt: {},
  roomAtBottom: {},

  friends: [],
  incomingRequests: [],
  outgoingRequests: [],
  blockedUserIds: {},
  mutedScopes: {},

  whisperLists: [],

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
  adminPanelOpen: false,
  profileEditorOpen: false,
  profileUser: null,
  profileOpen: false,
  jumpTarget: null,
  returnPoint: null,
  threadJump: null,
  presentRequest: null,
  pinsOpen: false,
  remindersOpen: false,
  pendingInsert: null,
  mediaPlayer: null,

  voiceConnected: null,
  voiceGuest: null,
  voiceSelf: { muted: false, deafened: false, pttEnabled: false, pttActive: false, transmitting: true, recording: false, cameraOn: false, screenOn: false },
  voiceUnavailable: false,
  voiceParticipants: {},
  voiceRingingUsers: {},
  voicePriority: {},
  watchingScreens: [],
  voiceFullscreen: false,
  myScreenWatchers: [],
  soundboards: {},

  incomingCall: null,
  activeCall: null,
  callSelf: { muted: false, deafened: false, cameraOn: false, screenOn: false, pttEnabled: false, pttActive: false, transmitting: true },
  liveCalls: {},
  callRingingUsers: {},
  callFullscreen: false,

  callWhisperTarget: null,
  callWhisperedBy: null,

  togglePushToTalk: () => {
    pttPrefs.enabled = !pttPrefs.enabled
    commitPttPrefs()
  },

  setPushToTalkKey: (key: string) => {
    if (!key) return
    pttPrefs.key = key
    commitPttPrefs()
  },

  forumPostsByChannel: {},
  forumLoaded: {},
  forumTags: {},
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
          get().refreshWhisperLists(),
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

  setView: (view) => {
    const prev = get().view
    // aura: crossing between the public site and the auth screens swaps the
    // entire page (landing -> login, app -> login for another account) — a
    // massive transition, it earns the whoom. Small hops (privacy, terms)
    // stay on their ticks.
    const authish = (v: View) => v === 'login' || v === 'register'
    if (authish(prev) !== authish(view)) sounds.play('whoom')
    set({ view })
  },

  doLogin: async (identifier, password) => {
    const { user, token } = await apiClient.login({ identifier, password })
    saveAccount(user, token)
    // the aura whoosh is reserved for massive transitions; landing inside
    // the app from the auth screen is the biggest one there is
    sounds.play('whoom')
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
    // same massive transition as login: a whole world just took shape
    sounds.play('whoom')
    set({ me: user, view: 'app' })
    await Promise.all([get().refreshServers(), get().refreshConversations(), get().refreshFriends()])
  },

  switchAccount: async (token) => {
    const { user, token: refreshed } = await apiClient.switchAccount(token)
    saveAccount(user, refreshed)
    // swapping worlds: the aura marks leaving this account behind, and the
    // short hold lets it land before the reload tears the page down
    sounds.play('whoom')
    await new Promise((r) => setTimeout(r, 420))
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
      // the world powering down is a massive transition: it gets the aura
      sounds.play('whoom')
      await new Promise((r) => setTimeout(r, 420))
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
      adminPanelOpen: false,
      profileEditorOpen: false,
      profileOpen: false,
      profileUser: null,
    })
  },

  setAccountOpen: (open) => set({ accountOpen: open }),
  setAdminPanelOpen: (open) => set({ adminPanelOpen: open }),
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

  setReturnPoint: (room, scrollTop) => set({ returnPoint: { room, scrollTop, at: Date.now() } }),
  clearReturnPoint: () => set({ returnPoint: null }),

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

  // ---- saved whisper lists ----

  refreshWhisperLists: async () => {
    try {
      const { lists } = await apiClient.whisperLists()
      set({ whisperLists: lists })
    } catch {
      // best-effort: the picker falls back to no saved lists until it lands
    }
  },

  addWhisperList: async (name, memberIds) => {
    const { list } = await apiClient.addWhisperList({ name, memberIds })
    set((s) => ({ whisperLists: [...s.whisperLists, list] }))
  },

  removeWhisperList: async (listId) => {
    await apiClient.removeWhisperList(listId)
    set((s) => ({ whisperLists: s.whisperLists.filter((l) => l.id !== listId) }))
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
    void get().refreshServerStickers(serverId)
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
      void get().refreshServerStickers(owner.id)
    } else if (owner && !get().serverEmoji[owner.id]) {
      void get().refreshServerEmoji(owner.id)
      void get().refreshServerStickers(owner.id)
    }
    const room = roomOfChannel(channelId)
    if (prevRoom !== room) carryAwayYouTube(prevRoom)
    rememberLastRoom(room)

    // forum channels have their own post/thread surface instead of a flat
    // message feed; voice channels DO have text chat now (the stage and the
    // chat ride side by side), so their feed loads like any text channel
    const channel = owner?.channels.find((c) => c.id === channelId)
    if (channel && channel.type === 'forum') {
      void get().loadForumPosts(channelId)
      return
    }

    void get().maybeMarkRead(`channel:${channelId}`)
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
          // friends-only read receipts seed with the room: my friends' latest
          // read stamps for this channel (live updates ride channel:read)
          ...(res.friendReadAt ? { channelFriendReadAt: { ...s.channelFriendReadAt, [channelId]: res.friendReadAt } } : {}),
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
    void get().maybeMarkRead(`conversation:${conversationId}`)
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

  setGroupCrossRing: async (conversationId, allowed) => {
    const prev = get().conversations.find((c) => c.id === conversationId)?.allowCrossRing ?? true
    // optimistic flip; the server + notifyParticipants keep every member
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId ? { ...c, allowCrossRing: allowed } : c
      ),
    }))
    try {
      await apiClient.setGroupCrossRing(conversationId, allowed)
    } catch (err) {
      // revert on failure
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === conversationId ? { ...c, allowCrossRing: prev } : c
        ),
      }))
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

  refreshServerStickers: async (serverId) => {
    try {
      const { stickers } = await apiClient.serverStickers(serverId)
      set((s) => ({ serverStickers: { ...s.serverStickers, [serverId]: stickers } }))
    } catch {
      // not a member (anymore) or offline: drop the cache
      set((s) => {
        if (!s.serverStickers[serverId]) return {}
        const serverStickers = { ...s.serverStickers }
        delete serverStickers[serverId]
        return { serverStickers }
      })
    }
  },

  addServerSticker: async (serverId, file, name) => {
    try {
      // 1) the image bytes land in the shared upload store (served back
      //    from /api/files/<uuid>.<ext>), 2) the sticker row references it
      const up = await apiClient.uploadFile(file)
      await apiClient.addServerSticker(serverId, { name, url: up.url, size: up.size, mime: up.type })
      await get().refreshServerStickers(serverId)
      return true
    } catch (err) {
      toast({
        title: 'could not add the sticker',
        description: err instanceof ApiError ? err.message : undefined,
      })
      return false
    }
  },

  removeServerSticker: async (serverId, stickerId) => {
    try {
      await apiClient.removeServerSticker(serverId, stickerId)
      await get().refreshServerStickers(serverId)
    } catch {
      toast({ title: 'could not remove the sticker' })
    }
  },

  refreshConversations: async () => {
    try {
      const { conversations } = await apiClient.conversations()
      set((s) => {
        const otherReadAt = { ...s.otherReadAt }
        const groupReadAt = { ...s.groupReadAt }
        for (const c of conversations) {
          otherReadAt[c.id] = c.otherLastReadAt
          // group read receipts: replace the whole per-conversation entry
          // (stale per-user stamps must never linger); absent payload drops
          // the key. DMs never carry one.
          if (c.kind === 'GROUP') {
            if (c.othersReadAt) groupReadAt[c.id] = { ...c.othersReadAt }
            else delete groupReadAt[c.id]
          }
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
          groupReadAt,
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

    // 1. local echo: a temp row appears immediately with pending state;
    //    the marker token swaps locally too so the echo never flashes the
    //    raw :fniger: words before the server row lands
    const tempId = `pending:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    const echo: ClientMessage = {
      id: tempId,
      content: payload.content ? swapMarker(payload.content) : null,
      imageUrl: payload.imageUrl ?? null,
      attachments: payload.attachments ?? null,
      createdAt: new Date().toISOString(),
      editedAt: null,
      pinned: false,
      pinnedAt: null,
      pingsEveryone: false,
      whisperTargetId: payload.whisperTo ? 'me' : null,
      whisperTargetName: payload.whisperTo ?? null,
      stickerName: payload.stickerName ?? null,
      stickerUrl: payload.stickerUrl ?? null,
      file: payload.file ?? null,
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

  // ---- cross-rung call guest: send-only chat ----

  sendGuestMessage: async (conversationId, content) => {
    const me = get().me
    const text = content.trim().slice(0, 2000)
    if (!me || !text) return
    const baseId = baseConversationId(conversationId)
    const room = `conversation-guest:${baseId}`
    const tempId = `pending:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
    const echo: ClientMessage = {
      id: tempId,
      content: swapMarker(text),
      imageUrl: null,
      attachments: null,
      createdAt: new Date().toISOString(),
      editedAt: null,
      pinned: false,
      pinnedAt: null,
      pingsEveryone: false,
      whisperTargetId: null,
      whisperTargetName: null,
      stickerName: null,
      stickerUrl: null,
      file: null,
      replyToId: null,
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
      if (!state?.loaded) return {}
      return { rooms: { ...s.rooms, [room]: { ...state, messages: [...state.messages, echo] } } }
    })
    sounds.play('send')
    try {
      const { message } = await apiClient.sendConversationMessage(baseId, { content: text, nonce: tempId })
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
    } catch {
      set((s) => {
        const state = s.rooms[room]
        if (!state?.loaded) return {}
        return {
          rooms: {
            ...s.rooms,
            [room]: { ...state, messages: state.messages.map((m) => (m.id === tempId ? { ...m, pending: false, failed: true } : m)) },
          },
        }
      })
      sounds.play('error')
      throw new Error('send-failed')
    }
  },

  // ---- THE VAULT: chunked ephemeral file sends ----

  vaultUploadFile: async (conversationId, file) => {
    const key = `vault-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    set((s) => ({
      vaultJobs: [
        ...s.vaultJobs,
        {
          key,
          conversationId,
          uploadId: null,
          name: file.name || 'file',
          size: file.size,
          mime: file.type || 'application/octet-stream',
          state: 'uploading' as const,
          uploadedBytes: 0,
          speed: 0,
          startedAt: Date.now(),
          expiresAt: null,
          file,
        },
      ],
    }))
    sounds.play('lightTick')
    await get().vaultRunJob(key)
  },

  vaultDropJob: (key) => {
    const job = get().vaultJobs.find((j) => j.key === key)
    vaultAbort.get(key)?.abort()
    vaultAbort.delete(key)
    set((s) => ({ vaultJobs: s.vaultJobs.filter((j) => j.key !== key) }))
    // the draft upload dies with the job (guarded: an id that already expired
    // or swept just 404s and that is fine)
    if (job?.uploadId) void apiClient.vaultDeleteFile(job.uploadId).catch(() => {})
  },

  vaultRetryJob: (key) => {
    void get().vaultRunJob(key)
  },

  vaultClearJob: (key) => {
    vaultAbort.delete(key)
    set((s) => ({ vaultJobs: s.vaultJobs.filter((j) => j.key !== key) }))
  },

  /** internal: run (or re-run) one job end to end. Lives on the store so it
   *  survives composer unmounts — switching rooms mid-upload keeps sending. */
  vaultRunJob: async (key) => {
    const job = get().vaultJobs.find((j) => j.key === key)
    if (!job) return
    const patch = (p: Partial<VaultUploadJob>) =>
      set((s) => ({ vaultJobs: s.vaultJobs.map((j) => (j.key === key ? { ...j, ...p } : j)) }))
    const ac = new AbortController()
    vaultAbort.set(key, ac)
    const runStartedAt = Date.now()
    patch({ state: 'uploading', uploadedBytes: 0, speed: 0, error: undefined, startedAt: runStartedAt })
    try {
      // a retry may leave a dead draft upload behind: clean it first
      if (job.uploadId) void apiClient.vaultDeleteFile(job.uploadId).catch(() => {})
      const init = await apiClient.vaultInit({
        filename: job.name,
        size: job.size,
        mime: job.mime,
        conversationId: job.conversationId,
      })
      patch({ uploadId: init.id, expiresAt: init.expiresAt })
      // parallel chunk PUTs, 3 in flight: fast on real links, polite to the box.
      // progress ticks per-byte via XHR upload events — completed chunks count
      // as a base, in-flight chunks report their loaded bytes live.
      const chunkSize = init.chunkSize
      let nextIndex = 0
      let sentBase = 0 // bytes of fully-completed chunks
      const inflight = new Map<number, number>() // chunk index → bytes reported
      const pushProgress = () => {
        let live = 0
        for (const v of inflight.values()) live += v
        const total = sentBase + live
        const elapsed = Math.max(0.25, (Date.now() - runStartedAt) / 1000)
        patch({ uploadedBytes: total, speed: total / elapsed })
      }
      const worker = async () => {
        while (true) {
          if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError')
          const i = nextIndex++
          if (i >= init.totalChunks) return
          const start = i * chunkSize
          const blob = job.file.slice(start, Math.min(start + chunkSize, job.size))
          inflight.set(i, 0)
          try {
            await putChunkXhr(`/api/files/${init.id}/chunks/${i}`, blob, ac.signal, (loaded) => {
              inflight.set(i, loaded)
              pushProgress()
            })
          } finally {
            inflight.delete(i)
          }
          sentBase += blob.size
          pushProgress()
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, init.totalChunks) }, worker))
      const done = await apiClient.vaultComplete(init.id)
      patch({
        state: 'done',
        speed: 0,
        uploadedBytes: job.size,
        expiresAt: done.file.expiresAt,
        uploadId: done.file.id,
      })
      sounds.play('midTick')
    } catch (err) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return // vaultDropJob already removed the job
      }
      patch({ state: 'error', error: err instanceof Error ? err.message : 'upload failed' })
      sounds.play('error')
    } finally {
      vaultAbort.delete(key)
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
    // optimistic, the same no-latency contract sendMessage has: the words
    // swap on screen the instant Enter lands. Every local copy (room list,
    // open thread, thread root) is patched at once; the server reply then
    // reconciles the row with its canonical stamp. A failed request rolls
    // the row back to exactly what it said before.
    const findAll = (): ClientMessage | null => {
      const s = get()
      for (const r of Object.values(s.rooms)) {
        const hit = r.messages.find((m) => m.id === messageId)
        if (hit) return hit
      }
      for (const t of Object.values(s.threads)) {
        const hit = t.messages.find((m) => m.id === messageId) ?? (t.root?.id === messageId ? t.root : null)
        if (hit) return hit
      }
      return null
    }
    const before = findAll()
    const applyContent = (next: { content: string | null; editedAt: string | null }) =>
      set((s) => {
        const rooms = { ...s.rooms }
        const threads = { ...s.threads }
        let threadsChanged = false
        const patch = (m: ClientMessage): ClientMessage => (m.id === messageId ? { ...m, ...next } : m)
        for (const [key, state] of Object.entries(s.rooms)) {
          if (state.messages.some((m) => m.id === messageId)) {
            rooms[key] = { ...state, messages: state.messages.map(patch) }
          }
        }
        for (const [rootId, t] of Object.entries(s.threads)) {
          if (t.messages.some((m) => m.id === messageId) || t.root?.id === messageId) {
            threadsChanged = true
            threads[rootId] = { ...t, messages: t.messages.map(patch), root: t.root ? patch(t.root) : t.root }
          }
        }
        return threadsChanged ? { rooms, threads } : { rooms }
      })

    applyContent({ content: content ? swapMarker(content) : null, editedAt: new Date().toISOString() })
    try {
      const { message } = await apiClient.editMessage(messageId, content)
      get().onMessageUpdate(message)
    } catch {
      if (before) applyContent({ content: before.content, editedAt: before.editedAt })
      sounds.play('error')
    }
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

  setRoomAtBottom: (room, atBottom) => {
    // unchanged values return the same state — and no side effects at all:
    // scroll events fire constantly and must never re-render or re-mark.
    // an early return (instead of a {} set) keeps that literal.
    const prev = get().roomAtBottom[room]
    if (prev === atBottom) return
    set((s) => ({ roomAtBottom: { ...s.roomAtBottom, [room]: atBottom } }))
    // arriving back at the bottom IS the reading posture: re-run the honest
    // gate (it no-ops unless this room is also the active one and the user
    // is present). flipping to false never marks anything read.
    if (atBottom) get().maybeMarkRead(room)
  },

  maybeMarkRead: (room) => {
    // ALL conditions must hold: the user is demonstrably present (focused +
    // recent input), this room is the one they are looking at, and its
    // newest messages are on screen. anything else leaves the unread badge
    // alone — a later gate flip or scroll re-triggers this.
    if (!getReadGate().ready) return
    if (activeRoomOf(get()) !== room) return
    if (get().roomAtBottom[room] !== true) return
    void get().markRead(room)
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

    // honest read check for the unread counters: the message only counts as
    // read right now when the gate would actually mark it read (present,
    // this room active, bottom-parked). a focused-but-scrolled-up reader
    // keeps their unread badge until they return to the bottom.
    const willRead =
      activeRoomOf(state) === msg.room && getReadGate().ready && get().roomAtBottom[msg.room] === true

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
          unreadCount: willRead ? 0 : (existing?.unreadCount ?? 0) + (msg.authorId === s.me?.id ? 0 : 1),
        }
        conversations = [updated, ...conversations.filter((c) => c.id !== conversationId)]
      }

      return { rooms, threads, channelUnread, channelMentions, conversations }
    })

    // viewing the room only means reading it when the read gate agrees
    // (present + active room + bottom-parked); otherwise the badge waits
    // for a later gate flip or scroll
    get().maybeMarkRead(msg.room)
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
    // route by conversation kind: groups keep WHO read (per-member stamps
    // for the avatar receipt row); DMs (and unknown conversations) keep the
    // single otherReadAt stamp the "seen" check uses
    const conv = get().conversations.find((c) => c.id === conversationId)
    if (conv?.kind === 'GROUP') {
      set((s) => ({
        groupReadAt: {
          ...s.groupReadAt,
          [conversationId]: { ...(s.groupReadAt[conversationId] ?? {}), [userId]: lastReadAt },
        },
      }))
      return
    }
    // a cross-rung call GUEST receiving a member's read stamp: the
    // conversation is not in my list, but my send-only guest room is — keep
    // the per-reader stamp so the guest chat can show WHO read my messages
    // (their avatars resolve from the call participant list)
    if (!conv && get().rooms[`conversation-guest:${conversationId}`]?.loaded) {
      set((s) => ({
        groupReadAt: {
          ...s.groupReadAt,
          [conversationId]: { ...(s.groupReadAt[conversationId] ?? {}), [userId]: lastReadAt },
        },
      }))
      return
    }
    set((s) => ({
      otherReadAt: { ...s.otherReadAt, [conversationId]: lastReadAt },
    }))
  },

  onChannelRead: ({ channelId, userId, lastReadAt }) => {
    const me = get().me
    if (!me || userId === me.id) return
    // friends only: the receipt row on my channel messages counts readers I
    // am friends with (the server seeds + broadcasts every member's read;
    // the filter happens here, on the author's side)
    const isFriend = get().friends.some((f) => f.user.id === userId)
    if (!isFriend) return
    set((s) => ({
      channelFriendReadAt: {
        ...s.channelFriendReadAt,
        [channelId]: { ...(s.channelFriendReadAt[channelId] ?? {}), [userId]: lastReadAt },
      },
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
      if (get().activeServerId === serverId || get().serverStickers[serverId]) {
        void get().refreshServerStickers(serverId)
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
    // one audio surface at a time: entering a voice channel ends any live
    // call (the hangup tells its participants before we take the mic)
    if (get().activeCall) get().hangupCall()
    try {
      await voiceEngine.join(channelId, serverId, me.id)
      set({ voiceConnected: { serverId, channelId }, voiceUnavailable: voiceEngine.getState().unavailable })
      if (voiceEngine.getState().unavailable) return true
      // your own arrival sound: everyone in the channel hears theirs, you
      // hear yours too, exactly like walking into a room
      sounds.play('callEnter')
      // initial sidebar participants before the socket's voice:state lands
      try {
        const { participants } = await apiClient.channelVoice(channelId)
        get().onVoiceState({ channelId, participants })
        // joining a channel where recording is already live: the joiner
        // gets the warning too (everyone in the room already heard it)
        if (participants.some((p) => p.recording)) sounds.play('recStart')
      } catch {
        // socket state is the source of truth; the fetch is best-effort
      }
      return true
    } catch (err) {
      if (err instanceof Error && err.message === 'mic-denied') {
        toast({
          title: 'microphone blocked',
          description: 'allow microphone access in your browser, then join again.',
        })
      } else {
        toast({ title: 'could not join voice', description: 'no microphone was found on this device.' })
      }
      return false
    }
  },

  leaveVoice: () => {
    // your own exit chirp, mirroring the join one
    sounds.play('callLeave')
    stopWatchingAllScreens(get)
    voiceEngine.leave()
    set({
      voiceConnected: null,
      voiceGuest: null,
      voiceSelf: { muted: false, deafened: false, pttEnabled: pttPrefs.enabled, pttActive: false, transmitting: !pttPrefs.enabled, recording: false, cameraOn: false, screenOn: false },
      voiceUnavailable: false,
      watchingScreens: [],
      myScreenWatchers: [],
      voiceFullscreen: false,
      callWhisperTarget: null,
    })
  },

  switchVoiceSpace: async (channelId, serverId) => {
    const state = get()
    if (!state.me) return false
    // not connected anywhere: a plain join
    if (!state.voiceConnected) return get().joinVoice(channelId, serverId)
    // already there: nothing to do
    if (state.voiceConnected.channelId === channelId && state.voiceConnected.serverId === serverId) return true
    // one audio surface at a time: hopping into a voice channel ends any
    // live call first
    if (state.activeCall) get().hangupCall()
    // what was live survives the hop: mute, deafen, camera, screen
    const wasMuted = voiceEngine.getState().muted
    const wasDeafened = voiceEngine.getState().deafened
    const wasCamera = state.voiceSelf.cameraOn
    const wasScreen = state.voiceSelf.screenOn
    // silent teardown - hopping channels is not leaving, no exit chirp
    stopWatchingAllScreens(get)
    voiceEngine.leave()
    set({
      voiceConnected: null,
      voiceSelf: { muted: false, deafened: false, pttEnabled: pttPrefs.enabled, pttActive: false, transmitting: !pttPrefs.enabled, recording: false, cameraOn: false, screenOn: false },
      voiceUnavailable: false,
      watchingScreens: [],
      myScreenWatchers: [],
    })
    const ok = await get().joinVoice(channelId, serverId)
    if (!ok) return false
    // re-arm what was live before the hop (best effort: a denial just
    // toasts, the hop itself already succeeded)
    if (wasMuted) voiceEngine.toggleMute()
    if (wasDeafened) voiceEngine.toggleDeafen()
    if (wasScreen) void get().toggleVoiceScreen()
    else if (wasCamera) void get().toggleVoiceCamera()
    return true
  },

  toggleVoiceMute: () => {
    if (!get().voiceConnected) return
    voiceEngine.toggleMute()
  },

  toggleVoiceDeafen: () => {
    if (!get().voiceConnected) return
    voiceEngine.toggleDeafen()
  },

  toggleVoiceCamera: async () => {
    if (!get().voiceConnected) return
    const on = !voiceEngine.getState().cameraOn
    try {
      await voiceEngine.setCamera(on)
      set((s) => ({ voiceSelf: { ...s.voiceSelf, cameraOn: on } }))
    } catch {
      toast({ title: 'camera unavailable' })
    }
  },

  toggleVoiceScreen: async () => {
    if (!get().voiceConnected) return
    const on = !voiceEngine.getState().screenOn
    try {
      await voiceEngine.setScreen(on)
      set((s) => ({
        voiceSelf: { ...s.voiceSelf, screenOn: on },
        // stopping the share ends everyone's watch: my watcher list dies
        // with it (watchers' tiles revert from their own voice:state view)
        myScreenWatchers: on ? s.myScreenWatchers : [],
      }))
    } catch {
      /* user dismissed the share picker */
    }
  },

  createVoiceCallChannel: async (channelId, serverId, name) => {
    const me = get().me
    if (!me) return
    const server = get().servers.find((s) => s.id === serverId)
    if (server && server.callChannelsEnabled === false) {
      toast({ title: 'call channels are disabled on this server' })
      return
    }
    const slug = roomSlugFromName(name)
    const spaceId = roomSpaceId(channelId, slug)
    const live = get().voiceParticipants[spaceId]
    if (live && live.length > 0) {
      await get().switchVoiceSpace(spaceId, serverId)
      return
    }
    await get().switchVoiceSpace(spaceId, serverId)
    toast({ title: `channel "${roomLabelOf(spaceId)}" is live` })
  },

  onVoiceState: ({ channelId, participants, ringing, priorityUserId }) => {
    const state = get()
    // call channels inside a voice channel ride a synthetic id
    // (<channelId>~<slug>): the owning server (and its member cache) hangs
    // off the BASE channel id
    const baseId = channelId.split('~')[0]
    const server = state.servers.find((s) => s.channels.some((c) => c.id === baseId))
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
        recording: p.recording === true,
        video: p.video === true,
        screen: p.screen === true,
      }
    })
    const meId = state.me?.id
    const mine = meId ? enriched.find((p) => p.userId === meId) : undefined
    // screens I was watching: prune the ones that stopped sharing or left,
    // so their tiles honestly revert to click-to-watch. Only the state of
    // MY OWN channel prunes (other channels' broadcasts are spectated
    // from the outside and must not touch my watch list).
    if (state.watchingScreens.length > 0 && state.voiceConnected?.channelId === channelId) {
      const pruned = state.watchingScreens.filter((id) => enriched.find((p) => p.userId === id)?.screen === true)
      if (pruned.length !== state.watchingScreens.length) {
        // keep the engine's watch intent in lockstep with the UI truth
        for (const id of state.watchingScreens) if (!pruned.includes(id)) voiceEngine.setScreenWatch(id, false)
        set({ watchingScreens: pruned })
      }
    }
    // my audience only counts people still in the channel (a watcher whose
    // socket died never sent their unwatch — the membership list is truth)
    if (state.myScreenWatchers.length > 0 && state.voiceConnected?.channelId === channelId) {
      if (mine?.screen !== true) {
        // not sharing (anymore): nobody can be watching
        set({ myScreenWatchers: [] })
      } else {
        const hereIds = new Set(enriched.map((p) => p.userId))
        const kept = state.myScreenWatchers.filter((w) => hereIds.has(w.userId))
        if (kept.length !== state.myScreenWatchers.length) set({ myScreenWatchers: kept })
      }
    }
    // presence chirps for the channel I am actually sitting in: someone
    // else arriving or leaving plays the same join/leave sounds I hear for
    // myself. The first state after my own join has no previous list, so
    // people who were already in the room stay silent (no phantom chorus).
    const prevList = state.voiceParticipants[channelId]
    if (state.voiceConnected?.channelId === channelId && meId && prevList) {
      const prevIds = new Set(prevList.map((p) => p.userId).filter((id) => id !== meId))
      const nextIds = enriched.map((p) => p.userId).filter((id) => id !== meId)
      const someoneJoined = nextIds.some((id) => !prevIds.has(id))
      const someoneLeft = [...prevIds].some((id) => !nextIds.includes(id))
      if (someoneJoined) sounds.play('callEnter')
      if (someoneLeft) sounds.play('callLeave')
      // recording transitions for the channel I am sitting in: the FIRST
      // recorder anywhere in the channel plays the warning to everyone in
      // it, and the LAST recorder stopping plays the all-clear
      const prevRecording = prevList.some((p) => p.recording)
      const nextRecording = enriched.some((p) => p.recording)
      if (!prevRecording && nextRecording) sounds.play('recStart')
      if (prevRecording && !nextRecording) sounds.play('recStop')
    }
    // who is being rung INTO this channel: everyone sitting in it renders
    // their pinging tiles. The list rides voice:state; an empty list clears
    // it, and its absence (older payloads) leaves the current one alone.
    if (Array.isArray(ringing)) {
      const ringingUsers = ringing.map((id) => resolveRingingUser(state, id))
      set((s) => {
        const next = { ...s.voiceRingingUsers }
        if (ringingUsers.length > 0) next[channelId] = ringingUsers
        else delete next[channelId]
        return { voiceRingingUsers: next }
      })
    }
    // priority speaker (voice-stage moderation): the crown rides
    // voice:state like every other flag - an explicit null clears it, an
    // absent field (older payloads, the plain HTTP snapshot) leaves the
    // current crown alone, same contract as `ringing`. Self-heal: a crown
    // whose wearer is no longer in the participant list drops on the floor.
    const priorityProvided = typeof priorityUserId === 'string' || priorityUserId === null
    const prevCrowned = state.voicePriority[channelId] ?? null
    let crowned = priorityProvided ? (priorityUserId ?? null) : prevCrowned
    if (crowned && !participants.some((p) => p.userId === crowned)) crowned = null
    if (crowned !== prevCrowned) {
      set((s) => {
        const next = { ...s.voicePriority }
        if (crowned) next[channelId] = crowned
        else delete next[channelId]
        return { voicePriority: next }
      })
    }
    // local ducking follows the crown of the channel I am sitting in (a
    // broadcast about some other channel never touches the engine)
    if (state.voiceConnected?.channelId === channelId) {
      voiceEngine.setPriority(crowned)
    }
    set((s) => ({
      voiceParticipants: { ...s.voiceParticipants, [channelId]: enriched },
      // the sidecar's view of me carries the composite mute flag (hard mute
      // OR push-to-talk idle); pttActive stays engine-local truth. camera /
      // screen mirror the sidecar's media flags for my own tile.
      voiceSelf: mine
        ? {
            ...s.voiceSelf,
            muted: mine.muted,
            deafened: mine.deafened,
            cameraOn: mine.video,
            screenOn: mine.screen,
            transmitting: !mine.muted && (!s.voiceSelf.pttEnabled || s.voiceSelf.pttActive),
          }
        : s.voiceSelf,
    }))
    // ghost-state self-heal: I believe I am connected to this channel but the
    // realtime service just said I am not (my socket died and dropped my
    // presence). Re-announce instead of sitting in a silent room with a live
    // mic; the join broadcast also re-triggers everyone's mesh.
    if (state.voiceConnected?.channelId === channelId && meId && !mine && voiceEngine.getState().connected) {
      voiceEngine.rejoinAfterReconnect()
    }
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

  startCall: async (conversationId, withVideo, opts) => {
    const me = get().me
    const sock = getSocket()
    if (!me || !sock) return
    const conversation = get().conversations.find((c) => c.id === conversationId)
    // no calling yourself: a self-chat can be texted but never called
    if (conversation?.otherUser?.id === me.id) {
      toast({ title: 'you cannot call yourself' })
      return
    }
    const active = get().activeCall
    if (active && active.conversationId === conversationId) return
    // switching calls: leave the previous one cleanly first (the service
    // tells its participants and any still-ringing callees)
    if (active) get().hangupCall()
    // one mic, one surface: starting a call from a server voice channel
    // leaves the channel (the join chirp on the call side covers the exit)
    if (get().voiceConnected) get().leaveVoice()
    const incoming = get().incomingCall
    if (incoming) {
      if (incoming.conversationId === conversationId) {
        // the call I'm being rung on IS this conversation: taking it beats
        // ringing it a second time
        await get().acceptIncomingCall()
        return
      }
      // starting elsewhere retires the ring I was ignoring (their end
      // stops ringing instead of dangling for the full timeout)
      get().declineIncomingCall()
    }
    // participants ride the start event so the sidecar can ring everyone's
    // personal room (members who never opened this conversation included)
    const participantIds = conversation?.participants?.map((p) => p.id) ?? []
    if (conversation?.otherUser && !participantIds.includes(conversation.otherUser.id)) {
      participantIds.push(conversation.otherUser.id)
    }
    const silent = opts?.silent === true
    // the sidecar registers the caller and broadcasts call:state back;
    // onCallState triggers the engine join for the caller
    sock.emit('call:start', {
      conversationId,
      video: withVideo,
      silent,
      // group calls outlive a 1:1 wind-down on the service side; DM calls
      // keep the either-side-hanging-up-ends-it rule
      group: conversation?.kind === 'GROUP',
      profile: {
        displayName: me.displayName,
        avatarUrl: me.avatarUrl,
        avatarColor: me.avatarColor,
      },
      participantIds,
    })
    // the call's chat row ("started a call", join button while it lives,
    // duration after) - the caller alone can delete it, so a withdrawn
    // attempt leaves no trace
    try {
      const { message } = await apiClient.createCallLog(conversationId, { video: withVideo })
      pendingCallLogByConversation.set(conversationId, message.id)
      // the call:state echo may already have landed: bind it now instead of
      // waiting for the next broadcast
      const live = get().liveCalls[conversationId]
      if (live && live.createdBy === me.id && !pendingCallLogs.has(live.callId)) {
        pendingCallLogs.set(live.callId, message.id)
        pendingCallLogByConversation.delete(conversationId)
      }
    } catch {
      /* the call works without its message */
    }
  },

  joinCall: async (conversationId) => {
    const me = get().me
    if (!me) return
    const conversation = get().conversations.find((c) => c.id === conversationId)
    if (conversation?.otherUser?.id === me.id) {
      toast({ title: 'you cannot call yourself' })
      return
    }
    await get().startCall(conversationId, false, { silent: true })
  },

  ringUserIntoCall: (userId) => {
    const active = get().activeCall
    const sock = getSocket()
    if (!active || !sock) return
    // already in the call: nothing to ring
    if (active.participants.some((p) => p.userId === userId)) return
    sock.emit('call:ring-user', { callId: active.callId, targetUserId: userId })
    toast({ title: 'ringing them into the call' })
  },

  ringUserIntoVoice: (channelId, serverId, targetUserId) => {
    const me = get().me
    const sock = getSocket()
    const connected = get().voiceConnected
    if (!me || !sock || !connected || connected.channelId !== channelId) return
    const channel = get()
      .servers.find((s) => s.id === serverId)
      ?.channels.find((c) => c.id === channelId)
    sock.emit('voice:ring', {
      channelId,
      serverId,
      targetUserId,
      channelName: channel?.name ?? 'voice',
      profile: {
        displayName: me.displayName,
        avatarUrl: me.avatarUrl,
        avatarColor: me.avatarColor,
      },
    })
    toast({ title: 'ringing them into the channel' })
  },

  callUser: async (userId, video) => {
    const me = get().me
    if (!me || me.id === userId) return
    const active = get().activeCall
    // already talking to exactly them: nothing to redial
    const existing = get().conversations.find(
      (c) => c.kind === 'DM' && c.otherUser?.id === userId
    )
    if (active && existing && active.conversationId === existing.id) return
    sounds.play('lightTick')
    try {
      const { conversationId } = await apiClient.createConversation(userId)
      await get().refreshConversations()
      await get().selectConversation(conversationId)
      await get().startCall(conversationId, video === true)
    } catch {
      toast({ title: 'could not start the call' })
    }
  },

  createCallRoom: async (conversationId, name) => {
    const me = get().me
    const sock = getSocket()
    if (!me || !sock) return
    const conversation = get().conversations.find((c) => c.id === conversationId)
    if (!conversation || conversation.kind !== 'GROUP') {
      toast({ title: 'rooms are a group-chat feature' })
      return
    }
    const slug = roomSlugFromName(name)
    const spaceId = roomSpaceId(conversationId, slug)
    // a room already live under this name: hop into it instead of stacking
    const live = get().liveCalls[spaceId]
    if (live) {
      await get().joinCall(spaceId)
      return
    }
    // switching surfaces: leave whatever call I am in cleanly first (same
    // move startCall makes) so the new call's state broadcast joins me
    if (get().activeCall) get().hangupCall()
    // the room rides the group's member list so every member's personal
    // room learns it exists (silent: rooms never ring anyone)
    const participantIds = conversation.participants?.map((p) => p.id) ?? []
    sock.emit('call:start', {
      conversationId: spaceId,
      video: false,
      silent: true,
      // a call channel is a group surface: it stays live for whoever
      // remains when someone hops elsewhere
      group: true,
      profile: {
        displayName: me.displayName,
        avatarUrl: me.avatarUrl,
        avatarColor: me.avatarColor,
      },
      participantIds,
    })
    toast({ title: `channel "${roomLabelOf(spaceId)}" is live` })
  },

  toggleCallRecording: () => {
    const active = get().activeCall
    if (!active) return
    const media = callEngine.getMediaState()
    if (media.recording) {
      void callEngine
        .stopRecording()
        .then((name) => {
          if (name) toast({ title: 'recording saved', description: name })
          else toast({ title: 'recording stopped' })
        })
        .catch(() => toast({ title: 'recording could not be saved' }))
    } else {
      try {
        callEngine.startRecording()
      } catch {
        toast({ title: 'recording is unavailable in this browser' })
      }
    }
  },

  toggleVoiceRecording: () => {
    const connected = get().voiceConnected
    if (!connected) return
    const state = voiceEngine.getState()
    if (state.recording) {
      void voiceEngine
        .stopRecording()
        .then((name) => {
          if (name) toast({ title: 'recording saved', description: name })
          else toast({ title: 'recording stopped' })
        })
        .catch(() => toast({ title: 'recording could not be saved' }))
    } else {
      try {
        voiceEngine.startRecording()
      } catch {
        toast({ title: 'recording is unavailable in this browser' })
      }
    }
  },

  setPrioritySpeaker: (targetUserId) => {
    const conn = get().voiceConnected
    if (!conn) return
    // the sidecar stores/clears the crown and broadcasts the fresh
    // voice:state to the channel + server rooms (including us); no local
    // optimism needed, the round trip is one tick
    getSocket()?.emit('voice:priority', {
      channelId: conn.channelId,
      targetUserId: targetUserId ?? null,
    })
  },

  // ---- whisper in calls / voice channels ----

  setCallWhisper: (userId) => {
    const state = get()
    const me = state.me
    if (!me) return
    if (userId) {
      // only a live target makes sense: a participant of my call, or of the
      // voice channel I am sitting in
      const inCall = state.activeCall?.participants.find((p) => p.userId === userId)
      const inVoice = state.voiceConnected
        ? state.voiceParticipants[state.voiceConnected.channelId]?.find((p) => p.userId === userId)
        : undefined
      const username = inCall?.username ?? inVoice?.username
      if (!username || userId === me.id) return
      if (state.callWhisperTarget?.userId === userId) return
      // both meshes carry the routing; only the live one has peers, so the
      // other call is a harmless no-op that keeps state coherent
      callEngine.setWhisperPeer(userId)
      voiceEngine.setWhisperPeer(userId)
      set({ callWhisperTarget: { userId, username } })
      getSocket()?.emit('call:whisper', {
        to: userId,
        active: true,
        profile: { displayName: me.displayName, avatarUrl: me.avatarUrl, avatarColor: me.avatarColor },
      })
    } else {
      const prev = state.callWhisperTarget
      if (!prev) return
      callEngine.setWhisperPeer(null)
      voiceEngine.setWhisperPeer(null)
      set({ callWhisperTarget: null })
      getSocket()?.emit('call:whisper', { to: prev.userId, active: false })
    }
  },

  onCallWhisper: ({ from, active }) => {
    if (!from?.userId) return
    set((s) => ({
      callWhisperedBy: active
        ? { userId: from.userId, username: from.username, displayName: from.displayName }
        : s.callWhisperedBy?.userId === from.userId
          ? null
          : s.callWhisperedBy,
    }))
  },

  // ---- screenshare watching (opt-in per sharer) ----

  watchScreen: (userId) => {
    const state = get()
    const conn = state.voiceConnected
    const me = state.me
    if (!conn || !me || userId === me.id) return
    if (state.watchingScreens.includes(userId)) return
    voiceEngine.setScreenWatch(userId, true)
    set({ watchingScreens: [...state.watchingScreens, userId] })
    // tell the sharer their audience grew (their tile shows who watches)
    getSocket()?.emit('voice:screen-watch', {
      channelId: conn.channelId,
      serverId: conn.serverId,
      targetUserId: userId,
      watching: true,
      profile: { displayName: me.displayName, avatarUrl: me.avatarUrl, avatarColor: me.avatarColor },
    })
  },

  unwatchScreen: (userId) => {
    const state = get()
    const conn = state.voiceConnected
    if (!conn) return
    if (!state.watchingScreens.includes(userId)) return
    voiceEngine.setScreenWatch(userId, false)
    set({ watchingScreens: state.watchingScreens.filter((id) => id !== userId) })
    getSocket()?.emit('voice:screen-watch', {
      channelId: conn.channelId,
      serverId: conn.serverId,
      targetUserId: userId,
      watching: false,
      profile: null,
    })
  },

  onScreenWatch: ({ channelId, watcher, watching }) => {
    const conn = get().voiceConnected
    // only the sharer in the very channel cares (a stale event from a hop
    // or a share that already stopped lands nowhere)
    if (!conn || conn.channelId !== channelId) return
    set((s) => ({
      myScreenWatchers: watching
        ? [...s.myScreenWatchers.filter((w) => w.userId !== watcher.userId), watcher]
        : s.myScreenWatchers.filter((w) => w.userId !== watcher.userId),
    }))
  },

  // ---- server soundboard ----

  refreshSoundboard: async (serverId) => {
    try {
      const { sounds: list } = await apiClient.serverSounds(serverId)
      set((s) => ({ soundboards: { ...s.soundboards, [serverId]: list } }))
    } catch {
      // not a member (anymore) or offline: drop the cache so the picker
      // refetches instead of showing a stale list forever
      set((s) => {
        if (!s.soundboards[serverId]) return {}
        const soundboards = { ...s.soundboards }
        delete soundboards[serverId]
        return { soundboards }
      })
    }
  },

  addSoundboardSound: async (serverId, file, name) => {
    try {
      // 1) the audio bytes land in the shared upload store (served back
      //    from /api/files/<uuid>.<ext>), 2) the soundboard row references it
      const up = await apiClient.uploadFile(file)
      await apiClient.addServerSound(serverId, { name, url: up.url, size: up.size, mime: up.type })
      await get().refreshSoundboard(serverId)
      return true
    } catch (err) {
      toast({
        title: 'could not add the sound',
        description: err instanceof ApiError ? err.message : undefined,
      })
      return false
    }
  },

  removeSoundboardSound: async (serverId, soundId) => {
    try {
      await apiClient.removeServerSound(serverId, soundId)
      await get().refreshSoundboard(serverId)
    } catch {
      toast({ title: 'could not remove the sound' })
    }
  },

  playVoiceSound: async (serverId, soundId) => {
    if (!get().voiceConnected) return
    const sound = get().soundboards[serverId]?.find((s) => s.id === soundId)
    if (!sound) return
    try {
      // fetch + decode once per URL, then into the outbound mix: everyone
      // in the channel hears it, the local monitor plays it back to me
      await voiceEngine.playSound(sound.url)
    } catch {
      toast({ title: 'could not play the sound', description: 'the file failed to load or decode.' })
    }
  },

  acceptIncomingCall: async () => {
    const state = get()
    const me = state.me
    const incoming = state.incomingCall
    if (!me || !incoming) return
    // accepting a different call while mine is live switches surfaces
    // cleanly: the hangup tears my media down and tells that call's
    // participants before we join the new one
    const currentCall = state.activeCall
    if (currentCall && currentCall.callId !== incoming.callId) get().hangupCall()
    // the same applies to a server voice channel: accept a DM/group call
    // and the channel is left first, so one mic feeds one surface
    if (!incoming.voice && state.voiceConnected) get().leaveVoice()
    sounds.stopRingLoop('callRingIn')
    set({ incomingCall: null })
    // the next queued ring (if any) takes the freed screen
    showNextPendingRing()

    // a ring INTO a server voice channel ("server call"): accepting hops me
    // straight into that channel - no DM, no call mesh, just voice
    if (incoming.voice) {
      const { channelId, serverId } = incoming.voice
      const guest = incoming.voice.guest === true
      // a GUEST ring (I am not a member of the server): remember the channel
      // identity so the voice stage can render from the connection alone —
      // the channel is not in my servers list and can never be selected
      if (guest) {
        set({ voiceGuest: { channelId, serverId, channelName: incoming.voice.channelName } })
      }
      const ok = await get().switchVoiceSpace(channelId, serverId)
      if (ok) {
        if (guest) {
          // guests stay exactly where they were: no selectChannel (they
          // cannot read it), no navigation — the VoiceRoom stage renders
          // from voiceConnected + voiceGuest
          toast({ title: `joined #${incoming.voice.channelName}`, description: 'you are a guest in this voice channel.' })
          return
        }
        // walk the user to the channel so the voice room is on screen
        const server = get().servers.find((s) => s.id === serverId)
        const channel = server?.channels.find((c) => c.id === channelId)
        if (server && channel) await get().selectChannel(channelId)
      }
      return
    }

    // a cross-rung GUEST call: the conversation is not in my list — I joined
    // from outside the membership (a friend rang me in). No selecting it, no
    // reading it: the stage goes fullscreen with the send-only guest chat.
    const iAmGuest = !get().conversations.some((c) => c.id === baseConversationId(incoming.conversationId))

    try {
      // subscribe to the call's conversation room BEFORE accepting: every
      // call:state broadcast (participant list, media flags) rides that room,
      // and a callee sitting on Home or another server is subscribed to
      // nothing — without this the stage sticks on "nobody else is here"
      // even though the media mesh itself works (the engine builds peers
      // from SDP/ICE, not from the participant list). GUESTS skip it: the
      // sidecar seats their socket in the conversation-guest room on accept
      // (and re-seats on every reconnect's call:accept).
      if (!iAmGuest) subscribeRoom(`conversation:${incoming.conversationId}`)
      await callEngine.join(incoming.callId, incoming.conversationId, me.id, { accept: true })
      sounds.play('callEnter')
      // seed the stage with the caller's profile from the ring payload so
      // their tile (and its volume controls) renders immediately; the next
      // call:state broadcast replaces this with the authoritative list
      const seeded: CallParticipantSummary[] = [
        {
          userId: incoming.from.userId,
          username: incoming.from.username,
          displayName: incoming.from.displayName,
          avatarUrl: incoming.from.avatarUrl,
          avatarColor: incoming.from.avatarColor,
          muted: false,
          deafened: false,
          video: incoming.video,
          screen: false,
          recording: false,
        },
      ]
      set({
        activeCall: {
          callId: incoming.callId,
          conversationId: incoming.conversationId,
          createdBy: incoming.from.userId,
          createdAt: incoming.createdAt,
          acceptedAt: Date.now(),
          state: 'active',
          participants: seeded,
          ...(iAmGuest ? { guestOf: baseConversationId(incoming.conversationId) } : {}),
        },
        callSelf: { ...get().callSelf, cameraOn: callEngine.getMediaState().cameraOn },
        // guests always get the fullscreen takeover: it carries the send-only
        // guest chat beside the stage (there is no conversation to inline in)
        callFullscreen: iAmGuest ? true : false,
      })
      callEngine.onParticipants(seeded)
      callEngine.onMediaFlags(incoming.from.userId, incoming.video, false)
      if (iAmGuest) {
        // the send-only guest chat room: my sends + their read receipts
        const guestRoom = `conversation-guest:${baseConversationId(incoming.conversationId)}`
        set((s) => {
          if (s.rooms[guestRoom]?.loaded) return {}
          return { rooms: { ...s.rooms, [guestRoom]: { ...emptyRoom, loaded: true } } }
        })
        toast({
          title: 'joined as a guest',
          description: 'you can talk and send messages here, but you cannot read the chat.',
        })
        return
      }
      // accept lands in the call's conversation (Discord behavior): the DM
      // behind the stage, its "call started" system messages, and the room
      // stays subscribed through the UI's room tracking
      void get().selectConversation(incoming.conversationId)
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
    const sock = getSocket()
    // a voice-channel ring declines back to the ringer with its own event
    if (incoming.voice) {
      sock?.emit('voice:ring-decline', { channelId: incoming.voice.channelId, to: incoming.from.userId })
    } else {
      sock?.emit('call:decline', { callId: incoming.callId })
    }
    set({ incomingCall: null })
    showNextPendingRing()
  },

  letRingIncomingCall: () => {
    const incoming = get().incomingCall
    if (!incoming) return
    // the ring dies on my end only: the caller keeps hearing theirs
    sounds.stopRingLoop('callRingIn')
    const sock = getSocket()
    sock?.emit('call:let-ring', { callId: incoming.callId })
    set({ incomingCall: null })
    showNextPendingRing()
  },

  cancelOutgoingCall: () => {
    const active = get().activeCall
    if (!active) return
    sounds.stopRingLoop('callRingOut')
    // your own exit chirp: you hear yourself withdraw the call
    sounds.play('callLeave')
    const sock = getSocket()
    sock?.emit('call:cancel', { callId: active.callId })
    callEngine.teardown()
    set({
      activeCall: null,
      callFullscreen: false,
      callSelf: { muted: false, deafened: false, cameraOn: false, screenOn: false, pttEnabled: pttPrefs.enabled, pttActive: false, transmitting: !pttPrefs.enabled },
    })
  },

  setCallFullscreen: (fullscreen) => set({ callFullscreen: fullscreen }),

  setVoiceFullscreen: (fullscreen) => set({ voiceFullscreen: fullscreen }),

  hangupCall: () => {
    const active = get().activeCall
    if (!active) return
    const sock = getSocket()
    sock?.emit('call:hangup', { callId: active.callId })
    callEngine.teardown()
    sounds.play('callLeave')
    set({
      activeCall: null,
      callFullscreen: false,
      callSelf: { muted: false, deafened: false, cameraOn: false, screenOn: false, pttEnabled: pttPrefs.enabled, pttActive: false, transmitting: !pttPrefs.enabled },
      // whisper lines die with the call (either direction)
      callWhisperTarget: null,
      callWhisperedBy: null,
    })
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

  onCallRing: ({ callId, conversationId, from, video, createdAt, voice }) => {
    const state = get()
    // never ring myself
    if (from.userId === state.me?.id) return
    // my own ring echo for a call I am already in (ring-anyone fanout)
    if (state.activeCall && state.activeCall.callId === callId) return
    const ring: NonNullable<ChatStore['incomingCall']> = {
      callId,
      conversationId,
      from,
      video,
      createdAt: createdAt ?? Date.now(),
      ...(voice ? { voice } : {}),
    }
    // one ring on screen at a time: extras queue behind the current one
    // (declining, dismissing or taking it reveals the next; a ring whose
    // call ends while queued is dropped with it)
    if (state.incomingCall) {
      if (state.incomingCall.callId === callId) return
      if (!pendingRings.some((r) => r.callId === callId) && pendingRings.length < MAX_PENDING_RINGS) {
        pendingRings.push(ring)
      }
      return
    }
    // a ring CAN land while I am in another call: the incoming modal then
    // offers adding the caller to the call I'm already in (or switching)
    set({ incomingCall: ring })
    sounds.startRingLoop('callRingIn')
  },

  onCallState: ({ callId, conversationId, state, createdBy, createdAt, acceptedAt, participants, ringing }) => {
    const me = get().me
    if (!me) return

    // awareness for every member, in the call or not (the service fans this
    // out to personal rooms too): sidebar chips, join buttons, the call
    // message's live state
    set((s) => ({
      liveCalls: {
        ...s.liveCalls,
        [conversationId]: {
          callId,
          conversationId,
          state,
          createdBy,
          createdAt,
          acceptedAt: acceptedAt ?? null,
          participants,
        },
      },
    }))
    // who is still being rung into this call: everyone in it renders their
    // pinging tiles. Targets that appear in participants have answered, so
    // they prune out of the list; an empty list clears the key (its
    // absence - older payloads - leaves the current list alone).
    if (Array.isArray(ringing)) {
      const inCall = new Set(participants.map((p) => p.userId))
      const ringingUsers = ringing
        .filter((id) => !inCall.has(id))
        .map((id) => resolveRingingUser(get(), id))
      set((s) => {
        const next = { ...s.callRingingUsers }
        if (ringingUsers.length > 0) next[callId] = ringingUsers
        else delete next[callId]
        return { callRingingUsers: next }
      })
    }
    // bind the call-log message I just posted to its now-known callId
    // (creator side; idempotent across the many state broadcasts)
    if (createdBy === me.id) {
      const pendingMsg = pendingCallLogByConversation.get(conversationId)
      if (pendingMsg && !pendingCallLogs.has(callId)) {
        pendingCallLogs.set(callId, pendingMsg)
        pendingCallLogByConversation.delete(conversationId)
      }
    }

    const mine = participants.find((p) => p.userId === me.id)
    const current = get().activeCall
    const incoming = get().incomingCall

    // MY first broadcast for this call - either my own ring echoing back
    // (I started it) or the state update from me JOINING an in-progress
    // group call from the header. Both join the media mesh for the first
    // time; the outgoing ring loop only belongs to a call still ringing.
    // (an incoming ring for this call stays up instead: answered-elsewhere
    // is branch two below)
    if (mine && !current && !(incoming && incoming.callId === callId)) {
      void (async () => {
        try {
          await callEngine.join(callId, conversationId, me.id, { withVideo: mine.video })
          // your own arrival chirp: you hear yourself join, exactly like
          // everyone else will
          sounds.play('callEnter')
          // joining a call where recording is already live: the joiner gets
          // the warning too (everyone in the call already heard it)
          if (participants.some((p) => p.recording)) sounds.play('recStart')
          if (state === 'ringing') sounds.startRingLoop('callRingOut')
          set({
            activeCall: {
              callId,
              conversationId,
              createdBy,
              createdAt,
              // a joiner entering an active call adopts the authoritative
              // acceptedAt so their timer is honest; callers start at null
              // until someone answers
              acceptedAt: acceptedAt ?? (createdBy !== me.id && state === 'active' ? Date.now() : null),
              state,
              participants,
            },
            callSelf: { ...get().callSelf, cameraOn: callEngine.getMediaState().cameraOn },
            callFullscreen: false,
          })
          // someone may have accepted while we were setting up
          callEngine.onParticipants(participants)
          for (const p of participants) {
            if (p.userId !== me.id) callEngine.onMediaFlags(p.userId, p.video, p.screen)
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : ''
          if (msg === 'mic-denied') toast({ title: 'microphone unavailable' })
          else toast({ title: createdBy === me.id ? 'could not start the call' : 'could not join the call' })
          const sock = getSocket()
          // the creator's failed start cancels the call for everyone; a
          // joiner's failed join only removes themselves from it
          sock?.emit(createdBy === me.id ? 'call:cancel' : 'call:hangup', { callId })
        }
      })()
      return
    }

    // accepted-elsewhere rings die quietly (a group call someone else took)
    if (incoming && incoming.callId === callId && mine && createdBy !== me.id) {
      // I'm now a participant (someone accepted a group call I was rung on
      // from another tab) — leave the incoming screen up; the user decides
    }

    // my ring for this call died without me acting on it (expiry, or the
    // caller withdrew me from the ringing set): take the modal down instead
    // of looping the ringtone forever. Answered-from-another-tab keeps the
    // screen up (the branch above), and accepting locally already cleared it.
    if (
      incoming &&
      incoming.callId === callId &&
      Array.isArray(ringing) &&
      !ringing.includes(me.id) &&
      !mine
    ) {
      sounds.stopRingLoop('callRingIn')
      set({ incomingCall: null })
      showNextPendingRing()
    }

    if (current && current.callId === callId) {
      // recording transitions for the call I am in: the FIRST recorder
      // anywhere in the call plays the warning for everyone (the recorder
      // included - they hear what they just switched on), and the LAST
      // recorder stopping plays the all-clear
      const prevRecording = current.participants.some((p) => p.recording)
      const nextRecording = participants.some((p) => p.recording)
      if (!prevRecording && nextRecording) sounds.play('recStart')
      if (prevRecording && !nextRecording) sounds.play('recStop')
      set({ activeCall: { ...current, state, participants } })
      callEngine.onParticipants(participants)
      for (const p of participants) {
        if (p.userId !== me.id) callEngine.onMediaFlags(p.userId, p.video, p.screen)
      }
      // ghost-state self-heal: my media is live but the service just listed
      // this call without me (my socket dropped mid-call) - re-register so
      // SDP/ICE relay resumes instead of a silent connected-looking call
      if (!mine && callEngine.callActive) callEngine.rejoinAfterReconnect()
      // ringing -> active transition: kill the outgoing ring, play connect
      if (state === 'active' && current.state === 'ringing') {
        sounds.stopRingLoop('callRingOut')
        sounds.play('callEnter')
      }
      // whisper honesty: a private line (either direction) to someone who
      // just left the call ends on the spot
      const whisperTarget = get().callWhisperTarget
      if (whisperTarget && !participants.some((p) => p.userId === whisperTarget.userId)) {
        get().setCallWhisper(null)
      }
      const whisperedBy = get().callWhisperedBy
      if (whisperedBy && !participants.some((p) => p.userId === whisperedBy.userId)) {
        set({ callWhisperedBy: null })
      }
    }
  },

  onCallAccepted: ({ callId, userId }) => {
    const me = get().me
    const incoming = get().incomingCall
    // answered on another tab or device of this account: my ring dies
    // quietly while the call continues over there
    if (incoming && incoming.callId === callId && userId === me?.id) {
      sounds.stopRingLoop('callRingIn')
      set({ incomingCall: null })
      toast({ title: 'answered elsewhere', description: 'you took this call on another tab or device.' })
      showNextPendingRing()
      return
    }
    const current = get().activeCall
    if (!current || current.callId !== callId) return
    sounds.stopRingLoop('callRingOut')
    if (current.state === 'ringing') {
      sounds.play('callEnter')
      set({ activeCall: { ...current, state: 'active', acceptedAt: Date.now() } })
    }
    void userId
  },

  onCallDeclined: ({ callId, userId }) => {
    const me = get().me
    const incoming = get().incomingCall
    // declined on another tab or device of this account: my ring dies too
    if (incoming && incoming.callId === callId && userId === me?.id) {
      sounds.stopRingLoop('callRingIn')
      set({ incomingCall: null })
      return
    }
    const current = get().activeCall
    if (!current || current.callId !== callId) return
    // my outgoing call was declined before anyone accepted
    if (current.state === 'ringing') {
      sounds.stopRingLoop('callRingOut')
      sounds.play('callLeave')
      callEngine.teardown()
      set({
      activeCall: null,
      callFullscreen: false,
      callSelf: { muted: false, deafened: false, cameraOn: false, screenOn: false, pttEnabled: pttPrefs.enabled, pttActive: false, transmitting: !pttPrefs.enabled },
    })
    }
    // a rung target passed on the call: their pinging tile leaves the list
    // for everyone still in it (the state broadcast confirms it everywhere)
    set((s) => {
      const list = s.callRingingUsers[callId]
      if (!list) return {}
      const next = list.filter((u) => u.userId !== userId)
      const ringing = { ...s.callRingingUsers }
      if (next.length > 0) ringing[callId] = next
      else delete ringing[callId]
      return { callRingingUsers: ringing }
    })
  },

  onCallPeerLeft: ({ callId }) => {
    const current = get().activeCall
    if (!current || current.callId !== callId) return
    sounds.play('callLeave')
  },

  onCallEnded: ({ callId, conversationId, acceptedAt, durationSec, late }) => {
    const state = get()
    const wasActive = state.activeCall?.callId === callId
    const wasIncoming = state.incomingCall?.callId === callId
    // queued rings for a dead call die with it
    for (let i = pendingRings.length - 1; i >= 0; i--) {
      if (pendingRings[i].callId === callId) pendingRings.splice(i, 1)
    }
    if (!wasActive && !wasIncoming) {
      // still stamp the outcome on the call's chat row (the creator may
      // have hung up long before the last participant left)
      const logId = pendingCallLogs.get(callId)
      if (logId) {
        pendingCallLogs.delete(callId)
        const missed = !acceptedAt
        void apiClient
          .patchCallLog(conversationId, { messageId: logId, durationSec: missed ? null : durationSec ?? null, missed })
          .catch(() => {})
      }
      set((s) => {
        if (!s.liveCalls[conversationId] && !s.callRingingUsers[callId]) return {}
        const next = { ...s.liveCalls }
        delete next[conversationId]
        const ringing = { ...s.callRingingUsers }
        delete ringing[callId]
        return { liveCalls: next, callRingingUsers: ringing }
      })
      return
    }
    sounds.stopRingLoop('callRingIn')
    sounds.stopRingLoop('callRingOut')
    if (wasActive) {
      sounds.play('callLeave')
      callEngine.teardown()
    }
    set({
      activeCall: null,
      incomingCall: null,
      callFullscreen: false,
      callSelf: { muted: false, deafened: false, cameraOn: false, screenOn: false, pttEnabled: pttPrefs.enabled, pttActive: false, transmitting: !pttPrefs.enabled },
      callWhisperTarget: null,
      callWhisperedBy: null,
    })
    if (wasIncoming) showNextPendingRing()
    set((s) => {
      if (!s.liveCalls[conversationId] && !s.callRingingUsers[callId]) return {}
      const next = { ...s.liveCalls }
      delete next[conversationId]
      const ringing = { ...s.callRingingUsers }
      delete ringing[callId]
      return { liveCalls: next, callRingingUsers: ringing }
    })
    // stamp the outcome on the call's chat row: how long it ran, or that
    // nobody ever answered (the creator's copy is the one that patches)
    const logId = pendingCallLogs.get(callId)
    if (logId) {
      pendingCallLogs.delete(callId)
      const missed = !acceptedAt
      void apiClient
        .patchCallLog(conversationId, { messageId: logId, durationSec: missed ? null : durationSec ?? null, missed })
        .catch(() => {})
    }
    // a "late" end is the sidecar rejecting an accept whose call already
    // died (the ring modal outlived the call): the stage just collapsed from
    // a call that never connected, so say so instead of failing silently
    if (late && wasActive) toast({ title: 'call ended' })
  },

  onCallSignal: (payload) => {
    callEngine.handleSignal(payload as { from: string; callId: string; data: CallSignalData })
  },

  onCallTakenOver: ({ callId, conversationId }) => {
    const current = get().activeCall
    if (!current || current.callId !== callId) return
    // this tab's session was retired: the call continues where it moved to.
    // Tear down WITHOUT emitting call:hangup (the new session owns the
    // participant row now; a hangup here would drop them instead)
    sounds.stopRingLoop('callRingIn')
    sounds.stopRingLoop('callRingOut')
    sounds.play('callLeave')
    callEngine.teardown()
    const ringingAfter = { ...get().callRingingUsers }
    delete ringingAfter[callId]
    set({
      activeCall: null,
      callFullscreen: false,
      callSelf: { muted: false, deafened: false, cameraOn: false, screenOn: false, pttEnabled: pttPrefs.enabled, pttActive: false, transmitting: !pttPrefs.enabled },
      callRingingUsers: ringingAfter,
      callWhisperTarget: null,
      callWhisperedBy: null,
    })
    toast({
      title: 'call moved',
      description: 'you joined this call from another tab or device.',
    })
    void conversationId
  },

  onVoiceTakenOver: ({ channelId, newChannelId }) => {
    const vc = get().voiceConnected
    if (!vc || vc.channelId !== channelId) return
    // the mic moved to another session: leave locally without emitting
    // voice:leave (the sidecar ownership guard would ignore it anyway, but
    // staying quiet keeps the handoff clean)
    sounds.play('callLeave')
    voiceEngine.teardownMediaOnly()
    set({
      voiceConnected: null,
      voiceGuest: null,
      voiceSelf: { muted: false, deafened: false, pttEnabled: pttPrefs.enabled, pttActive: false, transmitting: !pttPrefs.enabled, recording: false, cameraOn: false, screenOn: false },
      voiceUnavailable: false,
      watchingScreens: [],
      myScreenWatchers: [],
      voiceFullscreen: false,
      callWhisperTarget: null,
    })
    toast({
      title: 'voice moved',
      description: 'you connected to voice from another tab or device.',
    })
    void newChannelId
  },

  onVoiceDropped: ({ channelId }) => {
    const vc = get().voiceConnected
    if (!vc || vc.channelId !== channelId) return
    // the sidecar dropped my GUEST session: the channel emptied or its last
    // real member left — leave quietly (the sidecar already removed my row;
    // emitting voice:leave would be ignored by the ownership guard anyway)
    sounds.play('callLeave')
    stopWatchingAllScreens(get)
    voiceEngine.teardownMediaOnly()
    set({
      voiceConnected: null,
      voiceGuest: null,
      voiceSelf: { muted: false, deafened: false, pttEnabled: pttPrefs.enabled, pttActive: false, transmitting: !pttPrefs.enabled, recording: false, cameraOn: false, screenOn: false },
      voiceUnavailable: false,
      watchingScreens: [],
      myScreenWatchers: [],
      voiceFullscreen: false,
      callWhisperTarget: null,
    })
    toast({
      title: 'voice ended',
      description: 'the channel you were a guest in emptied.',
    })
  },

  // ---- forum ----

  loadForumPosts: async (channelId, sort = 'latest') => {
    // tags ride along: the chip row + composer need them with the posts
    void get().refreshForumTags(channelId)
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

  refreshForumTags: async (channelId) => {
    try {
      const { tags } = await apiClient.forumTags(channelId)
      set((s) => ({ forumTags: { ...s.forumTags, [channelId]: tags } }))
    } catch {
      // not a member (anymore) or offline: drop the cache
      set((s) => {
        if (!s.forumTags[channelId]) return {}
        const forumTags = { ...s.forumTags }
        delete forumTags[channelId]
        return { forumTags }
      })
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
    const groupReadAt = { ...get().groupReadAt }
    for (const stamp of sync.conversationStamps) {
      otherReadAt[stamp.conversationId] = stamp.otherLastReadAt
      // sync stamps carry no kind: look the conversation up in state; unknown
      // conversations are skipped (the next refreshConversations owns them)
      if (get().conversations.find((c) => c.id === stamp.conversationId)?.kind === 'GROUP') {
        if (stamp.othersReadAt) groupReadAt[stamp.conversationId] = { ...stamp.othersReadAt }
        else delete groupReadAt[stamp.conversationId]
      }
    }
    const blockedUserIds: Record<string, boolean> = {}
    for (const id of sync.blockedUserIds) blockedUserIds[id] = true
    const mutedScopes: Record<string, boolean> = {}
    for (const scope of sync.mutedScopes) mutedScopes[scope] = true
    // mentions reconcile with the server's authoritative count: unread rooms
    // I am not subscribed to only learn about mentions through this sync
    const channelMentions: Record<string, number> = { ...sync.channelMentions }
    // live calls in my conversations (a page loaded mid-call shows the join
    // affordances immediately; broadcasts keep it fresh from here on)
    const liveCalls: Record<string, LiveCallSummary> = {}
    for (const c of sync.liveCalls ?? []) {
      liveCalls[c.conversationId] = {
        callId: c.callId,
        conversationId: c.conversationId,
        state: c.state,
        createdBy: c.createdBy,
        createdAt: c.createdAt,
        acceptedAt: c.acceptedAt ?? null,
        participants: c.participants,
      }
    }
    set({
      onlineUserIds,
      presenceStatuses: sync.presenceStatuses ?? {},
      awaySince: sync.awaySince ?? {},
      lastSeen: sync.lastSeen ?? {},
      otherReadAt,
      groupReadAt,
      channelUnread: { ...sync.channelUnread },
      channelMentions,
      blockedUserIds,
      mutedScopes,
      liveCalls,
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
      const isActive = stamp.serverId === current.activeServerId
      if (
        !local ||
        local.channels.length !== stamp.channelCount ||
        // the ACTIVE server's member list must exist at all: a session that
        // restored straight into a channel never went through selectServer,
        // so this backfill is what fills the member list on boot
        (isActive && memberCount === undefined) ||
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
                get().maybeMarkRead(room)
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
    // camera / screen are engine media flags: take them when the engine
    // reports them, otherwise keep the store's current value (the toggles
    // and the sidecar's voice:state both maintain it)
    const media = state as { cameraOn?: boolean; screenOn?: boolean }
    useChatStore.setState({
      voiceSelf: {
        ...store.voiceSelf,
        muted: state.muted,
        deafened: state.deafened,
        pttEnabled: state.pttEnabled,
        pttActive: state.pttActive,
        transmitting: state.transmitting,
        recording: state.recording,
        cameraOn: media.cameraOn ?? store.voiceSelf.cameraOn,
        screenOn: media.screenOn ?? store.voiceSelf.screenOn,
      },
      voiceUnavailable: state.unavailable,
    })
  }
})

// Read-gate flips (window refocused, user returned after an idle stretch):
// re-run the honest read check on the room they are looking at, so the
// unread badge clears the moment attention actually returns — and never
// before. Closing flips call it too; maybeMarkRead no-ops when not ready.
subscribeReadGate(() => {
  const room = activeRoomOf(useChatStore.getState())
  if (room) useChatStore.getState().maybeMarkRead(room)
})

// helpers for components

export function useActiveRoom(): string | null {
  return useChatStore((s) => (s.activeChannelId ? `channel:${s.activeChannelId}` : s.activeConversationId ? `conversation:${s.activeConversationId}` : null))
}

export function activeRoomOfState(s: { activeChannelId: string | null; activeConversationId: string | null }): string | null {
  return activeRoomOf(s)
}

export { extractMentions }
