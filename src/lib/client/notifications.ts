'use client'

/**
 * HyperChat desktop notification engine.
 *
 * Desktop notifications are quiet and precise: DMs and direct @mentions of
 * me only, never my own messages, never the room I am already looking at
 * while the tab is focused. The OS may play its own default sound or
 * vibrate; the app never doubles that up (the sounds engine owns audio).
 *
 * Prefs persist in localStorage and are split the same way sounds are: one
 * master toggle plus a per-category switch for 'dm' and 'mention'. Focus
 * mode suppresses notifications through the same override hook sounds use.
 */

export type NotifyCategory = 'dm' | 'mention'

export type NotifyPrefs = {
  /** master toggle */
  enabled: boolean
  dm: boolean
  mention: boolean
}

/** The minimum shape a message needs for the pure decision. The realtime
 *  handler builds one of these from a ClientMessage. */
export type NotifyMessage = {
  authorId: string
  content?: string | null
  room: string
  systemKind?: string | null
  pingsEveryone?: boolean
  /** precomputed at the call site: true when the sender is me */
  mine?: boolean
  /** sender display data for the OS notification chrome */
  authorName?: string
  authorAvatarUrl?: string | null
}

const MASTER_KEY = 'hyperchat-notifications'
const CATS_KEY = 'hyperchat-notify-cats'

type CatMap = { dm: boolean; mention: boolean }

function loadCats(): CatMap {
  const fallback: CatMap = { dm: true, mention: true }
  if (typeof window === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(CATS_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallback
    return {
      dm: parsed.dm !== false,
      mention: parsed.mention !== false,
    }
  } catch {
    return fallback
  }
}

/** Pure decision: should a desktop notification fire for this message?
 *
 *  - never when the master toggle is off, the sender is me, or the row is
 *    a system row
 *  - never for the room currently focused and visible (focusedRoom)
 *  - DM/group conversations notify under the 'dm' category; server channels
 *    only notify on a direct @mention of me (or a permitted @everyone/@here)
 *    under the 'mention' category
 */
export function shouldNotify(
  message: NotifyMessage,
  prefs: NotifyPrefs,
  focusedRoom: string | null,
  myUsername: string
): boolean {
  if (!prefs?.enabled) return false
  if (!message) return false
  if (message.mine) return false
  if (message.systemKind) return false
  if (!message.room || !myUsername) return false
  if (focusedRoom && focusedRoom === message.room) return false

  const isConversation = message.room.startsWith('conversation:')
  const mentioned = isMentioned(message.content, myUsername, message.pingsEveryone)

  if (isConversation) return prefs.dm
  return mentioned && prefs.mention
}

/** Direct @mention of me, plus permitted mass pings. Mirrors the store's
 *  mention logic so a notification never disagrees with the unread badge. */
function isMentioned(content: string | null | undefined, myUsername: string, pingsEveryone?: boolean): boolean {
  if (!content) return false
  const target = myUsername.toLowerCase()
  for (const m of content.matchAll(/@([a-z0-9_]{3,20})/gi)) {
    if (m[1].toLowerCase() === target) return true
  }
  return !!pingsEveryone && /(^|\s)@(everyone|here)(?=\s|$)/i.test(content)
}

/** Strip markup tokens from a body for the OS notification preview. Kept
 *  intentionally simple: bold/italic/underline/strike, inline code,
 *  spoilers and the rich-text color/size wrappers all dissolve into plain
 *  text. */
export function notificationPreview(content: string, max = 100): string {
  const cleaned = content
    .replace(/\[c=#?[0-9a-fA-F]{3,8}\]|\[\/c\]|\[s=\d{1,2}\]|\[\/s\]/g, '')
    .replace(/\*\*|__|~~|\|\||`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length <= max) return cleaned
  return `${cleaned.slice(0, max).trimEnd()}...`
}

class NotificationsEngine {
  /** focus mode override: when false, all notifications are suppressed */
  private enabledOverride: boolean | null = null

  isSupported(): boolean {
    return typeof window !== 'undefined' && 'Notification' in window
  }

  getPermission(): NotificationPermission | 'unsupported' {
    if (!this.isSupported()) return 'unsupported'
    return Notification.permission
  }

  requestPermission(): Promise<NotificationPermission | 'unsupported'> {
    if (!this.isSupported()) return Promise.resolve('unsupported')
    try {
      return Notification.requestPermission().then((p) => p as NotificationPermission)
    } catch {
      return Promise.resolve('denied')
    }
  }

  /** Master toggle. Default off: permission is only ever requested from the
   *  settings UI, never on boot. */
  isEnabled(): boolean {
    if (typeof window === 'undefined') return false
    if (this.enabledOverride === false) return false
    try {
      return localStorage.getItem(MASTER_KEY) === 'on'
    } catch {
      return false
    }
  }

  setEnabled(enabled: boolean): void {
    try {
      localStorage.setItem(MASTER_KEY, enabled ? 'on' : 'off')
    } catch {
      /* storage may be blocked; the toggle just will not persist */
    }
  }

  /** Focus mode mutes notifications without touching the saved pref. */
  setEnabledOverride(override: boolean | null): void {
    this.enabledOverride = override
  }

  getCategoryEnabled(cat: NotifyCategory): boolean {
    return loadCats()[cat]
  }

  setCategoryEnabled(cat: NotifyCategory, enabled: boolean): void {
    try {
      const cats = loadCats()
      cats[cat] = enabled
      localStorage.setItem(CATS_KEY, JSON.stringify(cats))
    } catch {
      /* best-effort persistence */
    }
  }

  /** Show a desktop notification for a just-arrived realtime message. Called
   *  from the socket handler only (never from sync), so historical rows can
   *  never fire a burst of notifications. */
  maybeNotify(input: {
    message: NotifyMessage
    activeRoom: string | null
    myUsername: string
    onOpen?: (room: string) => void
  }): void {
    if (!this.isSupported()) return
    if (Notification.permission !== 'granted') return

    const visible = typeof document !== 'undefined' && document.visibilityState === 'visible'
    const focusedRoom = visible ? input.activeRoom : null
    const prefs: NotifyPrefs = {
      enabled: this.isEnabled(),
      dm: this.getCategoryEnabled('dm'),
      mention: this.getCategoryEnabled('mention'),
    }

    if (!shouldNotify(input.message, prefs, focusedRoom, input.myUsername)) return
    this.show(input.message, input.onOpen)
  }

  private show(message: NotifyMessage, onOpen?: (room: string) => void): void {
    try {
      const notification = new Notification(message.authorName || 'new message', {
        body: notificationPreview(message.content ?? ''),
        // one notification per room: a newer message replaces the older one
        tag: message.room,
        icon: message.authorAvatarUrl || '/logo.png',
      })
      notification.onclick = () => {
        window.focus()
        onOpen?.(message.room)
        notification.close()
      }
    } catch {
      /* a misbehaving OS or a revoked permission must never break chat */
    }
  }
}

export const notifications = new NotificationsEngine()
