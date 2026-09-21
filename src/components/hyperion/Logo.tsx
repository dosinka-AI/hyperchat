import { cn } from '@/lib/utils'

/** The official Hyperion mark: the white italic H on black. */
export function HyperionMark({ className }: { className?: string }) {
  return (
     
    <img
      src="/logo.png"
      alt=""
      aria-hidden="true"
      className={cn('object-contain select-none pointer-events-none', className)}
      draggable={false}
    />
  )
}

export function HyperionWordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-extrabold italic tracking-tight text-foreground', className)}>
      HYPERION
    </span>
  )
}
