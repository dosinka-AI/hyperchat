'use client'

import { useEffect, useId, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { apiClient, ApiError } from '@/lib/client/api'
import { renderMessageContent } from '@/lib/client/markdown'
import { sounds } from '@/lib/client/sounds'
import { shortTime } from '@/lib/client/format'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import { Copy, RotateCcw, Sparkles } from 'lucide-react'

const COUNT_CHOICES = [10, 25, 50, 100]

/** cooldown between summaries, shared with the server's rate limiter */
const COOLDOWN_MS = 30_000

/** when the last successful summarize run finished (epoch ms). module
 *  scope so closing the dialog, or remounting it after a view swap, keeps
 *  the countdown honest — the server enforces the same window. */
let lastRunStamp: number | null = null

/** the rainbow spectrum the ai-summary marks wear: 12 hues with tight
 *  bands, closing back to red so the repeating gradient has no seam.
 *  (blue/indigo/violet are banned as UI colors but are part of a full
 *  rainbow spectrum, which is exactly what these marks are.) */
const RAINBOW_STOPS: [offset: string, color: string][] = [
  ['0', '#ff5f6d'],
  ['0.083', '#ff9248'],
  ['0.167', '#ffe259'],
  ['0.25', '#69db7c'],
  ['0.333', '#2dd4bf'],
  ['0.417', '#4cc9f0'],
  ['0.5', '#4d8dff'],
  ['0.583', '#7c6cf0'],
  ['0.667', '#a78bfa'],
  ['0.75', '#e05fd0'],
  ['0.833', '#f472b6'],
  ['0.917', '#ff8fa3'],
  ['1', '#ff5f6d'],
]

/** shared gradient def for both rainbow marks: userSpaceOnUse along the
 *  diagonal with a 12-unit repeat cycle. at header size (16px) the
 *  sparkle's center mass alone sweeps five-plus distinct hues and each
 *  arm runs warm-to-cool, so it reads as a true multi-color rainbow
 *  instead of collapsing into the one or two hues a corner-to-corner
 *  gradient lands on (that was the "yellow and green" complaint). */
function RainbowGradientDef({ id }: { id: string }) {
  return (
    <linearGradient id={id} x1="2" y1="2" x2="10.49" y2="10.49" gradientUnits="userSpaceOnUse" spreadMethod="repeat">
      {RAINBOW_STOPS.map(([offset, color]) => (
        <stop key={`${offset}-${color}`} offset={offset} stopColor={color} />
      ))}
    </linearGradient>
  )
}

/** two little rainbow stars: the ai-summary mark, shown in the dialog header */
export function RainbowStars({ className }: { className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const id = `rs${uid}`
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <defs>
        <RainbowGradientDef id={id} />
      </defs>
      {/* the big four-point star */}
      <path
        d="M12 3.5c.6 3.4 2.1 4.9 5.5 5.5-3.4.6-4.9 2.1-5.5 5.5-.6-3.4-2.1-4.9-5.5-5.5 3.4-.6 4.9-2.1 5.5-5.5Z"
        stroke={`url(#${id})`}
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      {/* the little companion star */}
      <path
        d="M18.2 14.6c.35 2 1.25 2.9 3.3 3.25-2.05.35-2.95 1.25-3.3 3.25-.35-2-1.25-2.9-3.3-3.25 2.05-.35 2.95-1.25 3.3-3.25Z"
        stroke={`url(#${id})`}
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** the ai action mark for the chat header: the same sparkle silhouette the
 *  summarize button uses, filled in with the rainbow gradient. Same family
 *  as the dialog's two-star mark, so the whole feature reads as one thing. */
export function RainbowSparkFilled({ className }: { className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const id = `rsf${uid}`
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <defs>
        <RainbowGradientDef id={id} />
      </defs>
      {/* the lucide sparkles body, filled with the rainbow */}
      <path
        d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"
        fill={`url(#${id})`}
      />
      <path d="M20 3v4" stroke={`url(#${id})`} strokeWidth="2.2" strokeLinecap="round" />
      <path d="M22 5h-4" stroke={`url(#${id})`} strokeWidth="2.2" strokeLinecap="round" />
      <path d="M4 17v2" stroke={`url(#${id})`} strokeWidth="2.2" strokeLinecap="round" />
      <path d="M5 18H3" stroke={`url(#${id})`} strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  )
}

type SummaryResult = {
  summary: string
  summarized: number
  from: string
  to: string
  /** milliseconds the model took */
  took: number
}

/** staged status copy while the model works: honest about what is
 *  happening, quiet, never cutesy. swapped every ~2s. */
const STAGES = ['reading the last {n} messages', 'weighing what mattered', 'writing the recap'] as const

/** the ai summary tool: pick how many recent messages to fold into a
 *  recap. works in dms, group chats and server channels alike. */
export function SummarizeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const me = useChatStore((s) => s.me)
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const { toast } = useToast()

  const room = activeChannelId
    ? `channel:${activeChannelId}`
    : activeConversationId
      ? `conversation:${activeConversationId}`
      : null

  const [count, setCount] = useState(25)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<SummaryResult | null>(null)
  const [phase, setPhase] = useState(0)
  const [copied, setCopied] = useState(false)
  /** when the last successful run finished; the live countdown below is
   *  recomputed from it so it never drifts and survives close/reopen */
  const [lastRunAt, setLastRunAt] = useState<number | null>(lastRunStamp)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (open) {
      setResult(null)
      setLoading(false)
      setCopied(false)
    }
  }, [open, room])

  // staged status while the llm works: the wait itself shows craft
  useEffect(() => {
    if (!loading) return
    setPhase(0)
    const t = setInterval(() => setPhase((p) => Math.min(p + 1, STAGES.length - 1)), 2000)
    return () => clearInterval(t)
  }, [loading])

  // the 30s cooldown clock: recompute from the run stamp every second so
  // the label stays exact, and stop ticking entirely once it reaches zero
  useEffect(() => {
    if (lastRunAt === null) return
    const end = lastRunAt + COOLDOWN_MS
    let timer: ReturnType<typeof setInterval> | undefined
    const tick = () => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000))
      setCooldown(left)
      if (left === 0 && timer) {
        clearInterval(timer)
        timer = undefined
      }
    }
    timer = setInterval(tick, 1000)
    tick()
    return () => {
      if (timer) clearInterval(timer)
    }
  }, [lastRunAt])

  async function run() {
    if (!room || loading || cooldown > 0) return
    setLoading(true)
    sounds.play('lightTick')
    try {
      const res = await apiClient.summarize(room, count)
      setResult(res)
      setCopied(false)
      lastRunStamp = Date.now()
      setLastRunAt(lastRunStamp)
      sounds.play('midTick')
    } catch (err) {
      sounds.play('error')
      if (err instanceof ApiError && err.status === 429) {
        // the server owns the clock: resync the local countdown to it
        const data = (err.data ?? {}) as { retryAfter?: unknown }
        const retryAfter = typeof data.retryAfter === 'number' && Number.isFinite(data.retryAfter) ? data.retryAfter : 0
        const secs = Math.min(Math.max(1, Math.round(retryAfter)), Math.ceil(COOLDOWN_MS / 1000))
        lastRunStamp = Date.now() - (COOLDOWN_MS - secs * 1000)
        setLastRunAt(lastRunStamp)
        toast({ title: 'summarize cooldown', description: `${secs}s cooldown between summaries` })
      } else {
        toast({ title: 'could not summarize', description: err instanceof ApiError ? err.message : 'Try again in a moment.' })
      }
    } finally {
      setLoading(false)
    }
  }

  async function copy() {
    if (!result) return
    try {
      await navigator.clipboard.writeText(result.summary)
      sounds.play('lightTick')
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      toast({ title: 'could not copy' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl p-0 border-border bg-app-sidebar overflow-hidden rounded-sm top-6 translate-y-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Summarize recent messages</DialogTitle>

        <div className="relative flex items-center gap-2.5 px-4 py-3 border-b border-white/10">
          <RainbowStars className="size-5 shrink-0" />
          <span className="text-sm font-bold tracking-tight">summarize</span>
          <span className="text-xs text-muted-foreground truncate">
            {room ? (room.startsWith('channel:') ? 'this channel' : 'this conversation') : 'no room open'}
          </span>
          {/* the rainbow hairline: one gradient pixel under the header */}
          <span
            aria-hidden="true"
            className="absolute left-0 right-0 bottom-0 h-px opacity-50"
            style={{
              background:
                'linear-gradient(90deg, transparent, #ff5f6d 15%, #ffb347 32%, #ffe259 48%, #5edc9a 64%, #4cc9f0 80%, #b388ff 95%, transparent)',
            }}
          />
        </div>

        <div className="px-4 py-3">
          <p className="text-xs text-muted-foreground mb-2">how many recent messages to summarize</p>
          <div className="flex items-center gap-1.5">
            {COUNT_CHOICES.map((c) => (
              <button
                key={c}
                onClick={() => {
                  sounds.play('lightTick')
                  setCount(c)
                }}
                className={
                  'px-2.5 py-1 text-xs font-bold rounded-sm border transition-colors tabular-nums ' +
                  (count === c
                    ? 'border-hyper/60 bg-hyper/10 text-hyper'
                    : 'border-white/10 text-muted-foreground hover:text-foreground hover:bg-app-raise/60')
                }
                aria-pressed={count === c}
              >
                {c}
              </button>
            ))}
            <span className="flex-1" />
            <button
              onClick={() => void run()}
              disabled={!room || loading || cooldown > 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-sm bg-hyper text-white hover:bg-hyper/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? <Spinner className="size-3.5" /> : <Sparkles className="size-3.5" />}
              {loading ? 'summarizing' : cooldown > 0 ? `try again in ${cooldown}s` : 'summarize'}
            </button>
          </div>
        </div>

        {loading && (
          <div className="px-4 pb-4">
            <div className="rounded-sm border border-white/10 bg-app-chat/40 p-3">
              <p className="flex items-center gap-2 text-[11px] text-muted-foreground mb-3">
                <span className="inline-block size-1.5 rounded-full bg-hyper animate-pulse" aria-hidden="true" />
                {STAGES[phase].replace('{n}', String(count))}
              </p>
              <div className="space-y-2.5" aria-hidden="true">
                <div className="skeleton-sheen h-3 w-2/3" />
                <div className="skeleton-sheen h-3 w-full" />
                <div className="skeleton-sheen h-3 w-5/6" />
                <div className="skeleton-sheen h-3 w-3/4" />
              </div>
            </div>
          </div>
        )}

        {result && !loading && (
          <div className="px-4 pb-4 summary-in">
            <div className="rounded-sm border border-white/10 bg-app-chat/40 p-3 text-[13px] leading-relaxed">
              {renderMessageContent(result.summary, { myUsername: me?.username })}
            </div>
            <div className="flex items-center gap-2 mt-2 text-[11px] text-muted-foreground flex-wrap">
              <span className="tabular-nums">{result.summarized} messages covered</span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">
                {shortTime(result.from)} – {shortTime(result.to)}
              </span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums" title="how long the model took">
                {(result.took / 1000).toFixed(1)}s
              </span>
              <span className="flex-1" />
              <button
                onClick={() => void copy()}
                className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-foreground/75 hover:text-foreground hover:bg-accent transition-colors"
                aria-label={copied ? 'copied' : 'copy summary'}
                title={copied ? 'copied' : 'copy summary'}
              >
                {copied ? (
                  <>
                    <span className="size-1.5 rounded-full bg-hyper" aria-hidden="true" />
                    copied
                  </>
                ) : (
                  <>
                    <Copy className="size-3" />
                    copy
                  </>
                )}
              </button>
              <button
                onClick={() => void run()}
                disabled={cooldown > 0}
                className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-foreground/75 hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label={cooldown > 0 ? `regenerate in ${cooldown}s` : 'regenerate summary'}
                title={cooldown > 0 ? `regenerate in ${cooldown}s` : 'regenerate summary'}
              >
                <RotateCcw className="size-3" />
                {cooldown > 0 ? `${cooldown}s` : 'regenerate'}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
