'use client'

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useChatStore } from '@/lib/client/store'
import { ApiError, apiClient } from '@/lib/client/api'
import { useToast } from '@/hooks/use-toast'
import { Hash, FolderPlus, Volume2, MessagesSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sounds } from '@/lib/client/sounds'

type CreateChannelDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  categoryMode?: boolean
  categoryId?: string | null
}

function normalize(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

export function CreateChannelDialog({ open, onOpenChange, categoryMode = false, categoryId = null }: CreateChannelDialogProps) {
  const activeServerId = useChatStore((s) => s.activeServerId)
  const servers = useChatStore((s) => s.servers)
  const createCategory = useChatStore((s) => s.createCategory)
  const { toast } = useToast()

  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [type, setType] = useState<'text' | 'voice' | 'forum'>('text')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const server = servers.find((s) => s.id === activeServerId)
  const cleanName = categoryMode ? name.trim() : normalize(name)

  async function handleCreate() {
    if (!activeServerId || busy || !cleanName) return
    setError(null)
    setBusy(true)
    try {
      if (categoryMode) {
        await createCategory(activeServerId, cleanName)
        sounds.play('midTick')
        toast({ title: 'category created', description: `${cleanName} group added to the sidebar.` })
      } else {
        await apiClient.createChannel(activeServerId, { name: cleanName, topic: topic.trim() || undefined, categoryId, type })
        await useChatStore.getState().refreshServers()
        await useChatStore.getState().refreshServerDetail(activeServerId)
        sounds.play('midTick')
        toast({ title: 'channel created', description: `#${cleanName} is ready.` })
      }
      onOpenChange(false)
      setName('')
      setTopic('')
    } catch (err) {
      sounds.play('error')
      setError(err instanceof ApiError ? err.message : 'something went wrong. try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md rounded-sm">
        <DialogHeader>
          <DialogTitle>
            {categoryMode
              ? `create a category in ${server?.name}`
              : `create a channel in ${server?.name}`}
          </DialogTitle>

        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={categoryMode ? 'category-name' : 'channel-name'}>
              {categoryMode ? 'category name' : 'channel name'}
            </Label>
            <div className="flex items-center gap-2">
              {categoryMode ? (
                <FolderPlus className="size-4 text-muted-foreground shrink-0" />
              ) : type === 'voice' ? (
                <Volume2 className="size-4 text-muted-foreground shrink-0" />
              ) : type === 'forum' ? (
                <MessagesSquare className="size-4 text-muted-foreground shrink-0" />
              ) : (
                <Hash className="size-4 text-muted-foreground shrink-0" />
              )}
              <Input
                id={categoryMode ? 'category-name' : 'channel-name'}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={categoryMode ? 'voice, gaming, staff' : 'clips, announcements, off-topic'}
                maxLength={40}
                className={cn(!categoryMode && cleanName && name !== cleanName && 'border-hyper/40')}
                onKeyDown={(e) => e.key === 'Enter' && cleanName && void handleCreate()}
              />
            </div>
            {!categoryMode && cleanName && (
              <p className="text-xs text-muted-foreground">
                will be created as <span className="text-foreground font-medium">#{cleanName}</span>
              </p>
            )}
          </div>

          {!categoryMode && (
            <div className="space-y-1.5">
              <Label>channel type</Label>
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    { value: 'text', icon: Hash, label: 'text', desc: 'chat' },
                    { value: 'voice', icon: Volume2, label: 'voice', desc: 'talk' },
                    { value: 'forum', icon: MessagesSquare, label: 'forum', desc: 'posts' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setType(opt.value)}
                    className={cn(
                      'flex flex-col items-start gap-1 rounded-sm border px-2.5 py-2 text-left transition-colors',
                      type === opt.value ? 'border-hyper/60 bg-hyper/10' : 'border-white/10 hover:border-white/25'
                    )}
                  >
                    <opt.icon className={cn('size-4', type === opt.value ? 'text-hyper' : 'text-muted-foreground')} />
                    <span className={cn('text-xs font-semibold', type === opt.value ? 'text-foreground' : 'text-muted-foreground')}>
                      {opt.label}
                    </span>
                    <span className="text-[10px] text-muted-foreground">{opt.desc}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {!categoryMode && type === 'text' && (
            <div className="space-y-1.5">
              <Label htmlFor="channel-topic">topic, optional</Label>
              <Input
                id="channel-topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="what is this channel for"
                maxLength={120}
              />
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button
            className="w-full rounded-sm"
            disabled={busy || !cleanName}
            onClick={() => void handleCreate()}
          >
            {busy && <Spinner />}
            {categoryMode ? 'create category' : 'create channel'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
