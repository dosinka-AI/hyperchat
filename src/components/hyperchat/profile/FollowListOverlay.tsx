'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Avatar } from '@/components/hyperchat/Avatar'
import { apiClient, type ProfileUserBrief } from '@/lib/client/api'

type Props = {
  username: string
  list: 'followers' | 'following'
  onClose: () => void
  onOpenProfile: (username: string) => void
}

/** Followers / following list opened from the profile stats row. Rows jump
 *  straight to that profile. A failed load shows an explicit error with a
 *  retry — it must never look identical to an empty list. */
export function FollowListOverlay({ username, list, onClose, onOpenProfile }: Props) {
  // the loaded data is tagged with the request it belongs to; when the key
  // changes the render falls back to the loading state on its own, with no
  // reset-in-effect render cascade
  const [state, setState] = useState<{ key: string; users: ProfileUserBrief[]; failed: boolean } | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const key = `${username}:${list}:${retryKey}`
  const current = state?.key === key ? state : null

  useEffect(() => {
    let alive = true
    apiClient
      .followList(username, list)
      .then((res) => {
        if (alive) setState({ key, users: res.users, failed: false })
      })
      .catch(() => {
        if (alive) setState({ key, users: [], failed: true })
      })
    return () => {
      alive = false
    }
  }, [username, list, key])

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[min(22rem,94vw)] sm:max-w-none p-0 border-border bg-app-sidebar rounded-sm overflow-hidden" aria-describedby={undefined}>
        <DialogTitle className="sr-only">{list === 'followers' ? 'followers' : 'following'} of {username}</DialogTitle>

        <div className="px-4 py-3 border-b border-white/10">
          <p className="text-xs font-bold tracking-widest text-muted-foreground">
            {list === 'followers' ? `followers of @${username}` : `@${username} follows`}
          </p>
        </div>

        <div className="max-h-96 overflow-y-auto scroll-thin p-2">
          {!current ? (
            <div className="h-24 grid place-items-center" role="status" aria-label="loading list">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : current.failed ? (
            <div className="py-6 text-center">
              <p className="text-xs text-muted-foreground">the list didn't load</p>
              <button
                type="button"
                className="mt-2 text-xs font-semibold text-hyper hover:underline underline-offset-2"
                onClick={() => setRetryKey((k) => k + 1)}
              >
                try again
              </button>
            </div>
          ) : current.users.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {list === 'followers' ? 'no followers yet' : 'not following anyone yet'}
            </p>
          ) : (
            current.users.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => {
                  onOpenProfile(u.username)
                  onClose()
                }}
                className="w-full flex items-center gap-2.5 px-2 py-2 rounded-sm hover:bg-app-raise transition-colors text-left"
                aria-label={`open ${u.username} profile`}
              >
                <Avatar name={u.username} color={u.avatarColor} url={u.avatarUrl} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold truncate">{u.displayName || u.username}</span>
                  <span className="block text-[11px] text-muted-foreground truncate">@{u.username}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
