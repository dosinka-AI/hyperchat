'use client'

import type { Transition, Variants } from 'framer-motion'

/** ================================================================
 *  HYPERION FLUID — spring physics tokens (framer-motion layer)
 *  ----------------------------------------------------------------
 *  iOS motion is a damped harmonic oscillator: m·x'' + c·x' + k·x = 0.
 *  Everything below is derived from the two numbers that matter:
 *
 *    ω₀ = √(k/m)      natural angular frequency (how FAST it travels)
 *    ζ  = c/(2√(k·m)) damping ratio (how it SETTLES)
 *
 *  ζ = 1      critically damped — settles with zero overshoot (sheets,
 *             modals: the "expensive" feel)
 *  ζ ≈ 0.8    one small heartbeat of overshoot ~3% (badges, pills)
 *
 *  framer takes { stiffness: k, damping: c, mass: m }. With mass = 1:
 *    k = ω₀²            c = 2·ζ·ω₀
 *
 *  The constants below were picked from those curves at the perceived
 *  durations Apple ships (~120ms presses, ~350ms sheets).
 *  ================================================================ */

const m = 1

/** ω₀ ≈ 16.1 rad/s, ζ = 1.0 — dialogs and sheets. ~350ms settle. */
export const springSheet: Transition = { type: 'spring', stiffness: 260, damping: 32, mass: m }

/** ω₀ ≈ 20.5 rad/s, ζ = 0.93 — popovers, menus, toasts. ~270ms, nearly critical. */
export const springPopover: Transition = { type: 'spring', stiffness: 420, damping: 38, mass: m }

/** ω₀ ≈ 22.8 rad/s, ζ = 1.0 — toggles, chips, small surfaces. ~240ms. */
export const springSnappy: Transition = { type: 'spring', stiffness: 520, damping: 46, mass: m }

/** ω₀ ≈ 26.5 rad/s, ζ = 0.98 — icon presses. ~120ms, feels immediate. */
export const springPress: Transition = { type: 'spring', stiffness: 700, damping: 52, mass: m }

/** ω₀ ≈ 13 rad/s, ζ = 1.0 — large content fades, view switches. ~460ms. */
export const springGentle: Transition = { type: 'spring', stiffness: 170, damping: 26, mass: m }

/** ω₀ ≈ 18.2 rad/s, ζ ≈ 0.82 — the badge heartbeat (3% overshoot). */
export const springBadge: Transition = { type: 'spring', stiffness: 330, damping: 30, mass: m }

/** Icon affordances: hover lifts (1.05 = iOS springboard wobble, toned
 *  down), press squishes to 0.9 like touching a physical key. */
export const iconHoverTap = {
  whileHover: { scale: 1.06 },
  whileTap: { scale: 0.9 },
  transition: springPress,
} as const

/** Channel / conversation view switch: rise-in with the gentle spring. */
export const viewVariants: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: springGentle },
  exit: { opacity: 0, y: -4, transition: { duration: 0.12, ease: [0.4, 0, 0.9, 0.6] } },
}

/** A tile joining a voice room: scale+fade arrival. */
export const tileVariants: Variants = {
  hidden: { opacity: 0, scale: 0.92 },
  show: { opacity: 1, scale: 1, transition: springPopover },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.14, ease: [0.4, 0, 0.9, 0.6] } },
}
