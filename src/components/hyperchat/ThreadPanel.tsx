'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import type { ClientMessage } from '@/lib/types'
import { renderMessageContent } from '@/lib/client/markdown'
import { messageTimestamp, shortTime } from '@/lib/client/format'
import { Avatar } from './Avatar'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'
import { EmojiGrid, rememberRecent, rememberUsage } from './EmojiPicker'
import { openContextMenu } from './ContextMenu'
import { openEmojiPop } from './EmojiPop'
import { sounds } from '@/lib/client/sounds'
import { X, Reply as ReplyIcon, Copy, Pencil, Trash2, SmilePlus, Send, Clock, AlertCircle, RotateCcw, Link2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PERM } from '@/lib/perm'
import { EmojiText } from '@/lib/client/serverEmoji'
import { ReactionChips } from './ReactionChips'
/** one thread row: avatar, author, time, markdown, reactions, row menu */

/** the quiet "sending" marker for thread rows: an optimistic reply looks
 *  sent immediately and only greys its state after several seconds. */
function SlowSend() {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 4000)
    return () => clearTimeout(t)
  }, [])
  if (!slow) return null
  return (
    <div className="flex items-center gap-1 mt-0.5 text-[10px] text-muted-foreground" aria-live="polite">
      <Clock className="size-3" /> sending
    </div>
  )
}

function ThreadRow({
  msg,
  meId,
  canDeleteAny,
  onReact,
  onCopy,
  onCopyLink,
  onPermalink,
  onEdit,
  onDelete,
  editing,
  editDraft,
  setEditDraft,
  setEditingId,
  saveEdit,
}: {
  msg: ClientMessage
  meId: string | null
  canDeleteAny: boolean
  onReact: (emoji: string) => void
  onCopy: (msg: ClientMessage) => void
  onCopyLink: (msg: ClientMessage) => void
  onPermalink?: (messageId: string) => void
  onEdit: (msg: ClientMessage) => void
  onDelete: (msg: ClientMessage) => void
  editing: boolean
  editDraft: string
  setEditDraft: (v: string) => void
  setEditingId: (v: string | null) => void
  saveEdit: (msg: ClientMessage) => void
}) {
  if (editing) {
    return (
      <div className="flex gap-2.5 py-1">
        <div className="w-8 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <textarea
            autoFocus
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                saveEdit(msg)
              } else if (e.key === 'Escape') {
                setEditingId(null)
              }
            }}
            rows={2}
            className="chat-font w-full bg-app-raise border border-hyper/40 rounded-sm px-2 py-1.5 leading-[1.4] outline-none resize-none scroll-thin"
            aria-label="edit message"
          />
        </div>
      </div>
    )
  }
  return (
    <div
      data-mid={msg.id}
      className={cn(
        'group/row flex gap-2.5 rounded-sm px-2 -mx-1 py-1.5 hover:bg-white/[0.03] transition-colors',
        msg.failed && 'msg-failed'
      )}
      onContextMenu={(e) => {
        if (msg.pending || msg.failed) return
        e.preventDefault()
        openContextMenu(
          e,
          [
            {
              kind: 'item',
              label: 'add reaction',
              icon: SmilePlus,
              onSelect: () =>
                openEmojiPop(e.clientX, e.clientY, (emoji) => {
                  rememberRecent(emoji)
                  rememberUsage(emoji)
                  onReact(emoji)
                }),
            },
            ...(msg.content
              ? [{ kind: 'item' as const, label: 'copy text', icon: Copy, onSelect: () => onCopy(msg) }]
              : []),
            { kind: 'item', label: 'copy link', icon: Link2, onSelect: () => onCopyLink(msg) },
            ...(meId && msg.authorId === meId && msg.content
              ? [{ kind: 'item' as const, label: 'edit', icon: Pencil, onSelect: () => onEdit(msg) }]
              : []),
            ...(meId && (msg.authorId === meId || canDeleteAny)
              ? [{ kind: 'item' as const, label: 'delete', icon: Trash2, danger: true, onSelect: () => onDelete(msg) }]
              : []),
          ],
          { title: msg.author.displayName || msg.author.username, subtitle: shortTime(msg.createdAt) }
        )
      }}
    >
      <Avatar name={msg.author.username} color={msg.author.avatarColor} url={msg.author.avatarUrl} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-bold tracking-tight truncate">{msg.author.displayName || msg.author.username}</span>
          <span className="text-[10px] text-muted-foreground">{messageTimestamp(msg.createdAt)}</span>
        </div>
        {msg.content && (
          <div className="chat-font leading-[1.4] text-foreground/95 break-words text-[14px]">
            {renderMessageContent(msg.content, { myUsername: undefined, pingsEveryone: msg.pingsEveryone, onPermalink: onPermalink })}
          </div>
        )}
        {msg.imageUrl && (
          <img
            src={msg.imageUrl}
            alt={`Image sent by ${msg.author.username}`}
            className="mt-1 max-w-[min(20rem,100%)] max-h-60 object-contain rounded-sm border border-border bg-black/40"
            loading="lazy"
          />
        )}
        <ReactionChips reactions={msg.reactions} meId={meId} room={msg.room} author={msg.author} onToggle={onReact} />
        {msg.failed && (
          <div className="flex items-center gap-2 mt-1 text-[10px] text-destructive">
            <AlertCircle className="size-3 shrink-0" />
            <span className="flex-1">did not send</span>
          </div>
        )}
        {msg.pending && <SlowSend />}
      </div>
    </div>
  )
}

