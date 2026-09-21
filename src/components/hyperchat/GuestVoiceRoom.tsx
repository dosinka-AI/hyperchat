'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  Expand, HeadphoneOff, Headphones, Mic, MicOff, Minimize2, PhoneOff, Users,
} from 'lucide-react'
import { useChatStore } from '@/lib/client/store'
import { voiceEngine } from '@/lib/client/voice'
import { sounds } from '@/lib/client/sounds'
import { cn } from '@/lib/utils'

/**
 * THE GUEST VOICE STAGE — for a user rung into a server voice channel whose
 * server they are NOT a member of. There is no sidebar, no channel list, no
 * text channels: exactly the voice channel they were invited into.
 *
 * Renders docked (a compact glass card bottom-right with the participant
 * row and controls) with an expand to a fullscreen takeover carrying the
 * full participant grid. Mounted once from ChatApp; it renders nothing
 * unless my voice session is a guest session (voiceGuest set + connected
 * to that channel + the channel not being in my own servers list).
 */

function useGuestVoiceActive(): boolean {
  const voiceGuest = useChatStore((s) => s.voiceGuest)
  const voiceConnected = useChatStore((s) => s.voiceConnected)
  const servers = useChatStore((s) => s.servers)
  if (!voiceGuest || !voiceConnected) return false
  if (voiceConnected.channelId !== voiceGuest.channelId) return false
  // if the channel IS in my servers (e.g. I joined the server in another
  // tab), the normal VoiceRoom owns the view — the guest stage stands down
  const baseId = voiceConnected.channelId.split('~')[0]
  return !servers.some((s) => s.channels.some((c) => c.id === baseId))
}

/** one participant chip: avatar with a speaking ring + mute/deafen badges.
 * compact = the docked avatar-only dot; full = the tile with a name. */
function GuestParticipantChip({ userId, compact = false }: { userId: string; compact?: boolean }) {
  const participants = useChatStore((s) => s.voiceParticipants)
  const me = useChatStore((s) => s.me)
  const [speaking, setSpeaking] = useState(false)
  useEffect(() => {
    const unsub = voiceEngine.onActivity((uid, sp) => {
      if (uid !== userId) return
      setSpeaking((prev) => (prev === sp ? prev : sp))
    })
    return unsub
  }, [userId])

  const flat = Object.values(participants).flat()
  const p = flat.find((x) => x.userId === userId)
  if (!p) return null
  const name = p.displayName || p.username
  const isSelf = me?.id === userId

  if (compact) {
    return (
      <span
        className={cn(
          'relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-full border-2 transition-colors',
          speaking ? 'border-hyper' : 'border-transparent'
        )}
        title={isSelf ? 'you' : name}
      >
        {p.avatarUrl ? (
          <img src={p.avatarUrl} alt="" className="size-full rounded-full object-cover" draggable={false} />
        ) : (
          <span className="grid size-full place-items-center rounded-full bg-app-raise text-[10px] font-bold text-foreground/80">
            {name.slice(0, 2).toUpperCase()}
          </span>
        )}
        {p.muted && (
          <span className="absolute bottom-0 right-0 grid size-3.5 place-items-center rounded-full bg-black/80 text-foreground">
            <MicOff className="size-2" />
          </span>
        )}
      </span>
    )
  }

  return (
    <div className="flex min-w-[76px] flex-col items-center gap-1.5 rounded-sm border border-white/10 bg-app-raise/60 px-3 py-3">
      <span
        className={cn(
          'relative grid size-14 place-items-center overflow-hidden rounded-full border-2 transition-colors',
          speaking ? 'border-hyper' : 'border-transparent'
        )}
        title={isSelf ? 'you' : name}
      >
        {p.avatarUrl ? (
          <img src={p.avatarUrl} alt="" className="size-full rounded-full object-cover" draggable={false} />
        ) : (
          <span className="grid size-full place-items-center rounded-full bg-app-raise text-sm font-bold text-foreground/80">
            {name.slice(0, 2).toUpperCase()}
          </span>
        )}
        {p.muted && (
          <span className="absolute bottom-0 right-0 grid size-5 place-items-center rounded-full bg-black/80 text-foreground">
            <MicOff className="size-3" />
          </span>
        )}
      </span>
      <span className="w-full truncate text-center text-[11px] text-foreground/80">
        {isSelf ? 'you' : name}
      </span>
    </div>
  )
}

