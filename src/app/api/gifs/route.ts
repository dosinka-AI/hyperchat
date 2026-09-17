import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { unauthorized } from '@/lib/realtime'
import { searchCatalog, GIF_CATALOG } from '@/components/hyperchat/gif-catalog'

/** Hard cap on results returned per page to the picker grid. */
const MAX_RESULTS = 40
/** Trending grid size when no query is given. */
const TRENDING_COUNT = 60
/** Per-request upstream timeout; any slower response is treated as a failure. */
const UPSTREAM_TIMEOUT_MS = 4_000

type GifResult = { id: string; url: string; title: string; preview?: string }

/** Klipy ships a public demo app key inside their own open-source demo apps;
 *  it works out of the box so the full live library is reachable with zero
 *  setup. A KLIPY_API_KEY in the env always wins over the demo default. */
const KLIPY_DEMO_KEY = 'Y9qk261ZOzIZMj6Y8OYOMsDcK6we3rHfYOvgZX8rfAIHorqidaM5RjTD0gQfvdnY'

/** Built-in catalog fallback (also the default when no API key is configured).
 *  An empty query returns the daily trending sample instead of the whole file. */
function fromCatalog(q: string, offset: number): { gifs: GifResult[]; more: boolean } {
  if (!q.trim()) {
    const sample = trendingSample()
    return { gifs: sample.slice(offset, offset + MAX_RESULTS), more: offset + MAX_RESULTS < sample.length }
  }
  const hits = searchCatalog(q)
  return {
    gifs: hits.slice(offset, offset + MAX_RESULTS).map(({ id, url, title }) => ({ id, url, title })),
    more: offset + MAX_RESULTS < hits.length,
  }
}

/** Deterministic per-day shuffle so the trending grid rotates daily and stays
 *  stable within a session (no jumping rows). */
function trendingSample(): GifResult[] {
  const day = Math.floor(Date.now() / 86_400_000)
  const scored = GIF_CATALOG.map((g, i) => {
    // xorshift-ish hash of day+index for a stable pseudo-shuffle
    let h = (day * 2654435761 + i * 40503) >>> 0
    h = (h ^ (h >>> 13)) * 1274126177
    return { g, k: (h >>> 0) % 100000 }
  })
  scored.sort((a, b) => a.k - b.k)
  return scored.slice(0, TRENDING_COUNT).map(({ g }) => ({ id: g.id, url: g.url, title: g.title }))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Pick the best gif url plus a light preview from one real Klipy item:
 *  file.{hd,md}.{gif,webp} nests the variants; md.gif is the right size for
 *  chat, md.webp is a much smaller grid preview, hd covers missing md. */
function klipyItemToGif(item: Record<string, unknown>): GifResult | null {
  const rawId = item.id ?? item.gif_id
  const id = typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : ''
  const title = typeof item.title === 'string' && item.title.trim() ? item.title.trim() : 'gif'
  const file = isRecord(item.file) ? item.file : null

  const variantUrl = (size: 'hd' | 'md', fmt: 'gif' | 'webp'): string | null => {
    const tier = file && isRecord(file[size]) ? (file[size] as Record<string, unknown>) : null
    const fmtObj = tier && isRecord(tier[fmt]) ? (tier[fmt] as Record<string, unknown>) : null
    const url = fmtObj && typeof fmtObj.url === 'string' ? fmtObj.url : null
    return url && /^https?:\/\//i.test(url) ? url : null
  }

  // legacy flat shapes keep working (url / gif_url / formats[])
  const legacy: string[] = []
  for (const key of ['url', 'gif_url']) {
    const v = item[key]
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) legacy.push(v)
  }

  const url = variantUrl('md', 'gif') ?? variantUrl('hd', 'gif') ?? legacy[0]
  if (!id || !url) return null
  const preview = variantUrl('md', 'webp') ?? variantUrl('hd', 'webp')
  return { id, url, title, ...(preview ? { preview } : {}) }
}

/** Real Klipy payload: { result, data: { data: [items], current_page,
 *  per_page, has_next } }. Older/flat shapes (data as array, results) are
 *  still accepted so nothing regresses if the API shifts again. */
function extractKlipyGifs(payload: unknown): { gifs: GifResult[]; more: boolean } {
  if (!isRecord(payload)) return { gifs: [], more: false }
  let items: unknown[] | null = null
  let more = false
  if (isRecord(payload.data)) {
    const inner = payload.data
    if (Array.isArray(inner.data)) {
      items = inner.data
      more = inner.has_next === true || inner.hasNext === true
    }
  }
  if (!items && Array.isArray(payload.data)) items = payload.data
  if (!items && Array.isArray(payload.results)) items = payload.results
  if (!items) return { gifs: [], more: false }
  const gifs: GifResult[] = []
  for (const item of items) {
    if (!isRecord(item)) continue
    const gif = klipyItemToGif(item)
    if (gif) gifs.push(gif)
  }
  return { gifs, more: more && gifs.length > 0 }
}

