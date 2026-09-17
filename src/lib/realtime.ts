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

export function userRoom(userId: string): string {
  return `user:${userId}`
}

export function serverRoom(serverId: string): string {
  return `server:${serverId}`
}

const PRESENCE_URL = 'http://127.0.0.1:3004/presence'

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
