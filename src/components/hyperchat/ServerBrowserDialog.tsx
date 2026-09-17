'use client'

import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { apiClient, ApiError } from '@/lib/client/api'
import { colorForName } from '@/lib/client/format'
import { sounds } from '@/lib/client/sounds'
import { Avatar } from './Avatar'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import { Compass, Search, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EmailVerifyDialog } from './EmailVerifyDialog'

type BrowseServer = {
  id: string
  name: string
  description: string
  iconUrl: string | null
  bannerColor: string | null
  memberCount: number
}

type Sort = 'members' | 'new'
type SortOption = { key: Sort; label: string }
const SORTS: SortOption[] = [
  { key: 'members', label: 'most members' },
  { key: 'new', label: 'newest' },
]

const PAGE_SIZE = 24

/** Page-1 fetch for the discovery grid (local helper: the shared client
 *  contract does not carry sort/offset yet). */
async function browseServers(q: string, sort: Sort, offset: number): Promise<BrowseServer[]> {
  const res = await fetch(
    `/api/servers/browse?q=${encodeURIComponent(q)}&sort=${sort}&offset=${offset}`
  )
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : 'something went wrong. try again.'
    throw new ApiError(message, res.status)
  }
  const rows = data && typeof data === 'object' ? (data as { servers?: BrowseServer[] }).servers : null
  return rows ?? []
}

function ServerCardSkeleton() {
  return (
    <div className="rounded-sm border border-white/10 bg-app-raise overflow-hidden">
      <div className="h-24 bg-app-raise animate-pulse" />
      <div className="px-3 pt-8 pb-3 space-y-2">
        <div className="h-3.5 w-2/3 rounded-sm bg-app-sidebar animate-pulse" />
        <div className="h-3 w-full rounded-sm bg-app-sidebar animate-pulse" />
        <div className="h-3 w-1/2 rounded-sm bg-app-sidebar animate-pulse" />
      </div>
    </div>
  )
}

/** Discover: browse public servers like a search page and join them
 *  without an invite. */
