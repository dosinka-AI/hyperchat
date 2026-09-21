'use client'

import { useEffect, useState } from 'react'
import { Sparkles, Waves, CircleDot, Snowflake, Monitor } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { LiquidSurface } from './LiquidSurface'
import {
  applyGlassPrefs,
  loadGlassPrefs,
  saveGlassPrefs,
  type GlassPrefs,
} from '@/lib/client/glassPrefs'
import { supportsBackdropFilterUrl } from '@/lib/liquidGlass'
import { sounds } from '@/lib/client/sounds'

/**
 * Appearance settings for the Liquid Glass material: intensity of the
 * glass chrome, the drifting aurora behind it, and a live preview tile
 * so the choice can be judged in place. Preferences persist locally
 * and apply instantly across the whole app.
 */
export function GlassSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const [prefs, setPrefs] = useState<GlassPrefs>(() => loadGlassPrefs())
  // evaluated lazily on first render; the dialog only mounts after user
  // interaction (post-hydration), so the browser check is safe here
  const [refraction] = useState(() =>
    typeof window !== 'undefined' && supportsBackdropFilterUrl()
  )

  useEffect(() => {
    if (!open) return
    sounds.play('midTick')
  }, [open])

  const update = (patch: Partial<GlassPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      saveGlassPrefs(next)
      applyGlassPrefs(next)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-white/70" />
            liquid glass
          </DialogTitle>
          <DialogDescription>
            the interface material: how strongly panels, popovers and the
            composer pick up the light behind them.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 pt-1">
          {/* material strength */}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-white/40 mb-2">
              material
            </div>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="glass material">
              <MaterialOption
                active={prefs.mode === 'full'}
                icon={<Waves className="size-4" />}
                title="full"
                caption={refraction ? 'refraction + blur' : 'blur + tint'}
                onClick={() => update({ mode: 'full' })}
              />
              <MaterialOption
                active={prefs.mode === 'soft'}
                icon={<CircleDot className="size-4" />}
                title="soft"
                caption="blur only, calmer"
                onClick={() => update({ mode: 'soft' })}
              />
              <MaterialOption
                active={prefs.mode === 'off'}
                icon={<Snowflake className="size-4" />}
                title="off"
                caption="solid surfaces"
                onClick={() => update({ mode: 'off' })}
              />
            </div>
            {!refraction && (
              <p className="mt-2 text-[11px] text-white/40 leading-relaxed">
                this browser does not expose refraction filters, so full and
                soft render the same frosted material. chrome gets the lens.
              </p>
            )}
          </div>

          {/* aurora toggle */}
          <div className="flex items-center justify-between gap-4 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3">
            <div className="flex items-start gap-3">
              <Monitor className="size-4 mt-0.5 text-white/60" />
              <div>
                <div className="text-[13px] font-medium">aurora backdrop</div>
                <div className="text-[11px] text-white/40">
                  the slow light field the glass refracts
                </div>
              </div>
            </div>
            <Switch
              checked={prefs.aurora === 'on'}
              onCheckedChange={(v) => update({ aurora: v ? 'on' : 'off' })}
              aria-label="aurora backdrop"
            />
          </div>

          {/* live preview */}
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-white/40 mb-2">
              preview
            </div>
            <div className="relative overflow-hidden rounded-xl border border-white/10 h-28">
              {/* mini aurora so the preview shows real refraction content */}
              <div
                className="absolute inset-0"
                style={{
                  background:
                    'radial-gradient(120% 140% at 20% 0%, rgba(148,163,205,0.35), transparent 55%),' +
                    'radial-gradient(90% 120% at 85% 100%, rgba(84,124,255,0.35), transparent 60%),' +
                    'linear-gradient(120deg, #16161c 0%, #050506 100%)',
                }}
              />
              <div
                className="absolute left-[52%] top-[30%] size-10 rounded-full"
                style={{
                  background: 'conic-gradient(from 20deg, #f5f5f5, #547cff, #232323, #f5f5f5)',
                }}
              />
              <LiquidSurface
                variant="float"
                className="absolute left-3 bottom-3 right-3 h-14 flex items-center gap-3 px-4"
                radius={14}
                refract={prefs.mode === 'full'}
              >
                <span className="size-2 rounded-full bg-online" aria-hidden="true" />
                <span className="text-[12px] text-white/90 font-medium">
                  glass picks up whatever sits behind it
                </span>
              </LiquidSurface>
            </div>
          </div>

          <p className="text-[11px] text-white/35 leading-relaxed">
            changes save instantly and survive reloads. the aurora pauses
            automatically when your system asks for reduced motion.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function MaterialOption({
  active,
  icon,
  title,
  caption,
  onClick,
}: {
  active: boolean
  icon: React.ReactNode
  title: string
  caption: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={() => {
        sounds.play('lightTick')
        onClick()
      }}
      className={
        'lg-chip flex flex-col items-start gap-1 px-3 py-2.5 text-left ' +
        (active ? '!bg-white/[0.12] !border-white/25' : '')
      }
    >
      <span className="flex items-center gap-1.5 text-[12px] font-semibold text-white/90">
        {icon}
        {title}
      </span>
      <span className="text-[10px] text-white/45 leading-tight">{caption}</span>
    </button>
  )
}
