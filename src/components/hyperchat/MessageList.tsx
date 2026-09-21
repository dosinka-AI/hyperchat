'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import type { ClientMessage, MessageAttachment } from '@/lib/types'
import { renderMessageContent } from '@/lib/client/markdown'
import { dayDivider, formatBytes, messageTimestamp, shortTime } from '@/lib/client/format'
import { PERM } from '@/lib/perm'
import { Avatar } from './Avatar'
import { FileMediaEmbed, HideEmbedButton, HiddenMediaCard } from './MediaSurface'
import { isBlanked, subscribeBlanked } from '@/lib/client/media-blank'
import { Spinner } from '@/components/ui/spinner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Trash2, Pencil, Pin, PinOff, SmilePlus, Check, Reply, Copy, ArrowDown, Reply as ReplyIcon, Bookmark, BookmarkCheck, BookmarkPlus, Clock, AlertCircle, RotateCcw, X, BellRing, Download, Play, FileText, FileArchive, FileAudio, FileVideo, FileSpreadsheet, FileCode, EyeOff, MessagesSquare, Forward, History, Languages, Link2, MoreHorizontal, Phone, PhoneMissed, Video } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sounds } from '@/lib/client/sounds'
import { apiClient } from '@/lib/client/api'
import { downloadFile } from '@/lib/client/download'
import { useToast } from '@/hooks/use-toast'
import { loadHiddenIds, hideMessageForMe } from '@/lib/client/hidden'
import { EmojiGrid, mostUsedEmojis, rememberRecent, rememberUsage } from './EmojiPicker'
import { openContextMenu } from './ContextMenu'
import { openEmojiPop } from './EmojiPop'
import { MiniProfilePopover } from './MiniProfile'
import { EmojiText } from '@/lib/client/serverEmoji'
import { ReactionChips } from './ReactionChips'
import { VaultFileCard } from './VaultFileCard'

const GROUP_WINDOW_MS = 5 * 60 * 1000

/** Group read receipt: the row of overlapping reader avatars that rides
 *  under the last message of mine each reader has covered. Earliest reader
 *  first, capped at five faces with a muted +N chip; the title lists
 *  everyone who saw it. Null readers render nothing. */
function GroupReadReceipt({
  readers,
  participants,
}: {
  readers: { userId: string; at: number }[] | null
  participants: { id: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }[]
}) {
  if (!readers || readers.length === 0) return null
  const shown = readers.slice(0, 5)
  const extra = readers.length - shown.length
  const nameOf = (userId: string) => {
    const p = participants.find((pt) => pt.id === userId)
    return p?.displayName || p?.username || userId
  }
  return (
    <div
      className="flex items-center gap-1.5 mt-1"
      title={`${readers.map((r) => nameOf(r.userId)).join(', ')} · seen`}
      aria-live="polite"
    >
      <span className="flex items-center -space-x-1.5" aria-hidden="true">
        {shown.map((r) => {
          const p = participants.find((pt) => pt.id === r.userId)
          return (
            <Avatar
              key={r.userId}
              name={p?.username ?? r.userId}
              color={p?.avatarColor}
              url={p?.avatarUrl}
              size="sm"
              className="rounded-full ring-2 ring-app-chat"
            />
          )
        })}
        {extra > 0 && (
          <span className="grid place-items-center size-6 rounded-full bg-app-raise ring-2 ring-app-chat text-[9px] font-semibold text-muted-foreground select-none">
            +{extra}
          </span>
        )}
      </span>
      <span className="text-[10px] text-hyper">seen</span>
    </div>
  )
}

/** The edit box: a fresh mount means an edit just started, so the caret is
 *  placed at the END of the text (you are fixing the tail of what you wrote,
 *  never re-reading it from the top). Rows grow with the draft, and the
 *  commit is optimistic: the store swaps the words instantly, the server
 *  round trip is invisible. */
