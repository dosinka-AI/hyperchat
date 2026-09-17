'use client'

/**
 * One long-lived <video> element per media source, moved imperatively
 * between containers (the inline embed in a message row <-> the floating
 * mini player) so playback NEVER restarts when the visible surface changes.
 *
 * React never owns these nodes. Every surface renders a plain <div>
 * container and calls attach/detach in an effect; appendChild moves the
 * single element between parents without resetting currentTime, and a
 * parked (detached) element keeps its state in an offscreen lot so it can
 * be re-attached later. A tiny pub/sub mirrors play/pause/ended/time state
 * so React controls can render without owning the element.
 */

export type MediaHostState = {
  paused: boolean
  ended: boolean
  ready: boolean
  /** current playback head in seconds (fractional, live) */
  time: number
  /** media duration in seconds once known (NaN before metadata) */
  duration: number
  /** how many seconds are downloaded (buffered end) */
  buffered: number
  muted: boolean
  volume: number
}

type Host = {
  el: HTMLVideoElement
  listeners: Set<(s: MediaHostState) => void>
  state: MediaHostState
}

const hosts = new Map<string, Host>()

/** Offscreen lot where detached elements park: keeps them referenced (no
 *  GC -> no state loss) and out of layout. A parked element that is still
 *  playing keeps producing audio, which is exactly what we want between
 *  surface swaps. */
let parking: HTMLDivElement | null = null
function parkingLot(): HTMLDivElement {
  if (!parking) {
    parking = document.createElement('div')
    parking.setAttribute('data-media-parking', '')
    parking.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none'
    document.body.appendChild(parking)
  }
  return parking
}

function read(el: HTMLVideoElement): MediaHostState {
  return {
    paused: el.paused,
    ended: el.ended,
    ready: el.readyState >= 1,
    time: el.currentTime,
    duration: el.duration,
    buffered: el.buffered.length > 0 ? el.buffered.end(el.buffered.length - 1) : 0,
    muted: el.muted,
    volume: el.volume,
  }
}

function emit(host: Host) {
  host.state = read(host.el)
  for (const cb of host.listeners) {
    try {
      cb(host.state)
    } catch {
      // a dead listener must never break the others
    }
  }
}

/** The host element for a source key, created on first use. The key is the
 *  media url; the src is applied once and never re-applied. */
export function getMediaHost(key: string, src: string): HTMLVideoElement {
  let host = hosts.get(key)
  if (host) {
    if (host.el.src === '' ) host.el.src = src
    return host.el
  }
  const el = document.createElement('video')
  el.playsInline = true
  el.preload = 'metadata'
  el.src = src
  el.setAttribute('data-media-host', key)
  host = { el, listeners: new Set(), state: read(el) }
  hosts.set(key, host)
  const refresh = () => emit(host!)
  for (const ev of [
    'play',
    'playing',
    'pause',
    'ended',
    'loadedmetadata',
    'durationchange',
    'volumechange',
    'timeupdate',
    'progress',
  ] as const) {
    el.addEventListener(ev, refresh)
  }
  return el
}

/** Whether a host exists for this key yet (no element gets created just by
 *  asking). */
export function hasMediaHost(key: string): boolean {
  return hosts.has(key)
}

/** Subscribe to this source's playback state. Fires on every play/pause/
 *  timeupdate/volume event with a fresh snapshot. Returns an unsubscribe. */
export function subscribeMediaHost(key: string, cb: (s: MediaHostState) => void): () => void {
  const host = hosts.get(key)
  if (!host) return () => undefined
  host.listeners.add(cb)
  cb(host.state)
  return () => host.listeners.delete(cb)
}

/** Move the host element into a container (appendChild moves it out of any
 *  previous parent). Container null parks it. Safe to call repeatedly. */
export function attachMediaHost(key: string, container: HTMLElement | null): void {
  const host = hosts.get(key)
  if (!host) return
  if (container) {
    if (host.el.parentNode !== container) container.appendChild(host.el)
  } else if (host.el.parentNode && host.el.parentNode !== parkingLot()) {
    parkingLot().appendChild(host.el)
  }
}

/** Detach ONLY when the element still sits in this container: if another
 *  surface attached first, its ownership stands (React cleanup order across
 *  sibling subtrees is not something to fight over). */
export function detachMediaHost(key: string, container: HTMLElement): void {
  const host = hosts.get(key)
  if (!host || host.el.parentNode !== container) return
  parkingLot().appendChild(host.el)
}

/** Full teardown: stops playback, drops the element and its listeners.
 *  Called when the media player closes or the source is replaced. */
export function destroyMediaHost(key: string): void {
  const host = hosts.get(key)
  if (!host) return
  try {
    host.el.pause()
  } catch {
    // already dead
  }
  host.el.removeAttribute('src')
  host.el.load()
  host.el.remove()
  host.listeners.clear()
  hosts.delete(key)
}

/** imperatively play (user gesture surfaces call this through the host
 *  element itself; kept here so callers never touch the DOM directly) */
export function playMediaHost(key: string): void {
  const el = hosts.get(key)?.el
  if (!el) return
  if (el.ended) el.currentTime = 0
  void el.play().catch(() => {
    // autoplay policy: the surface shows the paused controls, the user
    // taps play themselves
  })
}

export function pauseMediaHost(key: string): void {
  hosts.get(key)?.el.pause()
}
