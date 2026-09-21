'use client'

import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { sounds } from './sounds'
import { useChatStore } from './store'
import { releaseYouTubeEmbed, trackYouTubeEmbed, youTubeTimeOf } from './yt-registry'
import { ServerInviteEmbed } from '@/components/hyperchat/ServerInviteEmbed'
import { UrlVideoEmbed, HideEmbedButton } from '@/components/hyperchat/MediaSurface'
import { isBlanked, subscribeBlanked, toggleBlanked } from './media-blank'
import { lookupServerEmoji } from './serverEmoji'
import { hasFlags, splitFlagText } from './flags'
import { parseTableBlock, type ParsedTable, type TableAlign } from './table'
import { Eye, EyeOff, PictureInPicture2, Play } from 'lucide-react'
import { PrismAsyncLight } from 'react-syntax-highlighter'
import prismJs from 'react-syntax-highlighter/dist/esm/languages/prism/javascript'
import prismTs from 'react-syntax-highlighter/dist/esm/languages/prism/typescript'
import prismTsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx'
import prismJsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx'
import prismPython from 'react-syntax-highlighter/dist/esm/languages/prism/python'
import prismBash from 'react-syntax-highlighter/dist/esm/languages/prism/bash'
import prismJson from 'react-syntax-highlighter/dist/esm/languages/prism/json'
import prismCss from 'react-syntax-highlighter/dist/esm/languages/prism/css'
import prismMarkup from 'react-syntax-highlighter/dist/esm/languages/prism/markup'
import prismSql from 'react-syntax-highlighter/dist/esm/languages/prism/sql'
import prismC from 'react-syntax-highlighter/dist/esm/languages/prism/c'
import prismCpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp'
import prismJava from 'react-syntax-highlighter/dist/esm/languages/prism/java'
import prismGo from 'react-syntax-highlighter/dist/esm/languages/prism/go'
import prismRust from 'react-syntax-highlighter/dist/esm/languages/prism/rust'
import prismYaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml'

// register a curated ~14-language set once; PrismAsyncLight highlights
// asynchronously and falls back to plain text when a language is unknown
PrismAsyncLight.registerLanguage('javascript', prismJs)
PrismAsyncLight.registerLanguage('typescript', prismTs)
PrismAsyncLight.registerLanguage('tsx', prismTsx)
PrismAsyncLight.registerLanguage('jsx', prismJsx)
PrismAsyncLight.registerLanguage('python', prismPython)
PrismAsyncLight.registerLanguage('bash', prismBash)
PrismAsyncLight.registerLanguage('json', prismJson)
PrismAsyncLight.registerLanguage('css', prismCss)
PrismAsyncLight.registerLanguage('markup', prismMarkup)
PrismAsyncLight.registerLanguage('sql', prismSql)
PrismAsyncLight.registerLanguage('c', prismC)
PrismAsyncLight.registerLanguage('cpp', prismCpp)
PrismAsyncLight.registerLanguage('java', prismJava)
PrismAsyncLight.registerLanguage('go', prismGo)
PrismAsyncLight.registerLanguage('rust', prismRust)
PrismAsyncLight.registerLanguage('yaml', prismYaml)

/** The code fence tag the user typed -> the prism language we registered. */
const LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  py: 'python',
  python: 'python',
  sh: 'bash',
  shell: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  css: 'css',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  markup: 'markup',
  sql: 'sql',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  java: 'java',
  go: 'go',
  golang: 'go',
  rs: 'rust',
  rust: 'rust',
  yaml: 'yaml',
  yml: 'yaml',
}

/** A minimal monochrome-plus-blue palette, keyed to Prism token types. The
 *  background stays transparent so the existing pre chrome (bg-black/70)
 *  shows through; only the token colors are ours. */