export function ServerBrowserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const refreshServers = useChatStore((s) => s.refreshServers)
  const selectServer = useChatStore((s) => s.selectServer)
  const { toast } = useToast()

  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [sort, setSort] = useState<Sort>('members')
  const [servers, setServers] = useState<BrowseServer[]>([])
  const [offset, setOffset] = useState(0)
  const [exhausted, setExhausted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [joiningId, setJoiningId] = useState<string | null>(null)
  // server email gate: verify in place, then retry the blocked join
  const [emailVerifyOpen, setEmailVerifyOpen] = useState(false)
  const [pendingJoin, setPendingJoin] = useState<BrowseServer | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reqRef = useRef(0)

  // reset the whole surface whenever the dialog opens (render-phase adjustment)
  const [prevOpen, setPrevOpen] = useState(false)
  if (prevOpen !== open) {
    setPrevOpen(open)
    reqRef.current++
    if (open) {
      setQuery('')
      setDebounced('')
      setSort('members')
      setServers([])
      setOffset(0)
      setExhausted(false)
      setLoading(false)
      setLoadingMore(false)
      setJoiningId(null)
    }
  }

  // debounced search: empty query lists every public server I have not joined
  useEffect(() => {
    if (!open) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebounced(query.trim()), 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [open, query])

  // first page for the current query + sort (stale responses are dropped)
  useEffect(() => {
    if (!open) return
    const id = ++reqRef.current
    setLoading(true)
    browseServers(debounced, sort, 0)
      .then((rows) => {
        if (id !== reqRef.current) return
        setServers(rows)
        setOffset(0)
        setExhausted(rows.length < PAGE_SIZE)
      })
      .catch(() => {
        if (id !== reqRef.current) return
        setServers([])
        setExhausted(true)
      })
      .finally(() => {
        if (id === reqRef.current) setLoading(false)
      })
  }, [open, debounced, sort])

  async function loadMore() {
    if (loadingMore || loading) return
    const id = ++reqRef.current
    setLoadingMore(true)
    try {
      const rows = await browseServers(debounced, sort, offset + PAGE_SIZE)
      if (id === reqRef.current) {
        setServers((prev) => [...prev, ...rows])
        setOffset(offset + PAGE_SIZE)
        setExhausted(rows.length < PAGE_SIZE)
      }
    } catch {
      // keep the current page; the button stays for another try
    } finally {
      if (id === reqRef.current) setLoadingMore(false)
    }
  }

  async function join(server: BrowseServer) {
    if (joiningId) return
    setJoiningId(server.id)
    try {
      // alreadyMember still lands us in the server
      await apiClient.joinServerById(server.id)
      sounds.play('lightTick')
      onOpenChange(false)
      await refreshServers()
      await selectServer(server.id)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EMAIL_REQUIRED') {
        setPendingJoin(server)
        setEmailVerifyOpen(true)
      } else {
        toast({
          title: 'could not join',
          description: err instanceof ApiError ? err.message : 'something went wrong. try again.',
        })
      }
      setJoiningId(null)
    }
  }

  const showSkeletons = loading && servers.length === 0
  const showEmpty = !loading && !loadingMore && servers.length === 0

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-4xl sm:max-w-4xl h-[80vh] p-0 gap-0 border-border bg-app-sidebar overflow-hidden rounded-sm flex flex-col"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">discover servers</DialogTitle>

        {/* header: title + big search + sort chips */}
        <div className="shrink-0 px-4 pt-4 pb-3 border-b border-white/10 space-y-3">
          <div className="flex items-center gap-2.5">
            <Compass className="size-4 text-muted-foreground shrink-0" />
            <h2 className="text-sm font-bold tracking-tight">discover servers</h2>
            {loading ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search public servers"
              className="w-full bg-app-raise border border-white/10 rounded-sm pl-9 pr-3 py-2 text-sm outline-none focus:border-hyper/60 transition-colors placeholder:text-muted-foreground"
              aria-label="search public servers"
            />
          </div>
          <div className="flex gap-1" role="radiogroup" aria-label="sort servers">
            {SORTS.map((option) => {
              const active = sort === option.key
              return (
                <button
                  key={option.key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    if (active) return
                    sounds.play('lightTick')
                    setSort(option.key)
                  }}
                  className={cn(
                    'px-2.5 py-1 text-[11px] font-semibold rounded-sm border whitespace-nowrap transition-colors',
                    active
                      ? 'bg-hyper/15 border-hyper/60 text-hyper'
                      : 'border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25'
                  )}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* card grid */}
        <div className="flex-1 min-h-0 overflow-y-auto scroll-thin px-4 py-4">
          {showSkeletons && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" aria-hidden="true">
              {Array.from({ length: 6 }, (_, i) => (
                <ServerCardSkeleton key={i} />
              ))}
            </div>
          )}

          {showEmpty && (
            <div className="h-full grid place-items-center">
              <p className="text-xs text-muted-foreground">
                {debounced ? 'no servers match' : 'no public servers yet'}
              </p>
            </div>
          )}

          {servers.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {servers.map((s) => (
                <article
                  key={s.id}
                  className="item-in rounded-sm border border-white/10 bg-app-raise overflow-hidden hover:border-white/25 transition-colors"
                >
                  <div className="relative">
                    <div
                      className="h-24 bg-[#1a1a1a]"
                      style={s.bannerColor ? { backgroundColor: s.bannerColor } : undefined}
                    />
                    <div className="absolute left-3 top-24 -translate-y-1/2">
                      <Avatar
                        name={s.name}
                        color={colorForName(s.name)}
                        url={s.iconUrl}
                        size="lg"
                        className="rounded-full ring-2 ring-app-chat"
                      />
                    </div>
                  </div>
                  <div className="px-3 pt-8 pb-3">
                    <p className="text-sm font-bold truncate" title={s.name}>
                      {s.name}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                      {s.description || 'no description'}
                    </p>
                    <div className="mt-2.5 flex items-center justify-between gap-2">
                      <span
                        className="flex items-center gap-1 text-xs text-muted-foreground"
                        title={`${s.memberCount} members`}
                      >
                        <Users className="size-3" />
                        {s.memberCount}
                      </span>
                      <button
                        type="button"
                        onClick={() => void join(s)}
                        disabled={joiningId === s.id}
                        className="px-3 py-1.5 text-xs font-semibold rounded-sm border border-white/15 hover:border-hyper/60 hover:text-hyper press transition-colors disabled:opacity-60 shrink-0"
                        aria-label={`join ${s.name}`}
                      >
                        {joiningId === s.id ? <Spinner className="size-3.5" /> : 'join'}
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}

          {servers.length > 0 && !exhausted && (
            <div className="flex justify-center pt-4">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="px-4 py-1.5 text-xs font-semibold rounded-sm border border-white/15 hover:border-hyper/60 hover:text-hyper press transition-colors disabled:opacity-60"
              >
                {loadingMore ? <Spinner className="size-3.5" /> : 'load more'}
              </button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
    <EmailVerifyDialog
      open={emailVerifyOpen}
      onOpenChange={setEmailVerifyOpen}
      reason="join"
      onVerified={() => {
        if (pendingJoin) {
          const target = pendingJoin
          setPendingJoin(null)
          void join(target)
        }
      }}
    />
    </>
  )
}
