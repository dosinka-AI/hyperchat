import { createHash } from 'crypto'
import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import path from 'path'
import { db } from '@/lib/db'
import { IS_SERVERLESS } from './server-env'
import { AUTHOR_INCLUDE, toClientMessage } from './messages'
import { channelRoom, conversationRoom, emitToRooms, userRoom } from './realtime'

/**
 * THE VAULT — ephemeral, chunked file sends.
 *
 * Drive-smart by design (the owner's future self-hosted box has one 4TB spinny
 * disk and this is the only part of the app that talks to it):
 *   - chunks are content-addressed on disk: {VAULT_DIR}/{sha256-of-chunk-bytes},
 *     so identical chunks across uploads share one file (never overwritten)
 *   - nothing ever scans the directory: a read computes which chunks cover the
 *     requested byte range from (chunkSize, totalChunks) math and opens exactly
 *     those files, in order
 *   - the hot index (chunk list per upload) lives in a small RAM LRU
 *   - whole-file buffers are cached ONLY for files < 2 MiB (~32 entries)
 *   - TTL is size-tiered at init and storage-pressure aware: a cached snapshot
 *     of live vault bytes (refreshed at most every 60s, riding the lazy sweep
 *     and the 60s interval) scales every tier down by up to 75% as the vault
 *     fills toward VAULT_BUDGET_BYTES (default 400 GiB — one tenant on the
 *     owner's 4TB drive), with a 10-minute floor. At zero pressure the tiers
 *     are exactly the original ladder.
 *   - completed uploads get a lightweight dangerous-file sniff (magic bytes of
 *     the first chunk + filename rules — vaultSafetyWarnings) whose warning
 *     codes ride the row to the client card
 *   - a lazy sweep rides every vault API call and a 60s interval singleton
 *     reaps the rest
 */

export const VAULT_CHUNK_SIZE = 4 * 1024 * 1024 // 4 MiB per chunk
export const VAULT_MAX_CHUNKS = 4096 // ceil() cap → hard ceiling ~16 GiB…
export const VAULT_MAX_FILE_BYTES = 1024 * 1024 * 1024 // …but init caps sends at 1 GiB
const SMALL_BUFFER_CAP = 2 * 1024 * 1024 // whole-file buffer cache only under this size
const STALE_UPLOAD_MS = 30 * 60_000 // "uploading" rows older than this get swept

/** Where chunk files live. VAULT_DIR env wins; serverless hosts get /tmp. */
export function vaultDir(): string {
  if (process.env.VAULT_DIR) return process.env.VAULT_DIR
  return IS_SERVERLESS ? '/tmp/hyperchat-vault' : path.join(process.cwd(), 'db', 'vault')
}

/** Vault-wide storage budget for the pressure factor (default 400 GiB: sized
 * for the owner's 4TB drive where the vault is one tenant among the OS, the
 * db and uploads). VAULT_BUDGET_BYTES env wins. */
export function vaultBudgetBytes(): number {
  const raw = Number(process.env.VAULT_BUDGET_BYTES)
  return Number.isFinite(raw) && raw > 0 ? raw : 400 * 1024 * 1024 * 1024
}

/** Per-user daily byte budget (default 8 GiB) — the init route's failsafe
 * against one account filling the drive in a day. VAULT_DAILY_USER_BYTES wins. */
export function vaultDailyUserBytes(): number {
  const raw = Number(process.env.VAULT_DAILY_USER_BYTES)
  return Number.isFinite(raw) && raw > 0 ? raw : 8 * 1024 * 1024 * 1024
}

/** Tiny bytes label for quota errors (the client's format.ts lives behind
 * 'use client' boundaries; server routes get this one). */