const CODE_STYLE: Record<string, CSSProperties> = {
  'pre[class*="language-"]': {
    background: 'transparent',
    margin: 0,
    padding: 0,
    overflow: 'visible',
    color: '#f5f5f5',
    fontFamily: 'inherit',
    fontSize: 'inherit',
  },
  'code[class*="language-"]': {
    background: 'transparent',
    color: '#f5f5f5',
    fontFamily: 'inherit',
    fontSize: 'inherit',
  },
  comment: { color: '#5c5c5c', fontStyle: 'italic' },
  prolog: { color: '#5c5c5c' },
  doctype: { color: '#5c5c5c' },
  cdata: { color: '#5c5c5c' },
  punctuation: { color: '#9a9a9a' },
  keyword: { color: '#547cff' },
  control: { color: '#547cff' },
  operator: { color: '#d4d4d4' },
  string: { color: '#4f9e63' },
  char: { color: '#4f9e63' },
  'attr-value': { color: '#4f9e63' },
  inserted: { color: '#4f9e63' },
  url: { color: '#4f9e63' },
  number: { color: '#f0b232' },
  boolean: { color: '#f0b232' },
  constant: { color: '#f0b232' },
  entity: { color: '#f0b232' },
  regex: { color: '#f0b232' },
  function: { color: '#f5f5f5' },
  'class-name': { color: '#f5f5f5' },
  builtin: { color: '#f5f5f5' },
  variable: { color: '#f5f5f5' },
  property: { color: '#f5f5f5' },
  symbol: { color: '#f5f5f5' },
  tag: { color: '#c96e50' },
  selector: { color: '#c96e50' },
  'attr-name': { color: '#c96e50' },
  deleted: { color: '#c96e50' },
  namespace: { color: '#c96e50' },
  important: { color: '#547cff', fontWeight: 'bold' },
  bold: { fontWeight: 'bold' },
  italic: { fontStyle: 'italic' },
}

type MentionOptions = {
  myUsername?: string | null
  onMention?: (username: string) => void
  /** true when the sender had permission to ping everyone (@everyone/@here render as live mentions) */
  pingsEveryone?: boolean
  /** clicking a #msg=<id> permalink jumps to that message in-app */
  onPermalink?: (messageId: string) => void
}

/** Extract the message id from a same-origin #msg= link, else null. */
export function permalinkTarget(href: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    const url = new URL(href, window.location.origin)
    if (url.origin !== window.location.origin) return null
    const m = /^#msg=([A-Za-z0-9_-]+)$/.exec(url.hash)
    return m ? m[1] : null
  } catch {
    return null
  }
}

const INLINE_RE = new RegExp(
  [
    // bold+italic first so *** is not half-eaten by the bold/italic rules
    String.raw`\*\*\*(?<boldItalic>[^*\n]+)\*\*\*`,
    // bold before italic so ** is not half-eaten by the single-star rule
    String.raw`\*\*(?<bold>[^*\n]+)\*\*`,
    String.raw`__(?<underline>[^_\n]+)__`,
    String.raw`\*(?<italic>[^*\n]+)\*`,
    String.raw`~~(?<strike>[^~\n]+)~~`,
    "`(?<code>[^`\\n]+)`",
    String.raw`\|\|(?<spoiler>[^|\n]+)\|\|`,
    // rich text: [c=#hex]...[/c] color and [s=px]...[/s] size. colored
    // bodies render recursively so **bold** inside a color still lands
    String.raw`\[c=(?<colorHex>#?[0-9a-fA-F]{3,8})\](?<colorBody>.*?)\[/c\]`,
    String.raw`\[s=(?<sizePx>\d{1,2})\](?<sizeBody>.*?)\[/s\]`,
    String.raw`(?<link>https?:\/\/[^\s]+)`,
    String.raw`(?<mentionRaw>@[a-z0-9_]{3,20})`,
    String.raw`(?<emojiRaw>:[a-z0-9_]{2,32}:)`,
    // the marker: only the ZWSP-sentineled ??? (swapped in from :fniger:
    // on send) carries the full-spectrum gradient. a plain ??? the user
    // typed renders as ordinary text
    String.raw`\u200B\?\?\?`,
  ].join('|'),
  'g'
)

/** Normalize a [c=...] color to a safe #rrggbb (null when unusable). */
function safeHex(raw: string): string | null {
  let h = raw.startsWith('#') ? raw.slice(1) : raw
  if (!/^[0-9a-fA-F]+$/.test(h)) return null
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length !== 6) return null
  return `#${h.toLowerCase()}`
}