function EditBox({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (text: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [])

  const rows = Math.max(2, Math.min(8, value.split('\n').length + 1))

  return (
    <div className="mt-0.5 msg-land">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            const text = value.trim()
            if (text) onCommit(text)
            onCancel()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
        rows={rows}
        className="chat-font w-full bg-app-raise border border-hyper/40 rounded-sm px-2 py-1.5 leading-[1.4] outline-none resize-none scroll-thin"
        aria-label="edit message"
      />
      <p className="mt-1 text-[10px] text-muted-foreground select-none">
        enter to save · escape to cancel
      </p>
    </div>
  )
}

/** GIF urls from the big libraries (and uploads) all end in .gif; the odd
 *  one with query strings still carries the extension before them. */
function isGifUrl(url: string): boolean {
  return /\.gif([?#]|$)/i.test(url) || /giphy\.com\/media|media\.tenor\.com|media\.giphy/i.test(url)
}

/** away time label: "for 12m" / "for 3h" */
export function awayForLabel(since: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - since) / 60000))
  if (mins < 1) return 'for a moment'
  if (mins < 60) return `for ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `for ${hours}h${mins % 60 ? ` ${mins % 60}m` : ''}`
  const days = Math.floor(hours / 24)
  return `for ${days}d`
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

type Entry =
  | { kind: 'divider'; key: string; label: string }
  | { kind: 'unread'; key: string }
  | { kind: 'message'; key: string; msg: ClientMessage; grouped: boolean }

function buildEntries(messages: ClientMessage[], unreadAfter: number | null): Entry[] {
  const entries: Entry[] = []
  let prev: ClientMessage | null = null
  let unreadPlaced = false
  for (const msg of messages) {
    const dt = new Date(msg.createdAt)
    const prevDt = prev ? new Date(prev.createdAt) : null
    if (!prevDt || !sameDay(dt, prevDt)) {
      entries.push({ kind: 'divider', key: `d-${msg.id}`, label: dayDivider(msg.createdAt) })
    }
    // NEW divider sits above the first message newer than my read stamp
    if (!unreadPlaced && unreadAfter !== null && dt.getTime() > unreadAfter) {
      entries.push({ kind: 'unread', key: `u-${msg.id}` })
      unreadPlaced = true
    }
    const grouped =
      !!prev &&
      !prev.systemKind &&
      prev.authorId === msg.authorId &&
      dt.getTime() - prevDt!.getTime() < GROUP_WINDOW_MS &&
      sameDay(dt, prevDt as Date) &&
      !msg.replyTo
    // keying by nonce keeps the optimistic row and its confirmed swap the
    // SAME react node: the entry animation never replays when the server row
    // replaces the pending echo, so the send confirmation is invisible
    entries.push({ kind: 'message', key: msg.nonce ?? msg.id, msg, grouped })
    prev = msg
  }
  return entries
}

/** Reply context chip: who, and a one-line preview. Click jumps to the original. */
function ReplyContext({ msg, onJump }: { msg: ClientMessage; onJump: () => void }) {
  if (!msg.replyTo) return null
  const r = msg.replyTo
  return (
    <button
      onClick={onJump}
      className="flex items-center gap-1.5 w-full max-w-full text-left text-xs text-muted-foreground hover:text-foreground mb-0.5 group/reply"
      aria-label={`Reply to ${r.authorUsername}: ${r.contentPreview ?? 'image'}`}
    >
      <ReplyIcon className="size-3 shrink-0 opacity-60" />
      <span className="shrink-0 font-semibold text-foreground/80">@{r.authorDisplayName || r.authorUsername}</span>
      <span className="truncate opacity-70 group-hover/reply:opacity-100">
        {r.contentPreview ?? (r.hasImage ? 'image' : 'message')}
      </span>
    </button>
  )
}

/** Thread bar under a root message: participant faces, reply count, open. */
function ThreadBar({
  msg,
  onOpen,
  active,
}: {
  msg: ClientMessage
  onOpen: () => void
  active: boolean
}) {
  const count = msg.threadCount ?? 0
  if (count <= 0) return null
  const faces = msg.threadUsers ?? []
  return (
    <button
      onClick={() => {
        sounds.play('uiWhoom')
        onOpen()
      }}
      className={cn(
        'group/bar mt-1.5 flex items-center gap-2 w-full max-w-md pl-1 pr-2.5 py-1 rounded-sm border text-left transition-colors',
        active
          ? 'border-hyper/50 bg-hyper/10'
          : 'border-white/10 bg-app-raise/50 hover:border-white/30 hover:bg-app-raise'
      )}
      aria-label={`Open thread with ${count} ${count === 1 ? 'reply' : 'replies'}`}
    >
      <span className="flex items-center gap-1 pl-1" aria-hidden="true">
        {faces.slice(0, 3).map((f, i) => (
          <span
            key={f.id}
            className="size-5 rounded-full overflow-hidden ring-2 ring-app-chat"
            style={{ marginLeft: i === 0 ? 0 : -8, zIndex: 3 - i, position: 'relative' }}
          >
            {f.avatarUrl ? (
              <img src={f.avatarUrl} alt="" className="size-full object-cover" loading="lazy" />
            ) : (
              <span
                className="size-full grid place-items-center text-[8px] font-bold text-white"
                style={{ backgroundColor: f.avatarColor }}
              >
                {f.username.slice(0, 1).toUpperCase()}
              </span>
            )}
          </span>
        ))}
        {faces.length === 0 && <MessagesSquare className="size-3.5 text-muted-foreground" />}
      </span>
      <span className="text-[11px] text-muted-foreground truncate">
        <span className="font-semibold text-foreground/90">{count}</span> {count === 1 ? 'reply' : 'replies'}
      </span>
      <span className="ml-auto flex items-center gap-1 text-[10px] font-semibold text-hyper/80 group-hover/bar:text-hyper shrink-0 transition-colors">
        view thread
        <MessagesSquare className="size-3" aria-hidden="true" />
      </span>
    </button>
  )
}

/** Map a mime type (plus filename fallback) to its chip icon; mirrors the composer tray. */
function fileIconFor(mime: string, name: string): typeof FileText {
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
  if (mime.startsWith('audio/')) return FileAudio
  if (mime.startsWith('video/')) return FileVideo
  if (/^(zip|rar|7z|gz|tar)$/.test(ext) || /zip|rar|7z|compressed/.test(mime)) return FileArchive
  if (/^(csv|xls|xlsx)$/.test(ext) || /csv|excel|spreadsheet/.test(mime)) return FileSpreadsheet
  if (/^(js|mjs|cjs|ts|tsx|jsx|html|htm|css)$/.test(ext) || /javascript|typescript|html|css/.test(mime)) return FileCode
  return FileText
}

/** Image with load pulse + device-pixel snapping. Fractional css sizes
 *  (odd container widths at 1.25x/1.5x display scaling) force the compositor
 *  to resample the bitmap, which reads as aliasing/shimmer on high-res
 *  images and re-samples animated GIFs on every frame; rounding the element
 *  box to whole device pixels lets the bitmap composite 1:1. The snap re-runs
 *  on every layout change (ResizeObserver) and on window resizes so zoom
 *  changes and sidebar toggles never leave a fractional box behind. Sources
 *  smaller than their box (chat gifs) display at exact 1:1 instead of being
 *  upscaled through a resampler. */
function AttachmentImg({
  src,
  alt,
  className,
  fill,
}: {
  src: string
  alt: string
  className?: string
  /** true for object-cover cells: the box must keep filling its cell, so
   *  no natural-size 1:1 shortcut applies */
  fill?: boolean
}) {
  const ref = useRef<HTMLImageElement>(null)
  const [loaded, setLoaded] = useState(false)

  function snap() {
    const el = ref.current
    if (!el) return
    const dpr = window.devicePixelRatio || 1
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    let w = Math.round(rect.width * dpr) / dpr
    let h = Math.round(rect.height * dpr) / dpr
    // crisp 1:1: a source that fits inside its box displays at its exact
    // device-pixel size (no resampling at all, animated or static)
    if (!fill && el.naturalWidth > 0 && el.naturalHeight > 0) {
      const natW = Math.round(el.naturalWidth / dpr)
      const natH = Math.round(el.naturalHeight / dpr)
      if (natW <= w + 1 && natH <= h + 1) {
        w = natW
        h = natH
      }
    }
    el.style.width = `${w}px`
    el.style.height = `${h}px`
    setLoaded(true)
  }

  // re-snap on every box change (layout shifts, resizes) — the style width
  // itself does not loop the observer because it matches the measured box
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(snap)
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [src, fill])

  return (
    <img
      ref={ref}
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={snap}
      className={cn(className, !loaded && 'bg-app-raise animate-pulse')}
    />
  )
}

/** Always-on save affordance: a small translucent banner pinned to the
 *  top-right corner of every image and GIF. Saving a gif (or bookmarking
 *  the message behind a plain image) never requires opening the lightbox. */
function ImageSaveButton({
  saved,
  isGif,
  small,
  onToggle,
}: {
  saved: boolean
  isGif: boolean
  small?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={cn(
        'absolute z-10 grid place-items-center rounded-sm bg-black/40 text-white/80 border border-white/10 backdrop-blur-[2px]',
        'hover:bg-black/70 hover:text-white transition-colors',
        small ? 'top-1 right-1 size-6' : 'top-1.5 right-1.5 size-7'
      )}
      aria-label={isGif ? (saved ? 'GIF saved to your collection' : 'Save GIF to your collection') : saved ? 'Remove from saved messages' : 'Save message'}
      title={isGif ? (saved ? 'saved' : 'save gif') : saved ? 'saved' : 'save'}
    >
      {saved ? <Bookmark className={cn('fill-hyper text-hyper', small ? 'size-3' : 'size-3.5')} /> : <BookmarkPlus className={small ? 'size-3' : 'size-3.5'} />}
    </button>
  )
}

/** Per-url blanked state, shared by every image surface in a row. */
function useBlanked(url: string): boolean {
  const [blanked, setBlanked] = useState(() => isBlanked(url))
  useEffect(() => {
    const sync = () => setBlanked(isBlanked(url))
    sync()
    return subscribeBlanked(sync)
  }, [url])
  return blanked
}

/** An image embed: the picture, its save affordance, and the eye-off that
 *  blanks the embed locally (content you would rather not see but want to
 *  keep findable to delete). Clicking the placeholder reveals again. */
function ImageEmbed({
  src,
  alt,
  imgClassName,
  fill,
  containerClassName,
  hideClassName,
  saved,
  isGif,
  small,
  onToggleSave,
  onOpen,
}: {
  src: string
  alt: string
  imgClassName: string
  fill?: boolean
  containerClassName: string
  hideClassName: string
  saved: boolean
  isGif: boolean
  small?: boolean
  onToggleSave: () => void
  onOpen: (url: string) => void
}) {
  const blanked = useBlanked(src)
  if (blanked) return <HiddenMediaCard url={src} kindLabel="image" />
  return (
    <div
      role="button"
      tabIndex={0}
      className={containerClassName}
      onClick={() => onOpen(src)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(src)
        }
      }}
      aria-label={alt}
    >
      <AttachmentImg src={src} alt={alt} className={imgClassName} fill={fill} />
      <ImageSaveButton small={small} saved={saved} isGif={isGif} onToggle={onToggleSave} />
      <HideEmbedButton url={src} blanked={blanked} className={hideClassName} />
    </div>
  )
}

/** Iframe-safe download affordance for attachment chips + the lightbox: the
 *  blob/a.download path in normal tabs, the window.open fallback when the app
 *  is embedded in a sandboxed iframe where programmatic download clicks are
 *  silently dropped (see src/lib/client/download.ts). */
function useSafeDownload() {
  const { toast } = useToast()
  return (url: string, filename: string) =>
    downloadFile({
      url,
      filename,
      onStatus: (kind) => {
        if (kind === 'blocked-fallback') {
          sounds.play('error')
          toast({ title: 'download blocked', description: 'open this app in a real browser tab, then try again.' })
          return
        }
        if (kind !== 'expired' && kind !== 'notready' && kind !== 'flagged') {
          sounds.play('error')
          toast({ title: 'download failed', description: 'try again in a moment.' })
        }
      },
    })
}

/** Attachments under a message: image grid (click opens the lightbox) plus
 *  playable media embeds and downloadable file chips. Pending optimistic
 *  rows reuse this verbatim. */
function MessageAttachments({
  attachments,
  author,
  room,
  onOpen,
  savedGifUrls,
  onSaveGif,
  isBookmarked,
  onToggleBookmark,
}: {
  attachments: MessageAttachment[]
  author: string
  /** room the row lives in: the mini player docks here while it is open */
  room: string
  onOpen: (url: string) => void
  savedGifUrls: Set<string>
  onSaveGif: (url: string, author: string) => void
  isBookmarked: boolean
  onToggleBookmark: () => void
}) {
  const safeDownload = useSafeDownload()
  const images = attachments.filter((a) => a.mime.startsWith('image/'))
  const files = attachments.filter((a) => !a.mime.startsWith('image/'))
  return (
    <>
      {images.length === 1 ? (
        <ImageEmbed
          src={images[0].url}
          alt={`Image sent by ${author}`}
          imgClassName="block max-w-full max-h-80 object-contain"
          containerClassName="relative group/embed mt-1.5 block max-w-sm rounded-sm border border-white/10 cursor-pointer overflow-hidden hover:border-white/25 transition-colors"
          hideClassName="top-1.5 right-[2.5rem]"
          small
          saved={isGifUrl(images[0].url) ? savedGifUrls.has(images[0].url) : isBookmarked}
          isGif={isGifUrl(images[0].url)}
          onToggleSave={() => {
            if (isGifUrl(images[0].url)) onSaveGif(images[0].url, author)
            else onToggleBookmark()
          }}
          onOpen={onOpen}
        />
      ) : images.length > 1 ? (
        <div className="mt-1.5 grid grid-cols-2 gap-1 max-w-md">
          {images.map((a) => (
            <ImageEmbed
              key={a.url}
              src={a.url}
              alt={`Image sent by ${author}`}
              imgClassName="size-full object-cover"
              fill
              containerClassName="relative group/embed aspect-square rounded-sm cursor-pointer overflow-hidden transition-opacity hover:opacity-90"
              hideClassName="top-1 right-[2rem]"
              small
              saved={isGifUrl(a.url) ? savedGifUrls.has(a.url) : isBookmarked}
              isGif={isGifUrl(a.url)}
              onToggleSave={() => {
                if (isGifUrl(a.url)) onSaveGif(a.url, author)
                else onToggleBookmark()
              }}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : null}
      {files.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1 max-w-md">
          {files.map((f) => {
            // video/audio attachments are EMBEDS now: they play in the
            // message row itself with custom chrome (the floating mini
            // player only carries them while you are elsewhere)
            if (f.mime.startsWith('video/') || f.mime.startsWith('audio/')) {
              return (
                <FileMediaEmbed
                  key={`${f.url}-${f.name}`}
                  url={f.url}
                  mime={f.mime}
                  name={f.name}
                  size={f.size}
                  room={room}
                  kind={f.kind}
                  duration={f.duration}
                  waveform={f.waveform}
                  variant={f.kind === 'voice' ? 'voice' : 'file'}
                />
              )
            }
            const Icon = fileIconFor(f.mime, f.name)
            // a button + the shared download helper instead of a bare
            // <a download>: sandboxed iframes (preview panels) silently drop
            // programmatic blob clicks — the helper falls back to a
            // top-level navigation that the route answers with
            // Content-Disposition: attachment
            return (
              <button
                key={`${f.url}-${f.name}`}
                type="button"
                onClick={() => void safeDownload(f.url, f.name)}
                className="flex w-full items-center gap-2.5 bg-app-raise border border-white/10 rounded-sm px-3 py-2 max-w-sm cursor-pointer hover:border-white/25 transition-colors text-left"
                aria-label={`Download ${f.name}`}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{f.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(f.size)}</span>
                <span
                  className="ml-auto p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"
                  title="download"
                  aria-hidden="true"
                >
                  <Download className="size-3.5" />
                </span>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}

/** The single image carried on the message row itself (not an attachment
 *  list): same embed chrome — save affordance, eye-off blanking, lightbox. */
function ImageUrlEmbed({
  url,
  author,
  savedGifUrls,
  onSaveGif,
  isBookmarked,
  onToggleBookmark,
  setLightbox,
}: {
  url: string
  author: string
  savedGifUrls: Set<string>
  onSaveGif: (url: string, author: string) => void
  isBookmarked: boolean
  onToggleBookmark: () => void
  setLightbox: (l: { url: string; author: string } | null) => void
}) {
  const blanked = useBlanked(url)
  if (blanked) return <HiddenMediaCard url={url} kindLabel="image" />
  return (
    <div
      role="button"
      tabIndex={0}
      className="relative group/embed mt-1.5 inline-block rounded-sm overflow-hidden border border-border hover:border-white/25 transition-colors cursor-pointer"
      onClick={() => setLightbox({ url, author })}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setLightbox({ url, author })
        }
      }}
      aria-label={`Open image sent by ${author}`}
    >
      <AttachmentImg
        src={url}
        alt={`Image sent by ${author}`}
        className="block max-w-[min(28rem,100%)] max-h-80 object-contain bg-black/40"
      />
      <ImageSaveButton
        saved={isGifUrl(url) ? savedGifUrls.has(url) : isBookmarked}
        isGif={isGifUrl(url)}
        onToggle={() => {
          if (isGifUrl(url)) onSaveGif(url, author)
          else onToggleBookmark()
        }}
      />
      <HideEmbedButton url={url} blanked={blanked} className="top-1.5 right-[2.5rem]" />
    </div>
  )
}

/** The content half of a message row: edit box, markdown body, image,
 *  edited/pinned labels, translation. Shared by normal and revealed-blocked rendering. */
function MessageBody({
  msg,
  meUsername,
  openProfile,
  editing,
  editDraft,
  setEditingId,
  editMessage,
  room,
  setLightbox,
  translation,
  onPermalink,
  savedGifUrls,
  onSaveGif,
  isBookmarked,
  onToggleBookmark,
}: {
  msg: ClientMessage
  meUsername?: string | null
  openProfile: (username: string) => Promise<void>
  editing: boolean
  editDraft: string
  setEditingId: (v: string | null) => void
  editMessage: (room: string, messageId: string, content: string) => Promise<void>
  room: string
  setLightbox: (l: { url: string; author: string } | null) => void
  translation?: { loading: boolean; text: string | null }
  onPermalink?: (messageId: string) => void
  savedGifUrls: Set<string>
  onSaveGif: (url: string, author: string) => void
  isBookmarked: boolean
  onToggleBookmark: () => void
}) {
  if (editing) {
    return (
      <EditBox
        initial={editDraft}
        onCommit={(text) => void editMessage(room, msg.id, text)}
        onCancel={() => setEditingId(null)}
      />
    )
  }

  return (
    <>
      {msg.forwardedFromName && (
        <div className="flex items-center gap-1.5 mb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground/80 select-none">
          <Forward className="size-3 shrink-0" aria-hidden="true" />
          forwarded from <span className="text-foreground/80">@{msg.forwardedFromName}</span>
        </div>
      )}
      {msg.content && (
        <div className="chat-font leading-[1.4] text-foreground/95 break-words">
          {renderMessageContent(msg.content, {
            myUsername: meUsername,
            onMention: (username) => void openProfile(username),
            pingsEveryone: msg.pingsEveryone,
            onPermalink,
          })}
        </div>
      )}
      {msg.stickerUrl && (
        <div className="mt-0.5 -mb-1">
          <img
            src={msg.stickerUrl}
            alt={msg.stickerName ?? 'sticker'}
            loading="lazy"
            decoding="async"
            className="h-[140px] w-auto max-w-[min(280px,100%)] object-contain rounded-sm cursor-zoom-in hover:brightness-110 transition"
            onClick={() => setLightbox({ url: msg.stickerUrl!, author: msg.author.username })}
            aria-label={`sticker: ${msg.stickerName ?? ''}`}
          />
          {msg.stickerName && (
            <p className="mt-0.5 text-[10px] font-medium tracking-wide text-muted-foreground/70 select-none">
              {msg.stickerName}
            </p>
          )}
        </div>
      )}
      {msg.imageUrl && (
        <ImageUrlEmbed
          url={msg.imageUrl}
          author={msg.author.username}
          savedGifUrls={savedGifUrls}
          onSaveGif={onSaveGif}
          isBookmarked={isBookmarked}
          onToggleBookmark={onToggleBookmark}
          setLightbox={setLightbox}
        />
      )}
      {msg.attachments && msg.attachments.length > 0 && (
        <MessageAttachments
          attachments={msg.attachments}
          author={msg.author.username}
          room={room}
          onOpen={(url) => setLightbox({ url, author: msg.author.username })}
          savedGifUrls={savedGifUrls}
          onSaveGif={onSaveGif}
          isBookmarked={isBookmarked}
          onToggleBookmark={onToggleBookmark}
        />
      )}
      {/* THE VAULT: the ephemeral chunked file this row carries — live
          countdown, expired flip, blob download */}
      {msg.file && <VaultFileCard file={msg.file} />}
      {/* translation: the English rendering rides under the original. The
          rainbow belongs to the button that asks for it, not the words it
          returns, so the result stays quiet and readable */}
      {translation && (translation.loading || translation.text) && (
        <div className="mt-1.5 pl-2 border-l-2 border-white/10 text-foreground/80">
          {translation.loading ? (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Spinner className="size-3" />
              translating
            </div>
          ) : (
            <>
              <div className="chat-font leading-[1.4] break-words text-[13.5px] text-foreground/75">{translation.text}</div>
              <div className="text-[10px] mt-0.5 flex items-center gap-1 select-none text-muted-foreground">
                <Languages className="size-2.5 shrink-0" aria-hidden="true" />
                <span className="font-semibold">translated</span>
              </div>
            </>
          )}
        </div>
      )}
      {(msg.editedAt || msg.pinned) && (
        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
          {msg.editedAt && (msg.editHistory && msg.editHistory.length > 0 ? (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  className="inline-flex items-center gap-0.5 hover:text-foreground underline underline-offset-2 transition-colors"
                  aria-label="show edit history"
                >
                  edited {shortTime(msg.editedAt)}
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-72 rounded-sm p-0 overflow-hidden" aria-describedby={undefined}>
                <div className="px-3 py-2 flex items-center gap-1.5 border-b border-border">
                  <History className="size-3 text-muted-foreground" aria-hidden="true" />
                  <span className="text-[10px] font-bold tracking-widest text-muted-foreground">edit history</span>
                </div>
                <div className="max-h-64 overflow-y-auto scroll-thin">
                  {msg.editHistory.map((v, i) => (
                    <div key={`${v.at}-${i}`} className="px-3 py-2 border-b border-border/60 last:border-b-0">
                      <div className="text-[10px] text-muted-foreground mb-0.5">{shortTime(v.at)}</div>
                      <div className="chat-font text-[13px] leading-[1.4] text-foreground/90 break-words whitespace-pre-wrap">
                        {v.content}
                      </div>
                    </div>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          ) : (
            <span>edited {shortTime(msg.editedAt)}</span>
          ))}
          {msg.pinned && (
            <span className="flex items-center gap-0.5">
              <Pin className="size-2.5" /> pinned
            </span>
          )}
        </div>
      )}
    </>
  )
}

/** One toolbar per message: three quick emojis, reply, edit (own rows) or
 *  thread (other rows), and a kebab that opens the full context menu
 *  (everything else lives there).
 *  It parks where the pointer FIRST entered the row and never follows the
 *  mouse; it ramps from near-invisible to solid when the pointer heads
 *  toward it, and steps aside entirely after a quick reaction until the
 *  pointer re-enters the row. Pure DOM style mutation: zero re-renders. */
function MessageToolbar({
  msg,
  onReact,
  onMore,
  isOwn,
  onEdit,
}: {
  msg: ClientMessage
  onReact: (emoji: string) => void
  onMore: (anchor: DOMRect) => void
  isOwn: boolean
  onEdit: () => void
}) {
  const setReplyTo = useChatStore((s) => s.setReplyTo)
  const openThread = useChatStore((s) => s.openThread)
  const barRef = useRef<HTMLDivElement>(null)
  const dismissedRef = useRef(false)
  // quick reactions: ranked INSIDE the toolbar (only the hovered one is on
  // screen). Owning the ranking here means an emoji menu toggling never
  // re-renders the message list itself - the old root-level quickBar state
  // re-rendered every row on every picker open/close, which lagged the app.
  const [quickBar, setQuickBar] = useState<string[]>(() => mostUsedEmojis(3))
  useEffect(() => {
    const onMenu = () => {
      const next = mostUsedEmojis(3)
      setQuickBar((cur) => (cur.join('\u0000') === next.join('\u0000') ? cur : next))
    }
    window.addEventListener('hyperchat-emoji-menu', onMenu)
    return () => window.removeEventListener('hyperchat-emoji-menu', onMenu)
  }, [])

  /** Where the first text line actually ends: the bar must never cover
   *  words, but the text BLOCK spans the full row width, so block-edge
   *  clamping always dumped it into the top-right corner on text messages.
   *  The markdown renderer wraps each line in a block span, so the range
   *  must target the first TEXT NODE: its client rects are the real line
   *  boxes, and the bar parks beside the words wherever they stop. */
  function firstLineRight(row: HTMLElement): number | null {
    const textEl = row.querySelector('.chat-font') as HTMLElement | null
    if (!textEl) return null
    try {
      const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT)
      const firstTextNode = walker.nextNode() as Text | null
      const target: Node = firstTextNode ?? textEl
      const range = document.createRange()
      range.selectNode(target)
      const rects = Array.from(range.getClientRects())
      if (rects.length === 0) return textEl.getBoundingClientRect().right
      const minTop = Math.min(...rects.map((r) => r.top))
      const firstLine = rects.filter((r) => r.top <= minTop + 2)
      return Math.max(...firstLine.map((r) => r.right))
    } catch {
      return textEl.getBoundingClientRect().right
    }
  }

  /** A quick reaction just landed: hide the bar until the pointer leaves
   *  and re-enters the row, so the fresh chip is never stalked by buttons. */
  function dismiss() {
    dismissedRef.current = true
    barRef.current?.setAttribute('data-dismissed', '1')
  }

  function react(emoji: string) {
    dismiss()
    onReact(emoji)
  }

  useEffect(() => {
    const bar = barRef.current
    const row = bar?.closest('.msg-row') as HTMLElement | null
    if (!bar || !row) return

    const setAlpha = (v: string) => {
      if (!dismissedRef.current) bar.style.setProperty('--toolbar-alpha', v)
    }

    // parked at near-invisible until the pointer goes for it
    bar.style.setProperty('--toolbar-alpha', '0.4')

    /** Park once, beside the point where the pointer entered the row,
     *  clamped past the first line of message text. */
    const park = (entryX: number) => {
      const rowRect = row.getBoundingClientRect()
      const w = bar.offsetWidth || 240
      const rel = entryX - rowRect.left
      // entered over the right quarter: the classic top-right corner
      if (rel > rowRect.width - Math.max(w + 48, rowRect.width * 0.25)) {
        bar.style.left = 'auto'
        bar.style.right = '4px'
        return
      }
      // otherwise: just right of the entry point, but never on top of words
      let x = rel + 22
      const textRight = firstLineRight(row)
      if (textRight !== null && x < textRight - rowRect.left + 10) x = textRight - rowRect.left + 10
      const maxX = rowRect.width - w - 6
      x = Math.max(44, Math.min(x, maxX))
      if (x >= maxX) {
        bar.style.left = 'auto'
        bar.style.right = '4px'
      } else {
        bar.style.left = `${x}px`
        bar.style.right = 'auto'
      }
    }

    // contact ramp: the bar only goes solid while the pointer is INSIDE it
    // (a 3px grace absorbs edge jitter). Merely hovering near it keeps the
    // parked dim state — no more flickering between solid and ghost as the
    // pointer crosses some invisible proximity box. The one exception: an
    // open "more reactions" popover belongs to the bar, so reaching into it
    // counts as touching the bar. Closed-but-mounted pickers (the composer
    // prewarms one) never count — their parked rects can overlap rows.
    let near = false
    const onMove = (e: MouseEvent) => {
      const barRect = bar.getBoundingClientRect()
      const grace = 3
      let inside =
        e.clientX >= barRect.left - grace &&
        e.clientX <= barRect.right + grace &&
        e.clientY >= barRect.top - grace &&
        e.clientY <= barRect.bottom + grace
      if (!inside) {
        for (const pop of document.querySelectorAll('[data-radix-popper-content-wrapper]')) {
          const content = pop.firstElementChild
          if (!content || content.getAttribute('data-state') !== 'open') continue
          const r = pop.getBoundingClientRect()
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
            inside = true
            break
          }
        }
      }
      if (inside !== near) {
        near = inside
        setAlpha(inside ? '1' : '0.4')
      }
    }

    const onEnter = (e: MouseEvent) => {
      dismissedRef.current = false
      bar.removeAttribute('data-dismissed')
      park(e.clientX)
      near = false
      bar.style.setProperty('--toolbar-alpha', '0.4')
    }

    row.addEventListener('mouseenter', onEnter)
    row.addEventListener('mousemove', onMove)
    return () => {
      row.removeEventListener('mouseenter', onEnter)
      row.removeEventListener('mousemove', onMove)
    }
  }, [])

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="message actions"
      className="msg-toolbar absolute top-0.5 right-1 z-10 flex items-center gap-1 rounded-sm border border-white/10 bg-app-chat/95 p-1 shadow-md"
    >
      {quickBar.map((emoji) => (
        <button
          key={emoji}
          onClick={() => react(emoji)}
          className="size-9 grid place-items-center rounded-sm text-xl leading-none hover:scale-110 active:scale-90 hover:bg-accent transition-all"
          aria-label={`React ${emoji}`}
          title={`React ${emoji}`}
        >
          <EmojiText emoji={emoji} />
        </button>
      ))}
      <Popover>
        <PopoverTrigger asChild>
          <button
            className="size-8 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="more reactions"
            title="more reactions"
          >
            <SmilePlus className="size-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-auto p-1.5 rounded-sm data-[state=open]:animate-none data-[state=closed]:animate-none"
          aria-describedby={undefined}
        >
          <EmojiGrid onPick={react} />
        </PopoverContent>
      </Popover>
      <span className="mx-0.5 h-4 w-px shrink-0 bg-white/15" aria-hidden="true" />
      <button
        className="size-8 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        onClick={() => {
          setReplyTo(msg)
        }}
        aria-label="reply"
        title="reply"
      >
        <Reply className="size-4" />
      </button>
      {isOwn ? (
        // editing your own words is the most likely action: it sits where
        // the thread button used to (threads stay one click away in the
        // kebab menu for your own rows)
        <button
          className="size-8 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          onClick={onEdit}
          aria-label="edit message"
          title="edit message"
        >
          <Pencil className="size-4" />
        </button>
      ) : (
        <button
          className={cn(
            'size-8 grid place-items-center rounded-sm transition-colors',
            msg.threadCount ? 'text-hyper hover:bg-hyper/15' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
          )}
          onClick={() => void openThread(msg.id)}
          aria-label="reply in thread"
          title="reply in thread"
        >
          <MessagesSquare className="size-4" />
        </button>
      )}
      <button
        className="size-8 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        onClick={(e) => onMore(e.currentTarget.getBoundingClientRect())}
        aria-label="more actions"
        title="more actions"
      >
        <MoreHorizontal className="size-4" />
      </button>
    </div>
  )
}

/** 92s -> "1m 32s"; 3725s -> "1h 02m". */
function callDurationLabel(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ${String(sec % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** The call's chat row: "x started a call" while it lives (with a join
 *  button while the call still runs), the duration stamped on once it
 *  ends, or "missed call from x" when nobody answered. The caller alone
 *  can wipe it: a withdrawn attempt leaves no trace. */
function CallSystemRow({ msg, room, isLastCallRow }: { msg: ClientMessage; room: string; isLastCallRow: boolean }) {
  const conversationId = room.startsWith('conversation:') ? room.slice('conversation:'.length) : ''
  const me = useChatStore((s) => s.me)
  const liveCall = useChatStore((s) => (conversationId ? s.liveCalls[conversationId] : undefined))
  const activeCall = useChatStore((s) => s.activeCall)
  const joinCall = useChatStore((s) => s.joinCall)
  const deleteMessage = useChatStore((s) => s.deleteMessage)

  const data = msg.systemData
  const by = data?.by || data?.byUsername || msg.author.username
  const mine = msg.authorId === me?.id || data?.byUserId === me?.id
  const missed = data?.missed === true
  const duration = typeof data?.durationSec === 'number' ? data.durationSec : null
  const live = !!liveCall
  const inThisCall = !!activeCall && activeCall.conversationId === conversationId

  return (
    <div className="w-full flex items-center justify-start gap-2 px-3 sm:px-4 py-1.5 select-none system-row group/call">
      {missed ? (
        <PhoneMissed className="size-3.5 shrink-0 text-red-400/80" aria-hidden="true" />
      ) : data?.video ? (
        <Video className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
      ) : (
        <Phone className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
      )}
      <span className="text-xs text-muted-foreground">
        {missed
          ? `missed call from ${by}`
          : `${by} started a call${duration !== null ? ` · ${callDurationLabel(duration)}` : ''}`}
      </span>
      {live && isLastCallRow && !inThisCall && (
        <button
          type="button"
          onClick={() => {
            sounds.play('callEnter')
            void joinCall(conversationId)
          }}
          className="px-2 py-0.5 rounded-full bg-emerald-400/15 border border-emerald-400/30 text-[10px] font-bold text-emerald-300 hover:bg-emerald-400/25 transition-colors"
          aria-label="join the ongoing call"
        >
          join
        </button>
      )}
      {live && isLastCallRow && inThisCall && (
        <span className="px-2 py-0.5 rounded-full bg-emerald-400/10 border border-emerald-400/20 text-[10px] font-bold text-emerald-300/90 flex items-center gap-1">
          <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
          live
        </span>
      )}
      {mine && (
        <button
          type="button"
          onClick={() => {
            sounds.play('lightTick')
            void deleteMessage(room, msg.id)
          }}
          className="grid place-items-center size-5 rounded-sm text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover/call:opacity-100 focus-visible:opacity-100 transition-all"
          aria-label="delete this call message"
          title="delete - they will never know you called"
        >
          <Trash2 className="size-3" />
        </button>
      )}
    </div>
  )
}

export function MessageList({ room }: { room: string }) {
  const roomState = useChatStore((s) => s.rooms[room])
  const me = useChatStore((s) => s.me)
  const loadOlder = useChatStore((s) => s.loadOlder)
  const deleteMessage = useChatStore((s) => s.deleteMessage)
  const editMessage = useChatStore((s) => s.editMessage)
  const toggleReaction = useChatStore((s) => s.toggleReaction)
  const toggleBookmark = useChatStore((s) => s.toggleBookmark)
  const togglePin = useChatStore((s) => s.togglePin)
  const setReplyTo = useChatStore((s) => s.setReplyTo)
  const retryMessage = useChatStore((s) => s.retryMessage)
  const discardMessage = useChatStore((s) => s.discardMessage)
  const bookmarks = useChatStore((s) => s.bookmarks)
  const createReminder = useChatStore((s) => s.createReminder)
  const typingUsers = useChatStore((s) => s.typing[room])
  const otherReadAt = useChatStore((s) => s.otherReadAt)
  const setRoomAtBottom = useChatStore((s) => s.setRoomAtBottom)
  // group read receipts: the conversation (kind + participant faces) and
  // this conversation's per-reader stamps (groups only; DMs have none)
  const conversations = useChatStore((s) => s.conversations)
  const groupReadStamps = useChatStore((s) =>
    room.startsWith('conversation:') ? s.groupReadAt[room.slice('conversation:'.length)] : undefined
  )
  // channel read receipts (friends only): my friends' latest read stamps
  // for THIS channel + the server member list to resolve their faces
  const channelFriendStamps = useChatStore((s) =>
    room.startsWith('channel:') ? s.channelFriendReadAt[room.slice('channel:'.length)] : undefined
  )
  const activeServerId = useChatStore((s) => s.activeServerId)
  const serverMembers = useChatStore((s) => (activeServerId ? s.serverMembers[activeServerId] : undefined))
  const servers = useChatStore((s) => s.servers)
  const openProfile = useChatStore((s) => s.openProfile)
  const setPinsOpen = useChatStore((s) => s.setPinsOpen)
  const setRemindersOpen = useChatStore((s) => s.setRemindersOpen)
  const jumpTarget = useChatStore((s) => s.jumpTarget)
  const jumpToMessage = useChatStore((s) => s.jumpToMessage)
  const requestPresent = useChatStore((s) => s.requestPresent)
  const presentRequest = useChatStore((s) => s.presentRequest)
  // reply-jump return pill: where the viewer stood before the last jump
  const returnPoint = useChatStore((s) => s.returnPoint)
  const setReturnPoint = useChatStore((s) => s.setReturnPoint)
  const clearReturnPoint = useChatStore((s) => s.clearReturnPoint)
  const editRequest = useChatStore((s) => s.editRequest)
  const blockedUserIds = useChatStore((s) => s.blockedUserIds)
  const openThread = useChatStore((s) => s.openThread)
  const openThreadId = useChatStore((s) => s.openThreadId)
  const setForwardTarget = useChatStore((s) => s.setForwardTarget)
  const translateMessage = useChatStore((s) => s.translateMessage)
  const translations = useChatStore((s) => s.translations)
  const [revealedBlocked, setRevealedBlocked] = useState<Record<string, boolean>>({})

  // locally hidden rows: "remove for me" on other people's messages
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    const t = setTimeout(() => setHiddenIds(loadHiddenIds()), 0)
    return () => clearTimeout(t)
  }, [])

  const messages = useMemo(
    () => (roomState?.messages ?? []).filter((m) => !hiddenIds.has(m.id) && !m.threadOfId),
    [roomState?.messages, hiddenIds]
  )
  const isDM = room.startsWith('conversation:')

  // snapshot the read stamp at room entry so the NEW divider stays put
  const [unreadAfter, setUnreadAfter] = useState<number | null>(null)
  const [enteredRoom, setEnteredRoom] = useState<string | null>(null)
  if (room !== enteredRoom) {
    setEnteredRoom(room)
    const stamp = roomState?.myReadAt ?? null
    setUnreadAfter(stamp ? new Date(stamp).getTime() : null)
  }

  const entries = useMemo(
    () => buildEntries(messages, unreadAfter && unreadAfter > 0 ? unreadAfter : null),
    [messages, unreadAfter]
  )

  // only the newest call row carries the live join chip: older rows are
  // history, not doors
  const lastCallRowId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].systemKind === 'call') return messages[i].id
    }
    return null
  }, [messages])

  const server = servers.find((s) => s.id === activeServerId)
  const canPin = isDM || (server ? (server.myPerms & (PERM.ADMINISTRATOR | PERM.MANAGE_MESSAGES)) !== 0 : false)
  const canDeleteAny = isDM ? false : (server ? (server.myPerms & (PERM.ADMINISTRATOR | PERM.MANAGE_MESSAGES)) !== 0 : false)

  // read receipt: "seen" rides under THE LAST MESSAGE OF MINE THEY READ,
  // not my newest one — so it keeps marking the same row even after I keep
  // typing, and slides forward only when they actually catch up
  const conversationId = isDM ? room.slice('conversation:'.length) : null
  const otherRead = conversationId ? otherReadAt[conversationId] : null
  const lastReadMessageId = useMemo(() => {
    if (!isDM || !otherRead || !me) return null
    const t = new Date(otherRead).getTime()
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.authorId !== me.id) continue
      if (new Date(m.createdAt).getTime() <= t) return m.id
    }
    return null
  }, [messages, me, otherRead, isDM])

  // group read receipts: per reader, the LAST of my messages their stamp
  // covers (the per-reader version of lastReadMessageId above), grouped
  // under that message — earliest reader first. DM receipts keep the plain
  // Check above; unknown conversations fall back to the DM path too
  const conversation = conversationId ? conversations.find((c) => c.id === conversationId) : undefined
  const isGroupConv = conversation?.kind === 'GROUP'
  const groupReceipts = useMemo(() => {
    if (!isGroupConv || !me || !groupReadStamps) return null
    const byMessage = new Map<string, { userId: string; at: number }[]>()
    for (const [userId, stamp] of Object.entries(groupReadStamps)) {
      if (userId === me.id) continue
      const t = new Date(stamp).getTime()
      if (!Number.isFinite(t)) continue
      let covered: string | null = null
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.authorId !== me.id) continue
        if (new Date(m.createdAt).getTime() <= t) {
          covered = m.id
          break
        }
      }
      if (!covered) continue
      const list = byMessage.get(covered) ?? []
      list.push({ userId, at: t })
      byMessage.set(covered, list)
    }
    for (const list of byMessage.values()) list.sort((a, b) => a.at - b.at)
    return byMessage
  }, [isGroupConv, me, groupReadStamps, messages])

  // channel read receipts (friends only): same shape as the group map —
  // per friend, the last of MY channel messages their read stamp covers;
  // grouped under that message. The stamp set is already friends-only on
  // both ends (server seeds friends who are members; live updates filter
  // to friends in onChannelRead), so no extra filtering happens here.
  const isChannel = room.startsWith('channel:')
  const channelReceipts = useMemo(() => {
    if (!isChannel || !me || !channelFriendStamps) return null
    const byMessage = new Map<string, { userId: string; at: number }[]>()
    for (const [userId, stamp] of Object.entries(channelFriendStamps)) {
      if (userId === me.id) continue
      const t = new Date(stamp).getTime()
      if (!Number.isFinite(t)) continue
      let covered: string | null = null
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.authorId !== me.id) continue
        if (new Date(m.createdAt).getTime() <= t) {
          covered = m.id
          break
        }
      }
      if (!covered) continue
      const list = byMessage.get(covered) ?? []
      list.push({ userId, at: t })
      byMessage.set(covered, list)
    }
    for (const list of byMessage.values()) list.sort((a, b) => a.at - b.at)
    return byMessage
  }, [isChannel, me, channelFriendStamps, messages])

  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const prevCountRef = useRef(0)
  const prevHeightRef = useRef(0)
  const missedWhileAwayRef = useRef(0)
  const prevRoomRef = useRef<string | null>(null)
  // while this timestamp is in the future, scroll events belong to the app
  // (jump glide, room swap, history-prepend compensation), not the user —
  // the return pill must survive its own jump
  const progScrollUntilRef = useRef(0)
  // a return-pill click into a swapped history window: the exact scrollTop
  // to land on once the newest page is restored
  const pendingReturnTopRef = useRef<number | null>(null)
  // long-press on a message row opens its context menu on touch screens
  // (Android fires contextmenu natively; iOS needs the manual timer)
  const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearLongPress = () => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current)
      longPressRef.current = null
    }
  }
  const onRowTouchStart = (msg: ClientMessage) => (e: React.TouchEvent) => {
    // touches born on interactive children (reactions, links, embeds,
    // the toolbar itself) belong to those children, not the row gesture
    const target = e.target as HTMLElement
    if (target.closest('button, a, input, textarea, [role="button"], img, video')) return
    const t = e.touches[0]
    const x = t.clientX
    const y = t.clientY
    clearLongPress()
    longPressRef.current = setTimeout(() => {
      longPressRef.current = null
      if (msg.pending || msg.failed || msg.systemKind) return
      // a tiny buzz sells the long-press on phones that support it
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try {
          navigator.vibrate(12)
        } catch {
          // vibration is a courtesy, never a requirement
        }
      }
      openRowMenu(msg, { x, y })
    }, 460)
  }

  const [lightbox, setLightbox] = useState<{ url: string; author: string } | null>(null)
  // lightbox downloads ride the same iframe-safe helper as the attachment chips
  const safeDownload = useSafeDownload()
  // device-pixel snap for the lightbox media: runs on load and after each
  // contain <-> fill toggle (the 150ms transition must settle first)
  const lightboxImgRef = useRef<HTMLImageElement | null>(null)
  const snapLightbox = () => {
    setTimeout(() => {
      const el = lightboxImgRef.current
      if (!el) return
      const dpr = window.devicePixelRatio || 1
      const rect = el.getBoundingClientRect()
      if (rect.width > 0) el.style.width = `${Math.round(rect.width * dpr) / dpr}px`
      if (rect.height > 0) el.style.height = `${Math.round(rect.height * dpr) / dpr}px`
    }, 200)
  }
  // click-the-media toggles centered <-> fill-the-screen; reset per open
  const [lightboxFilled, setLightboxFilled] = useState(false)
  const openLightbox = (l: { url: string; author: string } | null) => {
    if (!l) {
      setLightbox(null)
      return
    }
    setLightboxFilled(false)
    setLightbox(l)
  }
  // gifs kept from chat: url-level store state shared by the in-chat
  // banners, the lightbox and the picker's saved tab. toggling is optimistic
  // (click again on a saved gif to unsave it)
  const savedGifs = useChatStore((s) => s.savedGifs)
  const toggleSavedGif = useChatStore((s) => s.toggleSavedGif)
  const savedGifUrls = useMemo(() => new Set(savedGifs.map((g) => g.url)), [savedGifs])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [showJump, setShowJump] = useState(false)
  // mini profile card anchored to a clicked avatar
  const [miniProfile, setMiniProfile] = useState<{ username: string; rect: DOMRect } | null>(null)
  // note: no quickBar state here on purpose - each MessageToolbar owns its
  // own ranking so emoji-menu toggles never re-render the whole list

  // fake-sent pending rows: an optimistic send looks fully sent; only when
  // the server has not confirmed it after ~2 seconds does the row dim and
  // show a quiet "sending" marker. The row list swaps temp ids for real ones
  // on confirmation, so stale timer entries are pruned alongside
  const [slowPendingIds, setSlowPendingIds] = useState<Set<string>>(new Set())
  const pendingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  useEffect(() => {
    const liveIds = new Set(messages.filter((m) => m.pending).map((m) => m.id))
    for (const id of liveIds) {
      if (!pendingTimers.current.has(id)) {
        pendingTimers.current.set(
          id,
          setTimeout(() => {
            setSlowPendingIds((prev) => new Set(prev).add(id))
          }, 2000)
        )
      }
    }
    for (const [id, t] of pendingTimers.current) {
      if (!liveIds.has(id)) {
        clearTimeout(t)
        pendingTimers.current.delete(id)
      }
    }
    setSlowPendingIds((prev) => {
      const kept = new Set([...prev].filter((id) => liveIds.has(id)))
      return kept.size === prev.size ? prev : kept
    })
    return () => {
      for (const t of pendingTimers.current.values()) clearTimeout(t)
      pendingTimers.current.clear()
    }
  }, [messages])

  const bookmarkedIds = useMemo(() => new Set(bookmarks.map((b) => b.message.id)), [bookmarks])

  // track whether the user is parked at the bottom; near the top the
  // older-history fetch kicks in by itself so scrolling up just flows
  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottom.current = distance < 120
    // the honest read gate consults this. a permalink window parked on
    // history is never "at the newest messages", even when its own bottom
    // edge is on screen. the action no-ops when the value is unchanged, so
    // scroll spam never re-renders
    setRoomAtBottom(room, stickToBottom.current && !roomState?.hasNewer)
    setShowJump(distance > 300)
    // the return pill dies once the viewer wanders far from the captured
    // spot on their own. two comparisons, no layout reads — cheap enough
    // for every scroll tick; app-driven scrolls are excluded via the guard
    // timestamp so the jump itself never kills its own pill
    if (
      returnPoint &&
      returnPoint.room === room &&
      Date.now() > progScrollUntilRef.current &&
      Math.abs(el.scrollTop - returnPoint.scrollTop) > 600
    ) {
      clearReturnPoint()
    }
    if (el.scrollTop < 500 && roomState?.loaded && roomState.hasMore && !roomState.loadingMore) {
      void loadOlder(room)
    }
  }

  // bottom-parking report for the honest read gate: sync on room change and
  // whenever the permalink-window state flips (the pane remounts per room;
  // the room-switch layout effect lands on the newest message before
  // passive effects run, so the ref already holds the fresh value). every
  // later flip flows through handleScroll above
  useEffect(() => {
    setRoomAtBottom(room, stickToBottom.current && !roomState?.hasNewer)
  }, [room, roomState?.hasNewer, setRoomAtBottom])

  /** remember where the viewer stands before a reply/permalink jump, so
   *  the floating return pill can bring them back. only meaningful jumps
   *  count (parked deep in the list, not at the top), and a chain of jumps
   *  keeps the FIRST departure point of this room — discord-style */
  const captureReturnPoint = useCallback(() => {
    const el = scrollRef.current
    if (!el || el.scrollTop <= 400) return
    const cur = useChatStore.getState().returnPoint
    if (cur?.room === room) return
    setReturnPoint(room, el.scrollTop)
  }, [room, setReturnPoint])

  /** the return pill (and escape): glide back to the captured spot and
   *  spend the point. when the jump swapped the list to a history window,
   *  restore the newest page first and land on the captured spot after */
  const performReturn = useCallback(() => {
    const rp = useChatStore.getState().returnPoint
    if (!rp || rp.room !== room) return
    clearReturnPoint()
    sounds.play('lightTick')
    const el = scrollRef.current
    if (!el) return
    if (roomState?.hasNewer) {
      pendingReturnTopRef.current = rp.scrollTop
      requestPresent(room)
    } else {
      el.scrollTo({ top: rp.scrollTop, behavior: 'smooth' })
    }
  }, [room, roomState?.hasNewer, clearReturnPoint, requestPresent])

  // escape works like the pill while it is in view; menus, dialogs and
  // text inputs keep their own escape behavior
  useEffect(() => {
    if (!returnPoint || returnPoint.room !== room) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, [contenteditable="true"], [role="menu"]')) return
      if (document.querySelector('[role="menu"], [role="dialog"][data-state="open"]')) return
      e.preventDefault()
      performReturn()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [returnPoint, room, performReturn])

  // short first page (viewport taller than the content): the scroll event
  // never fires, so the first auto-load has to be kicked off directly
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !roomState?.loaded || !roomState.hasMore || roomState.loadingMore) return
    if (el.scrollHeight <= el.clientHeight + 40) void loadOlder(room)
  }, [room, roomState?.loaded, roomState?.hasMore, roomState?.loadingMore, loadOlder])

  // new message: follow the bottom if the user was there. Same-length list
  // updates (reactions, edits, presence, sync refreshes) must NEVER touch the
  // viewport: the old catch-all else branch snapped the list to the bottom on
  // nearly every button press, which read as "buttons scroll me down".
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (room !== prevRoomRef.current) {
      // room switch: land on the newest message and re-arm the follow behavior
      prevRoomRef.current = room
      progScrollUntilRef.current = Date.now() + 1600
      el.scrollTop = el.scrollHeight
      stickToBottom.current = true
      missedWhileAwayRef.current = 0
      prevCountRef.current = messages.length
      prevHeightRef.current = el.scrollHeight
      return
    }
    if (messages.length > prevCountRef.current) {
      if (stickToBottom.current) {
        el.scrollTop = el.scrollHeight
      } else {
        missedWhileAwayRef.current += messages.length - prevCountRef.current
      }
    }
    prevCountRef.current = messages.length
    // NOTE: no height write here — the prepend-anchor effect below owns
    // prevHeightRef; clobbering it here would break scroll compensation
  }, [messages, room])

  // keep position steady when older messages get prepended
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (roomState?.loadingMore) return
    if (el.scrollHeight > prevHeightRef.current && !stickToBottom.current) {
      progScrollUntilRef.current = Date.now() + 400
      el.scrollTop += el.scrollHeight - prevHeightRef.current
    }
    prevHeightRef.current = el.scrollHeight
  }, [roomState?.loadingMore, messages.length])

  // late-arriving content must not strand a bottom-parked reader: GIFs and
  // images finish loading seconds after their row lands, reactions and edit
  // chips grow rows in place. When the content box resizes and the reader
  // was at the bottom, re-pin the bottom instead of letting the viewport
  // drift up (the new-message effect only covers count changes, not height
  // changes on the same rows).
  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [room])

  // jump to a message (from search, pins, saved, replies or permalinks):
  // scroll + flash. The target row may not exist yet right after a room
  // swap while messages are still fetching, so the effect re-runs on every
  // list change while the request is fresh instead of failing silently.
  const jumpHandledAtRef = useRef(0)
  useEffect(() => {
    if (!jumpTarget || jumpTarget.room !== room) return
    if (jumpHandledAtRef.current === jumpTarget.at) return
    if (Date.now() - jumpTarget.at > 8000) {
      jumpHandledAtRef.current = jumpTarget.at
      return
    }
    const el = document.querySelector(`[data-mid="${jumpTarget.messageId}"]`)
    if (!el) return // not rendered yet: the messages dep retries this
    jumpHandledAtRef.current = jumpTarget.at
    progScrollUntilRef.current = Date.now() + 1600
    el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el.classList.add('flash-highlight')
    setTimeout(() => el.classList.remove('flash-highlight'), 2400)
  }, [jumpTarget?.at, room, messages])

  // return-to-present: after a permalink window swap, land at the bottom
  // (or at the return pill's captured spot when the pill drove the swap)
  useEffect(() => {
    if (!presentRequest || presentRequest.room !== room) return
    const el = scrollRef.current
    const top = pendingReturnTopRef.current
    pendingReturnTopRef.current = null
    if (el) el.scrollTo({ top: top ?? el.scrollHeight })
    missedWhileAwayRef.current = 0
  }, [presentRequest?.at, room])

  // ArrowUp edit-last-message request from the input (render-phase adjust:
  // derives editing state straight from the request instead of an effect)
  const [lastEditAt, setLastEditAt] = useState(0)
  if (editRequest && editRequest.at !== lastEditAt) {
    setLastEditAt(editRequest.at)
    const msg = messages.find((m) => m.id === editRequest.messageId)
    if (msg?.content) {
      setEditDraft(msg.content)
      setEditingId(msg.id)
    }
  }

  const typingNames = Object.entries(typingUsers || {})
    .filter(([userId]) => userId !== me?.id)
    .map(([, info]) => info.username)

  function copyMessage(msg: ClientMessage) {
    const text = msg.content ?? ''
    void navigator.clipboard?.writeText(text)
    sounds.play('glassTick')
  }

  /** Copy a permalink to this message; pasting it back into any chat turns
   *  the link into a live jump. */
  function copyMessageLink(msg: ClientMessage) {
    const link = `${window.location.origin}/#msg=${msg.id}`
    void navigator.clipboard?.writeText(link)
    sounds.play('glassTick')
  }

  /** The full message menu: right-click on a row, or the toolbar kebab. */
  // the newest message row keeps its quick-action toolbar pinned open on
  // touch screens (hover never happens there): long-press covers the rest
  const lastRowId = (() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e2 = entries[i]
      if (e2.kind === 'message' && !e2.msg.pending && !e2.msg.failed && !e2.msg.systemKind) return e2.msg.id
    }
    return null
  })()

  function openRowMenu(msg: ClientMessage, at: { x: number; y: number }) {
    const fakeEvent = {
      preventDefault: () => {},
      stopPropagation: () => {},
      clientX: Math.min(at.x, window.innerWidth - 240),
      clientY: Math.min(at.y, window.innerHeight - 360),
    } as React.MouseEvent
    openContextMenu(
      fakeEvent,
      [
        {
          kind: 'item',
          label: 'add reaction',
          icon: SmilePlus,
          onSelect: () =>
            openEmojiPop(at.x, at.y, (emoji) => {
              rememberQuickUse(emoji)
              void toggleReaction(room, msg.id, emoji)
            }),
        },
        { kind: 'item', label: 'reply', icon: Reply, onSelect: () => setReplyTo(msg) },
        { kind: 'item', label: 'reply in thread', icon: MessagesSquare, onSelect: () => void openThread(msg.id) },
        { kind: 'item', label: 'forward', icon: Forward, onSelect: () => setForwardTarget(msg) },
        ...(msg.content
          ? [{ kind: 'item' as const, label: 'translate', icon: Languages, rainbow: true, onSelect: () => void translateMessage(msg.id, msg.content ?? '') }] : []),
        ...(msg.content
          ? [{ kind: 'item' as const, label: 'copy text', icon: Copy, onSelect: () => copyMessage(msg) }] : []),
        { kind: 'item', label: 'copy link', icon: Link2, onSelect: () => copyMessageLink(msg) },
        {
          kind: 'item',
          label: bookmarkedIds.has(msg.id) ? 'remove from saved' : 'save message',
          icon: bookmarkedIds.has(msg.id) ? BookmarkCheck : Bookmark,
          onSelect: () => {
            sounds.play('midTick')
            void toggleBookmark(msg.id)
          },
        },
        ...(canPin
          ? [{ kind: 'item' as const, label: msg.pinned ? 'unpin' : 'pin', icon: msg.pinned ? PinOff : Pin, onSelect: () => void togglePin(room, msg.id, msg.pinned) }] : []),
        { kind: 'separator' },
        { kind: 'item', label: 'remind me', icon: BellRing, onSelect: () => void remindAbout(msg) },
        ...(me && msg.authorId === me.id && msg.content
          ? [
              { kind: 'item' as const, label: 'edit', icon: Pencil, onSelect: () => { setEditDraft(msg.content ?? ''); setEditingId(msg.id) } },
            ] : []),
        ...(me && msg.authorId !== me.id
          ? [{ kind: 'item' as const, label: 'hide for me', icon: EyeOff, onSelect: () => { setHiddenIds(hideMessageForMe(msg.id)) } }] : []),
        ...(me && (msg.authorId === me.id || canDeleteAny)
          ? [{ kind: 'item' as const, label: 'delete', icon: Trash2, danger: true, onSelect: () => void deleteMessage(room, msg.id) }] : []),
      ],
      { title: msg.authorNickname || msg.author.displayName || msg.author.username, subtitle: shortTime(msg.createdAt) }
    )
  }

  /** Record a reaction use in the recents/usage stats. The quick bar does
   *  not re-rank here: only menu open/close events recompute it. */
  function rememberQuickUse(emoji: string) {
    rememberRecent(emoji)
    rememberUsage(emoji)
  }

  /** Remind me about this message: quick presets in a context menu. */
  function remindAbout(msg: ClientMessage) {
    const now = Date.now()
    const presets = [
      { label: 'in 10 minutes', ms: 10 * 60 * 1000 },
      { label: 'in 1 hour', ms: 60 * 60 * 1000 },
      { label: 'in 3 hours', ms: 3 * 60 * 60 * 1000 },
      { label: 'tomorrow', ms: 24 * 60 * 60 * 1000 },
    ]
    // reuse the context menu at the pointer's last known position
    const fakeEvent = {
      preventDefault: () => {},
      stopPropagation: () => {},
      clientX: window.innerWidth / 2 - 110,
      clientY: window.innerHeight / 2 - 80,
    } as React.MouseEvent
    openContextMenu(
      fakeEvent,
      [
        ...presets.map((p) => ({
          kind: 'item' as const,
          label: p.label,
          icon: BellRing,
          onSelect: () => {
            void createReminder(msg.id, new Date(now + p.ms))
            sounds.play('midTick')
          },
        })),
        { kind: 'separator' as const },
        {
          kind: 'item' as const,
          label: 'all reminders',
          icon: BellRing,
          onSelect: () => setRemindersOpen(true),
        },
      ],
      { title: 'remind me', subtitle: (msg.content ?? 'image').slice(0, 40) }
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto scroll-thin px-3 sm:px-4 py-4"
        role="log"
        aria-live="polite"
        aria-label="messages"
      >
        {/* history top: skeletons while older messages stream in, a quiet
            marker once the beginning is reached. The fetch itself fires from
            the scroll handler the moment the top comes near. */}
        {roomState?.loaded && roomState.loadingMore && (
          <div className="pb-3 space-y-3" aria-hidden="true">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex gap-3 items-start px-1 animate-pulse" style={{ opacity: 1 - i * 0.14 }}>
                <div className="size-9 rounded-sm bg-app-raise shrink-0" />
                <div className="flex-1 space-y-1.5 pt-1">
                  <div className="h-2.5 w-28 rounded-sm bg-app-raise/80" />
                  <div className="h-2.5 rounded-sm bg-app-raise/70" style={{ width: `${58 + ((i * 13) % 30)}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
        {roomState?.loaded && !roomState.hasMore && messages.length > 0 && (
          <div className="flex items-center gap-3 pb-4 select-none">
            <span className="text-[10px] font-semibold tracking-widest text-muted-foreground shrink-0">beginning</span>
            <span className="flex-1 h-px bg-border" />
          </div>
        )}

        {/* first open of a room this session: rows stream in the moment the
            fetch resolves; until then a light skeleton keeps the layout from
            flashing empty (cached rooms skip this entirely) */}
        {!roomState?.loaded && (
          <div className="space-y-3 pt-2" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex gap-3 items-start animate-pulse" style={{ opacity: 1 - i * 0.13 }}>
                <div className="size-9 rounded-sm bg-app-raise shrink-0" />
                <div className="flex-1 space-y-1.5 pt-1">
                  <div className="h-2.5 w-28 rounded-sm bg-app-raise/80" />
                  <div className="h-2.5 rounded-sm bg-app-raise/70" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}

        {roomState?.loaded && messages.length === 0 && (
          <div className="h-full grid place-items-center">
            <div className="text-center max-w-sm">
              <h2 className="text-lg font-bold tracking-tight">this is the start of the conversation</h2>
            </div>
          </div>
        )}

        <div className="space-y-0.5" ref={contentRef}>
          {entries.map((entry) =>
            entry.kind === 'divider' ? (
              <div key={entry.key} className="flex items-center gap-3 my-3 select-none">
                <span className="text-xs font-semibold text-muted-foreground shrink-0">{entry.label}</span>
                <span className="flex-1 h-px bg-border" />
              </div>
            ) : entry.kind === 'unread' ? (
              <div key={entry.key} className="flex items-center gap-2 my-3 select-none" aria-label="new messages below">
                <span className="text-[10px] font-bold tracking-widest text-hyper shrink-0">new</span>
                <span className="flex-1 h-px bg-hyper/70" />
              </div>
            ) : (
              <div
                key={entry.key}
                data-mid={entry.msg.id}
                className={cn(
                  'group relative flex gap-3 rounded-sm px-2 -mx-1 msg-row',
                  entry.grouped ? 'py-px grouped' : 'pt-2.5 pb-0.5 leader',
                  'hover:bg-white/[0.03]',
                  entry.msg.whisperTargetId && 'whisper-row',
                  // fake-sent: a pending row looks delivered; only a slow one
                  // greys out so short sends never flash a loading state
                  entry.msg.pending && slowPendingIds.has(entry.msg.id) && 'msg-pending opacity-70',
                  entry.msg.failed && 'msg-failed',
                  blockedUserIds[entry.msg.authorId] && !revealedBlocked[entry.msg.id] && 'opacity-60'
                )}
                data-last={entry.msg.id === lastRowId || undefined}
                onContextMenu={(e) => {
                  // always kill the native browser menu on message rows, even
                  // for pending/system rows where we show nothing instead
                  e.preventDefault()
                  if (entry.msg.pending || entry.msg.failed) return
                  if (entry.msg.systemKind) return
                  openRowMenu(entry.msg, { x: e.clientX, y: e.clientY })
                }}
                onTouchStart={onRowTouchStart(entry.msg)}
                onTouchMove={clearLongPress}
                onTouchEnd={clearLongPress}
                onTouchCancel={clearLongPress}
              >
                {entry.msg.systemKind === 'call' ? (
                  <CallSystemRow msg={entry.msg} room={room} isLastCallRow={entry.msg.id === lastCallRowId} />
                ) : entry.msg.systemKind ? (
                  <div className="w-full flex items-center justify-center gap-1.5 py-1 select-none system-row">
                    {entry.msg.systemKind === 'pin' ? (
                      <Pin className="size-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
                    ) : (
                      <PinOff className="size-3 shrink-0 text-muted-foreground/60" aria-hidden="true" />
                    )}
                    <button
                      onClick={() => {
                        sounds.play('lightTick')
                        setPinsOpen(true)
                      }}
                      className="text-xs text-muted-foreground hover:text-hyper transition-colors"
                    >
                      {entry.msg.systemData?.byUsername || entry.msg.author.username}{' '}
                      {entry.msg.systemKind === 'pin' ? 'pinned a message' : 'unpinned a message'}
                    </button>
                    <button
                      onClick={() => {
                        sounds.play('lightTick')
                        setPinsOpen(true)
                      }}
                      className="text-[10px] text-hyper/70 hover:text-hyper underline underline-offset-2 transition-colors"
                    >
                      view pins
                    </button>
                  </div>
                ) : blockedUserIds[entry.msg.authorId] && !revealedBlocked[entry.msg.id] ? (
                  <div className="py-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="size-1.5 rounded-full bg-muted-foreground/50" aria-hidden="true" />
                    message from a blocked user
                    <button
                      onClick={() => setRevealedBlocked((m) => ({ ...m, [entry.msg.id]: true }))}
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      show it
                    </button>
                  </div>
                ) : blockedUserIds[entry.msg.authorId] && revealedBlocked[entry.msg.id] ? (
                  <div className="w-full">
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground mb-0.5">
                      <span className="size-1.5 rounded-full bg-muted-foreground/50" aria-hidden="true" />
                      blocked
                      <button
                        onClick={() =>
                          setRevealedBlocked((m) => {
                            const next = { ...m }
                            delete next[entry.msg.id]
                            return next
                          })
                        }
                        className="underline underline-offset-2 hover:text-foreground"
                      >
                        hide
                      </button>
                    </div>
                    <div className="opacity-70">
                      <MessageBody
                        msg={entry.msg}
                        meUsername={me?.username}
                        openProfile={openProfile}
                        editing={editingId === entry.msg.id}
                        editDraft={editDraft}
                        setEditingId={setEditingId}
                        editMessage={editMessage}
                        room={room}
                        setLightbox={openLightbox}
                        onPermalink={(messageId) => {
                          captureReturnPoint()
                          void jumpToMessage(messageId)
                        }}
                        savedGifUrls={savedGifUrls}
                        onSaveGif={(url, author) => void toggleSavedGif(url, `gif from ${author}`)}
                        isBookmarked={bookmarkedIds.has(entry.msg.id)}
                        onToggleBookmark={() => void toggleBookmark(entry.msg.id)}
                      />
                    </div>
                  </div>
                ) : (
                  <>
                    {entry.grouped ? (
                      <span
                        className="w-8 shrink-0 hidden sm:block text-right leading-none self-center"
                        aria-hidden="true"
                      >
                        {bookmarkedIds.has(entry.msg.id) ? (
                          // saved rows carry the mark in the gutter, always on
                          <Bookmark className="size-3 fill-hyper text-hyper" />
                        ) : (
                          <span className="text-[9px] text-muted-foreground/0 group-hover:text-muted-foreground/80 transition-colors tabular-nums whitespace-nowrap">
                            {shortTime(entry.msg.createdAt)}
                          </span>
                        )}
                      </span>
                    ) : (
                      <Avatar
                        name={entry.msg.author.username}
                        color={entry.msg.author.avatarColor}
                        url={entry.msg.author.avatarUrl}
                        size="md"
                        className="avatar-hover cursor-pointer"
                        onClick={(e) =>
                          setMiniProfile({
                            username: entry.msg.author.username,
                            rect: e.currentTarget.getBoundingClientRect(),
                          })
                        }
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      {!entry.grouped && (
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <button
                            className="text-[15px] font-bold tracking-tight hover:underline underline-offset-2 msg-author-name"
                            style={entry.msg.authorRoleColor ? { color: entry.msg.authorRoleColor } : undefined}
                            onClick={() => void openProfile(entry.msg.author.username)}
                          >
                            {entry.msg.authorNickname || entry.msg.author.displayName || entry.msg.author.username}
                          </button>
                          <span className="text-[11px] text-muted-foreground">
                            {messageTimestamp(entry.msg.createdAt)}
                          </span>
                          {bookmarkedIds.has(entry.msg.id) && (
                            <span
                              className="flex items-center gap-0.5 text-hyper"
                              title="saved"
                              aria-label="saved message"
                            >
                              <Bookmark className="size-3 fill-hyper text-hyper" aria-hidden="true" />
                            </span>
                          )}
                        </div>
                      )}

                      <ReplyContext
                        msg={entry.msg}
                        onJump={() => {
                          // deep history covered: jumpToMessage resolves the
                          // room and loads a window around the target when the
                          // original is not in the current page. remember
                          // where we stand so the return pill can bring us back
                          captureReturnPoint()
                          if (entry.msg.replyTo) void jumpToMessage(entry.msg.replyTo.id)
                        }}
                      />

                      {entry.msg.whisperTargetId && (
                        <div className="flex items-center gap-1 mb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground/80 select-none">
                          <EyeOff className="size-3" aria-hidden="true" />
                          {entry.msg.authorId === me?.id
                            ? `whispered to ${entry.msg.whisperTargetName ?? 'someone'}`
                            : 'whisper · only you two can see this'}
                        </div>
                      )}

                      <MessageBody
                        msg={entry.msg}
                        meUsername={me?.username}
                        openProfile={openProfile}
                        editing={editingId === entry.msg.id}
                        editDraft={editDraft}
                        setEditingId={setEditingId}
                        editMessage={editMessage}
                        room={room}
                        setLightbox={openLightbox}
                        translation={translations[entry.msg.id]}
                        onPermalink={(messageId) => {
                          captureReturnPoint()
                          void jumpToMessage(messageId)
                        }}
                        savedGifUrls={savedGifUrls}
                        onSaveGif={(url, author) => void toggleSavedGif(url, `gif from ${author}`)}
                        isBookmarked={bookmarkedIds.has(entry.msg.id)}
                        onToggleBookmark={() => void toggleBookmark(entry.msg.id)}
                      />

                      <ReactionChips
                        reactions={entry.msg.reactions}
                        meId={me?.id ?? null}
                        room={room}
                        author={entry.msg.author}
                        onToggle={(emoji) => {
                          sounds.play('lightTick')
                          rememberQuickUse(emoji)
                          void toggleReaction(room, entry.msg.id, emoji)
                        }}
                      />

                      {!entry.msg.threadOfId && (
                        <ThreadBar
                          msg={entry.msg}
                          active={openThreadId === entry.msg.id}
                          onOpen={() => void openThread(entry.msg.id)}
                        />
                      )}

                      {/* optimistic-send failure footer: retry or discard */}
                      {entry.msg.failed && (
                        <div className="flex items-center gap-2 mt-1 text-[11px] text-destructive">
                          <AlertCircle className="size-3.5 shrink-0" />
                          <span className="flex-1">did not send</span>
                          <button
                            onClick={() => void retryMessage(room, entry.msg.id)}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm hover:bg-destructive/15 transition-colors font-semibold"
                            aria-label="retry sending"
                          >
                            <RotateCcw className="size-3" /> retry
                          </button>
                          <button
                            onClick={() => discardMessage(room, entry.msg.id)}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm hover:bg-destructive/15 transition-colors font-semibold"
                            aria-label="discard message"
                          >
                            <X className="size-3" /> discard
                          </button>
                        </div>
                      )}

                      {/* slow-send marker: only appears when the optimistic
                          row is still unconfirmed after several seconds */}
                      {entry.msg.pending && slowPendingIds.has(entry.msg.id) && (
                        <div className="flex items-center gap-1 mt-0.5 text-[10px] text-muted-foreground" aria-live="polite">
                          <Clock className="size-3" /> sending
                        </div>
                      )}

                      {/* read receipts. DMs (and conversations whose kind we
                          do not know yet): the plain check under the last
                          message of mine the partner read. groups: the row
                          of reader avatars under the last message of mine
                          each reader covered — same footer slot, richer
                          answer to "who saw this" */}
                      {isDM && !isGroupConv && lastReadMessageId === entry.msg.id && (
                        <div className="flex items-center gap-1 mt-1 text-[10px] text-hyper" aria-live="polite">
                          <Check className="size-3" />
                          seen
                        </div>
                      )}
                      {isGroupConv && (
                        <GroupReadReceipt
                          readers={groupReceipts?.get(entry.msg.id) ?? null}
                          participants={conversation?.participants ?? []}
                        />
                      )}
                      {/* channel receipts: the same avatar-row receipt for
                          MY channel messages, counting friends only —
                          reader faces resolve from the server member list */}
                      {isChannel && (
                        <GroupReadReceipt
                          readers={channelReceipts?.get(entry.msg.id) ?? null}
                          participants={(serverMembers ?? []).map((m) => ({
                            id: m.id,
                            username: m.username,
                            displayName: m.displayName,
                            avatarUrl: m.avatarUrl,
                            avatarColor: m.avatarColor,
                          }))}
                        />
                      )}
                    </div>
                  </>
                )}

                {/* combined hover toolbar: quick emojis + reply + edit/thread + kebab */}
                {!entry.msg.pending && !entry.msg.failed && !entry.msg.systemKind && !blockedUserIds[entry.msg.authorId] && (
                  <MessageToolbar
                    msg={entry.msg}
                    isOwn={entry.msg.authorId === me?.id}
                    onEdit={() => {
                      setEditDraft(entry.msg.content ?? '')
                      setEditingId(entry.msg.id)
                    }}
                    onReact={(emoji) => {
                      sounds.play('lightTick')
                      rememberQuickUse(emoji)
                      void toggleReaction(room, entry.msg.id, emoji)
                    }}
                    onMore={(anchor) => openRowMenu(entry.msg, { x: anchor.left, y: anchor.bottom + 4 })}
                  />
                )}
              </div>
            )
          )}
        </div>
      </div>

      {/* permalink history view: newer messages exist below the window */}
      {roomState?.hasNewer && (
        <button
          onClick={() => {
            sounds.play('lightTick')
            requestPresent(room)
          }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 h-9 rounded-sm bg-app-raise border border-hyper/40 text-xs font-semibold shadow-lg hover:border-hyper/70 hover:text-hyper transition-colors z-10"
          aria-label="jump back to present"
        >
          <ArrowDown className="size-3.5" />
          jump to present
        </button>
      )}

      {/* reply-jump return pill: glide back to where the viewer stood
          before the last reply/permalink jump (escape works too). rides
          above the "jump to present" pill when both are up */}
      {returnPoint?.room === room && (
        <button
          onClick={performReturn}
          className={cn(
            'absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3.5 h-9 rounded-full bg-app-raise/95 backdrop-blur-sm border border-white/15 text-xs font-semibold shadow-lg hover:border-hyper/60 hover:text-hyper transition-colors z-10',
            roomState?.hasNewer ? 'bottom-16' : 'bottom-4'
          )}
          aria-label="back to where you were"
          title="back to where you were (esc)"
        >
          <ArrowDown className="size-3.5" />
          back to where you were
        </button>
      )}

      {/* jump to latest when scrolled up */}
      {showJump && (
        <button
          onClick={() => {
            const el = scrollRef.current
            if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
            missedWhileAwayRef.current = 0
          }}
          className="absolute bottom-4 right-4 flex items-center gap-1.5 px-3 h-9 rounded-sm bg-app-raise border border-white/15 text-xs font-semibold shadow-lg hover:border-hyper/60 transition-colors z-10"
          aria-label="jump to latest messages"
        >
          <ArrowDown className="size-3.5" />
          latest
        </button>
      )}

      {typingNames.length > 0 && (
        <div className="px-4 pb-1 flex items-center gap-1.5 text-xs text-muted-foreground h-5" aria-live="polite">
          <span className="flex gap-0.5 items-end" aria-hidden="true">
            <span className="typing-dot size-1 rounded-full bg-muted-foreground" />
            <span className="typing-dot size-1 rounded-full bg-muted-foreground" />
            <span className="typing-dot size-1 rounded-full bg-muted-foreground" />
          </span>
          <span>
            {typingNames.length === 1
              ? `${typingNames[0]} is typing`
              : typingNames.length === 2
                ? `${typingNames[0]} and ${typingNames[1]} are typing`
                : 'several people are typing'}
          </span>
        </div>
      )}

      {/* medium-small profile card anchored to a clicked avatar; clicking
          the avatar inside it escalates to the full profile card */}
      {miniProfile && (
        <MiniProfilePopover
          username={miniProfile.username}
          anchorRect={miniProfile.rect}
          onClose={() => setMiniProfile(null)}
        />
      )}

      <Dialog open={!!lightbox} onOpenChange={(open) => !open && setLightbox(null)}>
        <DialogContent
          className="w-screen h-dvh max-w-none sm:max-w-none p-0 rounded-none border-0 bg-black/95 gap-0 overflow-hidden data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100"
          aria-describedby={undefined}
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">Image sent by {lightbox?.author}</DialogTitle>
          {lightbox && (
            <div className="relative grid h-full w-full place-items-center group/lightbox zoom-blur-in">
              {/* the media box shrink-wraps the image: the close X rides the
                  media's OWN top-right corner, not the window's. Clicking the
                  media toggles centered <-> fill-the-screen. */}
              <div className={cn('relative', lightboxFilled ? 'size-full' : 'w-fit h-fit')}>
                <img
                  ref={lightboxImgRef}
                  src={lightbox.url}
                  alt={`Image sent by ${lightbox.author}`}
                  onLoad={snapLightbox}
                  onClick={() => {
                    setLightboxFilled((f) => !f)
                    sounds.play('lightTick')
                    snapLightbox()
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setLightboxFilled((f) => !f)
                      snapLightbox()
                    }
                  }}
                  tabIndex={0}
                  className={cn(
                    'select-none outline-none transition-[object-fit] duration-150',
                    lightboxFilled
                      ? 'size-full object-cover cursor-zoom-out'
                      : 'max-h-[calc(100dvh-4rem)] max-w-[calc(100vw-4rem)] object-contain cursor-zoom-in'
                  )}
                  draggable={false}
                />
                <DialogClose
                  className="absolute top-2 right-2 z-10 grid place-items-center size-8 rounded-sm bg-black/60 border border-white/15 text-white/80 hover:bg-black/85 hover:text-white transition-colors"
                  aria-label="close image"
                  title="close"
                >
                  <X className="size-4" />
                </DialogClose>
              </div>
              <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-2">
                {isGifUrl(lightbox.url) && (
                  <button
                    onClick={() => void toggleSavedGif(lightbox.url, `gif from ${lightbox.author}`)}
                    className="flex h-9 items-center gap-1.5 rounded-sm border border-white/15 bg-black/60 px-3 text-xs font-semibold text-foreground/90 opacity-0 max-md:opacity-100 transition-all hover:border-white/40 focus-visible:opacity-100 group-hover/lightbox:opacity-100"
                    aria-label={savedGifUrls.has(lightbox.url) ? 'Remove GIF from your collection' : 'Save GIF to your collection'}
                    title={savedGifUrls.has(lightbox.url) ? 'unsave gif' : 'save gif'}
                  >
                    {savedGifUrls.has(lightbox.url) ? (
                      <Bookmark className="size-3.5 fill-hyper text-hyper" />
                    ) : (
                      <BookmarkPlus className="size-3.5" />
                    )}
                    {savedGifUrls.has(lightbox.url) ? 'unsave gif' : 'save gif'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const name = lightbox.url.split('/').pop()?.split('?')[0] || 'download'
                    void safeDownload(lightbox.url, name)
                  }}
                  className="flex h-9 items-center gap-1.5 rounded-sm border border-white/15 bg-black/60 px-3 text-xs font-semibold text-foreground/90 opacity-0 max-md:opacity-100 transition-all hover:border-white/40 focus-visible:opacity-100 group-hover/lightbox:opacity-100"
                  aria-label="download image"
                  title="download image"
                >
                  <Download className="size-3.5" />
                  download
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