/** Standard Giphy API payload: { data: [{ id, title, images.original.url }] }. */
function extractGiphyGifs(payload: unknown): GifResult[] {
  const data = isRecord(payload) ? payload.data : null
  if (!Array.isArray(data)) return []
  const out: GifResult[] = []
  for (const item of data) {
    if (!isRecord(item)) continue
    const id = typeof item.id === 'string' ? item.id : ''
    const rawTitle = typeof item.title === 'string' ? item.title.trim() : ''
    const images = isRecord(item.images) ? item.images : null
    const original = images && isRecord(images.original) ? images.original : null
    const url = original && typeof original.url === 'string' ? original.url : null
    if (id && url) out.push({ id, url, title: rawTitle || 'gif' })
  }
  return out
}

/** One upstream attempt: fetch, timeout, shape-agnostic parse. Returns null on
 *  ANY failure so the caller can try the next variant or fall back. */
async function tryFetchJson(
  url: string,
  headers: Record<string, string>,
  extract: (p: unknown) => { gifs: GifResult[]; more: boolean }
): Promise<{ gifs: GifResult[]; more: boolean } | null> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const payload: unknown = await res.json()
    const parsed = extract(payload)
    return parsed.gifs.length > 0 ? parsed : null
  } catch {
    return null
  }
}

/** Klipy GIF search/trending on the live REST API (api.klipy.com).
 *  page-based pagination, a per-user customer_id for personalized trending,
 *  and a medium content filter so the grid stays chat-safe. The demo key
 *  works without signup; KLIPY_API_KEY overrides it. */
async function klipy(
  endpoint: 'search' | 'trending',
  q: string,
  apiKey: string,
  offset: number,
  customerId: string
): Promise<{ gifs: GifResult[]; more: boolean } | null> {
  const params = new URLSearchParams({
    per_page: String(MAX_RESULTS),
    page: String(Math.floor(offset / MAX_RESULTS) + 1),
    content_filter: 'medium',
    customer_id: customerId,
  })
  if (endpoint === 'search') params.set('q', q)
  const path = endpoint === 'search' ? 'gifs/search' : 'gifs/trending'
  return tryFetchJson(
    `https://api.klipy.com/api/v1/${encodeURIComponent(apiKey)}/${path}?${params.toString()}`,
    { Accept: 'application/json' },
    extractKlipyGifs
  )
}

/** Giphy REST (api.giphy.com/v1/gifs): search and trending, offset paging. */
async function giphy(endpoint: 'search' | 'trending', q: string, apiKey: string, offset: number): Promise<{ gifs: GifResult[]; more: boolean } | null> {
  const params = new URLSearchParams({
    limit: String(MAX_RESULTS),
    offset: String(offset),
    rating: 'pg-13',
  })
  if (endpoint === 'search') params.set('q', q)
  const gifs = await tryFetchJson(
    `https://api.giphy.com/v1/gifs/${endpoint}?${params.toString()}&api_key=${encodeURIComponent(apiKey)}`,
    {},
    (p) => ({ gifs: extractGiphyGifs(p), more: true })
  )
  return gifs
}

export async function GET(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  const q = (req.nextUrl.searchParams.get('q') || '').trim()
  const offset = Math.max(0, Math.min(9_999, Number(req.nextUrl.searchParams.get('offset')) || 0))
  const kind: 'search' | 'trending' = q ? 'search' : 'trending'

  // upstream providers win when their keys are configured; the klipy demo
  // key makes the live library reachable with zero setup, env overrides it
  const klipyKey = process.env.KLIPY_API_KEY || KLIPY_DEMO_KEY
  if (klipyKey) {
    const remote = await klipy(kind, q, klipyKey, offset, me.id)
    if (remote) {
      return NextResponse.json({ gifs: remote.gifs.slice(0, MAX_RESULTS), provider: 'klipy', more: remote.more })
    }
  }
  const giphyKey = process.env.GIPHY_API_KEY
  if (giphyKey) {
    const remote = await giphy(kind, q, giphyKey, offset)
    if (remote) {
      return NextResponse.json({ gifs: remote.gifs.slice(0, MAX_RESULTS), provider: 'giphy', more: remote.gifs.length >= MAX_RESULTS })
    }
  }

  const { gifs, more } = fromCatalog(q, offset)
  return NextResponse.json({ gifs, provider: 'catalog', more })
}
