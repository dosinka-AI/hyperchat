'use client'

import { useEffect, useMemo, useState } from 'react'
import { HyperionMark } from './Logo'
import { Volume2, Film } from 'lucide-react'

/** The landing preview: instead of a static screenshot drifting on a float
 *  loop, the mock chat PLAYS like a short video. A scripted conversation
 *  types itself out, messages land with a motion-blur settle, reactions
 *  pop, someone joins voice, an attachment arrives, and after a hold the
 *  scene fades and loops. The app chrome around it stays still, the way a
 *  real screen recording feels. */

type Msg = {
  id: number
  who: 'maya' | 'devon' | 'jules'
  time: string
  body: React.ReactNode
  image?: boolean
}

const PEOPLE: Record<Msg['who'], { initials: string; color: string }> = {
  maya: { initials: 'MK', color: '#c9c9c9' },
  devon: { initials: 'DV', color: '#8a8a8a' },
  jules: { initials: 'JL', color: '#4a4a4a' },
}

const MESSAGES: Msg[] = [
  {
    id: 0,
    who: 'maya',
    time: 'today at 8:02 pm',
    body: (
      <>
        new map rotation starts <strong className="text-white">friday</strong>, we should lock a squad
      </>
    ),
  },
  {
    id: 1,
    who: 'devon',
    time: 'today at 8:04 pm',
    body: (
      <>
        in. <span className="text-hyper font-medium">@maya</span> can host the voice room too
      </>
    ),
  },
  {
    id: 2,
    who: 'jules',
    time: 'today at 8:05 pm',
    body: <>posting the highlight clip in #clips after</>,
    image: true,
  },
]

/** Reactions that land on message 0, in order. */
const REACTIONS: { emoji: string; count: number; cls: string }[] = [
  { emoji: '🔥', count: 2, cls: 'border-hyper/60 bg-hyper/15' },
  { emoji: '🎉', count: 5, cls: 'border-white/15 bg-app-raise/70' },
]

type Beat =
  | { kind: 'typing'; who: Msg['who']; ms: number }
  | { kind: 'msg'; id: number; ms: number }
  | { kind: 'react'; msgId: number; idx: number; ms: number }
  | { kind: 'voice'; ms: number }
  | { kind: 'hold'; ms: number }
  | { kind: 'reset'; ms: number }

const BEATS: Beat[] = [
  { kind: 'typing', who: 'maya', ms: 1100 },
  { kind: 'msg', id: 0, ms: 650 },
  { kind: 'react', msgId: 0, idx: 0, ms: 420 },
  { kind: 'react', msgId: 0, idx: 1, ms: 900 },
  { kind: 'typing', who: 'devon', ms: 1000 },
  { kind: 'msg', id: 1, ms: 700 },
  { kind: 'voice', ms: 1100 },
  { kind: 'typing', who: 'jules', ms: 950 },
  { kind: 'msg', id: 2, ms: 3000 },
  { kind: 'hold', ms: 2600 },
  // the scene fades out during the reset beat, then the loop restarts
  { kind: 'reset', ms: 900 },
]

function TypingRow({ who }: { who: Msg['who'] }) {
  const p = PEOPLE[who]
  return (
    <div className="flex gap-3 msg-land">
      <div
        className="w-8 h-8 rounded-full shrink-0 grid place-items-center text-[11px] font-bold text-black/80"
        style={{ backgroundColor: p.color }}
      >
        {p.initials}
      </div>
      <div className="min-w-0 flex items-center gap-1.5 pt-2">
        <span className="typing-dot size-1.5 rounded-full bg-muted-foreground" />
        <span className="typing-dot size-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: '150ms' }} />
        <span className="typing-dot size-1.5 rounded-full bg-muted-foreground" style={{ animationDelay: '300ms' }} />
        <span className="sr-only">{who} is typing</span>
      </div>
    </div>
  )
}

