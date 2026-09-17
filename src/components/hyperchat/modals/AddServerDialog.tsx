'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useChatStore } from '@/lib/client/store'
import { ApiError } from '@/lib/client/api'
import { useToast } from '@/hooks/use-toast'
import { Hash } from 'lucide-react'
import { sounds } from '@/lib/client/sounds'
import { EmailVerifyDialog } from '../EmailVerifyDialog'

type AddServerDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AddServerDialog({ open, onOpenChange }: AddServerDialogProps) {
  const createServer = useChatStore((s) => s.createServer)
  const joinServer = useChatStore((s) => s.joinServer)
  const selectServer = useChatStore((s) => s.selectServer)
  const { toast } = useToast()

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // server email gate: verify in place, then retry the blocked action
  const [emailVerifyOpen, setEmailVerifyOpen] = useState(false)
  const [retryAfterVerify, setRetryAfterVerify] = useState<'create' | 'join' | null>(null)

  function handleGateError(err: unknown): boolean {
    if (err instanceof ApiError && err.code === 'EMAIL_REQUIRED') {
      setRetryAfterVerify(name.trim() && !inviteCode.trim() ? 'create' : 'join')
      setEmailVerifyOpen(true)
      return true
    }
    return false
  }

  async function retryVerified() {
    if (retryAfterVerify === 'create') await handleCreate()
    if (retryAfterVerify === 'join') await handleJoin()
    setRetryAfterVerify(null)
  }

  async function handleCreate() {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      const server = await createServer(name.trim(), description.trim() || undefined)
      onOpenChange(false)
      setName('')
      setDescription('')
      await selectServer(server.id)
      sounds.play('enter')
      toast({ title: 'server created', description: `${server.name} is live with a #general channel. you are its owner.` })
    } catch (err) {
      if (!handleGateError(err)) {
        setError(err instanceof ApiError ? err.message : 'something went wrong. try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleJoin() {
    if (busy) return
    setError(null)
    setBusy(true)
    try {
      const { server, alreadyMember } = await joinServer(inviteCode.trim())
      onOpenChange(false)
      setInviteCode('')
      await selectServer(server.id)
      sounds.play('join')
      toast({
        title: alreadyMember ? 'already a member' : `joined ${server.name}`,
        description: alreadyMember ? `you already belong to ${server.name}.` : 'welcome aboard.',
      })
    } catch (err) {
      sounds.play('error')
      if (!handleGateError(err)) {
        setError(err instanceof ApiError ? err.message : 'something went wrong. try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md top-6 translate-y-0">
        <DialogHeader>
          <DialogTitle>add a server</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="create">
          <TabsList className="grid grid-cols-2 w-full">
            <TabsTrigger value="create">create</TabsTrigger>
            <TabsTrigger value="join">join</TabsTrigger>
          </TabsList>

          <TabsContent value="create" className="space-y-4 pt-2">
            <div className="flex items-center gap-3 rounded-md border border-border bg-card p-3">
              <div className="size-11 rounded-lg bg-primary/15 border border-primary/30 grid place-items-center">
                <Hash className="size-5 text-primary" />
              </div>
              <p className="text-sm text-muted-foreground">
                your server starts with a <span className="text-foreground font-medium">#general</span> channel
                and an invite code you can share.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="server-name">server name</Label>
              <Input
                id="server-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="game night, study group, the crew"
                maxLength={40}
                onKeyDown={(e) => e.key === 'Enter' && name.trim().length >= 2 && void handleCreate()}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="server-description">description, optional</Label>
              <Input
                id="server-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="what is this server about"
                maxLength={300}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button className="w-full" disabled={busy || name.trim().length < 2} onClick={() => void handleCreate()}>
              {busy && <Spinner />}
              create server
            </Button>
          </TabsContent>

          <TabsContent value="join" className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label htmlFor="invite-code">invite code</Label>
              <Input
                id="invite-code"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.trim())}
                placeholder="8 character code, like aB3xY9Km"
                maxLength={8}
                className="font-mono tracking-widest"
                onKeyDown={(e) => e.key === 'Enter' && inviteCode.trim().length >= 4 && void handleJoin()}
              />
              <p className="text-xs text-muted-foreground">
                ask a server member for the code. it is 8 characters, no spaces.
              </p>
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button className="w-full" disabled={busy || inviteCode.trim().length < 4} onClick={() => void handleJoin()}>
              {busy && <Spinner />}
              join server
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
    <EmailVerifyDialog
      open={emailVerifyOpen}
      onOpenChange={setEmailVerifyOpen}
      reason="join"
      onVerified={() => void retryVerified()}
    />
    </>
  )
}