/** the thread panel: a right-hand column that opens from any message's
 *  "reply in thread" action. The root rides on top, replies below, composer
 *  at the bottom. Optimistic sends, live socket rows, inline editing. */
export function ThreadPanel() {
  const openThreadId = useChatStore((s) => s.openThreadId)
  const thread = useChatStore((s) => (s.openThreadId ? s.threads[s.openThreadId] : undefined))
  const me = useChatStore((s) => s.me)
  const sendThreadMessage = useChatStore((s) => s.sendThreadMessage)
  const closeThread = useChatStore((s) => s.closeThread)
  const toggleReaction = useChatStore((s) => s.toggleReaction)
  const deleteMessage = useChatStore((s) => s.deleteMessage)
  const editMessage = useChatStore((s) => s.editMessage)
  const jumpTo = useChatStore((s) => s.jumpTo)
  const jumpToMessage = useChatStore((s) => s.jumpToMessage)
  const threadJump = useChatStore((s) => s.threadJump)
  const discardMessage = useChatStore((s) => s.discardMessage)
  const servers = useChatStore((s) => s.servers)
  const activeServerId = useChatStore((s) => s.activeServerId)

  const [content, setContent] = useState('')
  const [sending, setSending] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)

  // the composer keeps focus so thread replies chain without touching the mouse
  useEffect(() => {
    if (thread?.loaded) textareaRef.current?.focus()
  }, [thread?.loaded, openThreadId])

  // follow the bottom as rows arrive
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const count = thread?.messages.length ?? 0
    if (count !== prevCountRef.current) {
      el.scrollTop = el.scrollHeight
      prevCountRef.current = count
    }
  }, [thread?.messages.length, openThreadId])

  // permalink jump into a thread row: scroll + flash inside this panel
  useEffect(() => {
    if (!threadJump || threadJump.rootId !== openThreadId) return
    const el = document.querySelector(`[data-mid="${threadJump.messageId}"]`)
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el.classList.add('flash-highlight')
      setTimeout(() => el.classList.remove('flash-highlight'), 2400)
    }
  }, [threadJump?.at, openThreadId, thread?.loaded])

  if (!openThreadId) return null
  const root = thread?.root ?? null
  const room = root?.room ?? ''
  // delete rights inside threads match the room: own rows always, any row for moderators
  const server = activeServerId ? servers.find((s) => s.id === activeServerId) : null
  const canDeleteAny = room.startsWith('channel:')
    ? (server ? (server.myPerms & (PERM.ADMINISTRATOR | PERM.MANAGE_MESSAGES)) !== 0 : false)
    : false

  async function submit() {
    const raw = content.trim()
    if (!raw || sending || !openThreadId) return
    setSending(true)
    setContent('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    try {
      await sendThreadMessage(openThreadId, { content: raw })
    } catch {
      // the failed row shows inline
    } finally {
      setSending(false)
      textareaRef.current?.focus()
    }
  }

  return (
    <aside
      className="fixed inset-y-0 right-0 z-40 w-[85vw] max-w-sm md:static md:w-80 md:max-w-none border-l border-white/10 bg-app-chat flex flex-col md:translate-x-0 shadow-2xl md:shadow-none"
      aria-label="thread"
    >
      <div className="h-12 px-3 flex items-center justify-between border-b border-white/10 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <ReplyIcon className="size-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
          <span className="text-sm font-bold tracking-tight">thread</span>
          {(thread?.count ?? 0) > 0 && (
            <span className="text-[10px] font-semibold text-muted-foreground tabular-nums">{thread?.count}</span>
          )}
        </div>
        <button
          onClick={() => {
            sounds.play('lightTick')
            closeThread()
          }}
          className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="close thread"
        >
          <X className="size-4" />
        </button>
      </div>

      {root && (
        <button
          onClick={() => {
            sounds.play('lightTick')
            jumpTo(root.room, root.id)
          }}
          className="px-3 py-2.5 text-left border-b border-white/10 hover:bg-white/[0.03] transition-colors shrink-0"
          aria-label="jump to the original message"
        >
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground mb-1">
            <span>original</span>
          </div>
          <div className="flex gap-2">
            <Avatar name={root.author.username} color={root.author.avatarColor} url={root.author.avatarUrl} size="sm" />
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[12px] font-bold tracking-tight truncate">
                  {root.author.displayName || root.author.username}
                </span>
                <span className="text-[10px] text-muted-foreground">{shortTime(root.createdAt)}</span>
              </div>
              {root.content && (
                <div className="text-[12px] text-muted-foreground line-clamp-2 break-words leading-[1.35]">{root.content}</div>
              )}
              {!root.content && <div className="text-[12px] text-muted-foreground">{root.imageUrl || root.attachments ? 'image' : 'message'}</div>}
            </div>
          </div>
        </button>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin px-2 py-2">
        {!thread?.loaded ? (
          <div className="h-full grid place-items-center">
            <Spinner />
          </div>
        ) : thread.messages.length === 0 ? (
          <div className="h-full grid place-items-center px-6 text-center">
            <p className="text-xs text-muted-foreground">no replies yet</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {thread.messages.map((m) => (
              // nonce keying keeps the optimistic row and its confirmed
              // server swap the same node: no entry-animation replay
              <div key={m.nonce ?? m.id}>
                <ThreadRow
                  msg={m}
                  meId={me?.id ?? null}
                  canDeleteAny={canDeleteAny}
                  onReact={(emoji) => {
                    sounds.play('lightTick')
                    void toggleReaction(room, m.id, emoji)
                  }}
                  onCopy={(msg) => {
                    void navigator.clipboard?.writeText(msg.content ?? '')
                    sounds.play('glassTick')
                  }}
                  onCopyLink={(msg) => {
                    void navigator.clipboard?.writeText(`${window.location.origin}/#msg=${msg.id}`)
                    sounds.play('glassTick')
                  }}
                  onPermalink={(messageId) => void jumpToMessage(messageId)}
                  onEdit={(msg) => {
                    setEditDraft(msg.content ?? '')
                    setEditingId(msg.id)
                  }}
                  onDelete={(msg) => void deleteMessage(room, msg.id)}
                  editing={editingId === m.id}
                  editDraft={editDraft}
                  setEditDraft={setEditDraft}
                  setEditingId={setEditingId}
                  saveEdit={(msg) => {
                    const text = editDraft.trim()
                    if (text) void editMessage(room, msg.id, text)
                    setEditingId(null)
                  }}
                />
                {m.failed && (
                  <div className="flex items-center gap-2 pl-11 text-[10px] text-destructive pb-1">
                    <button
                      onClick={() => void retryThreadRow(m)}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm hover:bg-destructive/15 transition-colors font-semibold"
                      aria-label="retry sending"
                    >
                      <RotateCcw className="size-3" /> retry
                    </button>
                    <button
                      onClick={() => discardThreadRow(m)}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm hover:bg-destructive/15 transition-colors font-semibold"
                      aria-label="discard message"
                    >
                      <X className="size-3" /> discard
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="p-2.5 border-t border-white/10 shrink-0">
        <div className="flex items-end gap-1.5 bg-app-raise border border-white/10 rounded-sm px-2 py-1.5 focus-within:border-white/25 transition-colors">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value)
              const el = e.target as HTMLTextAreaElement
              el.style.height = 'auto'
              el.style.height = `${Math.min(el.scrollHeight, 132)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder="reply in thread"
            rows={1}
            className="flex-1 bg-transparent outline-none resize-none text-sm leading-[1.4] chat-font scroll-thin max-h-32"
            aria-label="reply in thread"
          />
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
                aria-label="add emoji"
                title="add emoji"
              >
                <SmilePlus className="size-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1.5 rounded-sm" side="top" align="end" aria-describedby={undefined}>
              <EmojiGrid
                onPick={(emoji) => {
                  rememberRecent(emoji)
                  rememberUsage(emoji)
                  setContent((c) => (c ? `${c} ${emoji}` : emoji))
                }}
              />
            </PopoverContent>
          </Popover>
          <Button
            size="sm"
            className="h-8 w-8 p-0 rounded-sm shrink-0"
            disabled={!content.trim() || sending}
            onClick={() => void submit()}
            aria-label="send thread reply"
          >
            {sending ? <Spinner /> : <Send className="size-4" />}
          </Button>
        </div>
      </div>
    </aside>
  )

  async function retryThreadRow(msg: ClientMessage) {
    if (!openThreadId || !msg.content) return
    // drop the failed echo, resend the text through the normal path
    discardMessage(room, msg.id)
    try {
      await sendThreadMessage(openThreadId, { content: msg.content })
    } catch {
      // the fresh echo carries its own failed state
    }
  }

  function discardThreadRow(msg: ClientMessage) {
    discardMessage(room, msg.id)
  }
}
