'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { apiClient, ApiError } from '@/lib/client/api'
import { sounds } from '@/lib/client/sounds'
import { extractAvatarColors } from '@/lib/client/colors'
import { formatJoinDate } from '@/lib/client/format'
import { Avatar } from './Avatar'
import { CropDialog } from './CropDialog'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useToast } from '@/hooks/use-toast'
import { X, Check, Palette, Camera, Pencil, AtSign, Shield, Ban, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'

const HEX_RE = /^#[0-9a-fA-F]{6}$/

const BANNER_SWATCHES = [
  '#547cff', // rare blue
  '#23a55a', // green
  '#f0b232', // amber
  '#f23f43', // red
  '#b45cff', // violet
  '#2ec4b6', // teal
  '#ff7a59', // coral
  '#8a8a8a', // graphite
]

/** WYSIWYG profile editor: the screen mirrors exactly how other people see
 *  your profile card (banner, avatar, name, custom status bubble, bio), except
 *  every element is live-editable in place — you type where you want change. */
export function ProfileEditor() {
  const me = useChatStore((s) => s.me)
  const profileEditorOpen = useChatStore((s) => s.profileEditorOpen)
  const setProfileEditorOpen = useChatStore((s) => s.setProfileEditorOpen)
  const updateProfile = useChatStore((s) => s.updateProfile)
  const connected = useChatStore((s) => s.connected)
  const { toast } = useToast()

  const [displayName, setDisplayName] = useState('')
  const [customStatus, setCustomStatus] = useState('')
  const [bio, setBio] = useState('')
  const [pronouns, setPronouns] = useState('')
  const [hexInput, setHexInput] = useState('')
  const [autoColors, setAutoColors] = useState<string[]>([])
  const [customColorOpen, setCustomColorOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  /** live banner tint: local-first so the color picker drags never wait on
   *  a server round trip. commits debounced; this is the lag fix. */
  const [bannerPreview, setBannerPreview] = useState<string | null | undefined>(undefined)
  const colorCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // avatar + banner crop tools
  const [cropFile, setCropFile] = useState<File | null>(null)
  const [cropMode, setCropMode] = useState<'avatar' | 'banner'>('avatar')
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [uploadingBanner, setUploadingBanner] = useState(false)
  const avatarFileRef = useRef<HTMLInputElement>(null)
  const bannerFileRef = useRef<HTMLInputElement>(null)

  // seed from the live profile every time the editor opens
  useEffect(() => {
    if (!profileEditorOpen || !me) return
    setDisplayName(me.displayName ?? '')
    setCustomStatus(me.customStatus ?? '')
    setBio(me.bio ?? '')
    setPronouns(me.pronouns ?? '')
    setHexInput(me.bannerColor ?? '')
    setBannerPreview(undefined)
    setDirty(false)
  }, [profileEditorOpen])

  useEffect(() => {
    if (!me?.avatarUrl) {
      setAutoColors([])
      return
    }
    void extractAvatarColors(me.avatarUrl).then(setAutoColors)
  }, [me?.avatarUrl])

  if (!profileEditorOpen || !me) return null

  const touch = () => setDirty(true)

  async function save() {
    setSaving(true)
    try {
      await updateProfile({
        displayName: displayName.trim() || null,
        bio: bio.trim(),
        customStatus: customStatus.trim() || null,
        pronouns: pronouns.trim() || null,
      })
      sounds.play('lightTick')
      setDirty(false)
      toast({ title: 'profile saved' })
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not save profile',
        description: err instanceof ApiError ? err.message : 'try again.',
      })
    } finally {
      setSaving(false)
    }
  }

  function onPickImage(mode: 'avatar' | 'banner') {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file) return
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        toast({ title: 'unsupported file', description: 'pick a PNG, JPEG, or WebP image' })
        return
      }
      if (file.size > 8 * 1024 * 1024) {
        toast({ title: 'file too large', description: 'pick an image under 8 MB' })
        return
      }
      setCropMode(mode)
      setCropFile(file)
    }
  }

  async function applyAvatarCrop(blob: Blob) {
    if (!me) return
    setUploadingAvatar(true)
    const prevUrl = me.avatarUrl
    try {
      const res = await apiClient.uploadImage(blob)
      // optimistic: the bytes are already on the server, so paint the new
      // picture into every local surface NOW, while the profile PATCH is
      // still in flight. the ?v= cache buster makes <img> tags swap to the
      // fresh file instead of reusing a stale cached render
      const shownUrl = `${res.url}?v=${Date.now()}`
      useChatStore.getState().applyUserProfilePatch(me.id, { avatarUrl: shownUrl })
      try {
        await updateProfile({ avatarUrl: res.url })
        // re-stamp the busted url: the PATCH response (and the global
        // broadcast of it) carries the clean path, and a clean-path swap
        // would make already-painted images re-request. the patch merger
        // keeps the local busted url over the same clean path
        useChatStore.getState().applyUserProfilePatch(me.id, { avatarUrl: shownUrl })
        sounds.play('lightTick')
        toast({ title: 'profile picture updated' })
      } catch (err) {
        // the profile write failed: put the old picture back everywhere
        useChatStore.getState().applyUserProfilePatch(me.id, { avatarUrl: prevUrl })
        sounds.play('error')
        toast({
          title: 'could not update picture',
          description: err instanceof ApiError ? err.message : 'try again.',
        })
      }
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not update picture',
        description: err instanceof ApiError ? err.message : 'try again.',
      })
    } finally {
      setUploadingAvatar(false)
    }
  }

  async function applyBannerCrop(blob: Blob) {
    if (!me) return
    setUploadingBanner(true)
    const prevUrl = me.bannerUrl
    try {
      const res = await apiClient.uploadImage(blob)
      // same optimistic contract as the avatar: show first, commit second
      const shownUrl = `${res.url}?v=${Date.now()}`
      useChatStore.getState().applyUserProfilePatch(me.id, { bannerUrl: shownUrl })
      try {
        await updateProfile({ bannerUrl: res.url })
        useChatStore.getState().applyUserProfilePatch(me.id, { bannerUrl: shownUrl })
        sounds.play('lightTick')
        toast({ title: 'banner updated' })
      } catch (err) {
        useChatStore.getState().applyUserProfilePatch(me.id, { bannerUrl: prevUrl })
        sounds.play('error')
        toast({
          title: 'could not update banner',
          description: err instanceof ApiError ? err.message : 'try again.',
        })
      }
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not update banner',
        description: err instanceof ApiError ? err.message : 'try again.',
      })
    } finally {
      setUploadingBanner(false)
    }
  }

  function setBannerColor(color: string | null, opts?: { immediate?: boolean }) {
    // local-first: the banner repaints this frame, the server hears about it
    // only after the drag settles. one API call per color instead of dozens.
    setBannerPreview(color)
    setHexInput(color ?? '')
    if (colorCommitTimer.current) clearTimeout(colorCommitTimer.current)
    const commit = () => {
      void updateProfile({ bannerColor: color }).then(() => sounds.play('lightTick'))
    }
    if (opts?.immediate) {
      commit()
    } else {
      colorCommitTimer.current = setTimeout(commit, 350)
    }
  }

  function applyHex() {
    const value = hexInput.trim()
    if (!HEX_RE.test(value)) {
      toast({ title: 'use a hex color like #547cff' })
      return
    }
    setBannerColor(value.toLowerCase())
    setCustomColorOpen(false)
  }

  // live preview values: drafts win over the persisted profile
  const previewName = displayName.trim() || me.username
  const liveBanner = bannerPreview !== undefined ? bannerPreview : me.bannerColor

  // shared swatch chrome: small circles, selected wears a ring, hover lifts
  const swatchCls = (selected: boolean) =>
    cn(
      'size-5 rounded-full transition-[transform,box-shadow] duration-150 outline-none',
      'focus-visible:ring-2 focus-visible:ring-hyper/70 focus-visible:ring-offset-2 focus-visible:ring-offset-app-sidebar',
      selected
        ? 'ring-2 ring-white/90 ring-offset-2 ring-offset-app-sidebar scale-110'
        : 'ring-1 ring-white/10 hover:ring-white/40 hover:scale-110'
    )
  const palette = [...autoColors, ...BANNER_SWATCHES]
  const isCustomActive = !!liveBanner && !palette.includes(liveBanner)

  return (
    <div className="fixed inset-0 z-50 bg-app-chat overflow-y-auto scroll-thin fade-in" role="dialog" aria-label="edit profile">
      <div className="max-w-2xl mx-auto px-4 sm:px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-extrabold tracking-tight">your profile</h1>
          </div>
          <button
            onClick={() => setProfileEditorOpen(false)}
            className="p-2 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="close profile editor"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* ===== the live profile card ===== */}
        <div className="rounded-sm border border-white/10 bg-app-sidebar overflow-hidden dialog-in shadow-xl">
          {/* banner: hover reveals the edit affordances */}
          <div className="relative group/banner">
            <div
              className="h-36 relative overflow-hidden border-b border-white/10"
              style={
                !me.bannerUrl && liveBanner
                  ? { backgroundColor: liveBanner }
                  : !me.bannerUrl
                    ? { backgroundColor: '#1c1c1c' }
                    : undefined
              }
            >
              {me.bannerUrl && (
                <img src={me.bannerUrl} alt="your banner" className="absolute inset-0 size-full object-cover" draggable={false} />
              )}
              {/* banner edit overlay */}
              <div className="absolute inset-0 bg-black/50 opacity-0 group-hover/banner:opacity-100 transition-opacity duration-200 flex items-center justify-center gap-2">
                <input
                  ref={bannerFileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={onPickImage('banner')}
                  aria-hidden="true"
                />
                <Button
                  size="sm"
                  className="rounded-sm"
                  disabled={uploadingBanner}
                  onClick={() => bannerFileRef.current?.click()}
                >
                  <Camera className="size-4" />
                  {uploadingBanner ? 'uploading' : 'change banner image'}
                </Button>
                {me.bannerUrl && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-sm"
                    onClick={() => void updateProfile({ bannerUrl: null })}
                  >
                    remove image
                  </Button>
                )}
              </div>
            </div>

            {/* avatar: hover reveals its own controls, click-to-crop */}
            <div className="absolute left-5 top-[82px] z-10">
              <div className="relative group/avatar">
                <button
                  type="button"
                  className="block rounded-full ring-4 ring-app-sidebar transition-transform duration-200 hover:scale-[1.03]"
                  onClick={() => avatarFileRef.current?.click()}
                  aria-label="change profile picture"
                  title="change profile picture"
                >
                  <Avatar
                    name={me.username}
                    color={me.avatarColor}
                    url={me.avatarUrl}
                    size="2xl"
                    status={connected ? (me.presence === 'invisible' ? 'offline' : me.presence) : 'offline'}
                    showDot
                    className={cn(uploadingAvatar && 'opacity-50')}
                  />
                </button>
                <div className="pointer-events-none absolute inset-0 rounded-full bg-black/45 opacity-0 group-hover/avatar:opacity-100 transition-opacity duration-150 grid place-items-center">
                  <Camera className="size-7 text-white/90" aria-hidden="true" />
                </div>
                <input
                  ref={avatarFileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={onPickImage('avatar')}
                  aria-hidden="true"
                />
              </div>
            </div>

            {/* custom status: the bubble IS the input. you type straight into
                the speech bubble so what you see is literally what they see */}
            <div className="absolute left-36 top-[92px] z-10 max-w-[calc(100%-10.5rem)]">
              <input
                value={customStatus}
                onChange={(e) => {
                  setCustomStatus(e.target.value)
                  touch()
                }}
                placeholder="what are you thinking?"
                maxLength={80}
                aria-label="status quote"
                className={cn(
                  'status-bubble border px-3 py-1.5 text-xs leading-snug outline-none w-64 transition-colors placeholder:text-muted-foreground/60',
                  customStatus.trim()
                    ? 'border-white/10 bg-app-raise text-foreground/90 focus:border-hyper/50'
                    : 'border-dashed border-white/15 bg-app-raise/60 text-foreground/80 focus:border-hyper/40'
                )}
              />
            </div>
          </div>

          {/* identity block */}
          <div className="pt-14 px-5 pb-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                {/* display name: type directly in the card */}
                <input
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value)
                    touch()
                  }}
                  placeholder={me.username}
                  maxLength={32}
                  aria-label="display name"
                  className="w-full bg-transparent text-lg font-bold tracking-tight outline-none border-b border-transparent focus:border-hyper/60 transition-colors placeholder:text-muted-foreground/50 placeholder:font-bold"
                />
                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5 flex-wrap">
                  <AtSign className="size-3 shrink-0" />
                  {me.username}
                  <input
                    value={pronouns}
                    onChange={(e) => {
                      setPronouns(e.target.value)
                      touch()
                    }}
                    placeholder="pronouns"
                    maxLength={40}
                    aria-label="pronouns"
                    className="ml-1 w-24 bg-transparent border-b border-transparent hover:border-white/10 focus:border-hyper/60 text-[11px] outline-none transition-colors placeholder:text-muted-foreground/50"
                  />
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {me.role === 'ADMIN' && (
                  <span
                    className="flex items-center gap-1 text-[10px] font-bold tracking-wider text-hyper bg-hyper/10 border border-hyper/40 px-1.5 py-0.5 rounded-sm"
                    title="administers the entire HyperChat platform"
                  >
                    <Shield className="size-3" />
                    HyperChat admin
                  </span>
                )}
              </div>
            </div>

            {/* bio: edit right where it reads */}
            <div className="mt-4">
              <p className="text-[10px] font-bold tracking-widest text-muted-foreground mb-1.5 flex items-center gap-1">
                <Pencil className="size-2.5" />
                about me
              </p>
              <textarea
                value={bio}
                onChange={(e) => {
                  setBio(e.target.value)
                  touch()
                }}
                maxLength={190}
                rows={3}
                aria-label="about me"
                className="chat-font w-full bg-transparent border border-transparent hover:border-white/10 focus:border-hyper/60 rounded-sm px-2 py-1.5 text-sm text-foreground/90 leading-relaxed outline-none resize-none scroll-thin transition-colors placeholder:text-muted-foreground/50"
              />
              <p className="text-[11px] text-muted-foreground text-right">{bio.length}/190</p>
            </div>

            <p className="mt-1 text-[11px] text-muted-foreground">
              Hyperion member since {formatJoinDate(me.createdAt)}
            </p>
          </div>
        </div>

        {/* ===== banner color: a tight row of small circular swatches ===== */}
        <div className="mt-6 rounded-sm border border-white/10 bg-app-sidebar p-3.5 fade-in">
          <div className="flex items-center justify-between mb-2.5">
            <p className="text-[13px] font-semibold flex items-center gap-1.5">
              <Palette className="size-3.5 text-muted-foreground" />
              banner color
            </p>
            <span className="text-[11px] font-mono text-muted-foreground/80">{liveBanner ?? 'none'}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setBannerColor(null, { immediate: true })}
              className={cn(swatchCls(!liveBanner), 'bg-app-raise grid place-items-center')}
              style={{ backgroundColor: '#1c1c1c' }}
              aria-label="no banner color"
              aria-pressed={!liveBanner}
              title="no banner color"
            >
              <Ban className="size-2.5 text-muted-foreground" aria-hidden="true" />
            </button>
            {autoColors.length > 0 && (
              <>
                {autoColors.map((color) => (
                  <button
                    key={color}
                    onClick={() => setBannerColor(color, { immediate: true })}
                    className={swatchCls(liveBanner === color)}
                    style={{ backgroundColor: color }}
                    aria-label={`banner ${color}`}
                    aria-pressed={liveBanner === color}
                    title={`from your avatar · ${color}`}
                  />
                ))}
                <span className="w-px h-4 bg-white/10 mx-0.5" aria-hidden="true" />
              </>
            )}
            {BANNER_SWATCHES.map((color) => (
              <button
                key={color}
                onClick={() => setBannerColor(color, { immediate: true })}
                className={swatchCls(liveBanner === color)}
                style={{ backgroundColor: color }}
                aria-label={`banner ${color}`}
                aria-pressed={liveBanner === color}
                title={color}
              />
            ))}
            <span className="w-px h-4 bg-white/10 mx-0.5" aria-hidden="true" />
            <Popover open={customColorOpen} onOpenChange={setCustomColorOpen}>
              <PopoverTrigger asChild>
                <button
                  className={cn(swatchCls(isCustomActive), 'grid place-items-center')}
                  style={isCustomActive ? { backgroundColor: liveBanner ?? undefined } : { backgroundColor: '#1c1c1c' }}
                  aria-label="custom banner color"
                  aria-pressed={isCustomActive}
                  title="custom color"
                >
                  {!isCustomActive && <Plus className="size-2.5 text-muted-foreground" aria-hidden="true" />}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" side="top" className="w-44 p-2 rounded-sm border-white/10 bg-app-sidebar">
                <div className="flex items-center gap-2">
                  <label
                    className="relative block size-7 shrink-0 rounded-sm border border-white/15 cursor-pointer overflow-hidden"
                    aria-label="pick any color"
                    title="pick any color"
                  >
                    <input
                      type="color"
                      value={liveBanner && HEX_RE.test(liveBanner) ? liveBanner : '#547cff'}
                      onChange={(e) => setBannerColor(e.target.value)}
                      className="absolute inset-0 size-full opacity-0 cursor-pointer"
                    />
                    <span
                      className="pointer-events-none absolute inset-0"
                      style={{ backgroundColor: liveBanner ?? '#547cff' }}
                      aria-hidden="true"
                    />
                  </label>
                  <input
                    value={hexInput}
                    onChange={(e) => setHexInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && applyHex()}
                    placeholder="#547cff"
                    maxLength={7}
                    className="min-w-0 flex-1 bg-app-raise border border-white/10 rounded-sm px-1.5 py-1 text-[11px] font-mono outline-none focus:border-hyper/60"
                    aria-label="banner hex color"
                    title="press enter to apply"
                  />
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* save bar */}
        <div className="mt-6 flex items-center gap-3 pb-8">
          <Button size="sm" className="rounded-sm press" disabled={saving || !dirty} onClick={() => void save()}>
            <Check className="size-4" />
            {saving ? 'saving' : dirty ? 'save changes' : 'saved'}
          </Button>
          <Button variant="ghost" size="sm" className="rounded-sm" onClick={() => setProfileEditorOpen(false)}>
            done
          </Button>
          {dirty && <span className="text-xs text-muted-foreground">unsaved changes</span>}
        </div>
      </div>

      {/* crop tool: shared by the avatar and banner flows */}
      <CropDialog
        open={!!cropFile}
        file={cropFile}
        mode={cropMode}
        onApply={(blob) => void (cropMode === 'avatar' ? applyAvatarCrop(blob) : applyBannerCrop(blob))}
        onClose={() => setCropFile(null)}
      />
    </div>
  )
}
