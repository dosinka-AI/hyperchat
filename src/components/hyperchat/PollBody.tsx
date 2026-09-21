'use client'

/**
 * Discord-style poll rendering: the question, the option rows with live
 * vote bars, per-option counts, the author's "end poll" control, and the
 * ended state with the winner highlighted. Votes arrive as light
 * (optionIndex, userId) rows on the message and are folded here, so every
 * client computes counts locally exactly like reaction chips.
 */

import { useMemo } from 'react'
import { BarChart3, Check, Clock, Trophy } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ClientMessage } from '@/lib/types'

/** "ends in X" label for open timed polls. */
function endsInLabel(endsAt: string | null): string | null {
  if (!endsAt) return null
  const ms = new Date(endsAt).getTime() - Date.now()
  if (ms <= 0) return 'ended'
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `ends in ${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `ends in ${hours}h`
  return `ends in ${Math.round(hours / 24)}d`
}

export function PollBody({ msg, room, meId, onVote, onEnd }: {
  msg: ClientMessage
  room: string
  meId: string | null
  onVote: (room: string, messageId: string, optionIndex: number) => void
  onEnd: (room: string, messageId: string) => void
}) {
  const poll = msg.poll
  const pollId = poll?.id
  const tallies = useMemo(() => {
    if (!poll) return []
    const counts = poll.options.map(() => 0)
    for (const v of poll.votes) {
      if (v.optionIndex >= 0 && v.optionIndex < counts.length) counts[v.optionIndex]++
    }
    return counts
  }, [poll])
  if (!poll || !pollId) return null

  const closed = !!poll.closedAt
  const total = tallies.reduce((a, b) => a + b, 0)
  const myVotes = poll.votes.filter((v) => v.userId === meId).map((v) => v.optionIndex)
  const isAuthor = poll.createdById === meId
  const endsLabel = closed ? null : endsInLabel(poll.endsAt)
  const winners = closed && total > 0
    ? tallies.map((c, i) => ({ c, i })).filter((t) => t.c === Math.max(...tallies)).map((t) => t.i)
    : []
  const pending = !!pollId?.startsWith('pending-poll:')

  return (
    <div
      className={cn(
        'mt-1.5 max-w-md rounded-sm border overflow-hidden select-none',
        closed ? 'border-white/10 bg-black/20' : 'border-hyper/30 bg-hyper/5'
      )}
      role="group"
      aria-label={`poll: ${poll.question}`}
    >
      <div className="px-3 pt-2.5 pb-2 flex items-start gap-2">
        <BarChart3 className={cn('size-3.5 mt-0.5 shrink-0', closed ? 'text-muted-foreground' : 'text-hyper')} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-snug text-foreground/95 break-words">{poll.question}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {poll.allowMulti ? 'choose one or more' : 'choose one'}
            {closed ? ' · ended' : endsLabel ? ` · ${endsLabel}` : ''}
            {` · ${total} vote${total === 1 ? '' : 's'}`}
          </p>
        </div>
        {isAuthor && !closed && !pending && (
          <button
            type="button"
            onClick={() => onEnd(room, msg.id)}
            className="shrink-0 px-2 h-6 rounded-sm border border-white/10 text-[10px] font-semibold text-muted-foreground hover:text-foreground hover:border-white/30 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-hyper"
            aria-label="end the poll now"
          >
            end
          </button>
        )}
      </div>

      <div className={cn('px-2.5 pb-2.5 space-y-1', poll.options.length > 5 && 'max-h-56 overflow-y-auto scroll-thin')}>
        {poll.options.map((option, i) => {
          const count = tallies[i] ?? 0
          const pct = total > 0 ? Math.round((count / total) * 100) : 0
          const mine = myVotes.includes(i)
          const won = closed && winners.includes(i) && total > 0
          return (
            <button
              key={`${poll.id}-${i}`}
              type="button"
              disabled={closed || pending}
              onClick={() => onVote(room, msg.id, i)}
              aria-pressed={mine}
              className={cn(
                'relative w-full text-left rounded-sm border px-2.5 h-9 flex items-center transition-colors',
                closed ? 'border-white/5 cursor-default' : 'border-white/10 hover:border-hyper/50 cursor-pointer',
                mine && !closed && 'border-hyper/60',
                won && 'border-hyper/60'
              )}
              title={closed ? undefined : mine ? 'tap to remove your vote' : 'tap to vote'}
            >
              {/* vote bar fill */}
              <span
                className={cn('absolute inset-y-0 left-0 transition-[width] duration-300', won ? 'bg-hyper/25' : mine ? 'bg-hyper/20' : 'bg-white/10')}
                style={{ width: `${pct}%` }}
                aria-hidden="true"
              />
              <span className="relative z-10 min-w-0 flex-1 flex items-center gap-2">
                <span
                  className={cn(
                    'shrink-0 size-4 rounded-[4px] border flex items-center justify-center text-[10px] font-bold',
                    poll.allowMulti ? '' : 'rounded-full',
                    mine ? 'border-hyper bg-hyper/25 text-hyper' : 'border-white/25 text-transparent',
                    won && !mine && 'border-hyper/70 text-hyper'
                  )}
                  aria-hidden="true"
                >
                  {mine ? <Check className="size-2.5" /> : won ? <Trophy className="size-2.5" /> : null}
                </span>
                <span className={cn('min-w-0 truncate text-[12.5px]', mine || won ? 'text-foreground font-semibold' : 'text-foreground/85')}>
                  {option}
                </span>
              </span>
              <span className="relative z-10 shrink-0 pl-2 text-[10px] font-semibold text-muted-foreground tabular-nums">
                {count > 0 ? `${count} · ${pct}%` : ''}
              </span>
            </button>
          )
        })}
      </div>

      {closed && (
        <div className="px-3 py-1.5 border-t border-white/5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Clock className="size-2.5" aria-hidden="true" />
          final results
          {total === 0 && <span className="ml-1">· nobody voted</span>}
        </div>
      )}
    </div>
  )
}
