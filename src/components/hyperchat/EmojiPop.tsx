'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { sounds } from '@/lib/client/sounds'
import { EmojiGrid, mostUsedEmojis, notifyEmojiMenuToggled, rememberRecent, rememberUsage } from './EmojiPicker'
import { EmojiText } from '@/lib/client/serverEmoji'

type OpenPop = { id: number; x: number; y: number; onPick: (emoji: string) => void }

let seq = 0
let pushPop: ((p: Omit<OpenPop, 'id'>) => void) | null = null

/** Open a small emoji reaction picker floating at a point on screen.
 *  Used by the message context menu ("add reaction") so right-click reacts
 *  actually react instead of whatever the old wiring did. */
export function openEmojiPop(x: number, y: number, onPick: (emoji: string) => void) {
  if (!pushPop) return
  sounds.play('lightTick')
  pushPop({ x, y, onPick })
}

/** Same thing, anchored at the last pointer event. */
export function openEmojiPopAt(e: React.MouseEvent | MouseEvent, onPick: (emoji: string) => void) {
  openEmojiPop(e.clientX, e.clientY, onPick)
}

export function EmojiPopHost() {
  const [pop, setPop] = useState<OpenPop | null>(null)
  // keep-alive: once opened, the grid stays mounted (hidden) so every later
  // pop is a reposition + visibility flip instead of a ~600-button mount
  const [everOpened, setEverOpened] = useState(false)
  const [prewarmed, setPrewarmed] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    pushPop = (p) => {
      setEverOpened(true)
      setPop({ ...p, id: ++seq })
    }
    return () => {
      pushPop = null
    }
  }, [])

  // idle pre-warm after first use: the full grid mounts in the background,
  // so the next pop opens without any mount jank
  useEffect(() => {
    if (!everOpened || prewarmed) return
    const idle = (cb: () => void) =>
      'requestIdleCallback' in window ? window.requestIdleCallback(cb, { timeout: 1500 }) : setTimeout(cb, 400)
    const t = idle(() => setPrewarmed(true))
    return () => {
      if ('cancelIdleCallback' in window) window.cancelIdleCallback(t as number)
    }
  }, [everOpened, prewarmed])

  // close on any outside interaction
  useEffect(() => {
    if (!pop) return
    const close = () => setPop(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPop(null)
    }
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    document.addEventListener('pointerdown', (e) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }, { capture: true })
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [pop])

  const W = 424
  const H = 424

  // portal is client-only: Next.js still server-renders client components,
  // and createPortal needs a real document
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // the menu toggled signal lets the QuickRow re-rank on open/close
  useEffect(() => {
    if (pop) notifyEmojiMenuToggled()
    return () => {
      if (pop) notifyEmojiMenuToggled()
    }
  }, [pop ? pop.id : 0])

  if (!mounted) return null

  const left = pop ? Math.max(8, Math.min(pop.x - 40, window.innerWidth - W - 8)) : 8
  const top = pop ? Math.max(8, Math.min(pop.y - 60, window.innerHeight - H - 8)) : 8

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[96] glass-raise border border-border rounded-sm shadow-2xl overflow-hidden menu-in"
      style={{ left, top, visibility: pop ? 'visible' : 'hidden' }}
      role="dialog"
      aria-label="pick a reaction"
      onContextMenu={(e) => e.preventDefault()}
    >
      {everOpened && (
        <>
          <QuickRow onPick={(emoji) => { finish(emoji) }} />
          <EmojiGrid onPick={(emoji) => { finish(emoji) }} prewarm={prewarmed} />
        </>
      )}
    </div>,
    document.body
  )

  function finish(emoji: string) {
    rememberRecent(emoji)
    rememberUsage(emoji)
    pop?.onPick(emoji)
    setPop(null)
  }
}

/** The one-tap row above the full grid: your most-used reactions. Re-ranks
 *  only when an emoji menu opens or closes, not on every pick. */
function QuickRow({ onPick }: { onPick: (emoji: string) => void }) {
  const [emojis, setEmojis] = useState<string[]>(() => mostUsedEmojis(6))
  useEffect(() => {
    const onMenu = () => setEmojis(mostUsedEmojis(6))
    window.addEventListener('hyperchat-emoji-menu', onMenu)
    return () => window.removeEventListener('hyperchat-emoji-menu', onMenu)
  }, [])
  return (
    <div className="flex gap-0.5 items-center px-1.5 pt-1.5 pb-1 border-b border-white/[0.06]">
      {emojis.map((emoji) => (
        <button
          key={emoji}
          onClick={() => onPick(emoji)}
          className="size-8 max-[480px]:size-10 grid place-items-center rounded-sm text-lg leading-none hover:bg-accent transition-colors"
          aria-label={`react ${emoji}`}
          title={`react ${emoji}`}
        >
          <EmojiText emoji={emoji} />
        </button>
      ))}
    </div>
  )
}