export function formatVaultBytes(bytes: number): string {
  const GB = 1024 * 1024 * 1024
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GiB`
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

let dirEnsured = false
/** Create the vault directory once per process (cheap no-op afterwards). */
export async function ensureVaultDir(): Promise<string> {
  const dir = vaultDir()
  if (!dirEnsured) {
    await mkdir(dir, { recursive: true })
    dirEnsured = true
  }
  return dir
}

/* ------------------------------------------------------------------ *
 * Storage pressure (smart TTLs)                                      *
 * ------------------------------------------------------------------ */

export type VaultBudgetState = {
  totalLiveBytes: number // uploading+ready bytes not yet past expiresAt
  userCount: number
  pressure: number // clamp(live / budget, 0, 1)
  budgetBytes: number
  checkedAt: number // epoch ms of the last successful refresh
}

/** Cached snapshot for vaultExpiryFor (sync) — refreshed at most every 60s.
 * Held on globalThis so dev hot-reloads never fork it. */
const budgetGlobal = globalThis as unknown as { __vaultBudget?: VaultBudgetState }
let budgetRefreshing = false

/** Refresh the snapshot: one indexed aggregate over live uploads + a user
 * count. Called from the sweep path (lazy rides + the 60s interval) and safe
 * to fire-and-forget — a failed refresh keeps the previous snapshot. */
async function refreshBudgetSnapshot(): Promise<void> {
  if (budgetRefreshing) return
  budgetRefreshing = true
  try {
    const live = await db.fileUpload.aggregate({
      where: { status: { in: ['uploading', 'ready'] }, expiresAt: { gt: new Date() } },
      _sum: { size: true },
    })
    const userCount = await db.user.count()
    const budgetBytes = vaultBudgetBytes()
    const totalLiveBytes = live._sum.size ?? 0
    budgetGlobal.__vaultBudget = {
      totalLiveBytes,
      userCount,
      pressure: Math.min(1, totalLiveBytes / budgetBytes),
      budgetBytes,
      checkedAt: Date.now(),
    }
  } catch {
    // a failed refresh keeps the previous snapshot (or none → zero pressure)
  } finally {
    budgetRefreshing = false
  }
}

/** Lazy 60s gate: rides the sweep that already runs on every vault API call. */
function maybeRefreshBudget(): void {
  const snap = budgetGlobal.__vaultBudget
  if (!snap || Date.now() - snap.checkedAt >= 60_000) void refreshBudgetSnapshot()
}

/** Latest pressure snapshot for the admin panel (null before the first
 * refresh lands). */
export function vaultBudgetState(): VaultBudgetState | null {
  return budgetGlobal.__vaultBudget ? { ...budgetGlobal.__vaultBudget } : null
}

/** Smart size-tiered TTL (the owner's rule: huge files die fast, small ones
 * linger, one month hard cap). Storage-pressure aware: as the vault fills
 * toward VAULT_BUDGET_BYTES the pressure factor p (0..1, cached snapshot)
 * shrinks every tier by up to 75% — a filling drive shortens lifetimes
 * instead of rejecting sends — with a 10-minute floor for every tier. At
 * p=0 the ladder is exactly the original one. */
export function vaultExpiryFor(size: number): Date {
  const GB = 1024 * 1024 * 1024
  const MB = 1024 * 1024
  let ms: number
  if (size >= GB) ms = 10 * 60_000 // >= 1 GiB → 10 minutes
  else if (size >= 100 * MB) ms = 24 * 60 * 60_000 // >= 100 MiB → 24 hours
  else if (size >= 10 * MB) ms = 7 * 24 * 60 * 60_000 // >= 10 MiB → 7 days
  else ms = 30 * 24 * 60 * 60_000 // everything else → 30 days
  const pressure = budgetGlobal.__vaultBudget?.pressure ?? 0
  if (pressure > 0) ms = Math.max(10 * 60_000, Math.round(ms * (1 - 0.75 * pressure)))
  return new Date(Date.now() + ms)
}

/** Display-name hygiene: strip path separators + control chars, cap 255. */
export function sanitizeVaultFilename(raw: string): string {
  const base = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (base || 'file').slice(0, 255)
}

/** Mime hygiene: shape-checked, lowercase, capped 100, octet-stream fallback. */
export function sanitizeVaultMime(raw: unknown): string {
  if (typeof raw !== 'string') return 'application/octet-stream'
  const v = raw.trim().toLowerCase()
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(v) || v.length > 100) {
    return 'application/octet-stream'
  }
  return v
}

/* ------------------------------------------------------------------ *
 * RAM LRU caches (Map + manual eviction, bounded, no growth)         *
 * ------------------------------------------------------------------ */

/** Tiny LRU: Map preserves insertion order, so "get refreshes recency" is a
 * delete+set and eviction drops the oldest key. */
class Lru<K, V> {
  private map = new Map<K, V>()
  constructor(private cap: number) {}
  get(key: K): V | undefined {
    const hit = this.map.get(key)
    if (hit !== undefined) {
      this.map.delete(key)
      this.map.set(key, hit)
    }
    return hit
  }
  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }
  delete(key: K): void {
    this.map.delete(key)
  }
}

/** uploadId → chunk list sorted by index (the hot index for reads; ~256 uploads). */
const metaCache = new Lru<string, VaultChunkMetaLite[]>(256)
/** uploadId → assembled whole-file buffer, ONLY for files < 2 MiB (~32 entries). */
const smallFileCache = new Lru<string, Buffer>(32)

export type VaultChunkMetaLite = { chunkIndex: number; size: number; sha256: string }

/** Chunk list for a finished upload, ordered by index. Cached in RAM: range
 * math needs it on every download and it never changes after completion. */
export async function chunkMetasFor(uploadId: string): Promise<VaultChunkMetaLite[]> {
  const cached = metaCache.get(uploadId)
  if (cached) return cached
  const rows = await db.fileChunkMeta.findMany({
    where: { uploadId },
    orderBy: { chunkIndex: 'asc' },
    select: { chunkIndex: true, size: true, sha256: true },
  })
  const metas = rows.map((r) => ({ chunkIndex: r.chunkIndex, size: r.size, sha256: r.sha256 }))
  metaCache.set(uploadId, metas)
  return metas
}

/* ------------------------------------------------------------------ *
 * Chunk file I/O (content-addressed)                                 *
 * ------------------------------------------------------------------ */

export function chunkFilePath(sha256: string): string {
  return path.join(vaultDir(), sha256)
}

/** Expected byte length of chunk `index` (the last chunk may be short). */
export function expectedChunkSize(size: number, chunkSize: number, index: number): number {
  return Math.min(chunkSize, size - index * chunkSize)
}

/** Store one chunk at its content address. If an identical chunk is already
 * on disk (another upload sent the same bytes) the write is skipped — chunks
 * are shared, and existing files are NEVER overwritten. */
export async function writeChunkFile(sha256: string, bytes: Buffer): Promise<void> {
  await ensureVaultDir()
  const target = chunkFilePath(sha256)
  const existing = await stat(target).then((s) => s.size, () => null)
  if (existing !== null) return // identical bytes are already there
  await writeFile(target, bytes)
}

/* ------------------------------------------------------------------ *
 * Range math + streaming reads                                       *
 * ------------------------------------------------------------------ */

export type VaultRange = { start: number; end: number } // inclusive byte span

/** Parse a `Range: bytes=...` header against a file size. Returns:
 *  - { kind: 'none' } when absent → whole file
 *  - { kind: 'range', start, end } when satisfiable (end clamped to size-1)
 *  - { kind: 'bad' } when malformed (caller falls back to the whole file)
 *  - { kind: 'unsatisfiable' } when past EOF / inverted → 416 */
export function parseRangeHeader(header: string | null, size: number): { kind: 'none' } | ({ kind: 'range' } & VaultRange) | { kind: 'bad' } | { kind: 'unsatisfiable' } {
  if (!header) return { kind: 'none' }
  const m = header.trim().match(/^bytes=(\d*)-(\d*)$/)
  if (!m || (m[1] === '' && m[2] === '')) return { kind: 'bad' }
  const hasStart = m[1] !== ''
  const hasEnd = m[2] !== ''
  let start: number
  let end: number
  if (!hasStart) {
    // suffix range: last N bytes
    const n = parseInt(m[2], 10)
    if (n <= 0) return { kind: 'unsatisfiable' }
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = parseInt(m[1], 10)
    end = hasEnd ? parseInt(m[2], 10) : size - 1
    if (start >= size) return { kind: 'unsatisfiable' }
    if (end < start) return { kind: 'unsatisfiable' }
    if (end > size - 1) end = size - 1
  }
  return { kind: 'range', start, end }
}

/** Stream the byte span [start, end] by opening ONLY the covering chunk files
 * in order — a 1 KiB range of a 1 GiB file reads at most two 4 MiB chunks and
 * never holds more than one chunk in memory at a time. */
export function streamUploadRange(
  metas: VaultChunkMetaLite[],
  chunkSize: number,
  start: number,
  end: number
): ReadableStream<Uint8Array> {
  const firstChunk = Math.floor(start / chunkSize)
  const lastChunk = Math.floor(end / chunkSize)
  const headSkip = start - firstChunk * chunkSize
  const tailEnd = end - lastChunk * chunkSize + 1 // exclusive, inside the last chunk
  let cursor = firstChunk
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cursor > lastChunk || cursor >= metas.length) {
        controller.close()
        return
      }
      const at = cursor
      cursor += 1
      let raw: Buffer
      try {
        raw = await readFile(chunkFilePath(metas[at].sha256))
      } catch (err) {
        // a chunk file vanished mid-stream (swept, drive hiccup): abort the
        // response — the client sees a network error and can retry, never a
        // hang — and leave a loud trace for the log
        console.error('[vault] chunk read failed mid-stream', metas[at]?.sha256, err)
        controller.error(err)
        return
      }
      const from = at === firstChunk ? headSkip : 0
      const to = at === lastChunk ? Math.min(tailEnd, raw.length) : raw.length
      const view = from === 0 && to === raw.length ? raw : raw.subarray(from, to)
      // a fresh Buffer per read: the view shares it safely, no copy needed
      controller.enqueue(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
    },
  })
}

/** Whole small file (< 2 MiB) as one Buffer, cached for repeat sends. Returns
 * null when the file is too big for the buffer cache — callers stream instead. */
export async function assembleSmallFile(uploadId: string, metas: VaultChunkMetaLite[], totalSize: number): Promise<Buffer | null> {
  if (totalSize > SMALL_BUFFER_CAP) return null
  const cached = smallFileCache.get(uploadId)
  if (cached) return cached
  const parts: Buffer[] = []
  for (const m of metas) parts.push(await readFile(chunkFilePath(m.sha256)))
  const whole = Buffer.concat(parts, totalSize)
  smallFileCache.set(uploadId, whole)
  return whole
}

/** Incremental whole-file sha256: chunk files are read one at a time and fed
 * into the running hash — the file is never held in memory. */
export async function hashWholeFile(metas: VaultChunkMetaLite[]): Promise<string> {
  const hash = createHash('sha256')
  for (const m of metas) {
    hash.update(await readFile(chunkFilePath(m.sha256)))
  }
  return hash.digest('hex')
}

/* ------------------------------------------------------------------ *
 * Dangerous-file sniff (server side)                                 *
 * ------------------------------------------------------------------ */

/** Filename suffixes that are programs or scripts on the owner's boxes
 * (windows-first: a renamed .pdf.exe must never look innocent).
 * Keep in sync with src/lib/client/file-safety.ts. */
const DANGEROUS_SUFFIXES = new Set(['exe', 'scr', 'bat', 'cmd', 'com', 'pif', 'vbs', 'js', 'jar', 'apk', 'msi'])
/** Suffixes that read as "plain script" rather than "program". */
const SCRIPT_SUFFIXES = new Set(['vbs', 'js'])
/** Double-extension baits: a safe-looking document/media extension directly
 * before a dangerous one ("invoice.pdf.exe", "photo.jpg.scr"). */
const BAIT_PREFIX_EXTS = new Set([
  'pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'txt', 'doc', 'docx', 'xls',
  'xlsx', 'ppt', 'pptx', 'mp3', 'mp4', 'avi', 'mkv', 'zip', 'csv',
])

/** Lightweight safety sniff over the FIRST 4 MiB (chunk 0) of a finished
 * upload: magic bytes for PE/ELF executables and zip containers that do not
 * match the claimed mime, plus the filename rules. Returns short codes the
 * client card renders as an amber "careful" chip — a warning, never a
 * block (only a positive VirusTotal verdict blocks). */
export function vaultSafetyWarnings(filename: string, mime: string, head: Buffer): string[] {
  const out = new Set<string>()
  const parts = filename.toLowerCase().split('.')
  const last = parts.length >= 2 ? parts[parts.length - 1] : ''
  const prev = parts.length >= 3 ? parts[parts.length - 2] : ''
  if (DANGEROUS_SUFFIXES.has(last)) {
    out.add(SCRIPT_SUFFIXES.has(last) ? 'script' : 'executable')
    if (BAIT_PREFIX_EXTS.has(prev)) out.add('double-extension')
  }
  const octetStream = mime === 'application/octet-stream'
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) {
    // MZ: a windows PE executable
    out.add('executable')
    if (!octetStream) out.add('mime-mismatch')
  } else if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
    // \x7fELF: a linux executable
    out.add('executable')
    if (!octetStream) out.add('mime-mismatch')
  } else if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    // PK\x03\x04: a zip container (office docs, jars) — only suspicious when
    // the claimed mime is neither zip/office/archive nor the honest fallback
    if (!/(zip|rar|7z|tar|gzip|compressed|officedocument|opendocument|java-archive)/.test(mime)) {
      out.add('archive')
    }
  }
  return [...out]
}

/** Parse the stored warnings JSON for clients; a corrupt value reads as none. */
export function parseVaultWarnings(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : []
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ *
 * Deletion + sweeps                                                  *
 * ------------------------------------------------------------------ */

/** Hard-delete one upload: rows first (cascades the chunk metas), then the
 * chunk FILES — each only when no other upload still references that sha
 * (content addressing means chunks are shared). File errors are guarded:
 * a wedged unlink must never 500 the request that triggered it.
 *
 * The message that carried the file is told, live: a row with words keeps
 * its text and just loses the card (message:update, file now null); a
 * file-only send dies with its file (message:delete) so the feed never
 * shows an empty tombstone. */
export async function deleteUploadHard(uploadId: string): Promise<void> {
  const metas = await db.fileChunkMeta.findMany({
    where: { uploadId },
    select: { sha256: true },
  })
  // the carrier must be read BEFORE the upload row dies — SetNull would
  // erase the pointer. Isolation guards: a thread root or a reply target
  // survives (deleting it would cascade other people's words away).
  const carrier = await db.message.findFirst({
    where: { fileId: uploadId },
    select: {
      id: true,
      content: true,
      imageUrl: true,
      attachments: true,
      stickerUrl: true,
      systemKind: true,
      authorId: true,
      whisperTargetId: true,
      channelId: true,
      conversationId: true,
      replies: { select: { id: true } },
      threadMessages: { select: { id: true } },
    },
  })
  await db.fileUpload
    .delete({ where: { id: uploadId } })
    .catch(() => {/* already gone — the chunk pass below is still worth it */})
  for (const m of metas) {
    try {
      const shared = await db.fileChunkMeta.count({ where: { sha256: m.sha256 } })
      if (shared === 0) await unlink(chunkFilePath(m.sha256))
    } catch {
      // guarded on purpose: disk hiccups must not break the sweep
    }
  }
  metaCache.delete(uploadId)
  smallFileCache.delete(uploadId)
  if (!carrier) return
  try {
    const rooms = carrier.whisperTargetId
      ? [userRoom(carrier.authorId), userRoom(carrier.whisperTargetId)]
      : [
          ...(carrier.channelId ? [channelRoom(carrier.channelId)] : []),
          ...(carrier.conversationId ? [conversationRoom(carrier.conversationId)] : []),
        ]
    const bare =
      !carrier.content && !carrier.imageUrl && !carrier.attachments && !carrier.stickerUrl && !carrier.systemKind &&
      carrier.replies.length === 0 && carrier.threadMessages.length === 0
    if (bare) {
      await db.message.delete({ where: { id: carrier.id } }).catch(() => {/* already gone */})
      await emitToRooms(rooms, 'message:delete', { messageId: carrier.id, rooms })
    } else {
      const fresh = await db.message.findUnique({ where: { id: carrier.id }, include: AUTHOR_INCLUDE })
      if (fresh) await emitToRooms(rooms, 'message:update', toClientMessage(fresh, rooms[0] ?? ''))
    }
  } catch {
    // live-notification is best-effort; the rows themselves are already gone
  }
}

let sweeping = false

/** Reap expired uploads: only rows that are past their expiresAt (status
 * uploading/ready) plus "uploading" rows abandoned for > 30 minutes. Cheap
 * indexed expiresAt query; never touches still-live uploads. */
export async function sweepVault(): Promise<void> {
  if (sweeping) return // one sweep at a time; the next API call retries anyway
  sweeping = true
  try {
    // storage-pressure snapshot rides the same lazy pass (60s-gated refresh)
    maybeRefreshBudget()
    const now = new Date()
    const staleBefore = new Date(now.getTime() - STALE_UPLOAD_MS)
    const doomed = await db.fileUpload.findMany({
      where: {
        OR: [
          { expiresAt: { lt: now }, status: { in: ['uploading', 'ready'] } },
          { status: 'uploading', createdAt: { lt: staleBefore } },
        ],
      },
      select: { id: true },
      take: 200,
    })
    for (const d of doomed) {
      await deleteUploadHard(d.id)
    }
  } catch {
    // a failed sweep never breaks the caller
  } finally {
    sweeping = false
  }
}

// 60s sweeper singleton, started on the first import of this module. Held on
// globalThis so dev hot-reloads never stack intervals; unref'd so it never
// holds the process open on shutdown.
const vaultGlobal = globalThis as unknown as { __vaultSweepTimer?: ReturnType<typeof setInterval> }
if (!vaultGlobal.__vaultSweepTimer) {
  vaultGlobal.__vaultSweepTimer = setInterval(() => {
    void sweepVault()
  }, 60_000)
  vaultGlobal.__vaultSweepTimer.unref?.()
}

/* ------------------------------------------------------------------ *
 * Payload helpers shared by the routes                               *
 * ------------------------------------------------------------------ */

/** Prisma FileUpload row shape the routes query. */
export type VaultUploadRow = {
  id: string
  filename: string
  mime: string
  size: number
  sha256: string | null
  chunkSize: number
  totalChunks: number
  status: string
  warnings: string | null
  scanStatus: string | null
  scanResult?: string | null
  expiresAt: Date
  downloadCount: number
  createdAt: Date
  uploaderId: string
  conversationId: string | null
}

/** Full API metadata shape (init/complete/GET responses). */
export function toVaultSummary(upload: VaultUploadRow) {
  return {
    id: upload.id,
    filename: upload.filename,
    mime: upload.mime,
    size: upload.size,
    sha256: upload.sha256,
    chunkSize: upload.chunkSize,
    totalChunks: upload.totalChunks,
    status: upload.status,
    warnings: parseVaultWarnings(upload.warnings),
    scanStatus: upload.scanStatus ?? null,
    expiresAt: upload.expiresAt.toISOString(),
    downloadCount: upload.downloadCount,
    createdAt: upload.createdAt.toISOString(),
  }
}

/** RFC 5987 Content-Disposition: an ASCII fallback plus the UTF-8 encoded
 * real name, so unicode filenames survive the download dialog. */
export function vaultContentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** Access rule: the uploader, or any participant of the owning conversation. */
export async function canAccessVault(userId: string, upload: VaultUploadRow): Promise<boolean> {
  if (upload.uploaderId === userId) return true
  if (!upload.conversationId) return false
  const participant = await db.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: upload.conversationId, userId } },
    select: { id: true },
  })
  return !!participant
}
