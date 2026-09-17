'use client'

import { useMemo, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import type { ClientMessage, ForumPostSummary } from '@/lib/types'
import { renderMessageContent } from '@/lib/client/markdown'
import { messageTimestamp, relativeTime } from '@/lib/client/format'
import { Avatar } from './Avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Spinner } from '@/components/ui/spinner'
import { sounds } from '@/lib/client/sounds'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { PERM } from '@/lib/perm'
import { ArrowLeft, Lock, MessagesSquare, MoreVertical, PenLine, Pin, Send } from 'lucide-react'

/** A single forum post row in the list: title, author line, reply count,
 *  last activity, pin/lock badges and a "new" badge for unread activity. */
function PostRow({ post, onOpen }: { post: ForumPostSummary; onOpen: () => void }) {
  const isNew = !!post.lastReplyAt && (!post.readAt || post.lastReplyAt > post.readAt)
  return (
    <button
      onClick={onOpen}
      className="w-full text-left flex items-center gap-3 px-3 py-3 rounded-sm border border-white/10 bg-app-raise/40 hover:bg-app-raise hover:border-white/25 transition-colors"
    >
      <Avatar name={post.author.username} color={post.author.avatarColor} url={post.author.avatarUrl} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {post.pinned && <Pin className="size-3.5 shrink-0 text-hyper" aria-label="pinned" />}
          {post.locked && <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="locked" />}
          <span className="font-semibold text-sm tracking-tight truncate">{post.title}</span>
          {isNew && <span className="shrink-0 text-[9px] font-bold text-hyper uppercase">new</span>}
        </div>
        <div className="text-[11px] text-muted-foreground truncate mt-0.5">
          {post.author.displayName || post.author.username} · {relativeTime(post.lastReplyAt ?? post.createdAt)}
        </div>
      </div>
      <span className="shrink-0 flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
        <MessagesSquare className="size-3.5" />
        {post.replyCount}
      </span>
    </button>
  )
}

/** The in-post view: back button, post header, the message thread and the
 *  composer. Reuses the thread cache (keyed by firstMessageId) so replies
 *  flow through the same onMessageNew path as regular threads. */
function ForumPostView({ post }: { post: ForumPostSummary }) {
  const closeForumPost = useChatStore((s) => s.closeForumPost)
  const updateForumPost = useChatStore((s) => s.updateForumPost)
  const deleteForumPost = useChatStore((s) => s.deleteForumPost)
  const sendForumReply = useChatStore((s) => s.sendForumReply)
  const me = useChatStore((s) => s.me)
  const servers = useChatStore((s) => s.servers)
  const thread = useChatStore((s) => (post.firstMessageId ? s.threads[post.firstMessageId] : undefined))

  const server = servers.find((s) => s.channels.some((c) => c.id === post.channelId)) ?? null
  const canMod = server ? (server.myPerms & (PERM.ADMINISTRATOR | PERM.MANAGE_MESSAGES)) !== 0 : false
  const canEdit = canMod || post.author.id === me?.id

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  const messages = useMemo(() => {
    const list: ClientMessage[] = []
    if (thread?.root) list.push(thread.root)
    list.push(...(thread?.messages ?? []))
    return list
  }, [thread])

  async function submit() {
    const content = draft.trim()
    if (!content || sending) return
    setSending(true)
    setDraft('')
    try {
      await sendForumReply(post.id, content)
    } catch {
      // failed state is surfaced by the toast in the store; keep the draft clear
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-app-chat">
      <div className="h-12 px-3 flex items-center gap-2 border-b border-white/10 shrink-0">
        <button
          onClick={() => {
            sounds.play('lightTick')
            closeForumPost()
          }}
          className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          aria-label="back to posts"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {post.pinned && <Pin className="size-3.5 shrink-0 text-hyper" aria-label="pinned" />}
            {post.locked && <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="locked" />}
            <span className="font-bold text-sm tracking-tight truncate">{post.title}</span>
          </div>
          <div className="text-[11px] text-muted-foreground truncate">
            {post.author.displayName || post.author.username}
          </div>
        </div>
        {canEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" aria-label="post options">
                <MoreVertical className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48 rounded-sm">
              {canMod && (
                <>
                  <DropdownMenuItem onClick={() => void updateForumPost(post.id, { pinned: !post.pinned })}>
                    <Pin className="size-4" />
                    {post.pinned ? 'unpin' : 'pin'}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void updateForumPost(post.id, { locked: !post.locked })}>
                    <Lock className="size-4" />
                    {post.locked ? 'unlock' : 'lock'}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => void deleteForumPost(post.id)}
              >
                delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin px-3 py-3 space-y-2">
        {!thread?.loaded ? (
          <div className="h-full grid place-items-center">
            <Spinner />
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="flex gap-2.5 rounded-sm px-1 py-1">
              <Avatar name={m.author.username} color={m.author.avatarColor} url={m.author.avatarUrl} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-bold tracking-tight truncate">{m.author.displayName || m.author.username}</span>
                  <span className="text-[10px] text-muted-foreground">{messageTimestamp(m.createdAt)}</span>
                </div>
                {m.content ? (
                  <div className="chat-font leading-[1.4] text-foreground/95 break-words text-[14px]">
                    {renderMessageContent(m.content, { myUsername: undefined, pingsEveryone: false })}
                  </div>
                ) : (
                  <div className="text-[12px] text-muted-foreground">no body</div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="p-3 border-t border-white/10 shrink-0">
        <div className="flex items-end gap-1.5 bg-app-raise border border-white/10 rounded-sm px-2 py-1.5 focus-within:border-white/25 transition-colors">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit()
              }
            }}
            placeholder="reply"
            rows={1}
            className="flex-1 bg-transparent outline-none resize-none text-sm leading-[1.4] chat-font scroll-thin max-h-32 border-0 p-0 shadow-none focus-visible:ring-0"
          />
          <Button
            size="sm"
            className="h-8 w-8 p-0 rounded-sm shrink-0"
            disabled={!draft.trim() || sending}
            onClick={() => void submit()}
            aria-label="send reply"
          >
            {sending ? <Spinner /> : <Send className="size-4" />}
          </Button>
        </div>
      </div>
    </div>
  )
}

export function ForumView() {
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const servers = useChatStore((s) => s.servers)
  const forumLoaded = useChatStore((s) => s.forumLoaded)
  const posts = useChatStore((s) => (s.activeChannelId ? s.forumPostsByChannel[s.activeChannelId] ?? [] : []))
  const openForumPostId = useChatStore((s) => s.openForumPostId)
  const loadForumPosts = useChatStore((s) => s.loadForumPosts)
  const openForumPost = useChatStore((s) => s.openForumPost)
  const createForumPost = useChatStore((s) => s.createForumPost)
  const { toast } = useToast()

  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'latest' | 'new'>('latest')
  const [composeOpen, setComposeOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  const channel = servers.flatMap((s) => s.channels).find((c) => c.id === activeChannelId) ?? null

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = needle
      ? posts.filter(
          (p) =>
            p.title.toLowerCase().includes(needle) ||
            (p.author.displayName || p.author.username).toLowerCase().includes(needle)
        )
      : posts
    return [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const ka = sort === 'latest' ? a.lastReplyAt ?? a.createdAt : a.createdAt
      const kb = sort === 'latest' ? b.lastReplyAt ?? b.createdAt : b.createdAt
      return ka < kb ? 1 : ka > kb ? -1 : a.id < b.id ? -1 : 1
    })
  }, [posts, q, sort])

  const openPost = posts.find((p) => p.id === openForumPostId)
  if (openPost) return <ForumPostView post={openPost} />

  async function submitPost() {
    const cleanTitle = title.trim()
    if (!activeChannelId || !cleanTitle || busy) return
    setBusy(true)
    try {
      await createForumPost(activeChannelId, { title: cleanTitle, content: body.trim() || undefined })
      sounds.play('midTick')
      setComposeOpen(false)
      setTitle('')
      setBody('')
    } catch (err) {
      sounds.play('error')
      toast({ title: 'could not create post', description: err instanceof Error ? err.message : undefined })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-app-chat">
      <div className="h-12 px-3 flex items-center gap-2 border-b border-white/10 shrink-0">
        <MessagesSquare className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
        <span className="font-bold text-sm tracking-tight truncate flex-1">{channel?.name ?? 'forum'}</span>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search"
          className="h-7 w-40 rounded-sm text-xs bg-app-raise border-white/10"
        />
        <div className="flex items-center rounded-sm border border-white/10 overflow-hidden shrink-0">
          {(['latest', 'new'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={cn(
                'px-2 h-7 text-[11px] font-semibold transition-colors',
                sort === s ? 'bg-app-raise text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <Button size="sm" className="h-7 rounded-sm gap-1.5" onClick={() => setComposeOpen(true)}>
          <PenLine className="size-3.5" />
          new post
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin p-3">
        {!forumLoaded[activeChannelId ?? ''] ? (
          <div className="h-full grid place-items-center">
            <Spinner />
          </div>
        ) : filtered.length === 0 ? (
          <div className="h-full grid place-items-center px-6 text-center">
            <p className="text-sm text-muted-foreground">no posts yet</p>
          </div>
        ) : (
          <div className="space-y-1.5 max-w-3xl">
            {filtered.map((p) => (
              <PostRow key={p.id} post={p} onOpen={() => openForumPost(p.id)} />
            ))}
          </div>
        )}
      </div>

      <Dialog open={composeOpen} onOpenChange={setComposeOpen}>
        <DialogContent className="sm:max-w-md rounded-sm">
          <DialogHeader>
            <DialogTitle>new post</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="title"
              maxLength={200}
              className="rounded-sm"
            />
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="body, optional"
              rows={4}
              maxLength={2000}
              className="rounded-sm resize-none"
            />
            <Button className="w-full rounded-sm" disabled={busy || !title.trim()} onClick={() => void submitPost()}>
              {busy && <Spinner />}
              post
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
