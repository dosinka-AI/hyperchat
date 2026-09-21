import { NextResponse } from 'next/server'

const CONTROL_URL = 'http://127.0.0.1:3004/emit'
const VOICE_URL = 'http://127.0.0.1:3004/voice'
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || 'hyperion-internal-7x3n9'

/**
 * Broadcast an event to socket.io rooms through the realtime service's
 * internal control API. Fire-and-forget: message persistence must never
 * fail because the realtime service is down.
 */
export function emitToRooms(rooms: string[], event: string, payload: unknown): Promise<void> {
  return fetch(CONTROL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-token': INTERNAL_TOKEN,
    },
    body: JSON.stringify({ rooms, event, payload }),
  })
    .then(() => undefined)
    .catch((err) => {
      console.error('[realtime] emit failed:', err instanceof Error ? err.message : err)
    })
}

export function channelRoom(channelId: string): string {
  return `channel:${channelId}`
}

/**
 * Broadcast an event to EVERY connected socket through the realtime
 * service's control API ({ broadcast: true } -> io.emit). Used for profile
 * changes: any online client may hold a cached view of the changed user,
 * not just room members. Fire-and-forget like emitToRooms.
 */
export function emitToAll(event: string, payload: unknown): Promise<void> {
  return fetch(CONTROL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-token': INTERNAL_TOKEN,
    },
    body: JSON.stringify({ broadcast: true, event, payload }),
  })
    .then(() => undefined)
    .catch((err) => {
      console.error('[realtime] broadcast failed:', err instanceof Error ? err.message : err)
    })
}

export function conversationRoom(conversationId: string): string {
  return `conversation:${conversationId}`
}

/** The send-only room a cross-rung call GUEST sits in: call state, their own
 *  reduced message echoes and read receipts — never the conversation's real
 *  payloads. Call-channel space ids (`convId~room`) resolve to their base
 *  conversation, mirroring the sidecar's guest room. */
export function guestRoom(conversationId: string): string {
  return `conversation-guest:${baseConversationIdOf(conversationId)}`
}

export function userRoom(userId: string): string {
  return `user:${userId}`
}

export function serverRoom(serverId: string): string {
  return `server:${serverId}`
}

const PRESENCE_URL = 'http://127.0.0.1:3004/presence'
const CALLS_URL = 'http://127.0.0.1:3004/calls'

/** The owning conversation of a call space id: plain ids map to themselves,
 *  room space ids (`convId~room`) strip their suffix. Mirrors the client's
 *  call-space helper without the 'use client' dependency. */
function baseConversationIdOf(spaceId: string): string {
  const i = spaceId.indexOf('~')
  return i === -1 ? spaceId : spaceId.slice(0, i)
}

export type LiveCallSnapshot = {
  conversationId: string
  callId: string
  state: 'ringing' | 'active'
  createdBy: string
  createdAt: number
  acceptedAt: number | null
  participants: {
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
  }[]
}

/** Fetch the registry of live calls from the realtime service, filtered to
 *  the conversations I belong to (sidebar indicators, join buttons). Call
 *  rooms hang off a conversation at a synthetic space id (`convId~room`):
 *  those pass when the BASE conversation is mine. Best effort: [] when the
 *  sidecar is down. */
export async function fetchLiveCalls(myConversationIds: string[]): Promise<LiveCallSnapshot[]> {
  if (!myConversationIds.length) return []
  try {
    const res = await fetch(CALLS_URL, {
      headers: { 'x-internal-token': INTERNAL_TOKEN },
      cache: 'no-store',
    })
    if (!res.ok) return []
    const data = (await res.json()) as { calls?: LiveCallSnapshot[] }
    const wanted = new Set(myConversationIds)
    return (data.calls ?? []).filter(
      (c) => wanted.has(c.conversationId) || wanted.has(baseConversationIdOf(c.conversationId))
    )
  } catch {
    return []
  }
}

/** Fetch the raw voice presence list for a channel from the realtime
 *  service. Returns [] when the sidecar is down (voice is best-effort). */
export async function fetchVoiceParticipants(channelId: string): Promise<{
  userId: string
  username: string
  sessionId: string
  muted: boolean
  deafened: boolean
}[]> {
  try {
    const res = await fetch(`${VOICE_URL}?channelId=${encodeURIComponent(channelId)}`, {
      headers: { 'x-internal-token': INTERNAL_TOKEN },
      cache: 'no-store',
    })
    if (!res.ok) return []
    const data = (await res.json()) as { participants?: { userId: string; username: string; sessionId: string; muted: boolean; deafened: boolean }[] }
    return Array.isArray(data.participants) ? data.participants : []
  } catch {
    return []
  }
}

/** Fetch live presence snapshot from the realtime service. Used by the
 *  sync endpoint so presence survives even when websockets fail. */
export async function fetchOnlineUserIds(): Promise<string[]> {
  try {
    const res = await fetch(PRESENCE_URL, {
      headers: { 'x-internal-token': INTERNAL_TOKEN },
      cache: 'no-store',
    })
    if (!res.ok) return []
    const data = (await res.json()) as { onlineUserIds?: string[] }
    return Array.isArray(data.onlineUserIds) ? data.onlineUserIds : []
  } catch {
    return []
  }
}

/** Fetch per-user presence statuses (online / idle / dnd) plus idle-away
 *  timestamps and offline users' last-seen stamps, for the sync endpoint. */
export async function fetchPresenceSnapshot(): Promise<{
  statuses: Record<string, 'online' | 'idle' | 'dnd'>
  awaySince: Record<string, number>
  lastSeen: Record<string, string>
}> {
  try {
    const res = await fetch(PRESENCE_URL, {
      headers: { 'x-internal-token': INTERNAL_TOKEN },
      cache: 'no-store',
    })
    if (!res.ok) return { statuses: {}, awaySince: {}, lastSeen: {} }
    const data = (await res.json()) as {
      statuses?: Record<string, 'online' | 'idle' | 'dnd'>
      awaySince?: Record<string, number>
      lastSeen?: Record<string, string>
    }
    return {
      statuses: data.statuses && typeof data.statuses === 'object' ? data.statuses : {},
      awaySince: data.awaySince && typeof data.awaySince === 'object' ? data.awaySince : {},
      lastSeen: data.lastSeen && typeof data.lastSeen === 'object' ? data.lastSeen : {},
    }
  } catch {
    return { statuses: {}, awaySince: {}, lastSeen: {} }
  }
}

export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

export function unauthorized() {
  return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 })
}

export function forbidden(message = 'You do not have access to that.') {
  return NextResponse.json({ error: message }, { status: 403 })
}

export function notFound(message = 'Not found.') {
  return NextResponse.json({ error: message }, { status: 404 })
}

export function serverError() {
  return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
}
