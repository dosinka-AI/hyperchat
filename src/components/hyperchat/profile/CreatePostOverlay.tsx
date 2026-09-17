'use client'

import { useEffect, useRef, useState } from 'react'
import { ImagePlus, Loader2, RefreshCw } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { apiClient } from '@/lib/client/api'
import { useToast } from '@/hooks/use-toast'
import { uploadProfileImage, useProfileImagePicker } from './media'

type Props = {
  onClose: () => void
  onCreated: () => void
}

/** New-post composer: pick an image (downscaled in the browser, uploaded via
 *  the existing /api/upload flow), add a caption, post it to the grid.
 *  Mounted only while open, so state starts clean every time. */
export function CreatePostOverlay({ onClose, onCreated }: Props) {
  const { toast } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [caption, setCaption] = useState('')
  const [busy, setBusy] = useState(false)
  const previewRef = useRef<string | null>(null)

  const picker = useProfileImagePicker((picked) => {
    setFile(picked)
    setPreviewUrl(URL.createObjectURL(picked))
  })

  // revoke the object URL when it changes
  useEffect(() => {
    previewRef.current = previewUrl
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    }
  }, [previewUrl])

  async function submit() {
    if (!file || busy) return
    setBusy(true)
    try {
      const imageUrl = await uploadProfileImage(file)
      await apiClient.createProfilePost({ imageUrl, caption: caption.trim() })
      onCreated()
      onClose()
    } catch (err) {
      setBusy(false)
      toast({
        title: 'post failed',
        description: err instanceof Error ? err.message : 'Try again.',
      })
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(26rem,94vw)] sm:max-w-none p-0 border-border bg-app-sidebar rounded-sm overflow-hidden">
        <DialogTitle className="sr-only">new post</DialogTitle>

        <div className="p-4 flex flex-col gap-3">
          <input {...picker.inputProps} />
          <p className="text-xs font-bold tracking-widest text-muted-foreground">new post</p>

          {previewUrl ? (
            <div className="relative">
              <img
                src={previewUrl}
                alt="post preview"
                className="w-full aspect-square object-cover border border-white/10 rounded-sm"
                draggable={false}
              />
              <button
                type="button"
                onClick={picker.open}
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
              onClick={picker.open}
              className="w-full aspect-square grid place-items-center border border-dashed border-white/20 rounded-sm text-muted-foreground hover:text-foreground hover:border-white/40 transition-colors"
              aria-label="choose image"
            >
              <span className="flex flex-col items-center gap-2">
                <ImagePlus className="size-7" />
                <span className="text-xs font-semibold">choose image</span>
              </span>
            </button>
          )}

          <textarea
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="caption"
            aria-label="caption"
            className="w-full resize-none bg-app-raise border border-white/10 rounded-sm px-3 py-2 text-sm outline-none focus:border-hyper/60 placeholder:text-muted-foreground/60"
          />

          <div className="flex items-center justify-between gap-2">
            <span className={caption.length >= 1900 ? 'text-[10px] text-muted-foreground' : 'sr-only'}>
              {caption.length}/2000
            </span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" className="rounded-sm h-8" onClick={onClose} disabled={busy}>
                cancel
              </Button>
              <Button
                size="sm"
                className="rounded-sm h-8"
                onClick={() => void submit()}
                disabled={!file || busy}
                aria-label="create post"
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                post
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
