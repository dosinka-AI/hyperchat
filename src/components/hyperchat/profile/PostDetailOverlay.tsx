'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Heart, Loader2, MessageCircle, SendHorizontal, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/hyperchat/Avatar'
import { apiClient } from '@/lib/client/api'
import { messageTimestamp, relativeTime } from '@/lib/client/format'
import { sounds } from '@/lib/client/sounds'
import { getSocket } from '@/lib/client/socket'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import { confirmDialog } from '@/components/hyperchat/ConfirmDialog'
import type { ProfileComment } from './types'

type PostDetail = {
  id: string
  imageUrl: string
  caption: string
  createdAt: string
  likeCount: number
  commentCount: number
  likedByMe: boolean
  author: { id: string; username: string; displayName: string | null; avatarUrl: string | null; avatarColor: string }
}

type Props = {
  postId: string
  meId: string | null
  onClose: () => void
  onDeleted: () => void
  onOpenProfile: (username: string) => void
}

/** Merge a freshly fetched newest-first server page into the currently
 *  displayed ascending list: server versions win for their ids, comments
 *  older than the page's oldest are kept as loaded history, anything the
 *  server no longer returns from the newest window disappears. Pure and
 *  id-deduped, so concurrent updates can never produce duplicate keys. */
function mergeServerPage(current: ProfileComment[], serverDesc: ProfileComment[]): ProfileComment[] {
  if (serverDesc.length === 0) return []
  const serverAsc = serverDesc.slice().reverse()
  const serverIds = new Set(serverAsc.map((c) => c.id))
  const oldest = serverAsc[0]
  const merged = [...serverAsc]
  for (const c of current) {
    if (serverIds.has(c.id)) continue
    const older =
      c.createdAt < oldest.createdAt ||
      (c.createdAt === oldest.createdAt && c.id < oldest.id)
    if (older) merged.push(c)
  }
  return merged
}

/** Post detail: full image, caption, like toggle with an animated count,
 *  comment thread with avatars, a composer at the bottom and delete
 *  affordances for own content. */
