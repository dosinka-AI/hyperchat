'use client'

import { useMemo, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import type { VoiceParticipantSummary, WhisperListSummary } from '@/lib/types'
import { sounds } from '@/lib/client/sounds'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Check, Save, Trash2, Volume2, X } from 'lucide-react'

/** Saved-list row: click whispers to everyone in it right now (targets
 *  not currently in the channel are skipped); delete removes the list. */
function SavedListRow({ list, onWhisper, onDelete }: { list: WhisperListSummary; onWhisper: (ids: string[]) => void; onDelete: () => void }) {
  const preview = list.memberNames.length > 0 ? list.memberNames.join(', ') : `${list.memberIds.length} members`
  return (
    <div className="flex items-center gap-1.5 group">
      <button
        type="button"
        onClick={() => onWhisper(list.memberIds)}
        className="flex-1 min-w-0 text-left px-2 py-1.5 rounded-sm border border-white/10 bg-app-raise/60 hover:bg-app-raise hover:border-white/25 transition-colors"
        aria-label={`whisper to the ${list.name} list`}
      >
        <div className="text-xs font-semibold truncate">{list.name}</div>
        <div className="text-[10px] text-muted-foreground truncate">{preview}</div>
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="p-1.5 rounded-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label={`delete the ${list.name} list`}
        title="delete list"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  )
}

/** The whisper picker popover: check any mix of the people in the channel,
 *  whisper instantly, or save the selection as a reusable list. While
 *  whispering, the toolbar button stays lit and the header chip offers a
 *  one-click stop. */
