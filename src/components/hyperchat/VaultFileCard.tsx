'use client'

import { useEffect, useState } from 'react'
import { Clock, Download, FileArchive, FileAudio, FileImage, FileText, FileVideo, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react'
import { formatBytes, formatRemaining } from '@/lib/client/format'
import { downloadFile, type DownloadStatusKind } from '@/lib/client/download'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { sounds } from '@/lib/client/sounds'
import { useToast } from '@/hooks/use-toast'
import type { ClientMessage } from '@/lib/types'

/** The vault file a message carries, by mime (fallback: plain file). */
function vaultIconFor(mime: string): typeof FileText {
  if (mime.startsWith('image/')) return FileImage
  if (mime.startsWith('video/')) return FileVideo
  if (mime.startsWith('audio/')) return FileAudio
  if (/zip|rar|7z|tar|gzip|compressed/.test(mime)) return FileArchive
  return FileText
}

/** Ticking clock shared by every vault card: one interval each, 30s cadence —
 *  countdowns stay live without per-second churn. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/**
 * THE VAULT file card: the message-bubble rendering of an ephemeral chunked
 * upload. Shows name, size and a live "expires in 12m / 3d / 30d" countdown;
 * once the stamp passes (or the server says 410) the card dims, flips to an
 * "expired" chip and the download dies. Incomplete uploads render a
 * processing state. Downloads go through the shared iframe-safe helper
 * (blob + a.download, window.open fallback — see src/lib/client/download.ts).
 * Safety chips: amber "careful" when the server sniff flagged the file (an
 * inline confirm step guards the download), plus the virus-scan states
 * (scanning… / scanned clean / flagged — flagged disables the download).
 */
export function VaultFileCard({ file }: { file: NonNullable<ClientMessage['file']> }) {
  const { toast } = useToast()
  const now = useNow(30_000)
  const [busy, setBusy] = useState(false)
  const [dead, setDead] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const expired = dead || new Date(file.expiresAt).getTime() <= now
  const uploading = file.status !== 'ready' && !expired
  const warnings = file.warnings ?? []
  const flagged = file.scanStatus === 'detected'
  const Icon = vaultIconFor(file.mime)

  async function download() {
    if (expired || uploading || busy || flagged) return
    // sniffed-dangerous file: an inline confirm step (self-contained in the
    // card, no dialog) before any bytes move
    if (warnings.length > 0 && !confirming) {
      setConfirming(true)
      sounds.play('lightTick')
      return
    }
    setBusy(true)
    let failed = false
    const onStatus = (kind: DownloadStatusKind) => {
      failed = true
      if (kind === 'expired') {
        setDead(true)
        sounds.play('error')
        toast({ title: 'file expired', description: 'vault files vanish once their timer runs out.' })
        return
      }
      if (kind === 'notready') {
        toast({ title: 'file not ready yet', description: 'try again in a moment.' })
        return
      }
      if (kind === 'flagged') {
        sounds.play('error')
        toast({ title: 'file blocked', description: 'flagged by virus scan.' })
        return
      }
      if (kind === 'blocked-fallback') {
        sounds.play('error')
        toast({ title: 'download blocked', description: 'open this app in a real browser tab to download.' })
        return
      }
      sounds.play('error')
      toast({ title: 'download failed', description: 'try again in a moment.' })
    }
    try {
      await downloadFile({
        url: `/api/files/${file.id}/download`,
        filename: file.filename,
        onStatus,
      })
      if (!failed) sounds.play('lightTick')
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div
      className={cn(
        // relative z-20: the row's hover toolbar (z-10, top-right) would
        // otherwise sit on top of this card's download button on wide rows —
        // the card wins so the click can never land on a reaction by mistake
        'relative z-20 mt-1.5 flex items-center gap-2.5 rounded-sm border bg-app-raise px-3 py-2 max-w-sm transition-opacity',
        expired ? 'border-white/5 opacity-55' : 'border-white/10'
      )}
      aria-label={`vault file ${file.filename}, ${formatBytes(file.size)}${expired ? ', expired' : `, expires in ${formatRemaining(file.expiresAt, now)}`}`}
    >
      <Icon
        className={cn('size-4 shrink-0', expired ? 'text-muted-foreground/50' : 'text-muted-foreground')}
        aria-hidden="true"
      />
      {confirming ? (
        // inline confirm step for sniffed-dangerous files: the card flips to
        // the warning + two small buttons, self-contained (no dialog)
        <span className="min-w-0 flex-1 text-[11px] leading-tight text-amber-400" title="executable or suspicious file type">
          this file type can harm your device. download anyway?
        </span>
      ) : (
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-tight">{file.filename}</span>
        <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground select-none">
          <span className="shrink-0 tabular-nums">{formatBytes(file.size)}</span>
          {uploading ? (
            <span className="flex items-center gap-1 text-hyper">
              <Spinner className="size-2.5" />
              processing
            </span>
          ) : expired ? (
            <span className="inline-flex items-center rounded-sm border border-white/15 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
              expired
            </span>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-0.5" title={`expires ${new Date(file.expiresAt).toLocaleString()}`}>
              <Clock className="size-2.5 shrink-0" aria-hidden="true" />
              <span className="truncate">expires in {formatRemaining(file.expiresAt, now)}</span>
            </span>
          )}
          {!expired && warnings.length > 0 && (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 rounded-sm border border-amber-400/30 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-amber-400"
              title="executable or suspicious file type"
            >
              <TriangleAlert className="size-2.5" aria-hidden="true" />
              careful
            </span>
          )}
          {!expired && file.scanStatus === 'pending' && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-muted-foreground/80" title="virus scan in progress">
              <Spinner className="size-2.5" />
              scanning…
            </span>
          )}
          {!expired && file.scanStatus === 'clean' && (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 rounded-sm border border-emerald-400/30 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-emerald-400"
              title="checked by virus scan — nothing found"
            >
              <ShieldCheck className="size-2.5" aria-hidden="true" />
              scanned clean
            </span>
          )}
          {!expired && flagged && (
            <span
              className="inline-flex shrink-0 items-center gap-0.5 rounded-sm border border-red-400/30 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-red-400"
              title="flagged by virus scan — download blocked"
            >
              <ShieldAlert className="size-2.5" aria-hidden="true" />
              flagged
            </span>
          )}
        </span>
      </span>
      )}
      {confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="shrink-0 rounded-sm border border-white/15 px-1.5 py-0.5 text-[10px] font-semibold lowercase text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          cancel
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => void download()}
        disabled={expired || uploading || busy || flagged}
        className={cn(
          'shrink-0 rounded-sm p-1.5 transition-colors',
          confirming
            ? 'border border-amber-400/40 px-1.5 py-0.5 text-[10px] font-semibold lowercase text-amber-400 hover:bg-amber-400/10'
            : expired || uploading || flagged
              ? 'text-muted-foreground/40 cursor-not-allowed'
              : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        )}
        aria-label={
          expired
            ? `Download unavailable: ${file.filename} expired`
            : flagged
              ? `Download blocked: ${file.filename} was flagged by virus scan`
              : `Download ${file.filename}`
        }
        title={expired ? 'this file expired' : flagged ? 'flagged by virus scan' : confirming ? 'download anyway' : 'download'}
      >
        {busy ? <Spinner className="size-3.5" /> : confirming ? 'download' : <Download className="size-3.5" />}
      </button>
    </div>
  )
}
