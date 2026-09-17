'use client'

import { useEffect, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { apiClient, ApiError } from '@/lib/client/api'
import { colorForName } from '@/lib/client/format'
import { sounds } from '@/lib/client/sounds'
import { Avatar } from './Avatar'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import { Link2Off, Users } from 'lucide-react'

export type ResolvedInvite = {
  id: string
  name: string
  description: string
  iconUrl: string | null
  bannerColor: string | null
  /** canonical casing, so joins work even when the pasted code was lowered */
  inviteCode: string
  memberCount: number
  visibility: string
}

type CacheEntry = {
  promise: Promise<ResolvedInvite | null>
  /** filled once the promise settles so remounts render synchronously */
  resolved?: ResolvedInvite | null
}

/** module-level cache: the same code pasted in many messages resolves once */
const inviteCache = new Map<string, CacheEntry>()

function resolveInvite(code: string): CacheEntry {
  const hit = inviteCache.get(code)
  if (hit) return hit
  const entry: CacheEntry = {
    promise: fetch(`/api/servers/resolve/${encodeURIComponent(code)}`)
      .then(async (res) => {
        if (!res.ok) return null
        const data = (await res.json()) as { server?: ResolvedInvite }
        return data.server ?? null
      })
      .catch(() => null),
  }
  entry.promise = entry.promise.then((value) => {
    entry.resolved = value
    return value
  })
  inviteCache.set(code, entry)
  return entry
}

/** Compact server preview rendered under message text containing
 *  hyperchat.gg/<code>. */
export function ServerInviteEmbed({ code }: { code: string }) {
  const servers = useChatStore((s) => s.servers)
  const selectServer = useChatStore((s) => s.selectServer)
  const { toast } = useToast()

  // undefined = still resolving, null = expired invite
  const [server, setServer] = useState<ResolvedInvite | null | undefined>(() =>
    resolveInvite(code).resolved
  )
  const [joining, setJoining] = useState(false)

  useEffect(() => {
    if (server !== undefined) return
    let alive = true
    void resolveInvite(code).promise.then((s) => {
      if (alive) setServer(s)
    })
    return () => {
      alive = false
    }
  }, [code])

  if (server === undefined) {
    // skeleton bar while the code resolves
    return <div className="my-1 w-full max-w-sm h-[76px] rounded-sm border border-white/10 bg-app-raise animate-pulse" />
  }

  if (server === null) {
    return (
      <span className="inline-flex items-center gap-1.5 my-1 px-2 py-1 rounded-sm border border-white/10 bg-app-raise text-[11px] text-muted-foreground">
        <Link2Off className="size-3" />
        invite expired
      </span>
    )
  }

  const joined = servers.some((s) => s.id === server.id)

  async function join() {
    if (joining) return
    const target = server
    if (!target) return
    setJoining(true)
    try {
      // join by invite code (works for private servers too), using the
      // canonical casing from the resolver; alreadyMember just means we
      // should land in the server
      const res = await apiClient.joinServer(target.inviteCode || code)
      sounds.play('lightTick')
      await useChatStore.getState().refreshServers()
      await useChatStore.getState().selectServer(res.server.id)
      setJoining(false)
    } catch (err) {
      setJoining(false)
      toast({
        title: 'could not join',
        description: err instanceof ApiError ? err.message : 'something went wrong. try again.',
      })
    }
  }

  return (
    <div className="my-1 w-full max-w-sm rounded-sm border border-white/10 bg-app-raise overflow-hidden">
      <div
        className="h-12 bg-[#1a1a1a]"
        style={server.bannerColor ? { backgroundColor: server.bannerColor } : undefined}
      />
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <Avatar
          name={server.name}
          color={colorForName(server.name)}
          url={server.iconUrl}
          size="md"
          className="rounded-full ring-2 ring-app-raise"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold truncate">{server.name}</p>
          <span
            className="flex items-center gap-1 text-[11px] text-muted-foreground"
            title={`${server.memberCount} members`}
          >
            <Users className="size-3" />
            {server.memberCount} members
          </span>
        </div>
        <button
          type="button"
          onClick={() => {
            if (joined) {
              sounds.play('lightTick')
              void selectServer(server.id)
            } else {
              void join()
            }
          }}
          disabled={joining}
          className="px-3 py-1.5 text-xs font-semibold rounded-sm border border-white/15 hover:border-hyper/60 hover:text-hyper press transition-colors disabled:opacity-60 shrink-0"
          aria-label={joined ? `open ${server.name}` : `join ${server.name}`}
        >
          {joining ? <Spinner className="size-3.5" /> : joined ? 'open' : 'join'}
        </button>
      </div>
    </div>
  )
}
