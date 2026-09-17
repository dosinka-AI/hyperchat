'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useChatStore } from '@/lib/client/store'
import { useToast } from '@/hooks/use-toast'
import { Copy, Check, RefreshCw } from 'lucide-react'
import { sounds } from '@/lib/client/sounds'
import { cn } from '@/lib/utils'

type InviteDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function InviteDialog({ open, onOpenChange }: InviteDialogProps) {
  const servers = useChatStore((s) => s.servers)
  const activeServerId = useChatStore((s) => s.activeServerId)
  const updateServer = useChatStore((s) => s.updateServer)
  const { toast } = useToast()
  const [copied, setCopied] = useState(false)
  const [shareCopied, setShareCopied] = useState(false)
  const [regenerating, setRegenerating] = useState(false)

  const server = servers.find((s) => s.id === activeServerId)
  const code = server?.inviteCode ?? ''
  const isOwner = server?.myRole === 'OWNER'

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code)
      sounds.play('glassTick')
      setCopied(true)
      toast({ title: 'invite code copied', description: 'send it to whoever should join.' })
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast({ title: 'copy failed', description: 'select the code and copy it manually.' })
    }
  }

  async function copyShareLink() {
    if (!code) return
    try {
      await navigator.clipboard.writeText(`hyperchat.gg/${code}`)
      sounds.play('glassTick')
      setShareCopied(true)
      toast({ title: 'copied' })
      setTimeout(() => setShareCopied(false), 2000)
    } catch {
      toast({ title: 'copy failed' })
    }
  }

  async function regenerate() {
    if (!activeServerId || regenerating) return
    setRegenerating(true)
    try {
      await updateServer(activeServerId, { regenerateInvite: true })
      sounds.play('glassTick')
      toast({ title: 'new invite code', description: 'the old code no longer works.' })
    } catch {
      toast({ title: 'could not regenerate' })
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>invite people to {server?.name}</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-3 rounded-sm border border-border bg-card p-4">
          <code className="flex-1 font-mono text-2xl tracking-[0.3em] text-foreground select-all text-center font-bold">
            {code || '--------'}
          </code>
          <Button variant="outline" size="icon" className="rounded-sm" onClick={() => void copyCode()} aria-label="copy invite code">
            {copied ? <Check className="size-4 text-hyper" /> : <Copy className="size-4" />}
          </Button>
          {isOwner && (
            <Button
              variant="outline"
              size="icon"
              className="rounded-sm"
              onClick={() => void regenerate()}
              disabled={regenerating}
              aria-label="regenerate invite code"
              title="generate a new code, the old one stops working"
            >
              <RefreshCw className={cn('size-4', regenerating && 'animate-spin')} />
            </Button>
          )}
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-foreground">shareable link</p>
          <button
            type="button"
            onClick={() => void copyShareLink()}
            className="w-full flex items-center justify-between gap-2 rounded-sm border border-white/10 bg-app-raise px-3 py-2 text-sm text-hyper hover:border-hyper/60 transition-colors"
            aria-label="copy shareable invite link"
            title="click to copy"
          >
            <span className="truncate font-mono">hyperchat.gg/{code || 'xxxxxxxx'}</span>
            {shareCopied ? <Check className="size-3.5 shrink-0" /> : <Copy className="size-3.5 shrink-0" />}
          </button>
          <p className="text-[11px] text-muted-foreground">click to copy. pasting it in a message shows an invite card.</p>
        </div>

        <p className="text-xs text-muted-foreground">
          treat the code like a key: anyone who has it gets in.
          {isOwner ? ' you can regenerate it anytime from here.' : ' the owner can regenerate it anytime.'}
        </p>
      </DialogContent>
    </Dialog>
  )
}
