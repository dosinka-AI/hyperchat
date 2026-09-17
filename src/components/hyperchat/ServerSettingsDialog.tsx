'use client'

import { useEffect, useRef, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { apiClient, ApiError } from '@/lib/client/api'
import { sounds } from '@/lib/client/sounds'
import { GRANULAR_PERMS, PERM, PERM_DESCRIPTIONS, PERM_LABELS, ROLE_COLORS, hasPerm, permCount } from '@/lib/perm'
import type { AuditEventSummary, BanSummary, RoleSummary } from '@/lib/types'
import { Avatar } from './Avatar'
import { confirmDialog, promptDialog } from './ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import {
  Crown,
  Shield,
  ShieldOff,
  UserMinus,
  Ban,
  RefreshCw,
  Copy,
  ImagePlus,
  Gavel,
  ScrollText,
  ArrowUp,
  ArrowDown,
  Hash,
  Plus,
  Tag,
  Clock,
  Trash2,
  ShieldAlert,
  Lock,
  Slash,
  Smile,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type Tab = 'overview' | 'roles' | 'channels' | 'members' | 'emoji' | 'bans' | 'moderation' | 'audit'

/** Stable empty list for the server-emoji selector fallback (a fresh []
 *  there breaks getSnapshot caching). */
const EMPTY_SERVER_EMOJI: { id: string; name: string; url: string }[] = []

/** Solid banner tints for the swatch row (flat colors only). */
const BANNER_SWATCHES = ['#547cff', '#23a55a', '#f0b232', '#f23f43', '#b45cff', '#2ec4b6', '#ff7a59', '#8a8a8a'] as const

const AUDIT_LABELS: Record<string, string> = {
  member_join: 'joined the server',
  member_leave: 'left the server',
  member_kick: 'kicked',
  member_ban: 'banned',
  member_unban: 'unbanned',
  member_timeout: 'timed out',
  timeout_clear: 'removed a timeout from',
  role_change: 'changed a rank',
  role_create: 'created a role',
  role_update: 'updated a role',
  role_delete: 'deleted a role',
  role_assign: 'set a role on',
  nickname_change: 'changed a nickname',
  channel_create: 'created a channel',
  channel_delete: 'deleted a channel',
  channel_update: 'updated a channel',
  channel_purge: 'purged messages in',
  message_delete: 'deleted a message from',
  category_create: 'created a category',
  category_delete: 'deleted a category',
  server_update: 'updated the server',
}

const TIMEOUT_CHOICES: { minutes: number; label: string }[] = [
  { minutes: 1, label: '1m' },
  { minutes: 5, label: '5m' },
  { minutes: 10, label: '10m' },
  { minutes: 60, label: '1h' },
  { minutes: 1440, label: '1d' },
  { minutes: 10080, label: '7d' },
]

/** Compact custom-minutes input shown next to the timeout preset chips. */
function CustomTimeoutInput({ onApply }: { onApply: (minutes: number) => void }) {
  const [value, setValue] = useState('')
  const minutes = (() => {
    const n = Number(value)
    return Number.isFinite(n) && n >= 1 && n <= 10080 ? Math.round(n) : null
  })()
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        min={1}
        max={10080}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="min"
        className="w-14 bg-transparent border border-white/10 rounded-sm px-1.5 py-1 text-[11px] outline-none focus:border-hyper/60"
        aria-label="custom timeout minutes"
      />
      <button
        disabled={minutes === null}
        onClick={() => {
          if (minutes !== null) {
            onApply(minutes)
            setValue('')
          }
        }}
        className="px-2 py-1 text-[11px] font-semibold rounded-sm border border-hyper/50 text-hyper hover:bg-hyper/10 transition-colors disabled:opacity-40 disabled:border-white/10 disabled:text-muted-foreground"
      >
        set
      </button>
    </span>
  )
}

