'use client'

/**
 * Poll composer (Discord-style): question, 2..10 options, single vs
 * multi-choice, optional timed close. Launched from the composer's "+" menu
 * or the /poll command; on submit it sends the message with the poll
 * attached and the question as its content.
 */

import { useState } from 'react'
import { BarChart3, Check, Plus, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sounds } from '@/lib/client/sounds'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'

export type PollDraft = {
  question: string
  options: string[]
  allowMulti: boolean
  durationHours: number | null
}

const DURATIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'no timer' },
  { value: 1, label: '1 hour' },
  { value: 8, label: '8 hours' },
  { value: 24, label: '1 day' },
  { value: 72, label: '3 days' },
  { value: 168, label: '1 week' },
]

export function PollComposerDialog({ open, onOpenChange, onSend }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSend: (draft: PollDraft) => void
}) {
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<string[]>(['', ''])
  const [allowMulti, setAllowMulti] = useState(false)
  const [durationHours, setDurationHours] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const filled = options.map((o) => o.trim()).filter(Boolean)
  const canSend = question.trim().length > 0 && filled.length >= 2

  const submit = () => {
    if (!canSend) {
      setError(filled.length < 2 ? 'A poll needs at least two filled options.' : 'Ask something first.')
      return
    }
    sounds.play('send')
    onSend({
      question: question.trim(),
      options: filled.slice(0, 10),
      allowMulti,
      durationHours,
    })
    // reset for next time
    setQuestion('')
    setOptions(['', ''])
    setAllowMulti(false)
    setDurationHours(null)
    setError(null)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 border-border glass overflow-hidden rounded-sm top-6 translate-y-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">create a poll</DialogTitle>

        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/10">
          <BarChart3 className="size-4 text-hyper shrink-0" />
          <p className="text-sm font-bold tracking-tight">create a poll</p>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="ml-auto p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="close"
          >
            <X className="size-3.5" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3 max-h-[60vh] overflow-y-auto scroll-thin">
          <div>
            <label htmlFor="poll-question" className="block text-[11px] font-bold tracking-widest text-muted-foreground mb-1.5">
              question
            </label>
            <input
              id="poll-question"
              value={question}
              onChange={(e) => { setQuestion(e.target.value.slice(0, 300)); setError(null) }}
              placeholder="ask anything"
              autoFocus
              className="w-full h-9 rounded-sm border border-white/10 bg-black/30 px-2.5 text-[13px] placeholder:text-muted-foreground/50 focus:outline-none focus:border-hyper/60"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-bold tracking-widest text-muted-foreground">options</label>
              <span className="text-[10px] text-muted-foreground tabular-nums">{filled.length}/10</span>
            </div>
            <div className="space-y-1.5">
              {options.map((opt, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'shrink-0 size-4 rounded-full border flex items-center justify-center text-[9px] font-bold',
                      opt.trim() ? 'border-hyper/60 text-hyper' : 'border-white/25 text-muted-foreground/60'
                    )}
                    aria-hidden="true"
                  >
                    {opt.trim() ? <Check className="size-2" /> : i + 1}
                  </span>
                  <input
                    value={opt}
                    onChange={(e) => {
                      const next = [...options]
                      next[i] = e.target.value.slice(0, 55)
                      setOptions(next)
                      setError(null)
                    }}
                    placeholder={i < 2 ? `option ${i + 1}` : 'another option (optional)'}
                    aria-label={`poll option ${i + 1}`}
                    className="flex-1 h-8 rounded-sm border border-white/10 bg-black/30 px-2.5 text-[12.5px] placeholder:text-muted-foreground/50 focus:outline-none focus:border-hyper/60"
                  />
                  {options.length > 2 && (
                    <button
                      type="button"
                      onClick={() => setOptions(options.filter((_, j) => j !== i))}
                      className="shrink-0 size-6 rounded-sm flex items-center justify-center text-muted-foreground hover:text-red-400 hover:bg-red-400/10 transition-colors"
                      aria-label={`remove option ${i + 1}`}
                    >
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {options.length < 10 && (
              <button
                type="button"
                onClick={() => setOptions([...options, ''])}
                className="mt-2 flex items-center gap-1.5 px-2 h-7 rounded-sm border border-dashed border-white/15 text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:border-white/30 transition-colors"
              >
                <Plus className="size-3" />
                add option
              </button>
            )}
          </div>

          <div className="rounded-sm border border-white/10 divide-y divide-white/5">
            <div className="flex items-center justify-between px-3 py-2.5">
              <div>
                <p className="text-[12px] font-semibold tracking-tight">multiple answers</p>
                <p className="text-[10px] text-muted-foreground">voters pick every option they like</p>
              </div>
              <Switch checked={allowMulti} onCheckedChange={(v) => { sounds.play('lightTick'); setAllowMulti(v) }} aria-label="allow multiple answers" />
            </div>
            <div className="px-3 py-2.5">
              <p className="text-[12px] font-semibold tracking-tight mb-2">close automatically</p>
              <div className="flex flex-wrap gap-1.5">
                {DURATIONS.map((d) => (
                  <button
                    key={String(d.value)}
                    type="button"
                    onClick={() => { sounds.play('lightTick'); setDurationHours(d.value) }}
                    className={cn(
                      'px-2.5 h-7 rounded-sm border text-[11px] font-semibold transition-colors',
                      durationHours === d.value
                        ? 'border-hyper/60 bg-hyper/15 text-hyper'
                        : 'border-white/10 text-muted-foreground hover:text-foreground hover:border-white/30'
                    )}
                    aria-pressed={durationHours === d.value}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {error && <p className="text-[11px] text-red-400">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-white/10">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="px-3 h-8 rounded-sm border border-white/10 text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:border-white/25 transition-colors"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            className={cn(
              'flex items-center gap-1.5 px-3.5 h-8 rounded-sm text-[11px] font-bold transition-colors',
              canSend
                ? 'bg-hyper text-black hover:brightness-110'
                : 'bg-white/10 text-muted-foreground cursor-not-allowed'
            )}
          >
            <BarChart3 className="size-3.5" />
            send poll
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
