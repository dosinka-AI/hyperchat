'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { sounds } from '@/lib/client/sounds'
import { Check, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'

type CropMode = 'avatar' | 'banner'

const OUTPUT = {
  avatar: { w: 512, h: 512 },
  banner: { w: 1200, h: 300 },
} as const

const ZOOM_MIN = 1
const ZOOM_MAX = 4

/** Align + crop tool for the profile picture (square) and the banner image
 *  (wide). The image always covers the frame first (no letterboxing, no
 *  giant offscreen bitmaps), then drag pans and the wheel/slider zoom in —
 *  the zoom keeps the point under your cursor pinned, like every crop tool
 *  you have ever used. */
export function CropDialog({
  open,
  file,
  mode,
  onApply,
  onClose,
}: {
  open: boolean
  file: File | null
  mode: CropMode
  onApply: (blob: Blob) => void
  onClose: () => void
}) {
  if (!open || !file) return null
  return <CropDialogInner key={file.name + file.size} file={file} mode={mode} onApply={onApply} onClose={onClose} />
}

function CropDialogInner({
  file,
  mode,
  onApply,
  onClose,
}: {
  file: File
  mode: CropMode
  onApply: (blob: Blob) => void
  onClose: () => void
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  // frame size lives in state (not a ref read during render) so the drawn
  // image size can be computed for the style attribute without lint trouble
  const [frameSize, setFrameSize] = useState(() =>
    mode === 'avatar' ? { w: 280, h: 280 } : { w: 416, h: 104 }
  )
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => setImage(img)
    img.src = url
    return () => URL.revokeObjectURL(url)
  }, [file])

  // keep the frame measurement honest across dialog sizing
  useEffect(() => {
    const el = frameRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      setFrameSize({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /** Scale that makes the natural image just cover the frame: the zoom-1
   *  baseline. Everything (pan bounds, wheel math, export) multiplies it. */
  const baseScale = useCallback(() => {
    if (!image || frameSize.w === 0) return 1
    return Math.max(frameSize.w / image.width, frameSize.h / image.height)
  }, [image, frameSize])

  const drawnSize = useCallback(
    (z: number) => {
      if (!image) return { w: 0, h: 0 }
      const b = baseScale()
      return { w: image.width * b * z, h: image.height * b * z }
    },
    [image, baseScale]
  )

  // clamp pan so the frame always stays covered
  const clampOffset = useCallback(
    (ox: number, oy: number, z: number) => {
      if (!image) return { x: 0, y: 0 }
      const { w: dw, h: dh } = drawnSize(z)
      const maxX = Math.max(0, (dw - frameSize.w) / 2)
      const maxY = Math.max(0, (dh - frameSize.h) / 2)
      return {
        x: Math.min(maxX, Math.max(-maxX, ox)),
        y: Math.min(maxY, Math.max(-maxY, oy)),
      }
    },
    [image, drawnSize, frameSize]
  )

  /** Zoom to `z`, keeping the frame-space point (ax, ay) pinned where it is. */
  const zoomAt = useCallback(
    (z: number, ax: number | null, ay: number | null) => {
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
      if (!image) {
        setZoom(next)
        return
      }
      setOffset((cur) => {
        if (ax === null || ay === null) {
          // slider / buttons: zoom straight at the center
          return clampOffset(cur.x, cur.y, next)
        }
        const { w: dw0, h: dh0 } = drawnSize(zoom)
        const { w: dw1, h: dh1 } = drawnSize(next)
        // image-space point currently under (ax, ay), measured from center
        const ux = (ax - frameSize.w / 2 - cur.x) / dw0
        const vy = (ay - frameSize.h / 2 - cur.y) / dh0
        const ox = ax - frameSize.w / 2 - ux * dw1
        const oy = ay - frameSize.h / 2 - vy * dh1
        return clampOffset(ox, oy, next)
      })
      setZoom(next)
    },
    [image, zoom, drawnSize, clampOffset, frameSize]
  )

  function onPointerDown(e: React.PointerEvent) {
    if (!image) return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current
    if (!d) return
    const frame = frameRef.current
    if (!frame) return
    const rect = frame.getBoundingClientRect()
    const scaleFix = rect.width / frame.clientWidth || 1
    setOffset(clampOffset(d.ox + (e.clientX - d.x) / scaleFix, d.oy + (e.clientY - d.y) / scaleFix, zoom))
  }

  function onPointerUp() {
    dragRef.current = null
  }

  /** Wheel zoom anchored at the cursor: the pixel you point at stays put. */
  function onWheel(e: React.WheelEvent) {
    if (!image) return
    e.preventDefault()
    const frame = frameRef.current
    if (!frame) return
    const rect = frame.getBoundingClientRect()
    const ax = e.clientX - rect.left
    const ay = e.clientY - rect.top
    const factor = Math.exp(-e.deltaY * 0.0016)
    zoomAt(zoom * factor, ax, ay)
  }

  function reset() {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }

  function apply() {
    if (!image) return
    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT[mode].w
    canvas.height = OUTPUT[mode].h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // map the on-screen frame (CSS px) to the output resolution
    const scale = OUTPUT[mode].w / frameSize.w
    const b = baseScale()
    const drawW = image.width * b * zoom * scale
    const drawH = image.height * b * zoom * scale
    const dx = (OUTPUT[mode].w - drawW) / 2 + offset.x * scale
    const dy = (OUTPUT[mode].h - drawH) / 2 + offset.y * scale
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(image, dx, dy, drawW, drawH)
    canvas.toBlob(
      (blob) => {
        if (blob) {
          sounds.play('lightTick')
          onApply(blob)
          onClose()
        }
      },
      'image/png',
      0.95
    )
  }

  const drawn = drawnSize(zoom)

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-md p-4 border-border glass rounded-sm dialog-in" aria-describedby={undefined}>
        <DialogTitle className="text-sm font-bold tracking-tight mb-3">
          {mode === 'avatar' ? 'crop profile picture' : 'crop banner'}
        </DialogTitle>

        <div
          ref={frameRef}
          className={cn(
            'relative w-full overflow-hidden rounded-sm border border-white/15 bg-app-raise touch-none select-none cursor-grab active:cursor-grabbing',
            mode === 'avatar' ? 'aspect-square max-w-[280px] mx-auto' : 'aspect-[4/1]'
          )}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          onDoubleClick={reset}
          role="application"
          aria-label="drag to reposition, scroll to zoom"
        >
          {image && (
            <img
              src={image.src}
              alt=""
              draggable={false}
              className="absolute left-1/2 top-1/2 pointer-events-none max-w-none max-h-none"
              style={{
                width: drawn.w,
                height: drawn.h,
                transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
              }}
            />
          )}
          {mode === 'avatar' ? (
            // circular preview mask: dark outside, thin ring on the cut
            <>
              <span
                className="absolute inset-[7%] rounded-full pointer-events-none ring-1 ring-white/25"
                style={{ boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }}
                aria-hidden="true"
              />
              <span className="absolute inset-[7%] rounded-full pointer-events-none border border-black/40" aria-hidden="true" />
            </>
          ) : (
            // banner: subtle corner brackets so the cut reads instantly
            <>
              <span className="absolute inset-0 pointer-events-none border border-white/10" aria-hidden="true" />
              <span className="absolute inset-x-0 top-0 h-px bg-white/25 pointer-events-none" aria-hidden="true" />
              <span className="absolute inset-x-0 bottom-0 h-px bg-white/25 pointer-events-none" aria-hidden="true" />
            </>
          )}
        </div>

        <div className="mt-3 flex items-center gap-3">
          <input
            type="range"
            min={100}
            max={400}
            step={1}
            value={Math.round(zoom * 100)}
            onChange={(e) => zoomAt(Number(e.target.value) / 100, null, null)}
            className="flex-1 accent-hyper"
            aria-label="zoom"
          />
          <button
            onClick={reset}
            className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
            aria-label="reset"
            title="reset"
          >
            <RotateCcw className="size-3.5" />
          </button>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" className="rounded-sm" onClick={onClose}>
            cancel
          </Button>
          <Button size="sm" className="rounded-sm press" disabled={!image} onClick={apply}>
            <Check className="size-4" />
            apply
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