export function PostDetailOverlay({ postId, meId, onClose, onDeleted, onOpenProfile }: Props) {
  const { toast } = useToast()
  const [post, setPost] = useState<PostDetail | null>(null)
  const [comments, setComments] = useState<ProfileComment[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  // sequence numbers give each animated sibling a unique remount key so the
  // pop/bump CSS animations replay; the prefix keeps the two keys from ever
  // colliding inside the same parent.
  const [likeSeq, setLikeSeq] = useState(0)
  const [countSeq, setCountSeq] = useState(0)
  // guards the optimistic like state against a live refresh racing the
  // in-flight like request
  const likeInFlightRef = useRef(false)
  // the socket handler outlives renders; keep the author's username handy
  // without re-subscribing whenever the post loads
  const authorUsernameRef = useRef<string | null>(null)
  const deletingRef = useRef(false)

  // onClose arrives as an inline arrow and changes identity on every parent
  // render (the profile card polls every 15s) — calling it through a ref
  // keeps the initial-load effect from re-running and resetting pagination
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    authorUsernameRef.current = post?.author.username ?? null
  }, [post?.author.username])

  const load = useCallback(async () => {
    try {
      const res = await apiClient.profilePost(postId)
      setPost(res.post)
      setComments(res.comments)
    } catch {
      toast({ title: 'post unavailable' })
      onCloseRef.current()
    }
  }, [postId, toast])

  useEffect(() => {
    void load()
  }, [load])

  // derived, so it can never disagree with the data it describes
  const hasMoreComments = post ? post.commentCount > comments.length : false

  /** Live refresh: like/comment/delete broadcasts by anyone (including
   *  other viewers of this same post) arrive as profile:refresh keyed by
   *  the post author's username. Merge the authoritative state in without
   *  disturbing loaded history or in-flight optimistic toggles. */
  const refresh = useCallback(async () => {
    try {
      const res = await apiClient.profilePost(postId)
      setPost((cur) => {
        if (!cur || cur.id !== res.post.id) return cur
        if (likeInFlightRef.current) {
          return { ...res.post, likedByMe: cur.likedByMe, likeCount: cur.likeCount }
        }
        return res.post
      })
      setComments((cur) => mergeServerPage(cur, res.comments))
    } catch {
      /* live refresh is best-effort */
    }
  }, [postId])

  useEffect(() => {
    const sock = getSocket()
    if (!sock) return
    const handler = (data: unknown) => {
      const ev =
        data && typeof data === 'object' && typeof (data as { username?: unknown }).username === 'string'
          ? (data as { username: string }).username
          : null
      if (ev && ev === authorUsernameRef.current) void refresh()
    }
    sock.on('profile:refresh', handler)
    return () => {
      sock.off('profile:refresh', handler)
    }
  }, [refresh])

  async function toggleLike() {
    if (!post) return
    const nextLiked = !post.likedByMe
    const optimistic = {
      ...post,
      likedByMe: nextLiked,
      likeCount: Math.max(0, post.likeCount + (nextLiked ? 1 : -1)),
    }
    sounds.play('lightTick')
    likeInFlightRef.current = true
    setPost(optimistic)
    setLikeSeq((s) => s + 1)
    setCountSeq((s) => s + 1)
    try {
      const res = await apiClient.setProfilePostLike(post.id, nextLiked)
      setPost((cur) => (cur ? { ...cur, likedByMe: res.liked, likeCount: res.likeCount } : cur))
      // the count already animated optimistically; only re-bump if the
      // authoritative value actually differs from what is on screen.
      if (res.likeCount !== optimistic.likeCount) setCountSeq((s) => s + 1)
    } catch {
      // revert to the pre-toggle state; the number changed again so bump.
      setPost((cur) => (cur ? { ...cur, likedByMe: !nextLiked, likeCount: post.likeCount } : cur))
      setCountSeq((s) => s + 1)
    } finally {
      likeInFlightRef.current = false
    }
  }

  async function loadMoreComments() {
    if (!post || loadingMore || comments.length === 0) return
    // cursor pagination: ask for comments strictly older than the oldest
    // one on screen. Immune to comments being added or deleted while the
    // overlay is open (page offsets would drift, duplicate or skip rows).
    const oldest = comments[0]
    setLoadingMore(true)
    try {
      const res = await apiClient.profilePostComments(post.id, {
        before: oldest.createdAt,
        beforeId: oldest.id,
      })
      setComments((cur) => {
        const seen = new Set(cur.map((c) => c.id))
        const older = res.comments.slice().reverse().filter((c) => !seen.has(c.id))
        return [...older, ...cur]
      })
    } catch {
      toast({ title: 'comments unavailable' })
    } finally {
      setLoadingMore(false)
    }
  }

  async function sendComment() {
    const text = draft.trim()
    if (!text || !post || sending) return
    setSending(true)
    try {
      const res = await apiClient.addProfilePostComment(post.id, text.slice(0, 500))
      setComments((cur) => [...cur, res.comment])
      setPost((cur) => (cur ? { ...cur, commentCount: cur.commentCount + 1 } : cur))
      setDraft('')
      sounds.play('lightTick')
    } catch {
      toast({ title: 'comment failed', description: 'Try again.' })
    } finally {
      setSending(false)
    }
  }

  async function deleteComment(commentId: string) {
    if (!post) return
    try {
      await apiClient.deleteProfilePostComment(post.id, commentId)
      setComments((cur) => cur.filter((c) => c.id !== commentId))
      setPost((cur) => (cur ? { ...cur, commentCount: Math.max(0, cur.commentCount - 1) } : cur))
      sounds.play('midTick')
    } catch {
      toast({ title: 'delete failed' })
    }
  }

  async function deletePost() {
    if (!post || deletingRef.current) return
    const yes = await confirmDialog({
      title: 'delete this post?',
      body: 'The image, its likes and every comment go with it.',
      tone: 'danger',
      confirmLabel: 'delete',
    })
    if (!yes) return
    deletingRef.current = true
    try {
      await apiClient.deleteProfilePost(post.id)
      sounds.play('midTick')
      onDeleted()
      onClose()
    } catch {
      deletingRef.current = false
      toast({ title: 'delete failed' })
    }
  }

  const ownPost = post?.author.id === meId

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="w-[min(38rem,94vw)] sm:max-w-none p-0 border-border bg-app-sidebar rounded-sm overflow-hidden max-h-[88vh]"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">post by {post?.author.username ?? 'unknown'}</DialogTitle>

        {!post ? (
          <div className="h-64 grid place-items-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex flex-col max-h-[88vh]">
            {/* author row */}
            <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10 shrink-0">
              <Avatar name={post.author.username} color={post.author.avatarColor} url={post.author.avatarUrl} size="md" />
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className="text-sm font-bold truncate hover:underline underline-offset-2"
                  onClick={() => {
                    onOpenProfile(post.author.username)
                    onClose()
                  }}
                >
                  {post.author.displayName || post.author.username}
                </button>
                <p className="text-[11px] text-muted-foreground">{messageTimestamp(post.createdAt)}</p>
              </div>
              {ownPost && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-sm h-8 px-2 text-muted-foreground hover:text-destructive"
                  onClick={() => void deletePost()}
                  aria-label="delete post"
                  title="delete post"
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>

            {/* the image */}
            <div className="bg-black shrink-0">
              <img
                src={post.imageUrl}
                alt={post.caption ? `post: ${post.caption.slice(0, 80)}` : `post by ${post.author.username}`}
                className="w-full max-h-[46vh] object-contain"
                draggable={false}
              />
            </div>

            {/* likes + caption */}
            <div className="px-4 pt-3 shrink-0">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void toggleLike()}
                  className="flex items-center gap-1.5 group"
                  aria-label={post.likedByMe ? 'unlike post' : 'like post'}
                  aria-pressed={post.likedByMe}
                >
                  <Heart
                    key={`heart-${likeSeq}`}
                    className={cn(
                      'size-5 transition-colors hc-like-pop',
                      post.likedByMe
                        ? 'fill-foreground text-foreground'
                        : 'text-muted-foreground group-hover:text-foreground'
                    )}
                  />
                  <span key={`count-${countSeq}`} className="text-sm font-bold tabular-nums hc-count-bump">
                    {post.likeCount}
                  </span>
                </button>
                <span className="flex items-center gap-1.5 text-sm font-bold text-muted-foreground tabular-nums">
                  <MessageCircle className="size-5" />
                  {post.commentCount}
                </span>
              </div>

              {post.caption && (
                <p className="mt-2 text-sm leading-relaxed break-words whitespace-pre-wrap text-foreground/90">
                  <button
                    type="button"
                    className="font-bold hover:underline underline-offset-2 mr-1.5"
                    onClick={() => {
                      onOpenProfile(post.author.username)
                      onClose()
                    }}
                  >
                    {post.author.username}
                  </button>
                  {post.caption}
                </p>
              )}
            </div>

            {/* comments */}
            <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-4 py-3 mt-1 border-t border-white/10">
              {hasMoreComments && (
                <button
                  type="button"
                  onClick={() => void loadMoreComments()}
                  disabled={loadingMore}
                  className="text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors mb-2"
                >
                  {loadingMore ? 'loading…' : 'load earlier comments'}
                </button>
              )}
              {comments.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">no comments yet</p>
              ) : (
                comments.map((c) => (
                  <div key={c.id} className="flex items-start gap-2 py-1.5 group/comment">
                    <Avatar name={c.author.username} color={c.author.avatarColor} url={c.author.avatarUrl} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-snug break-words">
                        <button
                          type="button"
                          className="font-bold mr-1.5 hover:underline underline-offset-2"
                          onClick={() => {
                            onOpenProfile(c.author.username)
                            onClose()
                          }}
                        >
                          {c.author.username}
                        </button>
                        <span className="text-foreground/90">{c.text}</span>
                      </p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{relativeTime(c.createdAt)}</p>
                    </div>
                    {(c.author.id === meId || ownPost) && (
                      <button
                        type="button"
                        onClick={() => void deleteComment(c.id)}
                        className="opacity-0 group-hover/comment:opacity-100 focus-visible:opacity-100 p-1 text-muted-foreground hover:text-destructive transition-opacity"
                        aria-label="delete comment"
                        title="delete comment"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* comment composer */}
            <form
              className="flex items-center gap-2 p-3 border-t border-white/10 shrink-0"
              onSubmit={(e) => {
                e.preventDefault()
                void sendComment()
              }}
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={500}
                placeholder="add a comment"
                aria-label="add a comment"
                className="flex-1 bg-app-raise border border-white/10 rounded-sm px-3 py-2 text-sm outline-none focus:border-hyper/60 placeholder:text-muted-foreground/60"
              />
              <Button
                type="submit"
                size="sm"
                className="rounded-sm h-9 px-3"
                disabled={!draft.trim() || sending}
                aria-label="send comment"
              >
                {sending ? <Loader2 className="size-4 animate-spin" /> : <SendHorizontal className="size-4" />}
              </Button>
            </form>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
