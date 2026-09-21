'use client'

import { useMemo, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { apiClient } from '@/lib/client/api'
import type { ClientMessage, ForumPostSummary, ForumTagSummary } from '@/lib/types'
import { renderMessageContent } from '@/lib/client/markdown'
import { messageTimestamp, relativeTime } from '@/lib/client/format'
import { Avatar } from './Avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
import { ArrowLeft, Lock, MessagesSquare, MoreVertical, PenLine, Pin, Plus, Send, Tag, X } from 'lucide-react'

// stable empty lists for the selectors (fresh [] per call = infinite loop)
const NO_POSTS: ForumPostSummary[] = []
const NO_TAGS: ForumTagSummary[] = []

/** posts can carry tag names the local tag cache no longer knows (deleted
 *  elsewhere): render those chips in a neutral gray instead of guessing */
const FALLBACK_TAG_COLOR = '#a1a1aa'

/** max tags a single post can carry (mirrors the API) */
const MAX_POST_TAGS = 4

/** A small colored tag chip: dot-less pill with the tag color as text +
 *  border and a subtle tinted background. */
function TagChip({ name, color }: { name: string; color: string }) {
  return (
    <span
      className="shrink-0 inline-flex items-center h-4 px-1.5 rounded-full border text-[9px] font-semibold leading-none whitespace-nowrap"
      style={{ color, borderColor: `${color}66`, background: `${color}1f` }}
    >
      {name}
    </span>
  )
}

/** A single forum post row in the list: title, tags, author line, reply count,
 *  last activity, pin/lock badges and a "new" badge for unread activity. */
function PostRow({ post, tagColorOf, onOpen }: { post: ForumPostSummary; tagColorOf: (name: string) => string; onOpen: () => void }) {
  const isNew = !!post.lastReplyAt && (!post.readAt || post.lastReplyAt > post.readAt)
  return (
    <button
      onClick={onOpen}
      className="w-full text-left flex items-center gap-3 px-3 py-3 rounded-sm border border-white/10 bg-app-raise/40 hover:bg-app-raise hover:border-white/25 transition-colors"
    >
      <Avatar name={post.author.username} color={post.author.avatarColor} url={post.author.avatarUrl} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          {post.pinned && <Pin className="size-3.5 shrink-0 text-hyper" aria-label="pinned" />}
          {post.locked && <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="locked" />}
          <span className="font-semibold text-sm tracking-tight truncate">{post.title}</span>
          {(post.tags ?? []).slice(0, MAX_POST_TAGS).map((name) => (
            <TagChip key={name} name={name} color={tagColorOf(name)} />
          ))}
          {isNew && <span className="shrink-0 text-[9px] font-bold text-hyper tracking-wide">new</span>}
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

/** Toggle chip used by both the filter row and the composer: dim pill when
 *  off, tag-colored tint when on. */
function TagToggleChip({
  tag,
  active,
  disabled,
  onClick,
}: {
  tag: ForumTagSummary
  active: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      disabled={disabled}
      className={cn(
        'h-7 px-2 rounded-full border border-white/10 text-[11px] font-semibold inline-flex items-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
        active ? '' : 'text-muted-foreground hover:text-foreground'
      )}
      style={active ? { color: tag.color, borderColor: `${tag.color}66`, background: `${tag.color}1f` } : undefined}
    >
      <span className="size-2 rounded-full shrink-0" style={{ background: tag.color }} aria-hidden="true" />
      {tag.name}
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
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-app-chat">
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

/** Compact inline tag manager for MANAGE_SERVER users: swatch list with
 *  delete buttons plus a name + color + add row. */
function TagEditor({
  channelId,
  tags,
  onRemoved,
}: {
  channelId: string
  tags: ForumTagSummary[]
  /** the parent prunes its filter/composer state of the deleted name */
  onRemoved: (name: string) => void
}) {
  const refreshForumTags = useChatStore((s) => s.refreshForumTags)
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [color, setColor] = useState('#f5f5f5')
  const [busy, setBusy] = useState(false)

  async function addTag() {
    const clean = name.trim()
    if (!clean || busy) return
    setBusy(true)
    try {
      await apiClient.addForumTag(channelId, { name: clean, color })
      setName('')
      await refreshForumTags(channelId)
    } catch (err) {
      toast({ title: 'could not add the tag', description: err instanceof Error ? err.message : undefined })
    } finally {
      setBusy(false)
    }
  }

  async function removeTag(tag: ForumTagSummary) {
    if (busy) return
    setBusy(true)
    try {
      await apiClient.removeForumTag(channelId, tag.id)
      onRemoved(tag.name)
    } catch (err) {
      toast({ title: 'could not remove the tag', description: err instanceof Error ? err.message : undefined })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 rounded-sm gap-1.5 shrink-0 text-muted-foreground hover:text-foreground border border-white/10"
        >
          <Tag className="size-3.5" />
          tags
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 rounded-sm p-3 space-y-3">
        <div className="max-h-64 overflow-y-auto scroll-thin space-y-1">
          {tags.length === 0 ? (
            <p className="text-xs text-muted-foreground py-1">no tags yet</p>
          ) : (
            tags.map((t) => (
              <div key={t.id} className="flex items-center gap-2">
                <span
                  className="size-3.5 rounded-sm shrink-0 border border-white/20"
                  style={{ background: t.color }}
                  aria-hidden="true"
                />
                <span className="text-sm truncate flex-1">{t.name}</span>
                <button
                  type="button"
                  onClick={() => void removeTag(t)}
                  disabled={busy}
                  aria-label={`remove tag ${t.name}`}
                  className="h-7 w-7 grid place-items-center rounded-sm text-muted-foreground hover:text-destructive hover:bg-accent transition-colors disabled:opacity-50"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            void addTag()
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="tag name"
            maxLength={24}
            className="h-8 rounded-sm text-sm flex-1 bg-app-raise border-white/10"
          />
          <Input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            aria-label="tag color"
            className="h-8 w-10 rounded-sm p-0.5 shrink-0 cursor-pointer bg-app-raise border-white/10"
          />
          <Button
            type="submit"
            size="sm"
            className="h-8 w-8 p-0 rounded-sm shrink-0"
            disabled={!name.trim() || busy}
            aria-label="add tag"
          >
            {busy ? <Spinner /> : <Plus className="size-4" />}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  )
}

export function ForumView() {
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const servers = useChatStore((s) => s.servers)
  const forumLoaded = useChatStore((s) => s.forumLoaded)
  // module-level empty lists keep the selector snapshots stable (a fresh []
  // per call trips React's infinite-update guard, same class as the voice bug)
  const posts = useChatStore((s) =>
    s.activeChannelId ? s.forumPostsByChannel[s.activeChannelId] ?? NO_POSTS : NO_POSTS
  )
  const tags = useChatStore((s) =>
    s.activeChannelId ? s.forumTags[s.activeChannelId] ?? NO_TAGS : NO_TAGS
  )
  const openForumPostId = useChatStore((s) => s.openForumPostId)
  const loadForumPosts = useChatStore((s) => s.loadForumPosts)
  const openForumPost = useChatStore((s) => s.openForumPost)
  const { toast } = useToast()

  const [q, setQ] = useState('')
  const [sort, setSort] = useState<'latest' | 'new'>('latest')
  const [composeOpen, setComposeOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [composeTags, setComposeTags] = useState<string[]>([])
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const channel = servers.flatMap((s) => s.channels).find((c) => c.id === activeChannelId) ?? null
  const server = servers.find((s) => s.channels.some((c) => c.id === activeChannelId)) ?? null
  const canManageTags = server ? (server.myPerms & (PERM.ADMINISTRATOR | PERM.MANAGE_SERVER)) !== 0 : false

  const tagColorOf = useMemo(() => {
    const byName = new Map(tags.map((t) => [t.name, t.color]))
    return (name: string) => byName.get(name) ?? FALLBACK_TAG_COLOR
  }, [tags])

  // drop filters whose tag was deleted (the tags list is the source of truth)
  const liveTagFilter = useMemo(() => {
    const names = new Set(tags.map((t) => t.name))
    const live = new Set<string>()
    for (const name of tagFilter) if (names.has(name)) live.add(name)
    return live
  }, [tagFilter, tags])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = posts.filter((p) => {
      if (needle) {
        const inTitle = p.title.toLowerCase().includes(needle)
        const inAuthor = (p.author.displayName || p.author.username).toLowerCase().includes(needle)
        if (!inTitle && !inAuthor) return false
      }
      // OR across active tag filters: a post matches when it carries any of them
      if (liveTagFilter.size > 0 && !(p.tags ?? []).some((name) => liveTagFilter.has(name))) return false
      return true
    })
    return [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const ka = sort === 'latest' ? a.lastReplyAt ?? a.createdAt : a.createdAt
      const kb = sort === 'latest' ? b.lastReplyAt ?? b.createdAt : b.createdAt
      return ka < kb ? 1 : ka > kb ? -1 : a.id < b.id ? -1 : 1
    })
  }, [posts, q, sort, liveTagFilter])

  const openPost = posts.find((p) => p.id === openForumPostId)
  if (openPost) return <ForumPostView post={openPost} />

  function toggleTagFilter(name: string) {
    setTagFilter((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function toggleComposeTag(name: string) {
    setComposeTags((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : prev.length >= MAX_POST_TAGS ? prev : [...prev, name]
    )
  }

  async function submitPost() {
    const cleanTitle = title.trim()
    if (!activeChannelId || !cleanTitle || busy) return
    setBusy(true)
    try {
      // only names that are still tags of THIS channel (a channel switch can
      // leave a stale pick behind; the API would reject the unknown name)
      const selectedTags = composeTags.filter((name) => tags.some((t) => t.name === name))
      const { post } = await apiClient.createForumPost(activeChannelId, {
        title: cleanTitle,
        content: body.trim() || undefined,
        tags: selectedTags,
      })
      useChatStore.getState().onForumPostNew(post)
      sounds.play('midTick')
      setComposeOpen(false)
      setTitle('')
      setBody('')
      setComposeTags([])
    } catch (err) {
      sounds.play('error')
      toast({ title: 'could not create post', description: err instanceof Error ? err.message : undefined })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-app-chat">
      <div className="h-12 px-3 flex items-center gap-2 border-b border-white/10 shrink-0">
        <MessagesSquare className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
        <span className="font-bold text-sm tracking-tight truncate flex-1">{channel?.name ?? 'forum'}</span>
        {canManageTags && activeChannelId && (
          <TagEditor
            channelId={activeChannelId}
            tags={tags}
            onRemoved={(name) => {
              // drop the deleted name anywhere this client still holds it,
              // then pull the fresh post list (the delete stripped the name
              // from posts server-side; this also refreshes the tag cache)
              setTagFilter((prev) => {
                if (!prev.has(name)) return prev
                const next = new Set(prev)
                next.delete(name)
                return next
              })
              setComposeTags((prev) => prev.filter((n) => n !== name))
              void loadForumPosts(activeChannelId, sort)
            }}
          />
        )}
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

      {tags.length > 0 && (
        <div className="px-3 pt-2 flex items-center gap-1.5 flex-wrap shrink-0">
          {tags.map((t) => (
            <TagToggleChip
              key={t.id}
              tag={t}
              active={liveTagFilter.has(t.name)}
              onClick={() => toggleTagFilter(t.name)}
            />
          ))}
          {liveTagFilter.size > 0 && (
            <>
              <span className="text-[11px] text-muted-foreground tabular-nums">({filtered.length})</span>
              <button
                type="button"
                onClick={() => setTagFilter(new Set())}
                aria-label="clear tag filters"
                className="h-7 w-7 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                <X className="size-3.5" />
              </button>
            </>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto scroll-thin p-3">
        {!forumLoaded[activeChannelId ?? ''] ? (
          <div className="h-full grid place-items-center">
            <Spinner />
          </div>
        ) : filtered.length === 0 ? (
          <div className="h-full grid place-items-center px-6 text-center">
            <p className="text-sm text-muted-foreground">{liveTagFilter.size > 0 ? 'no posts match' : 'no posts yet'}</p>
          </div>
        ) : (
          <div className="space-y-1.5 max-w-3xl">
            {filtered.map((p) => (
              <PostRow key={p.id} post={p} tagColorOf={tagColorOf} onOpen={() => openForumPost(p.id)} />
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
            {tags.length > 0 ? (
              <div className="space-y-1.5">
                <span className="text-[11px] text-muted-foreground">tags</span>
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((t) => (
                    <TagToggleChip
                      key={t.id}
                      tag={t}
                      active={composeTags.includes(t.name)}
                      disabled={!composeTags.includes(t.name) && composeTags.length >= MAX_POST_TAGS}
                      onClick={() => toggleComposeTag(t.name)}
                    />
                  ))}
                </div>
              </div>
            ) : canManageTags ? (
              <p className="text-xs text-muted-foreground">no tags yet</p>
            ) : null}
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
