'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { sounds } from '@/lib/client/sounds'

export type ContextMenuItem =
  | { kind: 'separator' }
  | {
      kind?: 'item'
      label: string
      icon?: React.ComponentType<{ className?: string }>
      onSelect: () => void
      danger?: boolean
      disabled?: boolean
      /** small right-aligned hint, e.g. a keyboard shortcut */
      hint?: string
    }
  | {
      kind: 'label'
      label: string
    }

type OpenMenu = {
  id: number
  x: number
  y: number
  items: ContextMenuItem[]
  header?: { title: string; subtitle?: string }
}

let seq = 0
let pushMenu: ((m: Omit<OpenMenu, 'id'>) => void) | null = null

/** Open a context menu at the click point. Call from onContextMenu handlers. */
export function openContextMenu(
  e: React.MouseEvent,
  items: ContextMenuItem[],
  header?: { title: string; subtitle?: string }
) {
  e.preventDefault()
  e.stopPropagation()
  if (!pushMenu) return
  sounds.play('lightTick')
  pushMenu({ x: e.clientX, y: e.clientY, items, header })
}

export function ContextMenuHost() {
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    pushMenu = (m) => setMenu({ ...m, id: ++seq })
    return () => {
      pushMenu = null
    }
  }, [])

  // close on any outside interaction
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
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
  }, [menu])

  // measure the real rendered size and clamp it into the viewport before the
  // browser paints: tall menus (or a right-click near the bottom edge) can
  // never spill below the screen, whatever the real row heights turn out to
  // be. The estimate style is the mount-time guess; this corrects it.
  useLayoutEffect(() => {
    if (!menu) return
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = rect.width || 220
    const left = Math.max(8, Math.min(menu.x, vw - w - 8))
    let top = menu.y
    if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [menu])

  if (!menu || typeof document === 'undefined') return null

  // initial mount-time estimate from item counts; the measured layout
  // effect above corrects it before the first paint
  const estLeft = Math.max(8, Math.min(menu.x, window.innerWidth - 228))
  const estTop = Math.max(8, Math.min(menu.y, window.innerHeight - 240))

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[95] w-[220px] max-h-[calc(100vh-16px)] overflow-y-auto overflow-x-hidden scroll-thin bg-popover border border-border rounded-sm shadow-2xl py-1 menu-in"
      style={{ left: estLeft, top: estTop }}
      role="menu"
      aria-orientation="vertical"
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.header && (
        <div className="px-3 pt-1.5 pb-2 border-b border-border mb-1">
          <p className="text-[13px] font-bold truncate">{menu.header.title}</p>
          {menu.header.subtitle && (
            <p className="text-[11px] text-muted-foreground truncate">{menu.header.subtitle}</p>
          )}
        </div>
      )}
      {menu.items.map((item, i) => {
        if (item.kind === 'separator') {
          return <div key={i} className="h-px bg-border my-1 mx-2" role="separator" />
        }
        if (item.kind === 'label') {
          return (
            <p key={i} className="px-3 py-1 text-[10px] font-bold tracking-widest text-muted-foreground select-none">
              {item.label}
            </p>
          )
        }
        const Icon = item.icon
        return (
          <button
            key={i}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              setMenu(null)
              item.onSelect()
            }}
            className={cn(
              'w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors item-in',
              item.danger
                ? 'text-destructive hover:bg-destructive/10'
                : 'text-foreground/85 hover:bg-accent hover:text-foreground',
              item.disabled && 'opacity-40 pointer-events-none'
            )}
            style={{ animationDelay: `${Math.min(i * 12, 60)}ms` }}
          >
            {Icon && <Icon className="size-3.5 shrink-0 opacity-70" />}
            <span className="truncate flex-1">{item.label}</span>
            {item.hint && <span className="text-[10px] text-muted-foreground tabular-nums">{item.hint}</span>}
          </button>
        )
      })}
    </div>,
    document.body
  )
}
