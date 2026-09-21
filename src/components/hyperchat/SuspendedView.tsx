'use client'

import { useChatStore } from '@/lib/client/store'
import { HyperionMark } from '@/components/hyperion/Logo'
import { ShieldOff } from 'lucide-react'

/** Full-screen state for suspended accounts: the session cookie is dead,
 *  sockets are closed, and there is nothing to browse. */
export default function SuspendedView() {
  const suspension = useChatStore((s) => s.suspension)
  const doLogout = useChatStore((s) => s.doLogout)

  const until = suspension?.until ? new Date(suspension.until) : null
  const permanent = !!until && until.getFullYear() > 2900
  const untilText = until
    ? permanent
      ? 'permanently'
      : until.getTime() > Date.now()
        ? `until ${until.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}`
        : 'the ban has already expired. try signing in again'
    : 'permanently'

  return (
    <div className="min-h-screen bg-background grid place-items-center px-6">
      <div className="flex flex-col items-center gap-5 max-w-md text-center">
        <div className="flex items-center gap-3">
          <HyperionMark className="w-8 h-8 opacity-40" />
          <span className="text-sm font-bold tracking-tight text-muted-foreground">Hyperion</span>
        </div>
        <ShieldOff className="size-10 text-destructive" />
        <h1 className="text-2xl font-bold tracking-tight">Account suspended</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          This account {untilText}.
          {suspension?.reason ? ` Reason: ${suspension.reason}` : ''}
        </p>
        <button
          onClick={() => void doLogout()}
          className="px-5 py-2 text-sm font-semibold rounded-sm border border-white/15 hover:bg-accent transition-colors press"
        >
          sign out
        </button>
      </div>
    </div>
  )
}
