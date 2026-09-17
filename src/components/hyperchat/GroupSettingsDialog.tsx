'use client'

import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { sounds } from '@/lib/client/sounds'
import { ApiError } from '@/lib/client/api'
import { Avatar } from './Avatar'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import { confirmDialog } from './ConfirmDialog'
import { Crown, ImageOff, LogOut, Pencil, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ConversationSummary } from '@/lib/types'

type Policy = 'ALL' | 'OWNER'

/** group chat options: name, photo, member limit, and (owner only) the
 *  policies for who may edit the name/photo and add members. defaults are
 *  permissive — anyone can edit until the owner locks it down. */
export function GroupSettingsDialog({
  open,
  onOpenChange,
  conversationId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversationId: string | null
}) {
  const me = useChatStore((s) => s.me)
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === conversationId))
  const renameGroup = useChatStore((s) => s.renameGroup)
  const setGroupPhoto = useChatStore((s) => s.setGroupPhoto)
  const setGroupPolicies = useChatStore((s) => s.setGroupPolicies)
  const setGroupLimit = useChatStore((s) => s.setGroupLimit)
  const leaveGroup = useChatStore((s) => s.leaveGroup)
  const { toast } = useToast()

  const [nameDraft, setNameDraft] = useState('')
  const [nameBusy, setNameBusy] = useState(false)
  const [photoBusy, setPhotoBusy] = useState(false)
  const [policyBusy, setPolicyBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  // sync the rename draft with the live name each time it opens
  useEffect(() => {
    if (open) setNameDraft(conversation?.name ?? '')
  }, [open, conversation?.name])

  if (!conversation || conversation.kind !== 'GROUP' || !me) return null
  const c: ConversationSummary & { editPolicy?: Policy; invitePolicy?: Policy } = conversation
  const ownerId = c.ownerId ?? null
  const iAmOwner = ownerId === me.id
  const editLocked = c.editPolicy === 'OWNER' && !iAmOwner
  const members = c.participants ?? []
  const cap = c.limitRaised ? 50 : 5
  const editPolicy: Policy = c.editPolicy ?? 'ALL'
  const invitePolicy: Policy = c.invitePolicy ?? 'ALL'

  async function saveName() {
    const name = nameDraft.trim()
    if (nameBusy || !name || name === c.name) return
    setNameBusy(true)
    try {
      await renameGroup(conversationId!, name)
      sounds.play('midTick')
    } catch (err) {
      sounds.play('error')
      toast({ title: 'could not rename', description: err instanceof ApiError ? err.message : 'Try again.' })
    } finally {
      setNameBusy(false)
    }
  }

  async function pickPhoto(file: File | null) {
    if (photoBusy) return
    setPhotoBusy(true)
    try {
      await setGroupPhoto(conversationId!, file)
      sounds.play('midTick')
    } catch (err) {
      sounds.play('error')
      toast({ title: 'could not set the photo', description: err instanceof ApiError ? err.message : 'Try again.' })
    } finally {
      setPhotoBusy(false)
    }
  }

  async function applyPolicies(nextEdit: Policy, nextInvite: Policy) {
    if (policyBusy || (nextEdit === editPolicy && nextInvite === invitePolicy)) return
    setPolicyBusy(true)
    sounds.play('lightTick')
    try {
      await setGroupPolicies(conversationId!, nextEdit, nextInvite)
    } catch (err) {
      sounds.play('error')
      toast({ title: 'could not change settings', description: err instanceof ApiError ? err.message : 'Try again.' })
    } finally {
      setPolicyBusy(false)
    }
  }

  async function leave() {
    const ok = await confirmDialog({
      title: `leave ${c.name ?? 'this group'}?`,
      body: 'you will stop receiving messages from this group.',
      confirmLabel: 'leave',
    })
    if (!ok) return
    try {
      await leaveGroup(conversationId!)
      onOpenChange(false)
    } catch {
      toast({ title: 'could not leave', description: 'Try again in a moment.' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 border-border bg-app-sidebar overflow-hidden rounded-sm top-6 translate-y-0 max-h-[80vh] flex flex-col" aria-describedby={undefined}>
        <DialogTitle className="sr-only">Group settings</DialogTitle>

        <div className="px-5 pt-5 pb-3 border-b border-white/10 shrink-0">
          <h2 className="text-base font-extrabold tracking-tight truncate">{c.name ?? 'group'}</h2>
          <p className="text-xs text-muted-foreground">
            {members.length} of {cap} members{c.limitRaised ? '' : ' (owner can raise to 50)'}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto scroll-thin px-5 py-4 space-y-6">
          {/* identity: photo + name */}
          <section aria-label="group identity">
            <div className="flex items-center gap-4">
              <div className="relative shrink-0 group">
                {c.iconUrl ? (
                  <img src={c.iconUrl} alt="" className="size-14 rounded-sm object-cover border border-white/10" />
                ) : (
                  <div className="size-14 rounded-sm bg-app-raise border border-white/10 grid place-items-center text-xs font-bold text-muted-foreground">
                    {(c.name ?? 'g').slice(0, 2).toUpperCase()}
                  </div>
                )}
                {!editLocked && (
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={photoBusy}
                    className="absolute -bottom-1.5 -right-1.5 grid size-6 place-items-center rounded-sm bg-app-chat border border-white/15 text-muted-foreground hover:text-foreground hover:border-hyper/50 transition-colors"
                    aria-label="change group photo"
                    title="change group photo"
                  >
                    {photoBusy ? <Spinner className="size-3" /> : <Upload className="size-3" />}
                  </button>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  className="hidden"
                  aria-hidden="true"
                  onChange={(e) => {
                    // snapshot before the value reset clears the FileList
                    const file = e.target.files?.[0] ?? null
                    e.target.value = ''
                    if (file) void pickPhoto(file)
                  }}
                />
              </div>
              <div className="flex-1 min-w-0">
                <label className="block text-[11px] font-bold text-muted-foreground mb-1" htmlFor="gc-name">
                  name
                </label>
                <div className="flex gap-1.5">
                  <input
                    id="gc-name"
                    value={nameDraft}
                    disabled={editLocked || nameBusy}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void saveName()
                      }
                    }}
                    maxLength={60}
                    className="flex-1 min-w-0 bg-transparent border border-white/10 rounded-sm px-2 py-1.5 text-sm outline-none focus:border-hyper/60 transition-colors disabled:opacity-50"
                    placeholder="group name"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-sm shrink-0"
                    disabled={editLocked || nameBusy || nameDraft.trim().length < 2 || nameDraft.trim() === c.name}
                    onClick={() => void saveName()}
                  >
                    {nameBusy ? <Spinner className="size-3.5" /> : <Pencil className="size-3.5" />}
                    save
                  </Button>
                </div>
                {c.iconUrl && !editLocked && (
                  <button
                    type="button"
                    onClick={() => void pickPhoto(null)}
                    disabled={photoBusy}
                    className="mt-1.5 text-[11px] text-muted-foreground hover:text-destructive flex items-center gap-1 underline-offset-2 hover:underline transition-colors"
                  >
                    <ImageOff className="size-3" />
                    remove photo
                  </button>
                )}
                {editLocked && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">only the owner can rename this group or change its photo.</p>
                )}
              </div>
            </div>
          </section>

          {/* owner-only settings */}
          {iAmOwner && (
            <section aria-label="group permissions" className="rounded-sm border border-white/10 p-3 space-y-4">
              <div>
                <p className="text-[11px] font-bold text-muted-foreground mb-2">who can edit the name and photo</p>
                <PolicyToggle
                  value={editPolicy}
                  disabled={policyBusy}
                  onChange={(v) => void applyPolicies(v, invitePolicy)}
                />
              </div>
              <div>
                <p className="text-[11px] font-bold text-muted-foreground mb-2">who can add members</p>
                <PolicyToggle
                  value={invitePolicy}
                  disabled={policyBusy}
                  onChange={(v) => void applyPolicies(editPolicy, v)}
                />
              </div>
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-bold text-muted-foreground">member limit</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-sm h-7 px-2.5 text-xs"
                  disabled={policyBusy || (!c.limitRaised && members.length > 5)}
                  onClick={() => void setGroupLimit(conversationId!, !c.limitRaised).catch((err) => {
                    toast({ title: 'could not change the limit', description: err instanceof ApiError ? err.message : 'Try again.' })
                  })}
                >
                  {c.limitRaised ? '50 (lower to 5)' : '5 (raise to 50)'}
                </Button>
              </div>
            </section>
          )}

          {/* members snapshot */}
          <section aria-label="members">
            <p className="text-[11px] font-bold text-muted-foreground mb-2">members</p>
            <div className="space-y-1">
              {members.map((m) => (
                <div key={m.id} className="flex items-center gap-2.5 px-1.5 py-1 rounded-sm hover:bg-app-raise/60 transition-colors">
                  <Avatar name={m.username} color={m.avatarColor} url={m.avatarUrl} size="sm" />
                  <span className="text-sm truncate flex-1">{m.displayName || m.username}</span>
                  {m.id === ownerId && (
                    <span className="text-[10px] font-bold text-hyper flex items-center gap-1 shrink-0">
                      <Crown className="size-3" />
                      owner
                    </span>
                  )}
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="px-5 py-3 border-t border-white/10 shrink-0 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="rounded-sm text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => void leave()}
          >
            <LogOut className="size-3.5" />
            leave group
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PolicyToggle({
  value,
  disabled,
  onChange,
}: {
  value: Policy
  disabled?: boolean
  onChange: (v: Policy) => void
}) {
  const options: { key: Policy; label: string }[] = [
    { key: 'ALL', label: 'everyone' },
    { key: 'OWNER', label: 'owner only' },
  ]
  return (
    <div className="flex gap-1.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={value === o.key}
          disabled={disabled}
          onClick={() => onChange(o.key)}
          className={cn(
            'flex-1 px-2 py-1.5 text-xs font-bold rounded-sm border transition-colors disabled:opacity-50',
            value === o.key
              ? 'border-hyper/60 bg-hyper/10 text-hyper'
              : 'border-white/10 text-muted-foreground hover:text-foreground hover:bg-app-raise/60'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
