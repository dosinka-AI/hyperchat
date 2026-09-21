'use client';

/**
 * Liquid Glass user preferences.
 * Persisted in localStorage, applied as data attributes on <html>:
 *   data-glass="full|soft|off"   material mode (refraction needs full)
 *   data-aurora="on|off"         drifting aurora backdrop
 * glass.css consumes the attributes; LiquidSurface checks them too.
 */

export type GlassMode = 'full' | 'soft' | 'off';
export type AuroraMode = 'on' | 'off';

export type GlassPrefs = {
  mode: GlassMode;
  aurora: AuroraMode;
};

const KEY = 'hyperchat.glass.v1';

const DEFAULTS: GlassPrefs = { mode: 'full', aurora: 'on' };

export function loadGlassPrefs(): GlassPrefs {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<GlassPrefs>;
    return {
      mode: parsed.mode === 'soft' || parsed.mode === 'off' ? parsed.mode : 'full',
      aurora: parsed.aurora === 'off' ? 'off' : 'on',
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveGlassPrefs(prefs: GlassPrefs) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* private mode etc: prefs just won't persist */
  }
}

export function applyGlassPrefs(prefs: GlassPrefs) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.glass = prefs.mode;
  root.dataset.aurora = prefs.aurora;
}

/** Boot helper: read once, apply, return for first paint. */
export function bootGlassPrefs(): GlassPrefs {
  const prefs = loadGlassPrefs();
  applyGlassPrefs(prefs);
  return prefs;
}
