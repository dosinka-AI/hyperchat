'use client'

import { Plus } from 'lucide-react'
import { Avatar } from '@/components/hyperchat/Avatar'
import { cn } from '@/lib/utils'
import type { ProfileStoryGroup } from './types'

type Props = {
  groups: ProfileStoryGroup[]
  meId: string | null
  onCreate: () => void
  onOpen: (groupIndex: number) => void
}

/** The story rail on the own profile: a create tile first, then the active
 *  sequences of me + everyone I follow, unwatched rings bright, watched
 *  rings gray. */
export function StoryTray({ groups, meId, onCreate, onOpen }: Props) {
  return (
    <div className="flex items-start gap-3 overflow-x-auto scroll-thin pb-1 -mx-1 px-1" role="list" aria-label="stories">
      <div className="flex flex-col items-center gap-1 shrink-0 w-16">
        <button
          type="button"
          onClick={onCreate}
          className="size-14 rounded-full border border-dashed border-white/25 grid place-items-center text-muted-foreground hover:text-foreground hover:border-white/50 transition-colors"
          aria-label="new story"
          title="new story"
          role="listitem"
        >
          <Plus className="size-5" />
        </button>
        <span className="text-[10px] text-muted-foreground truncate w-full text-center">new</span>
      </div>

      {groups.map((group, idx) => (
        <div key={group.user.id} className="flex flex-col items-center gap-1 shrink-0 w-16" role="listitem">
          <button
            type="button"
            onClick={() => onOpen(idx)}
            className={cn(
              'size-16 rounded-full p-[2px] transition-colors',
              group.allViewed ? 'bg-white/15' : 'bg-white/85'
            )}
            aria-label={`open ${group.user.username} stories`}
            title={`open ${group.user.username} stories`}
          >
            <span className="block rounded-full p-[2px] bg-app-sidebar">
              <Avatar name={group.user.username} color={group.user.avatarColor} url={group.user.avatarUrl} size="mx" />
            </span>
          </button>
          <span className="text-[10px] text-muted-foreground truncate w-full text-center">
            {group.user.id === meId ? 'your story' : group.user.username}
          </span>
        </div>
      ))}
    </div>
  )
}
