import { isToday, isYesterday, format } from 'date-fns'

/** Read the 24h clock preference without an import cycle into the store. */
function clockIs24h(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.dataset.clock === '24'
}

export function messageTimestamp(iso: string): string {
  const dt = new Date(iso)
  if (clockIs24h()) {
    if (isToday(dt)) return `today at ${format(dt, 'HH:mm')}`
    if (isYesterday(dt)) return `yesterday at ${format(dt, 'HH:mm')}`
    return format(dt, 'MMM d, yyyy HH:mm')
  }
  if (isToday(dt)) return `today at ${format(dt, 'h:mm a')}`
  if (isYesterday(dt)) return `yesterday at ${format(dt, 'h:mm a')}`
  return format(dt, 'MMM d, yyyy h:mm a')
}

export function dayDivider(iso: string): string {
  const dt = new Date(iso)
  if (isToday(dt)) return 'today'
  if (isYesterday(dt)) return 'yesterday'
  return format(dt, 'MMMM d, yyyy')
}

export function shortTime(iso: string): string {
  return format(new Date(iso), clockIs24h() ? 'HH:mm' : 'h:mm a')
}

export function relativeTime(iso: string): string {
  const dt = new Date(iso)
  const diff = Date.now() - dt.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return format(dt, 'MMM d')
}

/** Label for a user's last-seen stamp: "just now", "5m ago", "2h ago",
 *  "3d ago", then the calendar day. Compose it as "last online {label}". */
export function lastOnlineLabel(iso: string): string {
  const dt = new Date(iso)
  if (Number.isNaN(dt.getTime())) return ''
  const diff = Date.now() - dt.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return format(dt, 'MMM d').toLowerCase()
}

export function formatJoinDate(iso: string): string {
  try {
    return format(new Date(iso), 'MMMM yyyy')
  } catch {
    return ''
  }
}

export function formatBytes(bytes: number): string {
  const GB = 1024 * 1024 * 1024
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Humanized time left until a stamp: "45s", "12m", "2h", "3d", "30d" —
 * floors to the largest unit that still has at least one of it. Powers the
 * vault file-card countdowns; pass `now` to stay in step with a ticking
 * clock instead of reading Date.now() twice. Days count like a day counter
 * (ceil: a fresh 30-day tier reads "30d", not "29d"). */
export function formatRemaining(expiresAt: string | number | Date, now: number = Date.now()): string {
  const left = new Date(expiresAt).getTime() - now
  if (!Number.isFinite(left)) return ''
  if (left <= 0) return 'expired'
  const s = Math.max(1, Math.floor(left / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.ceil(left / 86400000)}d`
}

/** Deterministic grayscale tone for a name, used for server icons and fallback avatars.
 *  Hyperion is monochrome: identity color comes from profile pictures, not hue wheels. */
const GRAYSCALE = ['#f0f0f0', '#c9c9c9', '#a3a3a3', '#7d7d7d', '#616161', '#4a4a4a', '#3a3a3a', '#2c2c2c', '#222222', '#e0e0e0']

export function colorForName(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0
  }
  return GRAYSCALE[Math.abs(h) % GRAYSCALE.length]
}

export function initialsOf(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, '')
  if (!clean) return '?'
  if (clean.length <= 2) return clean.toUpperCase()
  return clean.slice(0, 2).toUpperCase()
}
