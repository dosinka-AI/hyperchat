'use client'

import { Heart, Loader2, MessageCircle, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ProfileFeedPost } from './types'

type Props = {
  isSelf: boolean
  posts: ProfileFeedPost[]
  nextOffset: number | null
  loading: boolean
  loadingMore: boolean
  onLoadMore: () => void
  onOpenPost: (postId: string) => void
  onCreate: () => void
}

/** The posts grid: square crops, 3 columns (2 on narrow), hover overlays
 *  with like/comment counts on pointer devices, a create tile first on the
 *  own profile. */
export function ProfilePostsTab({
  isSelf,
  posts,
  nextOffset,
  loading,
  loadingMore,
  onLoadMore,
  onOpenPost,
  onCreate,
}: Props) {
  if (loading) {
    return (
      <div className="h-48 grid place-items-center" role="status" aria-label="loading posts">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (posts.length === 0 && !isSelf) {
    return <p className="py-10 text-center text-xs text-muted-foreground">no posts yet</p>
  }

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
        {isSelf && (
          <button
            type="button"
            onClick={onCreate}
            className="relative aspect-square border border-dashed border-white/20 rounded-sm grid place-items-center text-muted-foreground hover:text-foreground hover:border-white/40 transition-colors"
            aria-label="new post"
            title="new post"
          >
            <span className="flex flex-col items-center gap-1.5">
              <Plus className="size-6" />
              <span className="text-[10px] font-bold tracking-widest">new post</span>
            </span>
          </button>
        )}

        {posts.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onOpenPost(p.id)}
            className={cn(
              'relative aspect-square overflow-hidden rounded-sm border border-white/10 group',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hyper/70'
            )}
            aria-label={`open post, ${p.likeCount} likes, ${p.commentCount} comments`}
          >
            <img
              src={p.imageUrl}
              alt={p.caption ? p.caption.slice(0, 80) : 'post image'}
              className="absolute inset-0 size-full object-cover"
              loading="lazy"
              draggable={false}
            />
            <span className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-150 hidden sm:flex items-center justify-center gap-5">
              <span className="flex items-center gap-1.5 text-sm font-bold">
                <Heart className="size-4 fill-foreground" />
                {p.likeCount}
              </span>
              <span className="flex items-center gap-1.5 text-sm font-bold">
                <MessageCircle className="size-4" />
                {p.commentCount}
              </span>
            </span>
          </button>
        ))}
      </div>

      {nextOffset !== null && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="mt-3 w-full h-9 border border-white/10 rounded-sm text-xs font-semibold text-muted-foreground hover:text-foreground hover:border-white/25 transition-colors grid place-items-center disabled:opacity-50"
        >
          {loadingMore ? <Loader2 className="size-4 animate-spin" /> : 'load more'}
        </button>
      )}
    </div>
  )
}
