'use client'

import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useChatStore } from '@/lib/client/store'
import { apiClient, ApiError } from '@/lib/client/api'
import type { PublicUser } from '@/lib/types'
import { Avatar } from '../Avatar'
import { Search, AtSign, UserPlus, Check } from 'lucide-react'
import { sounds } from '@/lib/client/sounds'
import { useToast } from '@/hooks/use-toast'

type FindUserDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function FindUserDialog({ open, onOpenChange }: FindUserDialogProps) {
  const openDM = useChatStore((s) => s.openDM)
  const onlineUserIds = useChatStore((s) => s.onlineUserIds)
  const sendFriendRequest = useChatStore((s) => s.sendFriendRequest)
  const friends = useChatStore((s) => s.friends)
  const { toast } = useToast()

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PublicUser[]>([])
  const [searching, setSearching] = useState(false)
  const [picking, setPicking] = useState<string | null>(null)
  const [friending, setFriending] = useState<string | null>(null)
  const [friended, setFriended] = useState<Record<string, boolean>>({})

  const friendIds = new Set(friends.map((f) => f.user.id))

  useEffect(() => {
    if (!open) {
      setQuery('')
      setResults([])
      setFriended({})
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (q.length < 1) {
      setResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        const { users } = await apiClient.searchUsers(q)
        setResults(users)
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [query, open])

  async function pick(userId: string) {
    if (picking) return
    setPicking(userId)
    try {
      await openDM(userId)
      onOpenChange(false)
    } finally {
      setPicking(null)
    }
  }

  async function befriend(username: string) {
    if (friending) return
    setFriending(username)
    try {
      await sendFriendRequest(username)
      sounds.play('midTick')
      setFriended((m) => ({ ...m, [username]: true }))
      toast({ title: 'friend request sent', description: `@${username} will see it in their sidebar.` })
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not send request',
        description: err instanceof ApiError ? err.message : 'try again in a moment.',
      })
    } finally {
      setFriending(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md top-6 translate-y-0">
        <DialogHeader>
          <DialogTitle>find people</DialogTitle>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="type a username"
            className="pl-9"
            autoFocus
            aria-label="search users"
          />
          {searching && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <Spinner className="size-3.5" />
            </div>
          )}
        </div>

        <div className="max-h-72 overflow-y-auto scroll-thin -mx-2 px-2">
          {query.trim() && !searching && results.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              no one matches that username.
            </p>
          )}
          {!query.trim() && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              usernames are lowercase, like <span className="text-foreground">maya</span>.
            </p>
          )}
          <div className="space-y-0.5">
            {results.map((u) => {
              const isFriend = friendIds.has(u.id)
              const sent = !!friended[u.username] || isFriend
              return (
                <div
                  key={u.id}
                  className="w-full flex items-center gap-3 px-2 py-2 rounded-sm hover:bg-accent/60 transition-colors"
                >
                  <button
                    onClick={() => void pick(u.id)}
                    disabled={!!picking}
                    className="flex items-center gap-3 min-w-0 flex-1 text-left rounded-sm aria-disabled:opacity-60"
                    aria-disabled={!!picking}
                    aria-label={`message ${u.username}`}
                  >
                    <Avatar name={u.username} color={u.avatarColor} url={u.avatarUrl} size="md" online={!!onlineUserIds[u.id]} showDot />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold truncate">{u.displayName || u.username}</p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1">
                        <AtSign className="size-3" />
                        {u.username}
                        <span className="opacity-40">|</span>
                        {onlineUserIds[u.id] ? 'online now' : 'offline'}
                      </p>
                    </div>
                    {picking === u.id ? (
                      <Spinner />
                    ) : (
                      <span className="text-sm font-medium rounded-sm border border-input px-3 py-1.5 shrink-0">
                        message
                      </span>
                    )}
                  </button>
                  <button
                    onClick={() => void befriend(u.username)}
                    disabled={sent || !!friending}
                    className="shrink-0 p-2 rounded-sm text-hyper hover:bg-hyper/15 transition-colors disabled:text-muted-foreground disabled:hover:bg-transparent"
                    aria-label={sent ? 'friend request already sent' : `add ${u.username} as a friend`}
                    title={sent ? 'already friends or requested' : 'add friend'}
                  >
                    {sent ? <Check className="size-4" /> : friending === u.username ? <Spinner className="size-4" /> : <UserPlus className="size-4" />}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