/** Clamp a [s=..] size to a sane readable band. */
function safeSize(raw: string): number | null {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return null
  return Math.max(10, Math.min(28, n))
}

/** Shareable server invite token: hyperion.gg/<code> (the legacy
 *  hyperchat.gg/<code> form still renders, so pre-rebrand messages keep
 *  their cards). The optional leading whitespace is consumed by the match
 *  and stitched back into the surrounding text. */
const INVITE_RE = /(?:^|\s)(hyperion|hyperchat)\.gg\/([a-zA-Z0-9]{6,16})/g

/** Extract @username mentions from a message body. */
export function extractMentions(content: string): string[] {
  const found = new Set<string>()
  for (const match of content.matchAll(/@([a-z0-9_]{3,20})/g)) {
    found.add(match[1])
  }
  return Array.from(found)
}

/** Discord-style spoiler: blurred until clicked. */
function Spoiler({ text }: { text: string }) {
  const [revealed, setRevealed] = useState(false)
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        setRevealed((v) => !v)
      }}
      className={cn(
        'rounded-sm px-1 text-left transition-colors',
        revealed ? 'bg-white/10 text-foreground' : 'bg-black/80 text-transparent select-none'
      )}
      aria-label={revealed ? 'Hide spoiler' : 'Reveal spoiler'}
    >
      {text}
    </button>
  )
}

function CodeBlock({ body }: { body: string }) {
  const [copied, setCopied] = useState(false)
  // optional language tag on the first line: ```js …
  const firstNewline = body.indexOf('\n')
  const firstLine = firstNewline === -1 ? body : body.slice(0, firstNewline)
  const hasLang = /^[a-zA-Z0-9+#-]{1,20}$/.test(firstLine.trim()) && firstNewline !== -1
  const code = hasLang ? body.slice(firstNewline + 1) : body
  const lang = hasLang ? firstLine.trim() : null
  const prismLang = lang ? LANG_ALIASES[lang.toLowerCase()] ?? null : null

  return (
    <div className="relative group my-1.5">
      <div className="msg-codeblock text-[13px] leading-relaxed bg-black/70 border border-border rounded-sm px-3 py-2.5 overflow-x-auto scroll-thin">
        {prismLang ? (
          <PrismAsyncLight language={prismLang} style={CODE_STYLE}>
            {code || ' '}
          </PrismAsyncLight>
        ) : (
          <pre className="whitespace-pre">{code || ' '}</pre>
        )}
      </div>
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1.5">
        {lang && (
          <span className="text-[10px] font-semibold tracking-wider text-muted-foreground bg-app-raise/80 border border-white/10 rounded-sm px-1.5 py-0.5">
            {lang}
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code)
            sounds.play('glassTick')
            setCopied(true)
            setTimeout(() => setCopied(false), 1400)
          }}
          className="text-[10px] font-semibold tracking-wider text-muted-foreground hover:text-foreground bg-app-raise/80 border border-white/10 rounded-sm px-1.5 py-0.5 transition-colors"
          aria-label="Copy code"
        >
          {copied ? 'COPIED' : 'COPY'}
        </button>
      </div>
    </div>
  )
}

function alignClass(align?: TableAlign): string {
  if (align === 'center') return 'text-center'
  if (align === 'right') return 'text-right'
  return 'text-left'
}

/** Discord-style table: block-level, header rendered inline (markup inside
 *  cells works), alignment from the separator row. Wide tables scroll. */