/** the shared control row: mute / deafen / leave (+ expand or collapse) */
function GuestVoiceControls({ onToggleExpand, expanded }: { onToggleExpand: () => void; expanded: boolean }) {
  const voiceSelf = useChatStore((s) => s.voiceSelf)
  const toggleVoiceMute = useChatStore((s) => s.toggleVoiceMute)
  const toggleVoiceDeafen = useChatStore((s) => s.toggleVoiceDeafen)
  const leaveVoice = useChatStore((s) => s.leaveVoice)
  const btn =
    'grid size-9 place-items-center rounded-full border border-white/10 bg-black/50 text-foreground/85 backdrop-blur transition-all hover:bg-black/80 hover:text-foreground active:scale-90'
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void toggleVoiceMute()}
        className={cn(btn, voiceSelf.muted && 'border-destructive/50 text-destructive')}
        aria-label={voiceSelf.muted ? 'unmute' : 'mute'}
        aria-pressed={voiceSelf.muted}
        title={voiceSelf.muted ? 'unmute' : 'mute'}
      >
        {voiceSelf.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
      </button>
      <button
        type="button"
        onClick={() => void toggleVoiceDeafen()}
        className={cn(btn, voiceSelf.deafened && 'border-destructive/50 text-destructive')}
        aria-label={voiceSelf.deafened ? 'undeafen' : 'deafen'}
        aria-pressed={voiceSelf.deafened}
        title={voiceSelf.deafened ? 'undeafen' : 'deafen'}
      >
        <HeadphoneOff className={cn('size-4', !voiceSelf.deafened && 'hidden')} />
        <Headphones className={cn('size-4', voiceSelf.deafened && 'hidden')} />
      </button>
      <button
        type="button"
        onClick={onToggleExpand}
        className={btn}
        aria-label={expanded ? 'collapse voice view' : 'expand voice view'}
        title={expanded ? 'collapse' : 'expand'}
      >
        {expanded ? <Minimize2 className="size-4" /> : <Expand className="size-4" />}
      </button>
      <button
        type="button"
        onClick={() => {
          sounds.play('callLeave')
          leaveVoice()
        }}
        className="grid size-9 place-items-center rounded-full border border-destructive/40 bg-destructive/20 text-destructive transition-all hover:bg-destructive/35 active:scale-90"
        aria-label="leave voice"
        title="leave voice"
      >
        <PhoneOff className="size-4" />
      </button>
    </div>
  )
}

export function GuestVoiceRoom() {
  const active = useGuestVoiceActive()
  const voiceGuest = useChatStore((s) => s.voiceGuest)
  const voiceConnected = useChatStore((s) => s.voiceConnected)
  const participants = useChatStore((s) => (s.voiceConnected ? s.voiceParticipants[s.voiceConnected.channelId] : undefined))
  const [expanded, setExpanded] = useState(false)

  // portals need the DOM: false during SSR, true on the client, without a
  // setState-in-effect render cascade (the app's established pattern)
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  )
  // leaving the guest session folds the expanded view back (render-phase
  // adjust, the MessageList pattern)
  if (!active && expanded) setExpanded(false)

  if (!mounted || !active || !voiceGuest || !voiceConnected) return null

  const here = participants ?? []
  const channelId = voiceConnected.channelId

  /* ---------- fullscreen takeover ---------- */
  if (expanded) {
    return createPortal(
      <div className="fixed inset-0 z-[89] flex flex-col bg-app-chat whoosh-in" role="region" aria-label="voice channel, guest">
        <header className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <Users className="size-4 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{voiceGuest.channelName}</p>
            <p className="text-[11px] text-muted-foreground">
              you are a guest in this voice channel · {here.length} connected
            </p>
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center overflow-y-auto p-4">
          <div className="flex max-w-4xl flex-wrap items-start justify-center gap-3">
            {here.map((p) => (
              <GuestParticipantChip key={p.userId} userId={p.userId} />
            ))}
          </div>
        </div>
        <footer className="flex items-center justify-center border-t border-border px-4 py-3">
          <GuestVoiceControls expanded={expanded} onToggleExpand={() => setExpanded(false)} />
        </footer>
      </div>,
      document.body
    )
  }

  /* ---------- docked card ---------- */
  return createPortal(
    <div
      className="fixed bottom-4 right-4 z-[80] w-[248px] rounded-sm border border-border bg-app-raise/90 shadow-2xl backdrop-blur whoosh-in"
      role="region"
      aria-label={`voice channel ${voiceGuest.channelName}, guest`}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-sm bg-hyper/15 text-hyper">
          <Users className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold leading-tight">{voiceGuest.channelName}</p>
          <p className="truncate text-[10px] text-muted-foreground">guest · {here.length} connected</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 p-2.5">
        {here.map((p) => (
          <GuestParticipantChip key={p.userId} userId={p.userId} compact />
        ))}
      </div>
      <div className="flex items-center justify-center border-t border-border px-3 py-2.5">
        <GuestVoiceControls expanded={expanded} onToggleExpand={() => setExpanded(true)} />
      </div>
    </div>,
    document.body
  )
}
