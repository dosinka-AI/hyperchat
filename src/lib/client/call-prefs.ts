'use client'

/**
 * Call UI preferences, shared by the call surfaces (inline stage, fullscreen
 * overlay, dock) and the call engine. Same pattern as ptt-prefs / audio-prefs:
 * one mutable pref object on globalThis that survives Fast Refresh, a commit
 * function that persists to localStorage and notifies, and dependency-free
 * helpers so module-eval cycles can't form.
 *
 * - layout: how remote video tiles arrange — 'grid' (uniform tiles) or
 *   'speaker' (active speaker large, everyone else in a thumbnail rail)
 * - cameraDeviceId: preferred camera ('' = system default); the engine
 *   acquires with it and can swap live without renegotiation
 */

export type CallLayout = 'grid' | 'speaker'

export type CallPrefs = {
  layout: CallLayout
  cameraDeviceId: string
}

const STORAGE_KEY = 'hyperchat_call'

export const DEFAULT_CALL_PREFS: CallPrefs = {
  layout: 'grid',
  cameraDeviceId: '',
}

/** globalThis home: engines are globalThis singletons that keep referencing
 *  the object they were built with across module re-evaluations. */
const G = globalThis as unknown as {
  __hyperionCallPrefs?: CallPrefs
  __hyperionCallListeners?: Set<CallPrefsListener>
}

function readPrefs(): CallPrefs {
  if (typeof window === 'undefined') return { ...DEFAULT_CALL_PREFS }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_CALL_PREFS }
    const p = JSON.parse(raw) as Partial<CallPrefs>
    return {
      layout: p.layout === 'speaker' ? 'speaker' : 'grid',
      cameraDeviceId: typeof p.cameraDeviceId === 'string' ? p.cameraDeviceId : '',
    }
  } catch {
    return { ...DEFAULT_CALL_PREFS }
  }
}

/** The single shared, mutable preference object the engine and UI read from. */
export const callPrefs: CallPrefs = (G.__hyperionCallPrefs ??= readPrefs())

type CallPrefsListener = (prefs: CallPrefs) => void
const listeners: Set<CallPrefsListener> = (G.__hyperionCallListeners ??= new Set<CallPrefsListener>())

export function commitCallPrefs(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(callPrefs))
  } catch {
    // storage may be unavailable; the in-memory pref still works
  }
  for (const fn of listeners) fn(callPrefs)
}

export function onCallPrefsChanged(fn: CallPrefsListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Video tile layout preference (grid vs speaker view). */
export function setCallLayout(layout: CallLayout): void {
  if (callPrefs.layout === layout) return
  callPrefs.layout = layout
  commitCallPrefs()
}

/** Preferred camera; empty string clears back to the system default. */
export function setCameraDeviceId(deviceId: string): void {
  if (callPrefs.cameraDeviceId === deviceId) return
  callPrefs.cameraDeviceId = deviceId
  commitCallPrefs()
}

/** getUserMedia video constraints built from the current prefs. */
export function cameraVideoConstraints(): MediaTrackConstraints {
  return {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    ...(callPrefs.cameraDeviceId ? { deviceId: { exact: callPrefs.cameraDeviceId } } : {}),
  }
}