function TableBlock({ table, opts }: { table: ParsedTable; opts: MentionOptions }) {
  return (
    <div className="my-1.5 rounded-sm border border-white/10 overflow-x-auto scroll-thin">
      <table className="border-collapse w-full">
        <thead>
          <tr>
            {table.header.map((cell, ci) => (
              <th
                key={ci}
                className={cn(
                  'px-3 py-1.5 text-[13px] font-semibold text-muted-foreground border-b border-white/5',
                  alignClass(table.aligns[ci])
                )}
              >
                {renderInline(cell, opts)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri}>
              {table.header.map((_, ci) => (
                <td
                  key={ci}
                  className={cn(
                    'px-3 py-1.5 text-[13px] border-b border-white/5',
                    alignClass(table.aligns[ci])
                  )}
                >
                  {renderInline(row[ci] ?? '', opts)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Extract the 11-char video id from every common YouTube url shape:
 *  watch, youtu.be, shorts, live, embed, and the m./music. hosts.
 *  Wrong-length ids return null so the url stays a plain link. */
export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '')
    let id: string | null = null
    if (host === 'youtu.be') {
      id = u.pathname.split('/').filter(Boolean)[0] ?? null
    } else if (host === 'youtube.com') {
      const path = u.pathname.replace(/\/+$/, '')
      if (path === '/watch' || path === '') {
        id = u.searchParams.get('v')
      } else {
        const parts = path.split('/').filter(Boolean)
        if (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed') id = parts[1] ?? null
      }
    } else {
      return null
    }
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null
  } catch {
    return null
  }
}

/** Direct video file url (.mp4/.webm/.mov, query string allowed and kept
 *  for playback), else null. */
export function directVideoUrl(url: string): string | null {
  if (!/^https?:\/\//.test(url)) return null
  try {
    return /\.(mp4|webm|mov)$/i.test(new URL(url).pathname) ? url : null
  } catch {
    return null
  }
}

/** Urls pasted bare or inside angle brackets can drag punctuation along
 *  ("check this <https://youtu.be/x>."); trim the wrapper and the common
 *  trailing marks before any media parsing. */
function cleanMediaUrl(token: string): string {
  let t = token.trim()
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1)
  return t.replace(/[.,;:!?)]+$/, '')
}

/** true when a line, after trim, is nothing but an embeddable media url. */
function isStandaloneMediaUrl(line: string): boolean {
  const t = line.trim()
  if (!/^<?https?:\/\/\S+>?$/.test(t)) return false
  const cleaned = cleanMediaUrl(t)
  return youtubeId(cleaned) !== null || directVideoUrl(cleaned) !== null
}

/** Find the first embeddable media url inside an arbitrary line: urls
 *  dropped mid-sentence still earn a card (Discord behavior). Returns the
 *  cleaned url, or null. */
function inlineMediaUrl(line: string): string | null {
  if (!/https?:\/\//.test(line)) return null
  for (const m of line.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const cleaned = cleanMediaUrl(m[0])
    if (youtubeId(cleaned) !== null || directVideoUrl(cleaned) !== null) return cleaned
  }
  return null
}

/** Discord-style click-to-load YouTube card: thumbnail + play affordance,
 *  swapped for the nocookie iframe on first click. While it plays it is
 *  tracked in the yt registry so the mini player can carry it across room
 *  switches, and a pop-out button hands it over on demand. When the video
 *  is already live in the mini player and the user comes back to this
 *  room, the card resumes inline at the last tracked second (the panel
 *  steps aside for its source embed). An eye button blanks the card for
 *  things you would rather not look at. */
function YouTubeEmbed({ id }: { id: string }) {
  const [playing, setPlaying] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const openYouTubePlayer = useChatStore((s) => s.openYouTubePlayer)
  const closeMediaPlayer = useChatStore((s) => s.closeMediaPlayer)
  const player = useChatStore((s) => s.mediaPlayer)
  const currentRoom = useChatStore((s) => {
    if (s.friendsViewOpen || s.accountOpen) return null
    if (s.activeChannelId) return `channel:${s.activeChannelId}`
    if (s.activeConversationId) return `conversation:${s.activeConversationId}`
    return null
  })
  const [blanked, setBlanked] = useState(() => isBlanked(`yt:${id}`))
  useEffect(() => {
    const sync = () => setBlanked(isBlanked(`yt:${id}`))
    sync()
    return subscribeBlanked(sync)
  }, [id])

  // resume handoff: the mini player holds this video while the user is
  // away; the moment they are back in this room the embed takes over (the
  // panel closes itself) and playback continues inline at the tracked time
  const activeHere =
    player?.kind === 'youtube' && player.videoId === id && player.roomId === currentRoom && !player.popped
  useEffect(() => {
    if (activeHere && !playing) {
      // the embed owns playback now; the floating player can let go. this
      // one-shot handoff is genuinely stateful (room arrival flips the
      // surface), so a render-cascade here is the intended behavior
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPlaying(true)
      closeMediaPlayer()
    }
    // [playing] is deliberately not a dep: re-running on every play flip
    // would fight the handoff itself
  }, [activeHere])

  useEffect(() => {
    if (!playing) return
    trackYouTubeEmbed(id, iframeRef.current)
    return () => releaseYouTubeEmbed(id, iframeRef.current)
  }, [playing, id])

  /** pop out to the persistent mini player at the current timestamp */
  function detach() {
    openYouTubePlayer(id, youTubeTimeOf(id), undefined, currentRoom ?? undefined)
    openPopOut()
    setPlaying(false)
  }

  function openPopOut() {
    // the manual pop-out marks the player as deliberately floating so it
    // stays visible even while the user is in this room
    const cur = useChatStore.getState().mediaPlayer
    if (cur) useChatStore.getState().setMediaPopped(true)
  }

  if (blanked) {
    return (
      <div className="mt-1.5 max-w-md rounded-sm border border-white/10 bg-app-raise px-3 py-2.5 flex items-center gap-2.5">
        <EyeOff className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex-1 min-w-0 text-xs text-muted-foreground truncate">video hidden (you chose not to see it)</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            toggleBlanked(`yt:${id}`)
          }}
          className="flex items-center gap-1 rounded-sm px-1.5 py-1 text-[11px] font-semibold text-foreground/70 hover:text-foreground hover:bg-accent transition-colors"
          aria-label="Reveal hidden video"
          title="reveal"
        >
          <Eye className="size-3.5" />
          reveal
        </button>
      </div>
    )
  }

  if (playing) {
    return (
      <div className="mt-1.5 max-w-md rounded-sm border border-white/10 overflow-hidden bg-black group/embed">
        <div className="relative aspect-video">
          <iframe
            ref={iframeRef}
            src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&controls=1&start=${youTubeTimeOf(id)}&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            title="video"
            className="size-full absolute inset-0 border-0"
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              sounds.play('lightTick')
              detach()
            }}
            className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1 px-1.5 py-1 rounded-sm bg-black/70 text-[10px] font-bold text-white/90 hover:bg-black transition-colors opacity-0 group-hover/embed:opacity-100 focus-visible:opacity-100"
            aria-label="Open in mini player"
            title="open in mini player"
          >
            <PictureInPicture2 className="size-3" />
            player
          </button>
          <HideEmbedButton url={`yt:${id}`} blanked={blanked} className="top-1.5 right-[4.6rem]" />
        </div>
        {/* YouTube's own playbar runs inside the iframe (controls=1): no
            custom Hyperion bar rides under it */}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        setPlaying(true)
      }}
      aria-label="play video"
      // w-full is load-bearing: buttons shrink-to-fit under aspect-ratio in
      // some engines (a ~3px card reads as "embeds do not work"); with it the
      // card fills the column up to max-w-md like a proper video card
      className="block w-full mt-1.5 max-w-md aspect-video rounded-sm border border-white/10 overflow-hidden relative bg-black hover:border-white/25 transition-colors cursor-pointer group/embed"
    >
      <img
        src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`}
        alt=""
        loading="lazy"
        className="absolute inset-0 size-full object-cover"
      />
      <span className="absolute inset-0 grid place-items-center">
        <span className="size-12 rounded-full bg-black/70 border border-white/20 grid place-items-center">
          <Play className="size-5 fill-white text-white translate-x-0.5" />
        </span>
      </span>
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation()
          sounds.play('lightTick')
          detach()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation()
            e.preventDefault()
            detach()
          }
        }}
        className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1 px-1.5 py-1 rounded-sm bg-black/70 text-[10px] font-bold text-white/90 hover:bg-black transition-[color,background-color,opacity] opacity-0 group-hover/embed:opacity-100 focus-visible:opacity-100"
        aria-label="Open in mini player"
        title="open in mini player"
      >
        <PictureInPicture2 className="size-3" />
        player
      </span>
      <span
        role="button"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation()
          sounds.play('lightTick')
          toggleBlanked(`yt:${id}`)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation()
            e.preventDefault()
            sounds.play('lightTick')
            toggleBlanked(`yt:${id}`)
          }
        }}
        className="absolute top-1.5 right-[4.6rem] z-10 grid place-items-center size-6 rounded-sm bg-black/70 text-white/70 hover:text-white hover:bg-black transition-[color,background-color,opacity] opacity-0 group-hover/embed:opacity-100 focus-visible:opacity-100"
        aria-label="Hide video"
        title="hide (keep the message, lose the visuals)"
      >
        <EyeOff className="size-3" />
      </span>
    </button>
  )
}

/** Standalone media url -> YouTube card or the custom inline video player
 *  (file videos play in the message with Hyperion chrome, never the
 *  browser default). */
function MediaEmbed({ url }: { url: string }) {
  const yt = youtubeId(url)
  if (yt) return <YouTubeEmbed id={yt} />
  if (directVideoUrl(url)) return <UrlVideoEmbed url={url} />
  return null
}

/** Plain text run: regional-indicator flag pairs render as bundled twemoji
 *  glyphs (windows draws them as "US" letters), the rest stays text. */
function pushPlain(nodes: ReactNode[], text: string, nextKey: () => number): void {
  if (!hasFlags(text)) {
    nodes.push(<Fragment key={nextKey()}>{text}</Fragment>)
    return
  }
  for (const part of splitFlagText(text)) {
    if (part.kind === 'text') {
      nodes.push(<Fragment key={nextKey()}>{part.text}</Fragment>)
    } else {
      nodes.push(
        <img
          key={nextKey()}
          src={part.src}
          alt={part.pair}
          draggable={false}
          loading="lazy"
          className="emoji-img inline-block size-[1.2em] object-contain align-[-0.22em] pointer-events-none select-none"
        />
      )
    }
  }
}

function renderInline(line: string, opts: MentionOptions, depth = 0): ReactNode {
  const nodes: ReactNode[] = []
  let last = 0
  let key = 0
  const nextKey = () => key++

  for (const match of line.matchAll(INLINE_RE)) {
    const idx = match.index ?? 0
    if (idx > last) pushPlain(nodes, line.slice(last, idx), nextKey)

    const g = match.groups ?? {}
    const full = match[0]

    if (g.boldItalic) {
      nodes.push(
        <strong key={key++} className="font-bold italic text-white">
          {renderInline(g.boldItalic, opts, depth + 1)}
        </strong>
      )
    } else if (full === '\u200B???') {
      // the marker: the dense full-spectrum gradient treatment (the
      // leading ZWSP is stripped from the rendered text so copies are clean)
      nodes.push(
        <span key={key++} className="rainbow-marker" aria-label="???">
          ???
        </span>
      )
    } else if (g.bold) {
      nodes.push(
        <strong key={key++} className="font-bold text-white">
          {g.bold}
        </strong>
      )
    } else if (g.underline) {
      nodes.push(
        <u key={key++} className="underline decoration-foreground/60 underline-offset-2">
          {g.underline}
        </u>
      )
    } else if (g.italic) {
      nodes.push(
        <em key={key++} className="italic">
          {g.italic}
        </em>
      )
    } else if (g.strike) {
      nodes.push(
        <s key={key++} className="opacity-70">
          {g.strike}
        </s>
      )
    } else if (g.code) {
      nodes.push(
        <code
          key={key++}
          className="msg-codeblock text-[13px] bg-black/60 border border-border rounded-sm px-1.5 py-0.5"
        >
          {g.code}
        </code>
      )
    } else if (g.spoiler) {
      nodes.push(<Spoiler key={key++} text={g.spoiler} />)
    } else if (g.colorHex && g.colorBody !== undefined) {
      const hex = safeHex(g.colorHex)
      if (hex && depth < 4) {
        nodes.push(
          <span key={key++} style={{ color: hex }}>
            {renderInline(g.colorBody, opts, depth + 1)}
          </span>
        )
      } else {
        nodes.push(<Fragment key={key++}>{full}</Fragment>)
      }
    } else if (g.sizePx && g.sizeBody !== undefined) {
      const px = safeSize(g.sizePx)
      if (px && depth < 4) {
        nodes.push(
          <span key={key++} style={{ fontSize: `${px}px` }} className="leading-snug">
            {renderInline(g.sizeBody, opts, depth + 1)}
          </span>
        )
      } else {
        nodes.push(<Fragment key={key++}>{full}</Fragment>)
      }
    } else if (g.link) {
      const permalink = permalinkTarget(g.link)
      nodes.push(
        <a
          key={key++}
          href={permalink ? '#msg=' + permalink : g.link}
          target={permalink ? undefined : '_blank'}
          rel="noopener noreferrer"
          onClick={(e) => {
            if (!permalink) return
            e.preventDefault()
            e.stopPropagation()
            opts.onPermalink?.(permalink)
          }}
          className="text-hyper hover:underline break-all"
        >
          {g.link}
        </a>
      )
    } else if (g.mentionRaw) {
      const mention = g.mentionRaw.slice(1)
      const lower = mention.toLowerCase()
      const mine = opts.myUsername && lower === opts.myUsername.toLowerCase()
      // @everyone/@here only light up when the sender could actually ping
      const mass = (lower === 'everyone' || lower === 'here') && !!opts.pingsEveryone
      if (mass) {
        nodes.push(
          <span
            key={key++}
            className="rounded-sm px-0.5 font-semibold bg-hyper/20 text-hyper"
          >
            @{mention}
          </span>
        )
      } else {
        nodes.push(
          <button
            key={key++}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              opts.onMention?.(mention)
            }}
            className={cn(
              'rounded-sm px-0.5 font-medium transition-colors',
              mine
                ? 'bg-hyper/20 text-hyper hover:bg-hyper/30'
                : 'text-hyper/90 hover:bg-hyper/10 hover:text-hyper'
            )}
          >
            @{mention}
          </button>
        )
      }
    } else if (g.emojiRaw) {
      // custom server emoji: known tokens render as images, unknown stay text
      const hit = lookupServerEmoji(g.emojiRaw)
      if (hit) {
        nodes.push(
          <img
            key={key++}
            src={hit.url}
            alt={g.emojiRaw}
            draggable={false}
            loading="lazy"
            className="emoji-img inline-block size-[1.3em] object-contain align-[-0.24em] pointer-events-none select-none"
          />
        )
      } else {
        nodes.push(<Fragment key={key++}>{full}</Fragment>)
      }
    } else {
      nodes.push(<Fragment key={key++}>{full}</Fragment>)
    }
    last = idx + full.length
  }

  if (last < line.length) pushPlain(nodes, line.slice(last), nextKey)
  return nodes
}

/** A line carrying hyperion.gg/<code> tokens: the surrounding text
 *  stays intact and each token becomes a block-level invite card. */
function renderLineWithInvites(line: string, opts: MentionOptions): ReactNode | null {
  const matches = Array.from(line.matchAll(INVITE_RE))
  if (matches.length === 0) return null

  const parts: ReactNode[] = []
  let last = 0
  let key = 0
  for (const match of matches) {
    const code = match[2]
    // domain length + the slash; depends on which domain matched
    const prefixLen = match[1].length + 1
    const tokenStart = (match.index ?? 0) + match[0].length - prefixLen - code.length
    if (tokenStart > last) {
      parts.push(<Fragment key={`t${key++}`}>{renderInline(line.slice(last, tokenStart), opts)}</Fragment>)
    }
    parts.push(<ServerInviteEmbed key={`i${key++}`} code={code} />)
    last = tokenStart + prefixLen + code.length
  }
  if (last < line.length) {
    parts.push(<Fragment key={`t${key++}`}>{renderInline(line.slice(last), opts)}</Fragment>)
  }
  return <div className="whitespace-pre-wrap break-words">{parts}</div>
}

/** Render a chat message body: code blocks, quotes, bold, italic, strike,
 *  inline code, links, spoilers, @mentions, hyperion.gg server invite
 *  cards and standalone video embeds (YouTube click-to-load, direct video
 *  files). Deliberately small: chat markup, not a full document engine. */
export function renderMessageContent(content: string, opts: MentionOptions = {}): ReactNode {
  const segments = content.split(/```/)

  return segments.map((segment, i) => {
    if (i % 2 === 1) {
      // fenced code block
      const body = segment.replace(/^\n+|\n+$/g, '')
      return <CodeBlock key={i} body={body} />
    }

    const lines = segment.split('\n')
    const out: ReactNode[] = []
    let quote: string[] = []
    let list: string[] = []
    let key = 0

    const flushQuote = () => {
      if (quote.length === 0) return
      const body = quote.join('\n')
      quote = []
      out.push(
        <blockquote
          key={`q${key++}`}
          className="border-l-2 border-hyper/60 pl-3 my-1 text-foreground/90 whitespace-pre-wrap"
        >
          {renderInline(body, opts)}
        </blockquote>
      )
    }

    // consecutive "- " / "* " lines fold into a tight bullet list
    const flushList = () => {
      if (list.length === 0) return
      const items = list
      list = []
      out.push(
        <ul key={`ul${key++}`} className="my-1 pl-4 list-outside list-disc space-y-0.5">
          {items.map((li, n) => (
            <li key={n} className="whitespace-pre-wrap break-words">
              {renderInline(li, opts)}
            </li>
          ))}
        </ul>
      )
    }

    let idx = 0
    while (idx < lines.length) {
      const line = lines[idx]

      // Discord-style headings: "# text" (one to three hashes) renders as
      // a big bold display line anywhere — dms, gcs, servers alike
      const heading = /^(#{1,3})\s+(.+)$/.exec(line)
      if (heading) {
        flushQuote()
        flushList()
        const level = heading[1].length
        out.push(
          <span
            key={`h${key++}`}
            className={cn(
              'block font-bold tracking-tight text-white leading-tight mt-1 first:mt-0',
              level === 1 && 'text-[1.45rem]',
              level === 2 && 'text-[1.2rem]',
              level === 3 && 'text-[1.05rem]'
            )}
          >
            {renderInline(heading[2], opts)}
          </span>
        )
        idx++
        continue
      }

      // markdown table: a header line immediately followed by a separator
      // row renders as a block-level table; cells keep inline markup
      if (line.includes('|') && idx + 1 < lines.length) {
        const table = parseTableBlock(lines.slice(idx))
        if (table) {
          flushQuote()
          flushList()
          out.push(<TableBlock key={`t${key++}`} table={table} opts={opts} />)
          idx += 2 + table.rows.length
          continue
        }
      }

      if (line.startsWith('> ')) {
        flushList()
        quote.push(line.slice(2))
        idx++
        continue
      }
      flushQuote()
      if (/^\s*[-*]\s+\S/.test(line)) {
        list.push(line.replace(/^\s*[-*]\s+/, ''))
        idx++
        continue
      }
      flushList()
      if (line.trim() === '' && out.length > 0) {
        out.push(<div key={`s${key++}`} className="h-1.5" />)
        idx++
        continue
      }
      // a bare media url line becomes an embed and never a text line
      if (isStandaloneMediaUrl(line)) {
        out.push(
          <Fragment key={`m${key++}`}>
            <MediaEmbed url={cleanMediaUrl(line.trim())} />
          </Fragment>
        )
        idx++
        continue
      }
      // a media url dropped mid-sentence keeps the text and earns a card
      // under it (spoiler-wrapped urls stay hidden by design: the || marks
      // never survive the token clean, so they never match here)
      const inlineMedia = inlineMediaUrl(line)
      const invited = renderLineWithInvites(line, opts)
      if (invited) {
        out.push(<Fragment key={`l${key++}`}>{invited}</Fragment>)
      } else {
        out.push(
          <span key={`l${key++}`} className="block whitespace-pre-wrap break-words">
            {line.trim() === '' ? '\u00A0' : renderInline(line, opts)}
          </span>
        )
      }
      if (inlineMedia) {
        out.push(
          <Fragment key={`mi${key++}`}>
            <MediaEmbed url={inlineMedia} />
          </Fragment>
        )
      }
      idx++
    }
    flushList()
    flushQuote()

    return <Fragment key={i}>{out}</Fragment>
  })
}