export function WhisperControl({ channelId }: { channelId: string }) {
  const me = useChatStore((s) => s.me)
  const participants = useChatStore((s) => s.voiceParticipants[channelId]) ?? []
  const whispers = useChatStore((s) => s.voiceWhispers[channelId]) ?? []
  const whisperLists = useChatStore((s) => s.whisperLists)
  const loadWhisperLists = useChatStore((s) => s.loadWhisperLists)
  const createWhisperList = useChatStore((s) => s.createWhisperList)
  const deleteWhisperList = useChatStore((s) => s.deleteWhisperList)
  const setVoiceWhisper = useChatStore((s) => s.setVoiceWhisper)

  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving] = useState(false)

  const others = participants.filter((p) => p.userId !== me?.id)
  const hereIds = new Set(others.map((p) => p.userId))

  // my live targets from the broadcast mapping (source of truth: the
  // round-trip confirms what the sidecar actually registered)
  const myTargets = useMemo(() => {
    const mine = whispers.find((w) => w.from === me?.id)
    return mine?.to ?? []
  }, [whispers, me?.id])

  // render-phase adjust (the EmojiPicker openRequest pattern): opening the
  // popover syncs the checkboxes with the live whisper targets without a
  // setState-in-effect render cascade
  const [appliedOpen, setAppliedOpen] = useState(false)
  if (open && !appliedOpen) {
    setAppliedOpen(true)
    setPicked(myTargets)
    void loadWhisperLists()
  }
  if (!open && appliedOpen) setAppliedOpen(false)

  // someone who left the channel cannot stay checked: the effective set is
  // pruned at render time against the live participant list
  const effectivePicked = picked.filter((id) => hereIds.has(id))

  function toggle(id: string) {
    sounds.play('lightTick')
    setPicked(effectivePicked.includes(id) ? effectivePicked.filter((x) => x !== id) : [...effectivePicked, id])
  }

  function apply() {
    setVoiceWhisper(effectivePicked)
    setOpen(false)
  }

  function whisperToList(ids: string[]) {
    const live = ids.filter((id) => hereIds.has(id))
    if (live.length === 0) {
      sounds.play('error')
      return
    }
    setVoiceWhisper(live)
    setPicked(live)
    setOpen(false)
  }

  async function saveList() {
    const clean = saveName.trim()
    if (!clean || effectivePicked.length === 0 || saving) return
    const names = effectivePicked.map((id) => others.find((p) => p.userId === id)?.username ?? '').filter(Boolean)
    setSaving(true)
    const ok = await createWhisperList(clean, names)
    setSaving(false)
    if (ok) setSaveName('')
  }

  const active = myTargets.length > 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={() => sounds.play('lightTick')}
          className={cn(
            'p-1.5 rounded-sm transition-colors',
            active ? 'bg-hyper/25 text-hyper' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
          )}
          aria-label={active ? `whispering to ${myTargets.length} people` : 'whisper to people'}
          title={active ? `whispering to ${myTargets.length} — open to change or stop` : 'whisper (private voice aside)'}
        >
          <Volume2 className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="center" className="w-72 p-2 rounded-sm">
        <div className="flex items-center justify-between px-1 pb-2">
          <span className="text-xs font-bold tracking-tight">whisper to…</span>
          <span className="text-[10px] text-muted-foreground">only they hear you</span>
        </div>
        {others.length === 0 ? (
          <p className="text-[11px] text-muted-foreground px-1 py-3 text-center">nobody else is in the channel</p>
        ) : (
          <div className="max-h-48 overflow-y-auto scroll-thin space-y-0.5">
            {others.map((p) => {
              const on = effectivePicked.includes(p.userId)
              return (
                <button
                  key={p.userId}
                  type="button"
                  onClick={() => toggle(p.userId)}
                  className={cn(
                    'w-full flex items-center gap-2 px-2 py-1.5 rounded-sm border transition-colors text-left',
                    on ? 'border-hyper/40 bg-hyper/10' : 'border-transparent hover:bg-accent'
                  )}
                  aria-pressed={on}
                >
                  <span
                    className={cn(
                      'size-4 shrink-0 rounded-sm border grid place-items-center',
                      on ? 'bg-hyper border-hyper text-black' : 'border-white/25'
                    )}
                  >
                    {on && <Check className="size-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold truncate">{p.displayName || p.username}</span>
                    <span className="block text-[10px] text-muted-foreground truncate">@{p.username}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
        <div className="pt-2 mt-1 border-t border-white/10 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="save selection as…"
              maxLength={32}
              className="h-7 flex-1 rounded-sm text-xs bg-app-raise border-white/10"
            />
            <Button
              size="sm"
              className="h-7 rounded-sm px-2 gap-1"
              disabled={!saveName.trim() || effectivePicked.length === 0 || saving}
              onClick={() => void saveList()}
            >
              <Save className="size-3.5" />
            </Button>
          </div>
          {whisperLists.length > 0 && (
            <div className="space-y-1 max-h-32 overflow-y-auto scroll-thin">
              {whisperLists.map((l) => (
                <SavedListRow key={l.id} list={l} onWhisper={whisperToList} onDelete={() => void deleteWhisperList(l.id)} />
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 pt-2">
          <Button size="sm" className="h-7 rounded-sm flex-1" disabled={others.length === 0} onClick={apply}>
            {active ? 'update' : 'whisper'}
          </Button>
          {active && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 rounded-sm gap-1"
              onClick={() => {
                setVoiceWhisper([])
                setPicked([])
                setOpen(false)
              }}
            >
              <X className="size-3" />
              stop
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** The whisper status chip for the voice room header: who hears me right
 *  now, with a one-click stop. Rendered only while whispering. */
export function WhisperStatusChip({ channelId }: { channelId: string }) {
  const me = useChatStore((s) => s.me)
  const participants = useChatStore((s) => s.voiceParticipants[channelId]) ?? []
  const whispers = useChatStore((s) => s.voiceWhispers[channelId]) ?? []
  const setVoiceWhisper = useChatStore((s) => s.setVoiceWhisper)

  const mine = whispers.find((w) => w.from === me?.id)
  if (!mine || mine.to.length === 0) return null

  const names = mine.to.map((id) => {
    const p: VoiceParticipantSummary | undefined = participants.find((x) => x.userId === id)
    return p ? p.displayName || p.username : 'someone'
  })

  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-hyper/15 border border-hyper/40 text-[11px] font-semibold text-hyper"
      role="status"
      aria-label={`whispering to ${names.join(', ')}`}
    >
      <Volume2 className="size-3 shrink-0 animate-pulse" aria-hidden="true" />
      <span className="truncate max-w-52">
        whispering to {names.slice(0, 2).join(', ')}
        {names.length > 2 ? ` +${names.length - 2}` : ''}
      </span>
      <button
        type="button"
        onClick={() => setVoiceWhisper([])}
        className="grid place-items-center size-4 rounded-full hover:bg-hyper/25"
        aria-label="stop whispering"
        title="stop whispering"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

/** "X is whispering to me" indicator: sits on the whisperer's tile. */
export function WhisperingBadge({ channelId, fromUserId }: { channelId: string; fromUserId: string }) {
  const me = useChatStore((s) => s.me)
  const whispers = useChatStore((s) => s.voiceWhispers[channelId]) ?? []
  const mine = whispers.find((w) => w.from === fromUserId)
  if (!me || !mine || !mine.to.includes(me.id)) return null
  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-hyper/80 text-black text-[10px] font-bold" title="whispering to you">
      <Volume2 className="size-3" aria-hidden="true" />
      whisper
    </span>
  )
}
