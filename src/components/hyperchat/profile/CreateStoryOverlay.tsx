'use client'

import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Loader2, RefreshCw } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { apiClient } from '@/lib/client/api'
import { useToast } from '@/hooks/use-toast'
import { pickProfileImage, uploadProfileImage } from './media'

type Props = {
  onClose: () => void
  onCreated: () => void
}

/** New-story composer: pick an image, share it as a 24h story. Mounted
 *  only while open, so state starts clean every time. */
export function CreateStoryOverlay({ onClose, onCreated }: Props) {
  const { toast } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const previewRef = useRef<string | null>(null)

  useEffect(() => {
    previewRef.current = previewUrl
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    }
  }, [previewUrl])

  async function choose() {
    const picked = await pickProfileImage()
    if (!picked) return
    setFile(picked)
    setPreviewUrl(URL.createObjectURL(picked))
  }

  async function submit() {
    if (!file || busy) return
    setBusy(true)
    try {
      const imageUrl = await uploadProfileImage(file)
      await apiClient.createStory(imageUrl)
      onCreated()
      onClose()
    } catch (err) {
      setBusy(false)
      toast({
        title: 'story failed',
        description: err instanceof Error ? err.message : 'Try again.',
      })
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(26rem,94vw)] sm:max-w-none p-0 border-border bg-app-sidebar rounded-sm overflow-hidden" aria-describedby={undefined}>
        <DialogTitle className="sr-only">new story</DialogTitle>

        <div className="p-4 flex flex-col gap-3">
          <p className="text-xs font-bold tracking-widest text-muted-foreground">new story</p>

          {previewUrl ? (
            <div className="relative">
              <img
                src={previewUrl}
                alt="story preview"
                className="w-full max-h-[60vh] object-contain bg-black border border-white/10 rounded-sm"
                draggable={false}
              />
              <button
                type="button"
                onClick={choose}
                disabled={busy}
                className="absolute bottom-2 right-2 flex items-center gap-1.5 text-[11px] font-semibold bg-black/80 border border-white/15 text-foreground px-2 py-1.5 rounded-sm hover:bg-black transition-colors disabled:opacity-50"
                aria-label="replace image"
              >
                <RefreshCw className="size-3" />
                replace
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={choose}
              className="w-full h-56 grid place-items-center border border-dashed border-white/20 rounded-sm text-muted-foreground hover:text-foreground hover:border-white/40 transition-colors"
              aria-label="choose image"
            >
              <span className="flex flex-col items-center gap-2">
                <ImagePlus className="size-7" />
                <span className="text-xs font-semibold">choose image</span>
              </span>
            </button>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" className="rounded-sm h-8" onClick={onClose} disabled={busy}>
              cancel
            </Button>
            <Button
              size="sm"
              className="rounded-sm h-8"
              onClick={() => void submit()}
              disabled={!file || busy}
              aria-label="share story"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              share
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
