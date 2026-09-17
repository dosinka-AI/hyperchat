'use client'

/** Full-screen confetti burst. Pieces are plain DOM elements driven by the
 *  .confetti-piece keyframes in globals.css (reduced-motion turns them off
 *  at the CSS level, so this stays a pure spawn call). */

const COLORS = [
  '#ff5f56',
  '#ff8f3f',
  '#ffc23e',
  '#9dde3b',
  '#3ddc84',
  '#3fd8c8',
  '#45c4ff',
  '#7a9dff',
  '#a78bfa',
  '#d16ba5',
  '#ff5f8f',
]

/** Spawn ~120 pieces from the top edge with randomized horizontal drift,
 *  spin, delay and fall duration; every element removes itself on end. */
export function burstConfetti(): void {
  if (typeof document === 'undefined') return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  if (document.documentElement.dataset.motion === 'off') return

  const COUNT = 120
  const frag = document.createDocumentFragment()
  const cleanups: (() => void)[] = []

  for (let i = 0; i < COUNT; i++) {
    const el = document.createElement('span')
    el.className = 'confetti-piece'
    el.style.left = `${Math.random() * 100}%`
    el.style.background = COLORS[Math.floor(Math.random() * COLORS.length)]
    el.style.setProperty('--cx', `${Math.round((Math.random() - 0.5) * 260)}px`)
    el.style.setProperty('--cr', `${Math.round(360 + Math.random() * 720)}deg`)
    el.style.setProperty('--cd', `${(2.4 + Math.random() * 2.2).toFixed(2)}s`)
    el.style.setProperty('--cdel', `${(Math.random() * 0.35).toFixed(2)}s`)
    if (Math.random() < 0.35) {
      // every third piece is a wider ribbon
      el.style.width = '5px'
      el.style.height = '18px'
      el.style.borderRadius = '2px'
    }
    frag.appendChild(el)
    const remove = () => el.remove()
    el.addEventListener('animationend', remove)
    cleanups.push(remove)
  }

  document.body.appendChild(frag)
  // hard cap so a stuck animation can never leak pieces
  window.setTimeout(() => {
    for (const fn of cleanups) fn()
  }, 6500)
}
