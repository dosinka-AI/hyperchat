/** Live YouTube embed registry: tracks which click-to-load embeds are
 *  currently playing, their last known playback time and player state
 *  (polled through the iframe's enablejsapi postMessage channel). The store
 *  consults it when switching rooms so a playing video can carry into the
 *  portable player instead of dying with the unmounting message row, and
 *  the custom control bars subscribe to it for time / play-pause state.
 *
 *  "Parking": when a surface unmounts while the video is PAUSED, the entry
 *  survives with a null iframe so its lastTime stays readable — the inline
 *  card that re-mounts later resumes at exactly that second. Entries whose
 *  video was playing or ended when their surface went away are dropped. */

export type YtSnapshot = {
  /** last polled currentTime in whole seconds */
  time: number
  /** yt playerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued */
  playerState: number
  /** last known duration in seconds (0 until the first poll answers) */
  duration: number
}

export type YtEmbed = {
  videoId: string
  iframe: HTMLIFrameElement | null
  /** last polled currentTime in whole seconds */
  lastTime: number
  startedAt: number
  /** last polled yt playerState: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering */
  playerState: number
  /** last known duration in seconds */
  duration: number
  listeners: Set<(s: YtSnapshot) => void>
}

const embeds = new Map<string, YtEmbed>()
/** subscribers that arrived before the embed was ever tracked; they get
 *  wired up the moment trackYouTubeEmbed creates the entry */
const pendingListeners = new Map<string, Set<(s: YtSnapshot) => void>>()
let listenerInstalled = false
let pollTimer: ReturnType<typeof setInterval> | null = null

function snapshotOf(e: YtEmbed): YtSnapshot {
  return { time: e.lastTime, playerState: e.playerState, duration: e.duration }
}

function emit(e: YtEmbed) {
  const snap = snapshotOf(e)
  for (const cb of e.listeners) {
    try {
      cb(snap)
    } catch {
      // a dead listener must never break the others
    }
  }
}

/** Parse infoDelivery responses from any tracked embed and refresh its
 *  lastTime / state / duration. One window listener serves every embed.
 *  The widget API answers with JSON *strings*, not objects: parse first. */
function ensureListener() {
  if (listenerInstalled) return
  listenerInstalled = true
  window.addEventListener('message', (ev: MessageEvent) => {
    let data = ev.data as unknown
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      } catch {
        return
      }
    }
    if (!data || typeof data !== 'object' || (data as { event?: unknown }).event !== 'infoDelivery') return
    const src = ev.source as unknown
    for (const e of embeds.values()) {
      if (e.iframe && e.iframe.contentWindow === src) {
        const t = (data as { info?: { currentTime?: unknown } }).info?.currentTime
        if (typeof t === 'number' && Number.isFinite(t)) e.lastTime = Math.max(0, Math.floor(t))
        const state = (data as { info?: { playerState?: unknown } }).info?.playerState
        if (typeof state === 'number') e.playerState = state
        const d = (data as { info?: { duration?: unknown } }).info?.duration
        if (typeof d === 'number' && Number.isFinite(d) && d > 0) e.duration = d
        emit(e)
      }
    }
  })
}

/** Ask every tracked iframe for its time; responses land in the listener. */
function ensurePolling() {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    if (embeds.size === 0) return
    for (const e of embeds.values()) {
      const w = e.iframe?.contentWindow
      if (!w) continue
      try {
        w.postMessage(JSON.stringify({ event: 'command', func: 'getCurrentTime', args: [], channel: 'widget' }), '*')
        w.postMessage(JSON.stringify({ event: 'command', func: 'getPlayerState', args: [], channel: 'widget' }), '*')
        w.postMessage(JSON.stringify({ event: 'command', func: 'getDuration', args: [], channel: 'widget' }), '*')
      } catch {
        // cross-origin hiccup: the next tick retries
      }
    }
  }, 1000)
}

/** The widget channel only answers command polls after a listening
 * handshake from the parent window (and, on cross-origin pages, an origin
 * param on the embed url). Without this the iframe stays silent and every
 * snapshot is a stale default. Safe to send repeatedly. */
function wakeWidgetChannel(iframe: HTMLIFrameElement | null) {
  const w = iframe?.contentWindow
  if (!w) return
  try {
    w.postMessage(JSON.stringify({ event: 'listening', id: Date.now() % 100000, channel: 'widget' }), '*')
  } catch {
    // ignore
  }
}

