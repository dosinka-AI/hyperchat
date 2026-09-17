'use client'

import { useEffect, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { apiClient } from '@/lib/client/api'
import { renderMessageContent } from '@/lib/client/markdown'
import { messageTimestamp } from '@/lib/client/format'
import type { ClientMessage } from '@/lib/types'
import { Avatar } from './Avatar'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Pin, PinOff, Hash } from 'lucide-react'
import { PERM } from '@/lib/perm'
import { FileMediaEmbed } from './MediaSurface'

/** Images and media under a pinned message: thumbnails, click opens lightbox;
 *  audio/video keep the same embeds as the message list. */
function PinMedia({ msg, onOpen }: { msg: ClientMessage; onOpen: (url: string) => void }) {
  const urls: string[] = []
  if (msg.imageUrl) urls.push(msg.imageUrl)
  const imageAtts = (msg.attachments ?? []).filter((a) => a.mime.startsWith('image/') && a.url)
  for (const a of imageAtts) {
    if (!urls.includes(a.url)) urls.push(a.url)
  }
  // bare image urls pasted as the whole message body
  if (msg.content) {
    for (const line of msg.content.split('\n')) {
      const t = line.trim()
      if (/^https?:\/\/\S+\.(png|jpe?g|gif|webp|avif)(\?\S*)?$/i.test(t) && !urls.includes(t)) {
        urls.push(t)
      }
    }
  }
  const mediaFiles = (msg.attachments ?? []).filter(
    (a) => a.mime.startsWith('video/') || a.mime.startsWith('audio/')
  )

  return (
    <>
      {urls.length > 0 && (
        <div className={`mt-1.5 flex gap-1.5 flex-wrap ${urls.length > 1 ? 'max-w-64' : ''}`}>
          {urls.map((url) => (
            <button
              key={url}
              type="button"
              onClick={() => onOpen(url)}
              className="block rounded-sm overflow-hidden border border-white/10 hover:border-white/30 transition-colors"
              aria-label="Open image"
            >
              <img
                src={url}
                alt="pinned image"
                loading="lazy"
                draggable={false}
                className={urls.length > 1 ? 'size-20 object-cover' : 'max-h-28 max-w-56 object-contain'}
              />
            </button>
          ))}
        </div>
      )}
      {mediaFiles.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1 max-w-md">
          {mediaFiles.map((f) => (
            <FileMediaEmbed
              key={`${f.url}-${f.name}`}
              url={f.url}
              mime={f.mime}
              name={f.name}
              size={f.size}
              room={msg.room}
              kind={f.kind}
              duration={f.duration}
              waveform={f.waveform}
              variant={f.kind === 'voice' ? 'voice' : 'file'}
            />
          ))}
        </div>
      )}
    </>
  )
}

export function PinsDialog({
  open,
  onOpenChange,
  room,
  channelName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  room: string
  channelName: string | null
}) {
  const me = useChatStore((s) => s.me)
  const servers = useChatStore((s) => s.servers)
  const activeServerId = useChatStore((s) => s.activeServerId)
  const jumpToMessage = useChatStore((s) => s.jumpToMessage)
  const togglePin = useChatStore((s) => s.togglePin)

  const [pins, setPins] = useState<ClientMessage[]>([])
  const [lightbox, setLightbox] = useState<string | null>(null)

  const channelId = room.startsWith('channel:') ? room.slice('channel:'.length) : null
  const conversationId = room.startsWith('conversation:') ? room.slice('conversation:'.length) : null

  useEffect(() => {
    if (!open) return
    const load = channelId
      ? apiClient.channelPins(channelId)
      : conversationId
        ? apiClient.conversationPins(conversationId)
        : null
    if (load) {
      void load
        .then((res) => setPins(res.messages))
        .catch(() => setPins([]))
    }
  }, [open, channelId, conversationId])

  const server = servers.find((s) => s.id === activeServerId)
  const canUnpin =
    !!conversationId ||
    (!!channelId &&
      server != null &&
      (server.myPerms & (PERM.ADMINISTRATOR | PERM.MANAGE_MESSAGES)) !== 0)

  function jump(msg: ClientMessage) {
    onOpenChange(false)
    void jumpToMessage(msg.id)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0 border-border bg-app-sidebar overflow-hidden rounded-sm" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Pinned messages</DialogTitle>

        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
          <Pin className="size-4 text-muted-foreground" />
          <span className="text-sm font-bold tracking-tight">
            Pinned messages{channelName ? ` in #${channelName}` : ''}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">{pins.length}</span>
        </div>

        <div className="max-h-96 overflow-y-auto scroll-thin divide-y divide-white/[0.06]">
          {pins.length === 0 && (
            <p className="px-4 py-6 text-xs text-muted-foreground text-center">
              Nothing pinned yet.
            </p>
          )}
          {pins.map((msg) => (
            <div key={msg.id} className="px-4 py-3 flex gap-3 hover:bg-app-raise/60 transition-colors">
              <Avatar name={msg.author.username} color={msg.author.avatarColor} url={msg.author.avatarUrl} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-semibold truncate">{msg.author.displayName || msg.author.username}</span>
                  <span className="text-muted-foreground shrink-0">{messageTimestamp(msg.createdAt)}</span>
                </div>
                <div className="mt-0.5 text-[13px] text-foreground/85 break-words">
                  {msg.content ? renderMessageContent(msg.content, { myUsername: me?.username }) : null}
                  <PinMedia msg={msg} onOpen={setLightbox} />
                </div>
              </div>
              <div className="flex flex-col gap-1 shrink-0">
                <button
                  onClick={() => jump(msg)}
                  className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  aria-label="Jump to message"
                  title="Jump to message"
                >
                  <Hash className="size-3.5" />
                </button>
                {canUnpin && (
                  <button
                    onClick={() => {
                      void togglePin(room, msg.id, true).then(() => setPins((list) => list.filter((p) => p.id !== msg.id)))
                    }}
                    className="p-1.5 rounded-sm text-muted-foreground hover:text-destructive hover:bg-accent transition-colors"
                    aria-label="Unpin message"
                    title="Unpin message"
                  >
                    <PinOff className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>

      <Dialog open={!!lightbox} onOpenChange={(open) => !open && setLightbox(null)}>
        <DialogContent
          className="max-w-[92vw] max-h-[88vh] p-0 border-border bg-black/95 overflow-hidden rounded-sm grid place-items-center"
          aria-describedby={undefined}
        >
          <DialogTitle className="sr-only">Pinned image</DialogTitle>
          {lightbox && (
            <img
              src={lightbox}
              alt="pinned image"
              draggable={false}
              className="max-w-full max-h-[82vh] object-contain select-none"
            />
          )}
        </DialogContent>
      </Dialog>
    </Dialog>
  )
}
