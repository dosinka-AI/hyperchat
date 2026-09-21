import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, unauthorized, serverError } from '@/lib/realtime'

/** Discord-style rich link previews: fetch a URL's OpenGraph tags once,
 *  cache them in the LinkEmbed table forever, serve from cache after that.
 *  Safety: https/http only, 5s timeout, 256KB HTML cap, no redirects to
 *  private IPs (string check), every field length-capped and tag-stripped. */

const MAX_HTML = 262_144

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, '&')
}

function clean(input: string | undefined, cap: number): string | null {
  if (!input) return null
  const text = decodeEntities(input).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.slice(0, cap)
}

function metaTag(html: string, keys: string[]): string | null {
  for (const key of keys) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i')
    const tag = html.match(re)?.[0]
    if (!tag) continue
    const content = tag.match(/content=["']([^"']*)["']/i)?.[1]
    if (content) return content
  }
  return null
}

function linkTag(html: string, rel: string): string | null {
  const re = new RegExp(`<link[^>]+rel=["']${rel}["'][^>]*>`, 'i')
  const tag = html.match(re)?.[0]
  if (!tag) return null
  return tag.match(/href=["']([^"']*)["']/i)?.[1] ?? null
}

function isPublicHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return !(
    h === 'localhost' ||
    h === '0.0.0.0' ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)
  )
}

function absoluteUrl(raw: string, base: string): string | null {
  try {
    const u = new URL(raw, base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

export async function GET(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const raw = req.nextUrl.searchParams.get('url') ?? ''
    if (!raw) return badRequest('Which URL?')
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return badRequest('That is not a URL.')
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isPublicHost(url.hostname)) {
      return badRequest('Only public http(s) links unfurl.')
    }
    const canonical = url.toString().slice(0, 512)

    const cached = await db.linkEmbed.findUnique({ where: { url: canonical } })
    if (cached) {
      return NextResponse.json({
        embed: {
          url: cached.url,
          siteName: cached.siteName,
          title: cached.title,
          description: cached.description,
          faviconUrl: cached.faviconUrl,
          imageUrl: cached.imageUrl,
        },
      })
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    let html = ''
    let finalUrl = canonical
    try {
      const res = await fetch(canonical, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'user-agent': 'HyperionLinkPreview/1.0 (+unfurl bot)',
          accept: 'text/html,application/xhtml+xml',
        },
      })
      finalUrl = res.url || canonical
      const finalParsed = new URL(finalUrl)
      if (!isPublicHost(finalParsed.hostname)) return NextResponse.json({ embed: null })
      const contentType = res.headers.get('content-type') ?? ''
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
        return NextResponse.json({ embed: null })
      }
      const reader = res.body?.getReader()
      if (reader) {
        const chunks: Uint8Array[] = []
        let total = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done || !value) break
          total += value.length
          if (total > MAX_HTML) break
          chunks.push(value)
        }
        html = new TextDecoder('utf-8', { fatal: false }).decode(concat(chunks))
      }
    } catch {
      return NextResponse.json({ embed: null })
    } finally {
      clearTimeout(timer)
    }
    if (!html) return NextResponse.json({ embed: null })

    const title = metaTag(html, ['og:title', 'twitter:title']) ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? null
    const description = metaTag(html, ['og:description', 'twitter:description', 'description'])
    const siteName = metaTag(html, ['og:site_name', 'application-name']) ?? (() => { try { return new URL(finalUrl).hostname.replace(/^www\./, '') } catch { return null } })()
    const ogImage = metaTag(html, ['og:image', 'twitter:image'])
    const favicon = linkTag(html, 'icon') ?? linkTag(html, 'shortcut icon') ?? '/favicon.ico'

    const embed = {
      url: canonical,
      siteName: clean(siteName ?? undefined, 80),
      title: clean(title ?? undefined, 200),
      description: clean(description ?? undefined, 320),
      faviconUrl: favicon ? absoluteUrl(favicon, finalUrl) : null,
      imageUrl: ogImage ? absoluteUrl(ogImage, finalUrl) : null,
    }

    await db.linkEmbed
      .upsert({
        where: { url: canonical },
        create: { ...embed },
        update: {},
      })
      .catch(() => {})

    return NextResponse.json({ embed })
  } catch (err) {
    console.error('[embed GET]', err)
    return serverError()
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((a, c) => a + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}