function ChatMessage({ msg, reactions }: { msg: Msg; reactions: number[] }) {
  const p = PEOPLE[msg.who]
  return (
    <div className="flex gap-3 msg-land">
      <div
        className="w-8 h-8 rounded-full shrink-0 grid place-items-center text-[11px] font-bold"
        style={{ backgroundColor: p.color, color: p.color === '#c9c9c9' ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.9)' }}
      >
        {p.initials}
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-bold">{msg.who}</span>
          <span className="text-[10px] text-muted-foreground">{msg.time}</span>
        </div>
        <p className="text-[13px] text-foreground/90 leading-snug">{msg.body}</p>
        {msg.image && (
          <div className="mt-1.5 w-44 h-24 rounded-sm border border-border bg-app-raise grid place-items-center msg-land">
            <span className="text-[10px] font-bold tracking-widest text-muted-foreground/70">attached image</span>
          </div>
        )}
        {reactions.length > 0 && (
          <div className="flex gap-1.5 mt-1.5">
            {reactions.map((idx) => (
              <span
                key={idx}
                className={`chip-pop flex items-center gap-1.5 h-8 px-2.5 rounded-sm border text-[13px] font-semibold ${REACTIONS[idx].cls}`}
              >
                {REACTIONS[idx].emoji} <span className="tabular-nums">{REACTIONS[idx].count}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function ConversationPlayer() {
  const [beat, setBeat] = useState(0)

  // the timeline drives itself; each beat says how long it lasts
  useEffect(() => {
    const step = BEATS[beat]
    if (!step) return
    const t = setTimeout(() => setBeat((b) => (b + 1) % BEATS.length), step.ms)
    return () => clearTimeout(t)
  }, [beat])

  // what has landed so far, derived by walking the beats up to now
  const landed = useMemo(() => {
    const msgs = new Set<number>()
    const reacts: Record<number, number[]> = {}
    let voice = false
    for (let i = 0; i <= beat; i++) {
      const b = BEATS[i]
      if (b.kind === 'msg') msgs.add(b.id)
      else if (b.kind === 'react') (reacts[b.msgId] ??= []).push(b.idx)
      else if (b.kind === 'voice') voice = true
    }
    return { msgs, reacts, voice }
  }, [beat])

  const current = BEATS[beat]
  const resetting = current?.kind === 'reset'
  const typingWho = current?.kind === 'typing' ? current.who : null

  return (
    <div className="rounded-sm border border-border bg-app-chat shadow-2xl overflow-hidden" aria-hidden="true">
      <div className="flex h-[320px] sm:h-[380px] pointer-events-none select-none">
        {/* server rail */}
        <div className="w-12 sm:w-14 bg-app-rail flex flex-col items-center gap-2 py-3 border-r border-border/60">
          <div className="w-9 h-9 rounded-sm bg-app-raise border border-white/15 grid place-items-center">
            <HyperionMark className="w-6 h-6 rounded-sm" />
          </div>
          <div className="w-8 h-px bg-border my-1" />
          <div className="relative w-9 h-9 rounded-sm bg-app-raise grid place-items-center text-[11px] font-bold">HO</div>
          <div className="w-9 h-9 rounded-sm bg-white grid place-items-center text-[11px] font-bold text-black">GA</div>
          <div className="w-9 h-9 rounded-sm bg-app-raise grid place-items-center text-[11px] font-bold">MU</div>
          <div className="w-9 h-9 rounded-sm border border-dashed border-border grid place-items-center text-muted-foreground text-sm">+</div>
        </div>
        {/* channel sidebar (hidden on phones: the real app hides it behind the menu) */}
        <div className="hidden sm:flex w-44 md:w-48 bg-app-sidebar flex-col border-r border-border/60">
          <div className="h-11 px-3 flex items-center justify-between border-b border-border/60">
            <span className="text-[13px] font-bold tracking-tight truncate">game night</span>
          </div>
          <div className="px-3 pt-3 pb-1 text-[10px] font-bold tracking-widest text-muted-foreground">
            text channels
          </div>
          <div className="px-2 space-y-0.5">
            <div className="px-2 py-1 rounded-sm bg-app-raise text-[13px] flex items-center gap-1.5">
              <span className="text-muted-foreground font-semibold">#</span>
              <span className="font-semibold">general</span>
            </div>
            <div className="px-2 py-1 rounded-sm text-[13px] flex items-center gap-1.5 text-muted-foreground">
              <span className="font-normal">#</span>
              <span>saturday-run</span>
            </div>
            <div className="px-2 py-1 rounded-sm text-[13px] flex items-center gap-1.5 text-muted-foreground">
              <span className="font-normal">#</span>
              <span>clips</span>
              <span className="ml-auto min-w-4 h-4 px-1 bg-hyper text-[9px] font-bold text-white grid place-items-center rounded-sm">3</span>
            </div>
          </div>
          <div className="px-3 pt-4 pb-1 text-[10px] font-bold tracking-widest text-muted-foreground">
            voice
          </div>
          <div className="px-2">
            <div className="px-2 py-1 rounded-sm text-[13px] flex items-center gap-1.5 text-muted-foreground">
              <Volume2 className="size-3.5" />
              <span>lounge</span>
              {landed.voice && (
                <span className="ml-auto flex -space-x-1 chip-pop">
                  <span className="size-4 rounded-full bg-[#8a8a8a] ring-1 ring-app-sidebar grid place-items-center text-[7px] font-bold text-white/90">DV</span>
                </span>
              )}
            </div>
          </div>
          <div className="mt-auto mx-2 mb-2 px-2 py-1.5 rounded-sm bg-app-rail flex items-center gap-2">
            <div className="relative w-6 h-6 rounded-full bg-[#c9c9c9] grid place-items-center text-[10px] font-bold text-black/80">MK</div>
            <span className="text-[12px] text-foreground/90">maya</span>
            <span className="ml-auto size-2 rounded-full bg-online" />
          </div>
        </div>
        {/* chat: the playing "video" */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-11 px-3 flex items-center gap-2 border-b border-border/60">
            <span className="text-muted-foreground font-semibold">#</span>
            <span className="text-[13px] font-bold tracking-tight">general</span>
            <span className="text-[11px] text-muted-foreground truncate hidden md:block">weekly plans and general talk</span>
            <span className="ml-auto text-[10px] font-bold tracking-widest text-muted-foreground hidden sm:block">2 pinned</span>
          </div>
          <div
            className={`flex-1 px-4 py-4 space-y-3 overflow-hidden transition-opacity duration-500 ${
              resetting ? 'opacity-0 blur-[2px]' : 'opacity-100'
            }`}
          >
            {MESSAGES.filter((m) => landed.msgs.has(m.id)).map((m) => (
              <ChatMessage key={m.id} msg={m} reactions={landed.reacts[m.id] ?? []} />
            ))}
            {landed.voice && (
              <div className="row-slide flex items-center gap-2 pl-11 text-[11px] text-muted-foreground">
                <Volume2 className="size-3.5 text-hyper" />
                <span className="font-semibold text-foreground/70">devon</span> joined lounge
              </div>
            )}
            {typingWho && <TypingRow who={typingWho} />}
          </div>
          <div className="px-4 pb-4">
            <div className="h-9 rounded-sm bg-app-raise border border-border/60 flex items-center px-3 gap-2">
              <span className="text-[12px] text-muted-foreground">message. @ to mention.</span>
              <Film className="ml-auto size-3.5 text-muted-foreground" />
            </div>
          </div>
        </div>
        {/* member list */}
        <div className="w-36 bg-app-sidebar border-l border-border/60 hidden lg:flex flex-col py-3 px-2">
          <div className="px-2 pb-2 text-[10px] font-bold tracking-widest text-muted-foreground">owner · 1</div>
          <div className="px-2 py-1 rounded-sm flex items-center gap-2">
            <div className="relative w-5 h-5 rounded-full bg-[#8a8a8a] grid place-items-center text-[9px] font-bold text-white/90">
              DV
              <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-online ring-2 ring-app-sidebar" />
            </div>
            <span className="text-[12px] text-foreground/85">devon</span>
          </div>
          <div className="px-2 pt-3 pb-2 text-[10px] font-bold tracking-widest text-muted-foreground">online · 2</div>
          {(['maya', 'jules'] as const).map((name) => (
            <div key={name} className="px-2 py-1 rounded-sm flex items-center gap-2">
              <div className="relative w-5 h-5 rounded-full bg-app-raise grid place-items-center text-[9px] font-bold">
                {name.slice(0, 2).toUpperCase()}
                <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-online ring-2 ring-app-sidebar" />
              </div>
              <span className="text-[12px] text-foreground/85">{name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
