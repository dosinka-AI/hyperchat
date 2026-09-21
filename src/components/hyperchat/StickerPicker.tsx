'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import type { StickerSummary } from '@/lib/types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import { sounds } from '@/lib/client/sounds'
import { cn } from '@/lib/utils'
import { PERM } from '@/lib/perm'
import { Sticker as StickerIcon, Trash2, Upload } from 'lucide-react'

const STICKER_SWATCHES = ['#f5f5f5', '#547cff', '#4f9e63', '#c9a54e', '#c96e50', '#b05ac9', '#5ab8c9', '#c95a7a']

/** One sticker tile in the grid: uploaded art streams from /api/files. */
function StickerTile({ s, onPick }: { s: StickerSummary; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="group relative aspect-square rounded-sm border border-white/10 bg-app-raise/60 hover:border-white/30 hover:bg-app-raise transition-colors p-1.5 grid place-items-center overflow-hidden"
      aria-label={`send the ${s.name} sticker`}
      title={s.name}
    >
      { }
      <img src={s.url} alt={s.name} loading="lazy" className="max-w-full max-h-full object-contain select-none pointer-events-none" />
    </button>
  )
}

/** The sticker picker popover for the composer: the active server's custom
 *  pack (mods can upload + remove) plus a search box. Picking sends the
 *  sticker immediately. DMs have no stickers — packs are a server feature. */
export function StickerPicker({ onPick }: { onPick: (sticker: StickerSummary) => void }) {
  const activeServerId = useChatStore((s) => s.activeServerId)
  const servers = useChatStore((s) => s.servers)
  const stickers = useChatStore((s) => s.stickers)
  const loadStickers = useChatStore((s) => s.loadStickers)
  const addServerSticker = useChatStore((s) => s.addServerSticker)
  const removeSticker = useChatStore((s) => s.removeSticker)
  const { toast } = useToast()

  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [uploadName, setUploadName] = useState('')
  const [uploadBusy, setUploadBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const server = servers.find((s) => s.id === activeServerId) ?? null
  const canManage = server ? (server.myPerms & (PERM.ADMINISTRATOR | PERM.MANAGE_SERVER)) !== 0 : false

  // load the active server's pack (cached in the store; 'global' loads too
  // so DMs know there is nothing to show instead of spinning forever)
  useEffect(() => {
    if (!open) return
    void loadStickers(undefined)
    if (activeServerId) void loadStickers(activeServerId)
  }, [open, activeServerId, loadStickers])

  const globalPack = stickers['global'] ?? []
  const globalLoaded = stickers['global'] !== undefined
  const serverPack = activeServerId ? stickers[activeServerId] ?? [] : []

  const filtered = useMemo(() => {
    const all = [...globalPack, ...serverPack]
    const needle = q.trim().toLowerCase()
    return needle ? all.filter((s) => s.name.toLowerCase().includes(needle)) : all
  }, [globalPack, serverPack, q])

  async function handleUpload(file: File) {
    if (!activeServerId || !uploadName.trim()) {
      toast({ title: 'name the sticker first' })
      return
    }
    setUploadBusy(true)
    try {
      const ok = await addServerSticker(activeServerId, uploadName.trim(), file)
      if (ok) {
        setUploadName('')
        sounds.play('midTick')
      }
    } finally {
      setUploadBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={() => sounds.play('lightTick')}
          className="p-2 max-md:p-2.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
          aria-label="send a sticker"
          title="send a sticker"
        >
          <StickerIcon className="size-5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-0 rounded-sm">
        <div className="p-2 border-b border-white/10 flex items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="search stickers"
            className="h-7 rounded-sm text-xs bg-app-raise border-white/10"
          />
        </div>
        <div className="max-h-72 overflow-y-auto scroll-thin p-2">
          {filtered.length === 0 ? (
            <div className="h-24 grid place-items-center text-xs text-muted-foreground text-center px-4">
              {!globalLoaded ? (
                <Spinner />
              ) : activeServerId ? (
                serverPack.length === 0
                  ? 'no stickers in this server yet — mods can upload a pack below'
                  : 'no stickers match'
              ) : (
                'stickers live in servers — join one and mods can upload a pack'
              )}
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-1.5">
              {filtered.map((s) => (
                <div key={s.id} className="relative group">
                  <StickerTile
                    s={s}
                    onPick={() => {
                      sounds.play('lightTick')
                      onPick(s)
                      setOpen(false)
                    }}
                  />
                  {canManage && s.serverId && (
                    <button
                      type="button"
                      onClick={() => void removeSticker(s.id, s.serverId!)}
                      className="absolute -top-1 -right-1 hidden group-hover:grid max-md:grid place-items-center size-5 rounded-sm bg-destructive text-white shadow"
                      aria-label={`remove the ${s.name} sticker`}
                      title="remove sticker"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {activeServerId && canManage && (
          <div className="p-2 border-t border-white/10 space-y-1.5">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
              add to this server
            </div>
            <div className="flex items-center gap-1.5">
              <Input
                value={uploadName}
                onChange={(e) => setUploadName(e.target.value)}
                placeholder="name"
                maxLength={32}
                className="h-7 flex-1 rounded-sm text-xs bg-app-raise border-white/10"
              />
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,image/apng"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file && file.size > 512 * 1024) {
                    toast({ title: 'stickers are capped at 512 KB' })
                    return
                  }
                  if (file) void handleUpload(file)
                }}
              />
              <Button
                size="sm"
                className="h-7 rounded-sm gap-1 px-2"
                disabled={uploadBusy || !uploadName.trim()}
                onClick={() => fileRef.current?.click()}
              >
                {uploadBusy ? <Spinner /> : <Upload className="size-3.5" />}
                upload
              </Button>
            </div>
            <div className={cn('flex gap-1', serverPack.length === 0 && 'hidden')}>
              {STICKER_SWATCHES.map((c) => (
                <span key={c} className="size-2.5 rounded-full border border-white/20" style={{ backgroundColor: c }} aria-hidden="true" />
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
