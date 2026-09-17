'use client'

import { useEffect, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { sounds } from '@/lib/client/sounds'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import { ApiError } from '@/lib/client/api'
import { confirmDialog } from './ConfirmDialog'
import { Hash, Lock, Gauge, EyeOff, Trash2, Volume2, MessagesSquare } from 'lucide-react'
import { cn } from '@/lib/utils'

const SLOWMODE_CHOICES = [
  { value: 0, label: 'off' },
  { value: 5, label: '5 seconds' },
  { value: 10, label: '10 seconds' },
  { value: 15, label: '15 seconds' },
  { value: 30, label: '30 seconds' },
  { value: 60, label: '1 minute' },
  { value: 120, label: '2 minutes' },
  { value: 300, label: '5 minutes' },
  { value: 600, label: '10 minutes' },
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' },
]

function slowmodeLabel(seconds: number): string {
  if (seconds === 0) return 'off'
  if (seconds < 60) return `${seconds}s`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0) return `${seconds / 60}m`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function ChannelSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const servers = useChatStore((s) => s.servers)
  const activeServerId = useChatStore((s) => s.activeServerId)
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const serverRoles = useChatStore((s) => s.serverRoles)
  const updateChannel = useChatStore((s) => s.updateChannel)
  const deleteChannel = useChatStore((s) => s.deleteChannel)
  const { toast } = useToast()

  const server = servers.find((s) => s.id === activeServerId)
  const channel = server?.channels.find((c) => c.id === activeChannelId) ?? null
  const roles = activeServerId ? serverRoles[activeServerId] ?? [] : []

  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [slowmode, setSlowmode] = useState(0)
  const [slowUnit, setSlowUnit] = useState<'seconds' | 'minutes' | 'hours'>('minutes')
  const [slowCustomValue, setSlowCustomValue] = useState('')
  const slowCustomActive = slowmode > 0 && !SLOWMODE_CHOICES.some((c) => c.value === slowmode)
  const [locked, setLocked] = useState(false)
  const [privateCh, setPrivateCh] = useState(false)
  const [access, setAccess] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open && channel) {
      setName(channel.name)
      setTopic(channel.topic ?? '')
      setSlowmode(channel.slowmodeSeconds)
      // seed the custom editor when the stored value is not a preset
      if (channel.slowmodeSeconds > 0 && !SLOWMODE_CHOICES.some((c) => c.value === channel.slowmodeSeconds)) {
        const s = channel.slowmodeSeconds
        if (s % 3600 === 0) {
          setSlowUnit('hours')
          setSlowCustomValue(String(s / 3600))
        } else if (s % 60 === 0) {
          setSlowUnit('minutes')
          setSlowCustomValue(String(s / 60))
        } else {
          setSlowUnit('seconds')
          setSlowCustomValue(String(s))
        }
      }
      setLocked(channel.locked)
      setPrivateCh(channel.private)
      setAccess(channel.accessRoleIds)
    }
  }, [open, channel?.id, channel?.slowmodeSeconds, channel?.locked, channel?.private, channel?.topic, channel?.name])

  if (!channel || !server) return null

  async function save() {
    setSaving(true)
    try {
      await updateChannel(channel!.id, {
        name: name.trim(),
        topic: topic.trim() ? topic.trim() : undefined,
        slowmodeSeconds: slowmode,
        locked,
        private: privateCh,
        accessRoleIds: access,
      })
      sounds.play('midTick')
      toast({ title: 'channel saved' })
      onOpenChange(false)
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not save channel',
        description: err instanceof ApiError ? err.message : 'something went wrong. try again.',
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 border-border bg-app-sidebar overflow-hidden rounded-sm top-6 translate-y-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">settings for {channel.name}</DialogTitle>

        <div className="px-5 pt-5 pb-3 border-b border-white/10">
          <h2 className="text-base font-extrabold tracking-tight flex items-center gap-2">
            {channel.type === 'voice' ? (
              <Volume2 className="size-4 text-muted-foreground" />
            ) : channel.type === 'forum' ? (
              <MessagesSquare className="size-4 text-muted-foreground" />
            ) : (
              <Hash className="size-4 text-muted-foreground" />
            )}
            {channel.name}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">{channel.type} channel</p>
        </div>

        <div className="px-5 py-4 space-y-5 max-h-[65vh] overflow-y-auto scroll-thin">
          <div className="space-y-1.5">
            <Label htmlFor="chName">name</Label>
            <Input
              id="chName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
              className="rounded-sm"
              placeholder="channel-name"
            />
            <p className="text-[11px] text-muted-foreground">
              lowercase letters, numbers and dashes.#{name.trim() || 'channel-name'}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="chTopic">topic</Label>
            <Input
              id="chTopic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              maxLength={120}
              className="rounded-sm"
              placeholder="what is this channel about?"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              <Gauge className="size-3.5" />
              slowmode
            </Label>
            <div className="grid grid-cols-4 gap-1">
              {SLOWMODE_CHOICES.map((c) => (
                <button
                  key={c.value}
                  onClick={() => setSlowmode(c.value)}
                  className={cn(
                    'px-1 py-1.5 text-[11px] font-semibold rounded-sm border transition-colors',
                    slowmode === c.value
                      ? 'bg-hyper/20 border-hyper text-hyper'
                      : 'border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25'
                  )}
                  aria-pressed={slowmode === c.value}
                >
                  {c.label}
                </button>
              ))}
              <button
                onClick={() => {
                  setSlowmode(slowCustomActive ? slowmode : 45)
                  setSlowCustomValue(slowCustomValue || '45')
                }}
                className={cn(
                  'px-1 py-1.5 text-[11px] font-semibold rounded-sm border transition-colors',
                  slowCustomActive
                    ? 'bg-hyper/20 border-hyper text-hyper'
                    : 'border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25'
                )}
                aria-pressed={slowCustomActive}
                title="custom interval"
              >
                {slowCustomActive ? slowmodeLabel(slowmode) : 'custom'}
              </button>
            </div>
            {slowCustomActive && (
              <div className="flex items-center gap-1.5 fade-in">
                <input
                  type="number"
                  min={1}
                  value={slowCustomValue}
                  onChange={(e) => {
                    setSlowCustomValue(e.target.value)
                    const secs = e.target.value === '' ? null : (() => {
                      const n = Number(e.target.value)
                      const s = slowUnit === 'hours' ? n * 3600 : slowUnit === 'minutes' ? n * 60 : n
                      return Number.isFinite(s) && s >= 1 && s <= 21600 ? Math.round(s) : null
                    })()
                    if (secs !== null) setSlowmode(secs)
                  }}
                  className="w-20 bg-app-raise border border-white/10 rounded-sm px-2 py-1 text-xs outline-none focus:border-hyper/60"
                  aria-label="custom slowmode value"
                />
                {(['seconds', 'minutes', 'hours'] as const).map((u) => (
                  <button
                    key={u}
                    onClick={() => setSlowUnit(u)}
                    className={cn(
                      'px-2 py-1 text-[11px] font-semibold rounded-sm border transition-colors',
                      slowUnit === u
                        ? 'border-hyper/60 text-hyper'
                        : 'border-white/10 text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {u === 'seconds' ? 'sec' : u === 'minutes' ? 'min' : 'hr'}
                  </button>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              everyone except moderators waits this long between messages.
            </p>
          </div>

          <div className="flex items-start justify-between gap-3 py-1">
            <div>
              <Label className="flex items-center gap-1.5">
                <Lock className="size-3.5" />
                locked
              </Label>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                read-only for members. moderators can still post.
              </p>
            </div>
            <Switch checked={locked} onCheckedChange={setLocked} aria-label="lock channel" />
          </div>

          <div className="flex items-start justify-between gap-3 py-1">
            <div>
              <Label className="flex items-center gap-1.5">
                <EyeOff className="size-3.5" />
                private
              </Label>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                only the roles picked below can see this channel.
              </p>
            </div>
            <Switch checked={privateCh} onCheckedChange={setPrivateCh} aria-label="make channel private" />
          </div>

          {privateCh && (
            <div className="space-y-1.5 border border-white/10 rounded-sm p-3">
              <Label>who can read this channel</Label>
              {roles.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  no custom roles yet. create roles in server settings, then grant them access here.
                </p>
              )}
              <div className="space-y-1">
                {roles.map((r) => (
                  <label
                    key={r.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-app-raise/60 transition-colors cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={access.includes(r.id)}
                      onChange={(e) =>
                        setAccess((list) => (e.target.checked ? [...list, r.id] : list.filter((id) => id !== r.id)))
                      }
                      className="accent-hyper"
                      aria-label={`allow ${r.name} to read this channel`}
                    />
                    <span className="size-2.5 rounded-sm shrink-0" style={{ background: r.color }} aria-hidden="true" />
                    <span className="text-sm truncate flex-1">{r.name}</span>
                    <span className="text-[10px] text-muted-foreground">{r.memberCount}</span>
                  </label>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">moderators always see private channels.</p>
            </div>
          )}

          <div className="pt-2 border-t border-white/10">
            <Button
              variant="outline"
              size="sm"
              className="rounded-sm text-destructive hover:text-destructive w-full justify-center"
              onClick={() => {
                void (async () => {
                  if (await confirmDialog({
                    title: `delete #${channel.name}?`,
                    body: 'the channel and its messages will be gone for good. this cannot be undone.',
                    tone: 'danger',
                    confirmLabel: 'delete channel',
                  })) {
                    sounds.play('urgent')
                    void deleteChannel(channel.id)
                    onOpenChange(false)
                  }
                })()
              }}
            >
              <Trash2 className="size-4" />
              delete channel
            </Button>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-white/10 flex justify-end gap-2">
          <Button variant="ghost" size="sm" className="rounded-sm" onClick={() => onOpenChange(false)}>
            cancel
          </Button>
          <Button size="sm" className="rounded-sm press" disabled={saving || !name.trim()} onClick={() => void save()}>
            {saving ? 'saving' : 'save changes'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
