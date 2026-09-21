'use client'

import { useEffect, useRef, useState } from 'react'
import { Send, TriangleAlert } from 'lucide-react'
import { useChatStore } from '@/lib/client/store'
import { cn } from '@/lib/utils'
import type { ClientMessage } from '@/lib/types'

/**
 * THE GUEST CHAT — the send-only chat beside a call stage for a cross-rung
 * guest (rung into a conversation call they are NOT a member of).
 *
 * What a guest gets, exactly:
 *   - a chat interface: their OWN sent messages render (optimistic rows in
 *     the local conversation-guest room; the server POST honors their
 *     temporary CallGuest ticket),
 *   - read receipts: when members read the conversation, read:update stamps
 *     ride the guest room — readers show as avatar chips under the last
 *     message of the guest's they covered,
 *   - a banner, always: "you aren't in this chat. you cannot read
 *     messages, but you can send messages".
 *
 * Members' messages are NEVER rendered here — the sidecar never delivers
 * them to the guest room, and this panel only reads the guest room.
 */

/** the receipt row: overlapping reader avatars (resolved from the live call
 * participant list) under the last guest message each reader covered. */
function GuestReceiptRow({ guestOf }: { guestOf: string }) {
  const groupReadAt = useChatStore((s) => s.groupReadAt[guestOf])
  const activeCall = useChatStore((s) => s.activeCall)
  if (!groupReadAt) return null
  const readers = Object.entries(groupReadAt)
    .map(([userId, at]) => ({
      userId,
      at,
      participant: activeCall?.participants.find((p) => p.userId === userId),
    }))
    .filter((r) => r.participant)
    .sort((a, b) => a.at.localeCompare(b.at))
  if (readers.length === 0) return null
  return (
    <div className="flex items-center gap-1 px-1 pt-0.5" aria-label="read receipts">
      <div className="flex -space-x-1.5">
        {readers.slice(0, 5).map((r) => {
          const name = r.participant!.displayName || r.participant!.username
          return (
            <span
              key={r.userId}
              className="grid size-4 place-items-center overflow-hidden rounded-full ring-2 ring-app-chat"
              title={`${name} read this`}
            >
              {r.participant!.avatarUrl ? (
                <img src={r.participant!.avatarUrl} alt="" className="size-full rounded-full object-cover" draggable={false} />
              ) : (
                <span className="grid size-full place-items-center rounded-full text-[8px] font-bold" style={{ backgroundColor: r.participant!.avatarColor }}>
                  {name.slice(0, 1).toUpperCase()}
                </span>
              )}
            </span>
          )
        })}
      </div>
      {readers.length > 5 && (
        <span className="text-[10px] text-muted-foreground">+{readers.length - 5}</span>
      )}
      <span className="text-[10px] text-muted-foreground select-none">seen</span>
    </div>
  )
}

function GuestMessageRow({ msg }: { msg: ClientMessage }) {
  const failed = msg.failed === true
  const pending = msg.pending === true
  return (
    <div className={cn('flex flex-col items-end gap-0.5', failed && 'opacity-80')}>
      <div
        className={cn(
          'max-w-[85%] rounded-sm px-2.5 py-1.5 text-[13px] leading-snug break-words whitespace-pre-wrap',
          failed ? 'bg-destructive/15 border border-destructive/30' : 'bg-hyper/15 border border-hyper/25'
        )}
      >
        {msg.content}
      </div>
      <div className="flex items-center gap-1.5 pr-0.5">
        {failed ? (
          <span className="text-[10px] text-destructive">failed to send</span>
        ) : pending ? (
          <span className="text-[10px] text-muted-foreground">sending…</span>
        ) : null}
      </div>
    </div>
  )
}

/** The panel itself: banner + my messages + receipts + composer. Mounted
 * beside the fullscreen call stage while activeCall.guestOf is set. */
export function GuestChatPanel({ className }: { className?: string }) {
  const guestOf = useChatStore((s) => s.activeCall?.guestOf ?? null)
  const room = useChatStore((s) => (guestOf ? s.rooms[`conversation-guest:${guestOf}`] : undefined))
  const sendGuestMessage = useChatStore((s) => s.sendGuestMessage)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  const messages = room?.messages ?? []
  // scroll to the bottom as my messages land
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, guestOf])

  if (!guestOf) return null

  const submit = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setDraft('')
    setSending(true)
    try {
      await sendGuestMessage(guestOf, text)
    } catch {
      // the row already flipped to failed in the store; restore the draft so
      // nothing typed is lost
      setDraft(text)
    } finally {
      setSending(false)
    }
  }

  return (
    <aside
      className={cn('flex min-h-0 flex-col border-l border-border bg-app-raise/40', className)}
      aria-label="guest chat, send only"
    >
      {/* the honest banner: this is a send-only view */}
      <div className="flex items-start gap-2 border-b border-amber-400/20 bg-amber-400/10 px-3 py-2.5">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-300" aria-hidden="true" />
        <p className="text-[11px] leading-snug text-amber-200/90">
          you aren&apos;t in this chat. you cannot read messages, but you can send messages.
        </p>
      </div>

      {/* my messages + receipts */}
      <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-3 py-3">
        {messages.length === 0 ? (
          <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
            messages you send show up for everyone in the call. theirs stay private to the chat.
          </p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {messages.map((m) => (
              <div key={m.id} className="flex flex-col gap-0.5 items-end">
                <GuestMessageRow msg={m} />
                {/* receipts ride under the LAST message the readers covered:
                 * simplest honest placement — under the latest message */}
                {m === messages[messages.length - 1] && <GuestReceiptRow guestOf={guestOf} />}
              </div>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* composer */}
      <form
        className="flex items-end gap-1.5 border-t border-border p-2.5"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          placeholder="send a message…"
          maxLength={2000}
          rows={1}
          disabled={sending}
          aria-label="guest message"
          className="max-h-28 min-h-[36px] flex-1 resize-none rounded-sm border border-white/10 bg-app-raise px-2.5 py-2 text-[13px] outline-none transition-colors placeholder:text-muted-foreground focus:border-hyper/50 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!draft.trim() || sending}
          className="grid size-9 shrink-0 place-items-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          aria-label="send message"
        >
          <Send className="size-4" />
        </button>
      </form>
    </aside>
  )
}

/** Mobile companion of the panel: a floating chat button that opens the
 * send-only guest chat as a sheet over the stage (the desktop right column
 * is hidden below md). Shares the same GuestChatPanel content. */
export function GuestChatSheet() {
  const guestOf = useChatStore((s) => s.activeCall?.guestOf ?? null)
  const [open, setOpen] = useState(false)
  if (!guestOf) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="open guest chat"
        title="guest chat"
        className="fixed bottom-20 right-4 z-[92] grid size-11 place-items-center rounded-full border border-white/15 bg-black/70 text-foreground/90 shadow-xl backdrop-blur transition-colors hover:bg-black/85 md:hidden"
      >
        <Send className="size-4" />
      </button>
      {open && (
        <div className="fixed inset-0 z-[93] flex flex-col justify-end bg-black/50 md:hidden" onClick={() => setOpen(false)}>
          <div className="max-h-[70vh] min-h-[45vh] rounded-t-xl border-t border-border bg-app-chat shadow-2xl whoosh-in" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-3 pt-2.5">
              <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">guest chat</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="close guest chat"
                className="grid size-7 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                ✕
              </button>
            </div>
            <GuestChatPanel className="flex-1 min-h-0 border-0 bg-transparent" />
          </div>
        </div>
      )}
    </>
  )
}
