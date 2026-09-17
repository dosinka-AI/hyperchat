'use client'

import { useSyncExternalStore } from 'react'

/** Client appearance settings: compact density, chat font size, motion level,
 *  clock style. Persisted in localStorage, applied to <html> as data
 *  attributes so plain CSS can pick them up without re-rendering the world. */

export type ChatFont = 'small' | 'medium' | 'large'

export type Appearance = {
  compact: boolean
  font: ChatFont
  /** false = 12-hour clock (4:17 PM), true = 24-hour (16:17) */
  clock24: boolean
  /** stillness override: kills every animation and transition app-wide */
  reducedMotion: boolean
  /** timestamp column on grouped rows, plus hover chips, stay visible */
  showTimestamps: boolean
}

const KEY = 'hyperchat-appearance'

const DEFAULTS: Appearance = {
  compact: false,
  font: 'medium',
  clock24: false,
  reducedMotion: false,
  showTimestamps: true,
}

function load(): Appearance {
  if (typeof window === 'undefined') return DEFAULTS
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw)
    return {
      compact: parsed.compact === true,
      font: parsed.font === 'small' || parsed.font === 'large' ? parsed.font : 'medium',
      clock24: parsed.clock24 === true,
      reducedMotion: parsed.reducedMotion === true,
      showTimestamps: parsed.showTimestamps !== false,
    }
  } catch {
    return DEFAULTS
  }
}

let current: Appearance = DEFAULTS
let initialized = false
const listeners = new Set<() => void>()

function ensureInit() {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  current = load()
  apply(current)
}

function apply(a: Appearance) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.compact = a.compact ? '1' : '0'
  document.documentElement.dataset.chatFont = a.font
  document.documentElement.dataset.clock = a.clock24 ? '24' : '12'
  document.documentElement.dataset.motion = a.reducedMotion ? 'off' : 'on'
  document.documentElement.dataset.timestamps = a.showTimestamps ? 'on' : 'off'
}

export function getAppearance(): Appearance {
  ensureInit()
  return current
}

export function setAppearance(next: Partial<Appearance>) {
  ensureInit()
  current = { ...current, ...next }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* best effort */
  }
  apply(current)
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void) {
  ensureInit()
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** React binding: re-renders when the appearance changes. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, getAppearance, () => DEFAULTS)
}
