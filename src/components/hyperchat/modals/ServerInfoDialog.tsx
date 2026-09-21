'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useChatStore } from '@/lib/client/store'
import { apiClient } from '@/lib/client/api'
import { requestServerInfo, type ServerServiceInfo } from '@/lib/client/socket'
import { Avatar } from '../Avatar'
import { Info } from 'lucide-react'
import type { ServerDetail } from '@/lib/types'

function uptimeLabel(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** TS-style server info panel: static facts (owner, created, members,
 *  channels) plus live service stats (uptime, sockets, online accounts,
 *  people in voice) straight from the realtime service. */
export function ServerInfoDialog({
  serverId,
  open,
  onOpenChange,
}: {
  serverId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const servers = useChatStore((s) => s.servers)
  const summary = servers.find((s) => s.id === serverId) ?? null
  const [detail, setDetail] = useState<ServerDetail | null>(null)
  const [live, setLive] = useState<ServerServiceInfo | null>(null)

  useEffect(() => {
    if (!open) return
    // a previously-loaded detail stays visible while the fresh one loads
    void apiClient
      .serverDetail(serverId)
      .then(setDetail)
      .catch(() => {})
  }, [open, serverId])

  useEffect(() => {
    if (!open) return
    let alive = true
    const tick = () => {
      void requestServerInfo(serverId).then((info) => {
        if (alive) setLive(info)
      })
    }
    tick()
    const id = setInterval(tick, 5000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [open, serverId])

  const channels = detail?.channels ?? summary?.channels ?? []
  const textCount = channels.filter((c) => c.type === 'text').length
  const voiceCount = channels.filter((c) => c.type === 'voice').length
  const forumCount = channels.filter((c) => c.type === 'forum').length
  const owner = detail?.members.find((m) => m.role === 'OWNER')

  const rows: { label: string; value: string }[] = [
    { label: 'owner', value: owner ? `@${owner.username}` : 'unknown' },
    { label: 'created', value: detail ? new Date(detail.server.createdAt).toLocaleDateString() : '...' },
    {
      label: 'members',
      value: String(detail?.members.length ?? summary?.memberCount ?? 0),
    },
    {
      label: 'channels',
      value: `${textCount} text · ${voiceCount} voice${forumCount ? ` · ${forumCount} forum` : ''}`,
    },
  ]
  if (live) {
    rows.push(
      { label: 'service uptime', value: uptimeLabel(live.uptimeSec) },
      { label: 'live sockets', value: String(live.sockets) },
      { label: 'accounts online', value: String(live.onlineUsers) },
      { label: 'in voice', value: String(live.voiceParticipants) }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 lowercase">
            <Info className="size-4 text-hyper" />
            server info
          </DialogTitle>
        </DialogHeader>

        {summary && (
          <div className="flex items-center gap-3 pb-2">
            <Avatar
              name={summary.name}
              color={summary.bannerColor ?? '#2e2e2e'}
              url={summary.iconUrl}
              size="md"
            />
            <div className="min-w-0">
              <p className="text-sm font-bold truncate">{summary.name}</p>
              {summary.description && (
                <p className="text-[11px] text-muted-foreground line-clamp-2">{summary.description}</p>
              )}
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-muted-foreground">{r.label}</span>
              <span className="font-semibold tabular-nums text-right truncate">{r.value}</span>
            </div>
          ))}
          {!live && <p className="text-[11px] text-muted-foreground">live stats unavailable right now.</p>}
        </div>

        <p className="text-[11px] text-muted-foreground">
          live rows refresh every 5 seconds from the realtime service.
        </p>
      </DialogContent>
    </Dialog>
  )
}