function wirePending(e: YtEmbed) {
  const pending = pendingListeners.get(e.videoId)
  if (!pending) return
  pendingListeners.delete(e.videoId)
  const snap = snapshotOf(e)
  for (const cb of pending) {
    e.listeners.add(cb)
    try {
      cb(snap)
    } catch {
      // a dead listener must never break the others
    }
  }
}

export function trackYouTubeEmbed(videoId: string, iframe: HTMLIFrameElement | null) {
  ensureListener()
  ensurePolling()
  const existing = embeds.get(videoId)
  if (existing) {
    // a null iframe never orphans a live one (a hidden surface must not
    // steal the element another surface is playing through)
    if (iframe || !existing.iframe) existing.iframe = iframe
    if (iframe) wakeWidgetChannel(iframe)
    wirePending(existing)
    return
  }
  const entry: YtEmbed = {
    videoId,
    iframe,
    lastTime: 0,
    startedAt: Date.now(),
    playerState: 1,
    duration: 0,
    listeners: new Set(),
  }
  embeds.set(videoId, entry)
  wirePending(entry)
}

export function untrackYouTubeEmbed(videoId: string, iframe?: HTMLIFrameElement | null) {
  // ownership guard: only drop the entry when it still points at the iframe
  // being untracked (or none was given). The panel and an inline embed can
  // hand the same video id back and forth; a stale cleanup from one must
  // never delete the other's registration.
  const entry = embeds.get(videoId)
  if (!entry) return
  if (iframe !== undefined && entry.iframe !== iframe) return
  embeds.delete(videoId)
}

/** The polite unmount for a surface that showed a YouTube embed: a PAUSED
 *  video parks (iframe released, lastTime kept) so the next surface resumes
 *  at the same second; anything else (playing, ended, cued) is forgotten. */
export function releaseYouTubeEmbed(videoId: string, iframe: HTMLIFrameElement | null) {
  const entry = embeds.get(videoId)
  if (!entry) return
  if (entry.iframe !== iframe) return
  if (entry.playerState === 2) {
    entry.iframe = null
    return
  }
  embeds.delete(videoId)
}

/** The freshest time we have for an embed (parked entries included). */
export function youTubeTimeOf(videoId: string): number {
  return embeds.get(videoId)?.lastTime ?? 0
}

/** Live snapshot for controls/gating (parked entries answer their last
 *  known state; never null once the video has ever been tracked). */
export function youTubeSnapshotOf(videoId: string): YtSnapshot | null {
  const e = embeds.get(videoId)
  return e ? snapshotOf(e) : null
}

/** React-friendly subscription to an embed's playback state. Fires on every
 *  poll response (and immediately once the video is tracked). Subscribing
 *  before the first track is fine: the listener is wired when that happens.
 *  Returns an unsubscribe. */
export function subscribeYouTubeState(videoId: string, cb: (s: YtSnapshot) => void): () => void {
  const e = embeds.get(videoId)
  if (e) {
    e.listeners.add(cb)
    cb(snapshotOf(e))
    return () => {
      e.listeners.delete(cb)
    }
  }
  let set = pendingListeners.get(videoId)
  if (!set) {
    set = new Set()
    pendingListeners.set(videoId, set)
  }
  set.add(cb)
  return () => {
    set.delete(cb)
    if (set.size === 0) pendingListeners.delete(videoId)
  }
}

/** Room switch: hand the most recently started playing embed over to the
 *  portable player. Returns null when nothing is worth carrying. */
export function carryYouTubeEmbed(): { videoId: string; time: number } | null {
  let best: YtEmbed | null = null
  for (const e of embeds.values()) {
    // 1 = playing, 3 = buffering; ended (0), paused (2) and parked rows do
    // not carry — a paused video has no live surface to keep alive
    if ((e.playerState === 1 || e.playerState === 3) && e.iframe) {
      if (!best || e.startedAt > best.startedAt) best = e
    }
  }
  if (!best) return null
  const out = { videoId: best.videoId, time: best.lastTime }
  embeds.delete(best.videoId)
  return out
}

/** Send a command (playVideo / pauseVideo / seekTo / mute / setVolume...)
 *  to an iframe. Optional args pass through verbatim. */
export function youTubeCommand(iframe: HTMLIFrameElement | null, func: string, args: unknown[] = []) {
  const w = iframe?.contentWindow
  if (!w) return
  try {
    w.postMessage(JSON.stringify({ event: 'command', func, args, channel: 'widget' }), '*')
  } catch {
    // ignore
  }
}
