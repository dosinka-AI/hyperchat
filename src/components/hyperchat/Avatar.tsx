'use client'

import { cn } from '@/lib/utils'
import { initialsOf } from '@/lib/client/format'

type AvatarProps = {
  name: string
  color?: string
  url?: string | null
  size?: 'sm' | 'md' | 'lg' | 'mx' | 'xl' | '2xl'
  /** full presence: online (green), idle (yellow), busy (blue clock), dnd (red), offline (gray) */
  status?: 'online' | 'idle' | 'busy' | 'dnd' | 'offline'
  online?: boolean | null
  showDot?: boolean
  className?: string
  onClick?: (e: React.MouseEvent) => void
}

const SIZES = {
  sm: 'size-6 text-[10px]',
  md: 'size-8 text-xs',
  lg: 'size-10 text-sm',
  mx: 'size-14 text-base',
  xl: 'size-20 text-2xl',
  '2xl': 'size-28 text-4xl',
}

const DOT_SIZES = {
  sm: 'size-2.5',
  md: 'size-3.5',
  lg: 'size-4',
  mx: 'size-4.5',
  xl: 'size-6',
  '2xl': 'size-7',
}

/** Grayscale backgrounds need readable text: dark letters on light tones,
 *  light letters on dark tones. */
function textToneFor(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return 'text-black/80'
  const v = parseInt(m[1].slice(0, 2), 16) * 0.299 + parseInt(m[1].slice(2, 4), 16) * 0.587 + parseInt(m[1].slice(4, 6), 16) * 0.114
  return v > 140 ? 'text-black/80' : 'text-white/90'
}

/** The presence dot. dnd gets a horizontal notch, idle a crescent cut,
 *  busy a tiny clock face, online breathes slowly, offline sits quiet and gray. */
function StatusDot({ status, size }: { status: 'online' | 'idle' | 'busy' | 'dnd' | 'offline'; size: keyof typeof DOT_SIZES }) {
  return (
    <span
      className={cn(
        DOT_SIZES[size],
        'absolute -bottom-0.5 -right-0.5 grid place-items-center rounded-full ring-[3.5px] ring-black/90 transition-colors status-dot',
        status === 'online' && 'status-breathe',
        status === 'busy' && 'busy-breathe'
      )}
      data-status={status}
      role="status"
      aria-label={status === 'busy' ? 'busy' : status}
    >
      {status === 'dnd' ? (
        // red dot with a dark dash through it
        <>
          <span className="absolute inset-0 rounded-full bg-dnd" />
          <span className="relative w-[55%] h-[2px] rounded-full bg-app-sidebar" />
        </>
      ) : status === 'idle' ? (
        // yellow dot with a bite taken out of the corner: a crescent
        <>
          <span className="absolute inset-0 rounded-full bg-idle" />
          <span className="absolute -top-[30%] -right-[25%] w-[70%] h-[70%] rounded-full bg-app-sidebar" />
        </>
      ) : status === 'busy' ? (
        // blue dot with clock hands reading 12:15
        <>
          <span className="absolute inset-0 rounded-full bg-busy" />
          <span className="absolute left-1/2 bottom-1/2 w-[1.5px] h-[32%] -translate-x-1/2 bg-white/95 rounded-full" />
          <span className="absolute top-1/2 left-1/2 w-[32%] h-[1.5px] -translate-y-1/2 bg-white/95 rounded-full" />
        </>
      ) : (
        <span
          className={cn(
            'absolute inset-0 rounded-full',
            status === 'online' && 'bg-online',
            status === 'offline' && 'bg-offline'
          )}
        />
      )}
    </span>
  )
}

export function Avatar({
  name,
  color = '#2e2e2e',
  url,
  size = 'md',
  online,
  status,
  showDot,
  className,
  onClick,
}: AvatarProps) {
  const effective: 'online' | 'idle' | 'busy' | 'dnd' | 'offline' =
    status ?? (online ? 'online' : 'offline')
  const inner = url ? (
    <img
      src={url}
      alt=""
      className={cn(SIZES[size], 'rounded-full object-cover select-none')}
      draggable={false}
    />
  ) : (
    <div
      className={cn(SIZES[size], 'rounded-full grid place-items-center font-semibold select-none', textToneFor(color))}
      style={{ backgroundColor: color }}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </div>
  )

  return (
    <div
      className={cn('relative shrink-0', onClick && 'cursor-pointer', className)}
      onClick={onClick ? (e) => onClick(e) : undefined}
      role={onClick ? 'button' : undefined}
      aria-hidden={onClick ? undefined : true}
    >
      {inner}
      {showDot && <StatusDot status={effective} size={size} />}
    </div>
  )
}