function relativeTimeOf(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function ServerSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const me = useChatStore((s) => s.me)
  const servers = useChatStore((s) => s.servers)
  const activeServerId = useChatStore((s) => s.activeServerId)
  const serverMembers = useChatStore((s) => s.serverMembers)
  const serverRoles = useChatStore((s) => s.serverRoles)
  const updateServer = useChatStore((s) => s.updateServer)
  const setMemberRole = useChatStore((s) => s.setMemberRole)
  const setMemberCustomRole = useChatStore((s) => s.setMemberCustomRole)
  const setMemberNickname = useChatStore((s) => s.setMemberNickname)
  const timeoutMember = useChatStore((s) => s.timeoutMember)
  const kickMember = useChatStore((s) => s.kickMember)
  const banMember = useChatStore((s) => s.banMember)
  const unbanUser = useChatStore((s) => s.unbanUser)
  const moveChannel = useChatStore((s) => s.moveChannel)
  const createRole = useChatStore((s) => s.createRole)
  const updateRole = useChatStore((s) => s.updateRole)
  const deleteRole = useChatStore((s) => s.deleteRole)
  const refreshServers = useChatStore((s) => s.refreshServers)
  const { toast } = useToast()

  const server = servers.find((s) => s.id === activeServerId)
  const members = activeServerId ? serverMembers[activeServerId] ?? [] : []
  const roles = activeServerId ? serverRoles[activeServerId] ?? [] : []
  const myPerms = server?.myPerms ?? 0
  const isOwner = server?.myRole === 'OWNER'
  const canManageRoles = hasPerm(myPerms, PERM.MANAGE_ROLES)
  const canBan = hasPerm(myPerms, PERM.BAN_MEMBERS)
  const canManageServer = hasPerm(myPerms, PERM.MANAGE_SERVER)
  const canTimeout = hasPerm(myPerms, PERM.TIMEOUT_MEMBERS)
  const canNick = hasPerm(myPerms, PERM.MANAGE_NICKNAMES)

  const [tab, setTab] = useState<Tab>('overview')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [inviteCode, setInviteCode] = useState('')
  const [bans, setBans] = useState<BanSummary[]>([])
  const [audit, setAudit] = useState<AuditEventSummary[]>([])
  const [blockedWords, setBlockedWords] = useState('')
  const [visibility, setVisibility] = useState<'PRIVATE' | 'PUBLIC'>('PRIVATE')
  const [banner, setBanner] = useState<string | null>(null)
  const [hexDraft, setHexDraft] = useState('')
  const iconFileRef = useRef<HTMLInputElement>(null)

  // role editor state
  const [editingRole, setEditingRole] = useState<RoleSummary | null>(null)
  const [roleName, setRoleName] = useState('')
  const [roleColor, setRoleColor] = useState(ROLE_COLORS[0])
  const [rolePerms, setRolePerms] = useState(0)
  const [roleSaving, setRoleSaving] = useState(false)
  const [creatingRole, setCreatingRole] = useState(false)

  // nickname inline editor
  const [nickEditId, setNickEditId] = useState<string | null>(null)
  const [nickDraft, setNickDraft] = useState('')

  useEffect(() => {
    if (open && server) {
      setName(server.name)
      setDescription(server.description)
      setInviteCode(server.inviteCode)
      setBanner(server.bannerColor)
      setHexDraft(server.bannerColor ?? '')
      setTab('overview')
      setEditingRole(null)
      setCreatingRole(false)
      // load blocked words + visibility through the detail endpoint
      void apiClient
        .serverDetail(server.id)
        .then((d) => {
          setBlockedWords(d.server.blockedWords)
          const v = (d as { visibility?: 'PRIVATE' | 'PUBLIC' }).visibility
          setVisibility(v === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE')
        })
        .catch(() => {
          setBlockedWords('')
          setVisibility('PRIVATE')
        })
    }
  }, [open, server?.id])

  useEffect(() => {
    if (open && tab === 'bans' && activeServerId) {
      void apiClient
        .bans(activeServerId)
        .then((res) => setBans(res.bans))
        .catch(() => setBans([]))
    }
  }, [open, tab, activeServerId])

  useEffect(() => {
    if (open && tab === 'audit' && activeServerId) {
      void apiClient
        .serverEvents(activeServerId)
        .then((res) => setAudit(res.events))
        .catch(() => setAudit([]))
    }
  }, [open, tab, activeServerId])

  if (!server || !me) return null
  const srv = server

  async function save() {
    setSaving(true)
    try {
      await updateServer(srv.id, { name: name.trim(), description: description.trim() })
      sounds.play('midTick')
      toast({ title: 'server saved' })
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not save',
        description: err instanceof ApiError ? err.message : 'something went wrong. try again.',
      })
    } finally {
      setSaving(false)
    }
  }

  async function saveBlockedWords() {
    setSaving(true)
    try {
      await updateServer(srv.id, { blockedWords })
      sounds.play('midTick')
      toast({ title: 'automod words saved' })
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not save',
        description: err instanceof ApiError ? err.message : 'something went wrong. try again.',
      })
    } finally {
      setSaving(false)
    }
  }

  /** Optimistically flip PRIVATE/PUBLIC; revert + toast when the PATCH fails. */
  async function setServerVisibility(next: 'PRIVATE' | 'PUBLIC') {
    if (!srv || next === visibility) return
    const prev = visibility
    setVisibility(next)
    sounds.play('lightTick')
    try {
      await apiClient.updateServer(srv.id, { visibility: next })
    } catch {
      setVisibility(prev)
      toast({ title: 'could not update' })
    }
  }

  /** Optimistically set the server banner color (shown on discover cards
   *  and invite embeds); revert + toast when the PATCH fails. */
  async function applyBanner(next: string | null) {
    if (!srv) return
    const clean = next ? next.trim().toLowerCase() : null
    if (clean === banner || (clean && !/^#[0-9a-f]{6}$/.test(clean))) return
    const prev = banner
    setBanner(clean)
    setHexDraft(clean ?? '')
    sounds.play('lightTick')
    try {
      await apiClient.updateServer(srv.id, { bannerColor: clean })
      await refreshServers()
    } catch {
      setBanner(prev)
      setHexDraft(prev ?? '')
      toast({ title: 'could not update' })
    }
  }

  async function regenerateInvite() {
    try {
      await updateServer(srv.id, { regenerateInvite: true })
      const fresh = useChatStore.getState().servers.find((s) => s.id === srv.id)
      if (fresh) setInviteCode(fresh.inviteCode)
      sounds.play('glassTick')
      toast({ title: 'invite code regenerated', description: 'the old code no longer works.' })
    } catch (err) {
      toast({ title: 'could not regenerate', description: err instanceof ApiError ? err.message : '' })
    }
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteCode)
      sounds.play('glassTick')
      toast({ title: 'invite code copied' })
    } catch {
      toast({ title: 'copy failed', description: 'select the code and copy it manually.' })
    }
  }

  async function uploadIcon(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
      toast({ title: 'unsupported file', description: 'only PNG, JPEG, GIF, and WebP images are allowed.' })
      return
    }
    try {
      const res = await apiClient.uploadImage(file)
      await updateServer(srv.id, { iconUrl: res.url })
      sounds.play('glassTick')
      toast({ title: 'server icon updated' })
    } catch {
      sounds.play('error')
      toast({ title: 'could not update icon' })
    }
  }

  function startRoleEdit(role: RoleSummary | null) {
    setEditingRole(role)
    setCreatingRole(role === null)
    setRoleName(role?.name ?? '')
    setRoleColor(role?.color ?? ROLE_COLORS[0])
    setRolePerms(role?.permissions ?? 0)
  }

  async function saveRole() {
    if (!activeServerId) return
    setRoleSaving(true)
    try {
      if (creatingRole) {
        await createRole(activeServerId, { name: roleName.trim() || 'new role', color: roleColor, permissions: rolePerms })
        toast({ title: 'role created' })
      } else if (editingRole) {
        await updateRole(activeServerId, editingRole.id, {
          name: roleName.trim() || editingRole.name,
          color: roleColor,
          permissions: rolePerms,
        })
        toast({ title: 'role saved' })
      }
      sounds.play('midTick')
      setEditingRole(null)
      setCreatingRole(false)
    } catch (err) {
      sounds.play('error')
      toast({ title: 'could not save role', description: err instanceof ApiError ? err.message : '' })
    } finally {
      setRoleSaving(false)
    }
  }

  async function moveRole(role: RoleSummary, direction: 1 | -1) {
    if (!activeServerId) return
    try {
      await updateRole(activeServerId, role.id, { direction })
      sounds.play('lightTick')
    } catch {
      toast({ title: 'could not move role' })
    }
  }

  async function removeRole(role: RoleSummary) {
    if (!activeServerId) return
    const yes = await confirmDialog({
      title: `delete the ${role.name} role?`,
      body: 'members keeping it fall back to the default permissions.',
      tone: 'danger',
      confirmLabel: 'delete role',
    })
    if (!yes) return
    try {
      await deleteRole(activeServerId, role.id)
      sounds.play('urgent')
      toast({ title: 'role deleted' })
      if (editingRole?.id === role.id) {
        setEditingRole(null)
        setCreatingRole(false)
      }
    } catch (err) {
      toast({ title: 'could not delete role', description: err instanceof ApiError ? err.message : '' })
    }
  }

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: 'overview' },
    ...(canManageRoles ? [{ key: 'roles' as Tab, label: 'roles' }] : []),
    { key: 'channels', label: 'channels' },
    { key: 'members', label: `members (${members.length})` },
    { key: 'emoji', label: 'emoji' },
    ...(canBan ? [{ key: 'bans' as Tab, label: 'bans' }] : []),
    ...(canManageServer ? [{ key: 'moderation' as Tab, label: 'moderation' }] : []),
    ...(canManageServer || hasPerm(myPerms, PERM.MANAGE_MESSAGES) ? [{ key: 'audit' as Tab, label: 'audit log' }] : []),
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-none sm:max-w-none w-[min(96vw,1500px)] h-[min(90vh,900px)] top-[5vh] translate-y-0 p-0 border-border bg-app-sidebar overflow-hidden rounded-sm flex flex-col"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">{server.name} settings</DialogTitle>

        {/* live banner strip preview */}
        <div
          className="h-2.5 shrink-0 bg-app-raise border-b border-white/10"
          style={banner ? { backgroundColor: banner } : undefined}
        />

        {/* header with tabs */}
        <div className="px-5 pt-5 pb-0 shrink-0">
          <div className="flex items-center gap-3">
            {server.iconUrl ? (
               
              <img src={server.iconUrl} alt="" className="size-10 rounded-sm object-cover border border-white/10" />
            ) : (
              <div className="size-10 rounded-sm bg-app-raise grid place-items-center text-sm font-extrabold tracking-tight border border-white/10">
                {server.name.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <h2 className="text-base font-extrabold tracking-tight truncate">{server.name}</h2>
              <p className="text-xs text-muted-foreground">server settings</p>
            </div>
          </div>

          <div className="flex gap-1 mt-4 border-b border-white/10 overflow-x-auto scroll-thin">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => {
                  setTab(t.key)
                  if (t.key !== 'roles') {
                    setEditingRole(null)
                    setCreatingRole(false)
                  }
                }}
                className={cn(
                  'px-3 py-2 text-xs font-bold tracking-wide tabular-nums transition-colors border-b-2 -mb-px shrink-0',
                  tab === t.key ? 'border-white text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* fixed-height scroll body: switching tabs never re-centers the dialog.
         *  the members + emoji grids use the full near-fullscreen canvas; the
         *  form/list tabs keep a capped column so inputs stay a sane width. */}
        <div
          className={cn(
            'flex-1 overflow-y-auto scroll-thin px-5 py-5',
            tab !== 'members' && tab !== 'emoji' && 'max-w-3xl'
          )}
        >
          {tab === 'overview' && (
            <div className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="serverName">server name</Label>
                <Input id="serverName" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className="rounded-sm" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="serverDescription">description</Label>
                <Textarea
                  id="serverDescription"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="what is this server about?"
                  maxLength={300}
                  rows={3}
                  className="rounded-sm resize-none"
                />
                <p className="text-[11px] text-muted-foreground">{description.length}/300</p>
              </div>

              <div className="space-y-1.5">
                <Label>server icon</Label>
                <div className="flex items-center gap-3">
                  {server.iconUrl ? (
                     
                    <img src={server.iconUrl} alt="" className="size-12 rounded-sm object-cover border border-white/10" />
                  ) : (
                    <div className="size-12 rounded-sm bg-app-raise grid place-items-center text-base font-extrabold border border-white/10">
                      {server.name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <input
                    ref={iconFileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    className="hidden"
                    onChange={uploadIcon}
                    aria-hidden="true"
                  />
                  <Button variant="outline" size="sm" className="rounded-sm" onClick={() => iconFileRef.current?.click()}>
                    <ImagePlus className="size-4" />
                    change icon
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>invite code</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-app-raise border border-white/10 rounded-sm px-3 py-2 text-sm font-bold tracking-widest">
                    {inviteCode}
                  </code>
                  <Button variant="outline" size="sm" className="rounded-sm" onClick={() => void copyInvite()}>
                    <Copy className="size-4" />
                    copy
                  </Button>
                  {isOwner && (
                    <Button variant="outline" size="sm" className="rounded-sm" onClick={() => void regenerateInvite()}>
                      <RefreshCw className="size-4" />
                      new code
                    </Button>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  anyone with this code can join{bans.length > 0 ? ', unless banned' : ''}.
                </p>
              </div>

              {canManageServer && (
                <div className="space-y-1.5">
                  <Label>server visibility</Label>
                  <div className="grid grid-cols-2 bg-app-raise p-1 rounded-sm" role="radiogroup" aria-label="server visibility">
                    {(['PRIVATE', 'PUBLIC'] as const).map((v) => (
                      <button
                        key={v}
                        role="radio"
                        aria-checked={visibility === v}
                        onClick={() => void setServerVisibility(v)}
                        className={cn(
                          'py-1.5 text-xs rounded-sm transition-colors',
                          visibility === v
                            ? 'bg-popover font-semibold text-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {v === 'PRIVATE' ? 'private' : 'public'}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {canManageServer && (
                <div className="space-y-1.5">
                  <Label>banner color</Label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {BANNER_SWATCHES.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => void applyBanner(c)}
                        className={cn(
                          'size-6 rounded-sm border press transition-colors',
                          banner === c
                            ? 'border-white ring-1 ring-white/60'
                            : 'border-white/15 hover:border-white/40'
                        )}
                        style={{ backgroundColor: c }}
                        aria-label={`banner ${c}`}
                        aria-pressed={banner === c}
                        title={c}
                      />
                    ))}
                    <button
                      type="button"
                      onClick={() => void applyBanner(null)}
                      className={cn(
                        'size-6 rounded-sm border grid place-items-center press transition-colors bg-app-raise',
                        banner === null
                          ? 'border-white text-foreground'
                          : 'border-white/15 text-muted-foreground hover:border-white/40 hover:text-foreground'
                      )}
                      aria-label="no banner color"
                      aria-pressed={banner === null}
                      title="none"
                    >
                      <Slash className="size-3" />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={banner && /^#[0-9a-fA-F]{6}$/.test(banner) ? banner : '#1a1a1a'}
                      onChange={(e) => void applyBanner(e.target.value)}
                      className="size-8 rounded-sm border border-white/15 bg-app-raise cursor-pointer p-0.5"
                      aria-label="custom banner color"
                      title="custom color"
                    />
                    <input
                      value={hexDraft}
                      onChange={(e) => setHexDraft(e.target.value)}
                      placeholder="#547cff"
                      maxLength={7}
                      spellCheck={false}
                      className="flex-1 min-w-0 bg-app-raise border border-white/10 rounded-sm px-2.5 py-1.5 text-xs font-mono outline-none focus:border-hyper/60 transition-colors placeholder:text-muted-foreground"
                      aria-label="banner color hex"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="rounded-sm press shrink-0"
                      disabled={!/^#[0-9a-fA-F]{6}$/.test(hexDraft.trim()) || hexDraft.trim().toLowerCase() === banner}
                      onClick={() => void applyBanner(hexDraft)}
                    >
                      apply
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">shown on discover cards and invite links.</p>
                </div>
              )}

              <Button size="sm" className="rounded-sm press" disabled={saving || name.trim().length < 2} onClick={() => void save()}>
                {saving ? 'saving' : 'save changes'}
              </Button>
            </div>
          )}

          {tab === 'roles' && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground leading-relaxed">
                roles layer on top of the owner / admin / member ranks. they carry a color, a spot in the member list,
                and granular permissions. the owner always has every permission.
              </p>

              <Button variant="outline" size="sm" className="rounded-sm w-full justify-center" onClick={() => startRoleEdit(null)}>
                <Plus className="size-4" />
                new role
              </Button>

              {editingRole === null && !creatingRole && roles.length === 0 && (
                <p className="text-sm text-muted-foreground py-4">no custom roles yet.</p>
              )}

              {editingRole === null && !creatingRole &&
                roles.map((role) => (
                  <button
                    key={role.id}
                    onClick={() => startRoleEdit(role)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-sm border border-white/10 hover:border-white/25 transition-colors text-left"
                  >
                    <span className="size-3.5 rounded-sm shrink-0 border border-white/20" style={{ background: role.color }} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold truncate">{role.name}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {permCount(role.permissions)} permission{permCount(role.permissions) === 1 ? '' : 's'} · {role.memberCount} member{role.memberCount === 1 ? '' : 's'}
                      </p>
                    </div>
                    <Tag className="size-4 text-muted-foreground shrink-0" />
                  </button>
                ))}

              {(editingRole !== null || creatingRole) && (
                <div className="border border-white/10 rounded-sm p-4 space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-bold">{creatingRole ? 'new role' : 'edit role'}</p>
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        setEditingRole(null)
                        setCreatingRole(false)
                      }}
                    >
                      close
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="roleName">name</Label>
                    <Input id="roleName" value={roleName} onChange={(e) => setRoleName(e.target.value)} maxLength={32} className="rounded-sm" />
                  </div>

                  <div className="space-y-1.5">
                    <Label>color</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {ROLE_COLORS.map((c) => (
                        <button
                          key={c}
                          onClick={() => setRoleColor(c)}
                          className={cn(
                            'size-7 rounded-sm border transition-transform',
                            roleColor === c ? 'border-white scale-110' : 'border-white/20 hover:scale-105'
                          )}
                          style={{ background: c }}
                          aria-label={`color ${c}`}
                          aria-pressed={roleColor === c}
                        />
                      ))}
                      <input
                        type="color"
                        value={roleColor}
                        onChange={(e) => setRoleColor(e.target.value)}
                        className="size-7 rounded-sm border border-white/20 bg-transparent cursor-pointer"
                        aria-label="custom color"
                        title="custom color"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label>permissions</Label>
                    <div className="space-y-1">
                      {GRANULAR_PERMS.map((key) => {
                        const on = (rolePerms & PERM[key]) !== 0
                        return (
                          <label
                            key={key}
                            className="flex items-start gap-2.5 px-2.5 py-2 rounded-sm hover:bg-app-raise/60 transition-colors cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={(e) =>
                                setRolePerms((p) => (e.target.checked ? p | PERM[key] : p & ~PERM[key]))
                              }
                              className="accent-hyper mt-0.5"
                              aria-label={PERM_LABELS[key]}
                            />
                            <span className="min-w-0">
                              <span className="block text-sm font-medium">{PERM_LABELS[key]}</span>
                              <span className="block text-[11px] text-muted-foreground leading-snug">{PERM_DESCRIPTIONS[key]}</span>
                            </span>
                          </label>
                        )
                      })}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {permCount(rolePerms)} of {GRANULAR_PERMS.length} granted.
                    </p>
                  </div>

                  {!creatingRole && (
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1">
                        <Button variant="outline" size="sm" className="rounded-sm px-2" onClick={() => void moveRole(editingRole!, 1)} title="move up">
                          <ArrowUp className="size-4" />
                        </Button>
                        <Button variant="outline" size="sm" className="rounded-sm px-2" onClick={() => void moveRole(editingRole!, -1)} title="move down">
                          <ArrowDown className="size-4" />
                        </Button>
                        <span className="text-[11px] text-muted-foreground ml-1">list position</span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-sm text-destructive hover:text-destructive"
                        onClick={() => void removeRole(editingRole!)}
                      >
                        <Trash2 className="size-4" />
                        delete
                      </Button>
                    </div>
                  )}

                  <Button size="sm" className="rounded-sm press" disabled={roleSaving || !roleName.trim()} onClick={() => void saveRole()}>
                    {roleSaving ? 'saving' : creatingRole ? 'create role' : 'save role'}
                  </Button>
                </div>
              )}
            </div>
          )}

          {tab === 'channels' && (
            <div className="space-y-1">
              {srv.channels.map((channel, i) => {
                const category = srv.categories.find((c) => c.id === channel.categoryId)
                return (
                  <div
                    key={channel.id}
                    className="flex items-center gap-3 px-2 py-2 rounded-sm hover:bg-app-raise/60 transition-colors"
                  >
                    <Hash className="size-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold truncate flex items-center gap-1.5">
                        {channel.name}
                        {channel.private && <Lock className="size-3 text-muted-foreground" aria-label="private" />}
                        {channel.locked && <Lock className="size-3 text-hyper" aria-label="locked" />}
                      </p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {category ? category.name : 'no category'}
                        {channel.topic ? ` · ${channel.topic}` : ''}
                        {channel.slowmodeSeconds > 0 ? ` · slowmode ${channel.slowmodeSeconds}s` : ''}
                      </p>
                    </div>
                    {hasPerm(myPerms, PERM.MANAGE_CHANNELS) && (
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-30"
                          disabled={i === 0}
                          onClick={() => {
                            sounds.play('lightTick')
                            void moveChannel(srv.id, channel.id, -1)
                          }}
                          title="move up"
                          aria-label={`move ${channel.name} up`}
                        >
                          <ArrowUp className="size-4" />
                        </button>
                        <button
                          className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-30"
                          disabled={i === srv.channels.length - 1}
                          onClick={() => {
                            sounds.play('lightTick')
                            void moveChannel(srv.id, channel.id, 1)
                          }}
                          title="move down"
                          aria-label={`move ${channel.name} down`}
                        >
                          <ArrowDown className="size-4" />
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {tab === 'members' && (
            <div className="grid grid-cols-1 gap-y-1 items-start xl:grid-cols-2 xl:gap-x-8">
              {members.map((m) => {
                const isSelf = m.id === me.id
                const isTargetOwner = m.role === 'OWNER'
                const isAdmin = m.role === 'ADMIN'
                const timedOut = m.timeoutUntil ? new Date(m.timeoutUntil).getTime() > Date.now() : false
                const showRankButton = !isTargetOwner && !isSelf && isOwner
                const showKickBan = !isTargetOwner && !isSelf && (isOwner || (isAdmin ? false : hasPerm(myPerms, PERM.KICK_MEMBERS)))
                const showTimeout = !isTargetOwner && !isSelf && canTimeout && (isOwner || !isAdmin)
                const showRoleSelect = !isTargetOwner && !isSelf && canManageRoles
                const showNick = isSelf || (!isTargetOwner && canNick)
                return (
                  <div key={m.id} className="px-2 py-2 rounded-sm hover:bg-app-raise/60 transition-colors">
                    <div className="flex items-center gap-3">
                      <Avatar name={m.username} color={m.avatarColor} url={m.avatarUrl} size="md" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold truncate flex items-center gap-1.5" style={m.roleColor ? { color: m.roleColor } : undefined}>
                          {m.nickname || m.displayName || m.username}
                          {isTargetOwner && <Crown className="size-3 text-white/80" />}
                          {isAdmin && <Shield className="size-3 text-muted-foreground" />}
                          {timedOut && <Clock className="size-3 text-destructive" aria-label="timed out" />}
                          {isSelf && <span className="text-[10px] text-muted-foreground">you</span>}
                        </p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          @{m.username}
                          {m.roleName ? ` · ${m.roleName}` : ''}
                        </p>
                      </div>

                      <div className="flex items-center gap-0.5 shrink-0">
                        {showRankButton && (
                          <button
                            className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                            onClick={() => {
                              void setMemberRole(server.id, m.id, isAdmin ? 'MEMBER' : 'ADMIN')
                              sounds.play('midTick')
                            }}
                            title={isAdmin ? 'demote to member' : 'promote to admin'}
                            aria-label={isAdmin ? `demote ${m.username} to member` : `promote ${m.username} to admin`}
                          >
                            {isAdmin ? <ShieldOff className="size-4" /> : <Shield className="size-4" />}
                          </button>
                        )}
                        {showKickBan && (
                          <>
                            <button
                              className="p-1.5 rounded-sm text-muted-foreground hover:text-destructive hover:bg-accent transition-colors"
                              onClick={() => {
                                void (async () => {
                                  const reason = await promptDialog({
                                    title: `kick ${m.username}?`,
                                    body: 'they can rejoin with an invite. add a reason for the audit log.',
                                    tone: 'warning',
                                    placeholder: 'reason (optional)',
                                    optional: true,
                                    confirmLabel: 'kick',
                                  })
                                  if (reason === null) return
                                  void kickMember(server.id, m.id, reason || undefined)
                                  sounds.play('urgent')
                                })()
                              }}
                              title="kick member"
                              aria-label={`kick ${m.username}`}
                            >
                              <UserMinus className="size-4" />
                            </button>
                            {canBan && (
                              <button
                                className="p-1.5 rounded-sm text-muted-foreground hover:text-destructive hover:bg-accent transition-colors"
                                onClick={() => {
                                  void (async () => {
                                    const reason = await promptDialog({
                                      title: `ban ${m.username} permanently?`,
                                      body: 'they cannot rejoin unless unbanned. add a reason for the audit log.',
                                      tone: 'danger',
                                      placeholder: 'reason (optional)',
                                      optional: true,
                                      confirmLabel: 'ban',
                                    })
                                    if (reason === null) return
                                    void banMember(server.id, m.id, reason || undefined)
                                    sounds.play('urgent2')
                                  })()
                                }}
                                title="ban member"
                                aria-label={`ban ${m.username}`}
                              >
                                <Ban className="size-4" />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {(showTimeout || showRoleSelect || showNick) && (
                      <div className="flex items-center flex-wrap gap-1.5 mt-1.5 pl-12">
                        {showNick && (
                          <button
                            className="px-2 py-1 text-[11px] font-semibold rounded-sm border border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25 transition-colors"
                            onClick={() => {
                              setNickEditId(m.id)
                              setNickDraft(m.nickname ?? '')
                            }}
                          >
                            <Tag className="size-3 inline mr-1" />
                            {m.nickname ? 'nickname' : 'set nickname'}
                          </button>
                        )}
                        {showRoleSelect && (
                          <select
                            value={m.roleId ?? ''}
                            onChange={(e) => void setMemberCustomRole(server.id, m.id, e.target.value || null)}
                            className="px-2 py-1 text-[11px] font-semibold rounded-sm border border-white/10 bg-app-raise outline-none focus:border-hyper/50 max-w-36"
                            aria-label={`role for ${m.username}`}
                          >
                            <option value="">no custom role</option>
                            {roles.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                          </select>
                        )}
                        {showTimeout && TIMEOUT_CHOICES.map((c) => (
                          <button
                            key={c.minutes}
                            className="px-2 py-1 text-[11px] font-semibold rounded-sm border border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25 transition-colors"
                            onClick={() => {
                              void timeoutMember(server.id, m.id, c.minutes)
                              sounds.play('midTick')
                            }}
                            title={`timeout for ${c.label}`}
                          >
                            <Clock className="size-3 inline mr-0.5" />
                            {c.label}
                          </button>
                        ))}
                        {showTimeout && (
                          <CustomTimeoutInput onApply={(mins) => void timeoutMember(server.id, m.id, mins)} />
                        )}
                        {showTimeout && timedOut && (
                          <button
                            className="px-2 py-1 text-[11px] font-semibold rounded-sm border border-destructive/40 text-destructive hover:bg-destructive/10 transition-colors"
                            onClick={() => {
                              void timeoutMember(server.id, m.id, null)
                              sounds.play('lightTick')
                            }}
                          >
                            clear timeout
                          </button>
                        )}
                      </div>
                    )}

                    {nickEditId === m.id && (
                      <div className="flex items-center gap-2 mt-1.5 pl-12">
                        <input
                          autoFocus
                          value={nickDraft}
                          onChange={(e) => setNickDraft(e.target.value)}
                          maxLength={32}
                          placeholder="nickname in this server"
                          className="flex-1 max-w-56 bg-app-raise border border-white/10 rounded-sm px-2 py-1 text-xs outline-none focus:border-hyper/50"
                          aria-label={`nickname for ${m.username}`}
                        />
                        <Button
                          size="sm"
                          className="rounded-sm h-7 px-2 text-xs"
                          onClick={() => {
                            void setMemberNickname(server.id, m.id, nickDraft.trim() || null)
                            setNickEditId(null)
                            sounds.play('midTick')
                          }}
                        >
                          save
                        </Button>
                        <button className="text-xs text-muted-foreground hover:text-foreground px-1" onClick={() => setNickEditId(null)}>
                          cancel
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {tab === 'emoji' && <EmojiManager serverId={srv.id} serverName={srv.name} canManage={canManageServer} />}

          {tab === 'bans' && (
            <div className="space-y-1">
              {!canBan && <p className="text-xs text-muted-foreground mb-3">you need the ban members permission to manage bans.</p>}
              {bans.length === 0 && <p className="text-sm text-muted-foreground py-4">nobody is banned from this server.</p>}
              {bans.map((b) => (
                <div key={b.id} className="flex items-center gap-3 px-2 py-2 rounded-sm hover:bg-app-raise/60 transition-colors">
                  <Avatar name={b.user.username} color={b.user.avatarColor} url={b.user.avatarUrl} size="md" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold truncate flex items-center gap-1.5">
                      {b.user.displayName || b.user.username}
                      <Gavel className="size-3 text-muted-foreground" />
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      @{b.user.username}
                      {b.reason ? ` · ${b.reason}` : ''}
                    </p>
                  </div>
                  {canBan && (
                    <button
                      className="p-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                      onClick={() => {
                        void unbanUser(server.id, b.user.id).then(() => {
                          setBans((list) => list.filter((x) => x.id !== b.id))
                          sounds.play('midTick')
                        })
                      }}
                      title="lift ban"
                      aria-label={`unban ${b.user.username}`}
                    >
                      <RefreshCw className="size-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'moderation' && (
            <div className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="blockedWords" className="flex items-center gap-1.5">
                  <ShieldAlert className="size-3.5" />
                  automod: blocked words
                </Label>
                <Textarea
                  id="blockedWords"
                  value={blockedWords}
                  onChange={(e) => setBlockedWords(e.target.value)}
                  placeholder={'spam\nscam\nfree money'}
                  rows={4}
                  className="rounded-sm resize-none font-mono text-sm"
                />
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  one word or phrase per line (commas also work). messages containing any of them are rejected with an
                  error. matching ignores case. keep it to real problems: overblocking kills conversation.
                </p>
                <Button size="sm" className="rounded-sm press" disabled={saving} onClick={() => void saveBlockedWords()}>
                  {saving ? 'saving' : 'save automod'}
                </Button>
              </div>

              <div className="border border-white/10 rounded-sm p-4 space-y-2">
                <p className="text-xs font-bold tracking-wide text-muted-foreground">moderation toolkit</p>
                <ul className="text-xs text-muted-foreground leading-relaxed space-y-1.5 list-disc pl-4">
                  <li>timeouts: pick a member, choose 1m to 7d in the members tab or their profile.</li>
                  <li>slowmode: open a channel, gear icon in the header, up to 1 hour.</li>
                  <li>lock: same place, makes a channel read-only for members.</li>
                  <li>private channels: limit visibility to chosen roles.</li>
                  <li>purge: trash icon in a channel header deletes the newest messages in bulk.</li>
                  <li>@everyone pings only fire for members with the mention everyone permission.</li>
                </ul>
              </div>
            </div>
          )}

          {tab === 'audit' && (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground mb-3 flex items-center gap-1.5">
                <ScrollText className="size-3.5" />
                the official record of who did what. last 100 events.
              </p>
              {audit.length === 0 && <p className="text-sm text-muted-foreground py-4">nothing has happened yet.</p>}
              {audit.map((event) => {
                const actor = event.actor?.displayName || event.actor?.username || 'someone'
                const target = event.targetUser?.displayName || event.targetUser?.username
                const label = AUDIT_LABELS[event.type] ?? event.type
                let detail = ''
                const data = event.data as {
                  name?: string
                  reason?: string
                  role?: string
                  reordered?: boolean
                  count?: number
                  nickname?: string
                  slowmodeSeconds?: number
                  locked?: boolean
                  private?: boolean
                }
                if (data.name) detail = data.name
                if (data.role) detail = `to ${String(data.role).toLowerCase()}`
                if (data.nickname) detail = `to "${data.nickname}"`
                if (typeof data.count === 'number') detail = `${data.count} message${data.count === 1 ? '' : 's'}`
                if (data.reason) detail = detail ? `${detail}, reason: ${data.reason}` : `reason: ${data.reason}`
                if (data.reordered) detail = 'reordered the sidebar'
                return (
                  <div key={event.id} className="flex items-baseline gap-2.5 px-2 py-1.5 rounded-sm hover:bg-app-raise/60 transition-colors">
                    <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums w-14 text-right">
                      {relativeTimeOf(event.createdAt)}
                    </span>
                    <p className="text-xs leading-relaxed min-w-0">
                      <span className="font-semibold">{actor}</span>{' '}
                      <span className="text-muted-foreground">{label}</span>
                      {target && <span className="font-semibold"> {target}</span>}
                      {detail && <span className="text-muted-foreground"> · {detail}</span>}
                    </p>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Custom emoji manager: the grid of current emoji, an upload row (image is
 *  downscaled to 128px in the browser), and per-emoji removal. Picked names
 *  become :name: tokens in messages and reactions across the server. */
function EmojiManager({ serverId, serverName, canManage }: { serverId: string; serverName: string; canManage: boolean }) {
  // stable fallback: a fresh [] inside the selector breaks getSnapshot
  // caching and can loop React on servers with no emoji yet
  const emoji = useChatStore((s) => s.serverEmoji[serverId]) ?? EMPTY_SERVER_EMOJI
  const refreshServerEmoji = useChatStore((s) => s.refreshServerEmoji)
  const { toast } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)

  const [name, setName] = useState('')
  const [preview, setPreview] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)

  useEffect(() => {
    void refreshServerEmoji(serverId)
  }, [serverId, refreshServerEmoji])

  function pickFile(f: File | null) {
    if (!f) return
    if (!f.type.startsWith('image/')) {
      toast({ title: 'images only' })
      return
    }
    if (f.size > 8 * 1024 * 1024) {
      toast({ title: 'file too large', description: 'images must stay under 8 MB' })
      return
    }
    setFile(f)
    if (preview) URL.revokeObjectURL(preview)
    setPreview(URL.createObjectURL(f))
    if (!name) {
      const base = f.name.replace(/\.[a-zA-Z0-9]+$/, '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '').slice(0, 32)
      if (base.length >= 2) setName(base)
    }
  }

  function resetForm() {
    setFile(null)
    if (preview) URL.revokeObjectURL(preview)
    setPreview(null)
    setName('')
    if (fileRef.current) fileRef.current.value = ''
  }

  /** Fit inside 128px keeping the aspect ratio; GIFs pass through untouched. */
  async function shrink(file: File): Promise<Blob> {
    if (file.type === 'image/gif' || file.size <= 24 * 1024) return file
    try {
      const bitmap = await createImageBitmap(file)
      const scale = Math.min(1, 128 / Math.max(bitmap.width, bitmap.height))
      const w = Math.max(1, Math.round(bitmap.width * scale))
      const h = Math.max(1, Math.round(bitmap.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return file
      ctx.drawImage(bitmap, 0, 0, w, h)
      bitmap.close()
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      return blob && blob.size < file.size ? blob : file
    } catch {
      return file
    }
  }

  async function add() {
    const clean = name.trim().toLowerCase()
    if (!file || !/^[a-z0-9_]{2,32}$/.test(clean)) {
      toast({ title: 'pick an image and a name', description: 'names use 2-32 lowercase letters, numbers or underscores' })
      return
    }
    if (emoji.some((e) => e.name === clean)) {
      toast({ title: 'that name is taken' })
      return
    }
    setSaving(true)
    try {
      const blob = await shrink(file)
      const ext = blob.type.split('/')[1] || 'png'
      const form = new FormData()
      form.append('file', new File([blob], `emoji.${ext}`, { type: blob.type }))
      const res = await fetch('/api/upload', { method: 'POST', body: form })
      if (!res.ok) throw new Error('upload failed')
      const up = (await res.json()) as { url: string }
      await apiClient.addServerEmoji(serverId, { name: clean, url: up.url })
      await refreshServerEmoji(serverId)
      sounds.play('midTick')
      toast({ title: `:${clean}: added` })
      resetForm()
    } catch (err) {
      sounds.play('error')
      toast({ title: 'could not add emoji', description: err instanceof ApiError ? err.message : 'try again.' })
    } finally {
      setSaving(false)
    }
  }

  async function remove(id: string, emojiName: string) {
    const yes = await confirmDialog({
      title: `remove :${emojiName}:?`,
      body: 'messages and reactions using it will show its name as plain text.',
      tone: 'danger',
      confirmLabel: 'remove emoji',
    })
    if (!yes) return
    setRemovingId(id)
    try {
      await apiClient.removeServerEmoji(serverId, id)
      await refreshServerEmoji(serverId)
      sounds.play('midTick')
    } catch (err) {
      sounds.play('error')
      toast({ title: 'could not remove', description: err instanceof ApiError ? err.message : 'try again.' })
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex items-start gap-3 p-3 bg-app-raise/60 border border-white/10 rounded-sm">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="size-16 shrink-0 rounded-sm border border-dashed border-white/20 hover:border-hyper/60 grid place-items-center overflow-hidden transition-colors"
            aria-label="pick an image"
            title="pick an image"
          >
            {preview ? (
              <img src={preview} alt="new emoji preview" className="size-full object-contain p-1" />
            ) : (
              <ImagePlus className="size-5 text-muted-foreground" />
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-muted-foreground font-mono shrink-0">:</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32))}
                placeholder="name"
                className="h-8 rounded-sm font-mono text-sm flex-1 min-w-0"
                aria-label="emoji name"
                disabled={saving}
              />
              <span className="text-sm text-muted-foreground font-mono shrink-0">:</span>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" className="rounded-sm h-8" disabled={saving || !file || name.trim().length < 2} onClick={() => void add()}>
                {saving ? <Spinner /> : <Plus className="size-4" />}
                add
              </Button>
              {file && (
                <Button size="sm" variant="ghost" className="rounded-sm h-8" disabled={saving} onClick={resetForm}>
                  <X className="size-4" />
                </Button>
              )}
              <span className="text-[10px] text-muted-foreground ml-auto tabular-nums shrink-0">{emoji.length}/50</span>
            </div>
          </div>
        </div>
      )}

      {emoji.length === 0 ? (
        <div className="text-center py-8">
          <Smile className="size-6 mx-auto text-muted-foreground/50" aria-hidden="true" />
          <p className="text-sm text-muted-foreground mt-2">no custom emoji yet</p>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
          {emoji.map((e) => (
            <div
              key={e.id}
              className="group relative flex flex-col items-center gap-1 p-2 rounded-sm border border-white/10 hover:border-white/25 bg-app-raise/40 transition-colors"
            >
              <img
                src={e.url}
                alt={`:${e.name}:`}
                className="size-10 object-contain"
                loading="lazy"
                draggable={false}
              />
              <span className="text-[10px] font-mono text-muted-foreground truncate max-w-full">:{e.name}:</span>
              {canManage && (
                <button
                  onClick={() => void remove(e.id, e.name)}
                  disabled={removingId === e.id}
                  className="absolute top-1 right-1 p-1 rounded-sm text-muted-foreground bg-app-chat/80 hover:text-destructive hover:bg-destructive/15 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity disabled:opacity-40"
                  aria-label={`remove :${e.name}:`}
                  title="remove emoji"
                >
                  <Trash2 className="size-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="text-[10px] text-muted-foreground text-center">
        use <span className="font-mono">:name:</span> in {serverName}
      </p>
    </div>
  )
}
