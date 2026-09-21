import { readdir, stat } from 'fs/promises'
import path from 'path'
import { db } from '@/lib/db'
import { vaultDir } from '@/lib/vault'

/**
 * CLIENT DISCOVERY CHECK (decoupled per the owner's spec, 2026-09-21 DM):
 *
 *   the github txt is CLIENT-side discovery, nothing more.
 *   - the owner updates the txt BY HAND with the current cloudflared
 *     temp link whenever the tunnel restarts
 *   - hyperion clients read that txt on their own to find the server
 *   - the server NEVER depends on it: no env var, no shipped default,
 *     nothing in the install. it boots and runs fully standalone.
 *
 * what remains here is an OPTIONAL sanity check for the owner: the
 * admin panel can be pointed at the txt URL (AppSetting 'bootstrapUrl')
 * to answer "did my manual github edit land, and does it resolve?"
 * unconfigured = perfectly fine — every surface treats that as a
 * neutral "not set up" state, never an error.
 */

/** AppSetting keys the resolver owns. */
const KEY_URL = 'bootstrapUrl'
const KEY_ADDRESS = 'serverAddress'
const KEY_AT = 'serverAddressAt'
const KEY_SOURCE = 'serverAddressSource'
const KEY_OK = 'serverAddressOk' // '1' | '0'
const KEY_ERROR = 'serverAddressError'

/** Cache lifetime: a resolve younger than this is served as-is. */
const CACHE_MS = 60_000

/** Hard cap on the address + URL strings (matches the admin validation). */
const MAX_LEN = 2000

export type BootstrapState = {
  /** The txt anchor in force, null when the check is not configured. */
  url: string | null
  /** False when no txt URL is set — a neutral state, not an error. */
  configured: boolean
  /** The resolved server address (origin form), null until a good resolve. */
  address: string | null
  /** ISO time of the last resolve attempt (success OR failure). */
  addressAt: string | null
  ok: boolean
  error?: string
}

/** The txt URL to verify against, or null when the owner never set one.
 * The AppSetting row (set from the admin panel) is the ONLY source —
 * deliberately no env override and no shipped default, so a self-hosted
 * box never carries someone else's anchor. */
export async function getBootstrapUrl(): Promise<string | null> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: KEY_URL } })
    if (row && /^https?:\/\//.test(row.value)) return row.value
  } catch {
    // a settings hiccup reads as "not configured" — never fatal
  }
  return null
}

/** Validate + normalize one line of the txt: a full origin (http/https)
 * passes as-is; a bare host[:port] is normalized to https://host[:port].
 * Returns null when the line is not an address at all. */
export function normalizeAddressLine(line: string): string | null {
  const v = line.trim()
  if (!v || v.length > MAX_LEN) return null
  if (/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(v)) return v
  // bare host[:port] — e.g. "mybox.local:3000"
  if (/^[a-zA-Z0-9][a-zA-Z0-9.-]*(:\d{1,5})?$/.test(v)) return `https://${v}`
  return null
}

async function readSetting(key: string): Promise<string | null> {
  try {
    const row = await db.appSetting.findUnique({ where: { key } })
    return row?.value ?? null
  } catch {
    return null
  }
}

async function writeSettings(map: Record<string, string>): Promise<void> {
  try {
    await Promise.all(
      Object.entries(map).map(([key, value]) =>
        db.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } })
      )
    )
  } catch {
    // persistence is best-effort: the resolve still returns to the caller
  }
}

const UNCONFIGURED: BootstrapState = {
  url: null,
  configured: false,
  address: null,
  addressAt: null,
  ok: false,
}

/**
 * Resolve what clients will read from the owner's txt. Never throws.
 *
 * - unconfigured → returns the neutral state immediately (no fetch,
 *   no cache rows touched)
 * - serves the cached result when it is younger than CACHE_MS (unless forced)
 * - fetches the txt with a `?t=<epoch-seconds>` cache-buster (the
 *   raw.githubusercontent edge caches for ~5 min otherwise) and cache:no-store
 * - 8s hard timeout via AbortController
 * - first non-empty line, trimmed, capped 2000 chars, must look like an
 *   origin (http/https) or a bare host[:port] (normalized to https://)
 */
export async function resolveServerAddress(force = false): Promise<BootstrapState> {
  const url = await getBootstrapUrl()
  if (!url) return UNCONFIGURED

  const cachedAt = await readSetting(KEY_AT)
  const cacheAge = cachedAt ? Date.now() - Date.parse(cachedAt) : Infinity
  if (!force && cachedAt && Number.isFinite(cacheAge) && cacheAge >= 0 && cacheAge < CACHE_MS) {
    const [address, ok, error] = await Promise.all([readSetting(KEY_ADDRESS), readSetting(KEY_OK), readSetting(KEY_ERROR)])
    return {
      url,
      configured: true,
      address: address && address.length > 0 ? address : null,
      addressAt: cachedAt,
      ok: ok === '1',
      ...(ok !== '1' && error ? { error } : {}),
    }
  }

  let ok = false
  let address: string | null = null
  let error: string | undefined
  try {
    const bust = new URL(url)
    bust.searchParams.set('t', String(Math.floor(Date.now() / 1000)))
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    let text: string
    try {
      const res = await fetch(bust.toString(), {
        cache: 'no-store',
        signal: ctrl.signal,
        headers: { Accept: 'text/plain' },
      })
      if (!res.ok) throw new Error(`the txt answered ${res.status}`)
      text = await res.text()
    } finally {
      clearTimeout(timer)
    }
    const firstLine = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0)
    if (!firstLine) {
      throw new Error('the txt is empty')
    }
    const normalized = normalizeAddressLine(firstLine.slice(0, MAX_LEN))
    if (!normalized) {
      throw new Error('the txt does not contain an address')
    }
    ok = true
    address = normalized
  } catch (err) {
    error =
      err instanceof Error && err.name === 'AbortError'
        ? 'the txt took too long to answer (8s timeout)'
        : err instanceof Error
          ? err.message
          : 'could not reach the txt'
  }

  const addressAt = new Date().toISOString()
  await writeSettings({
    [KEY_ADDRESS]: address ?? '',
    [KEY_AT]: addressAt,
    [KEY_SOURCE]: url,
    [KEY_OK]: ok ? '1' : '0',
    [KEY_ERROR]: (error ?? '').slice(0, 500),
  })

  return { url, configured: true, address, addressAt, ok, ...(error ? { error } : {}) }
}

/** Sum the sizes of the chunk files on disk (the vault dir). Admin-only
 * overview helper: the vault is the one app surface that talks to the drive,
 * so the owner's panel shows honest disk numbers. Streaming readdir with
 * withFileTypes — never more than one dirent in memory at a time beyond the
 * listing itself. Best-effort: 0 when the dir is unreadable. */
export async function vaultDiskUsageBytes(): Promise<number> {
  try {
    const dir = vaultDir()
    const entries = await readdir(dir, { withFileTypes: true })
    let total = 0
    for (const entry of entries) {
      if (!entry.isFile()) continue
      try {
        total += (await stat(path.join(dir, entry.name))).size
      } catch {
        // raced away mid-sweep: skip it
      }
    }
    return total
  } catch {
    return 0
  }
}
