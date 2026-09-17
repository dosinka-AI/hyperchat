'use client'

import { useEffect, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { apiClient, ApiError } from '@/lib/client/api'
import { sounds, VOICES, type SoundEvent, type SoundName } from '@/lib/client/sounds'
import { notifications } from '@/lib/client/notifications'
import { useAppearance, setAppearance, type ChatFont } from '@/lib/client/appearance'
import { formatJoinDate } from '@/lib/client/format'
import { Avatar } from './Avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import { X, KeyRound, Volume2, LogOut, Check, UserX, Focus, Clock3, Sparkles, MessageSquareText, UserRoundPlus, Gauge, Eye, EyeOff, CalendarClock, Bookmark, Bell, AlertCircle, RotateCcw, ShieldCheck, Mail } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EmailVerifyDialog } from './EmailVerifyDialog'
import type { PublicUser } from '@/lib/types'

type SettingsTab = 'appearance' | 'notifications' | 'privacy' | 'account'

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'appearance', label: 'appearance' },
  { id: 'notifications', label: 'notifications' },
  { id: 'privacy', label: 'privacy' },
  { id: 'account', label: 'account' },
]

const FONT_STEPS: { id: ChatFont; label: string; glyph: string }[] = [
  { id: 'small', label: 'small', glyph: 'text-[11px]' },
  { id: 'medium', label: 'medium', glyph: 'text-[13px]' },
  { id: 'large', label: 'large', glyph: 'text-[15px]' },
]

/** Settings, and only settings: profile editing lives in its own full-profile
 *  editor (ProfileEditor). Appearance previews render a real fake
 *  conversation — someone else plus you — so compact and text size changes
 *  can be judged exactly as they will read in chat. */
export function AccountView() {
  const me = useChatStore((s) => s.me)
  const accountOpen = useChatStore((s) => s.accountOpen)
  const setAccountOpen = useChatStore((s) => s.setAccountOpen)
  const changePassword = useChatStore((s) => s.changePassword)
  const doLogout = useChatStore((s) => s.doLogout)
  const blockedUserIds = useChatStore((s) => s.blockedUserIds)
  const unblockUser = useChatStore((s) => s.unblockUser)
  const focusUntil = useChatStore((s) => s.focusUntil)
  const setFocus = useChatStore((s) => s.setFocus)
  const setSavedOpen = useChatStore((s) => s.setSavedOpen)
  const setScheduledOpen = useChatStore((s) => s.setScheduledOpen)
  const setProfileEditorOpen = useChatStore((s) => s.setProfileEditorOpen)
  const { toast } = useToast()
  const appearance = useAppearance()

  const [tab, setTab] = useState<SettingsTab>('appearance')

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  // email-coded password change: code request + entry
  const [passwordCode, setPasswordCode] = useState('')
  const [deliveredCode, setDeliveredCode] = useState<string | null>(null)
  const [sendingCode, setSendingCode] = useState(false)
  const [emailDialogOpen, setEmailDialogOpen] = useState(false)

  const [soundEnabled, setSoundEnabled] = useState(true)
  const [volume, setVolume] = useState(1)
  const [focusMinutes, setFocusMinutes] = useState('')
  const [catMessage, setCatMessage] = useState(true)
  const [catJoin, setCatJoin] = useState(true)
  const [catUi, setCatUi] = useState(true)
  /** per-event voice choices (null = stock voice) */
  const [voices, setVoices] = useState<Record<SoundEvent, SoundName | null>>({
    msg: null,
    msgunfocused: null,
    join: null,
    ping: null,
    error: null,
    ui: null,
  })

  const [blockedUsers, setBlockedUsers] = useState<PublicUser[]>([])

  const [notifyEnabled, setNotifyEnabled] = useState(false)
  const [notifyDm, setNotifyDm] = useState(true)
  const [notifyMention, setNotifyMention] = useState(true)
  const [notifyPermission, setNotifyPermission] = useState<NotificationPermission | 'unsupported'>('default')

  useEffect(() => {
    setSoundEnabled(sounds.isEnabled())
    setVolume(sounds.getVolume())
    setCatMessage(sounds.getCategoryEnabled('message'))
    setCatJoin(sounds.getCategoryEnabled('join'))
    setCatUi(sounds.getCategoryEnabled('ui'))
    setVoices({
      msg: sounds.getEventVoice('msg'),
      msgunfocused: sounds.getEventVoice('msgunfocused'),
      join: sounds.getEventVoice('join'),
      ping: sounds.getEventVoice('ping'),
      error: sounds.getEventVoice('error'),
      ui: sounds.getEventVoice('ui'),
    })
    setNotifyEnabled(notifications.isEnabled())
    setNotifyDm(notifications.getCategoryEnabled('dm'))
    setNotifyMention(notifications.getCategoryEnabled('mention'))
    setNotifyPermission(notifications.getPermission())
  }, [])

  useEffect(() => {
    if (!accountOpen) return
    apiClient
      .blockedUsers()
      .then((res) => setBlockedUsers(res.blocked))
      .catch(() => setBlockedUsers([]))
  }, [accountOpen, blockedUserIds])

  if (!accountOpen || !me) return null

  async function savePassword() {
    if (newPassword.length < 8) {
      toast({ title: 'password too short', description: 'the new password must be at least 8 characters.' })
      return
    }
    setSavingPassword(true)
    try {
      await changePassword(currentPassword, newPassword, passwordCode)
      setCurrentPassword('')
      setNewPassword('')
      setPasswordCode('')
      setDeliveredCode(null)
      sounds.play('lightTick')
      toast({ title: 'password changed' })
    } catch (err) {
      sounds.play('error')
      toast({
        title: 'could not change password',
        description: err instanceof ApiError ? err.message : 'Try again.',
      })
    } finally {
      setSavingPassword(false)
    }
  }

  /** fire the one-time code to the account's verified email; this build has
   *  no mail transport so it comes back inline and is shown next to the field */
  async function requestCode() {
    if (!me?.email) return
    setSendingCode(true)
    try {
      const res = await apiClient.sendEmailCode({ email: me.email, purpose: 'password' })
      setDeliveredCode(res.delivery === 'inline' ? (res.code ?? null) : null)
      sounds.play('lightTick')
      toast({ title: 'code sent', description: 'it expires in 10 minutes.' })
    } catch (err) {
      sounds.play('error')
      toast({ title: 'could not send code', description: err instanceof ApiError ? err.message : 'Try again.' })
    } finally {
      setSendingCode(false)
    }
  }

  function toggleSounds(enabled: boolean) {
    setSoundEnabled(enabled)
    sounds.setEnabled(enabled)
    if (enabled) sounds.play('lightTick')
  }

  function changeVolume(v: number) {
    setVolume(v)
    sounds.setVolume(v)
    sounds.play('lightTick')
  }

  function applyFocus(minutes: number) {
    setFocus(minutes)
    setFocusMinutes('')
    toast({ title: `focus mode on for ${minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`}` })
  }

  function toggleCat(cat: 'message' | 'join' | 'ui', enabled: boolean) {
    sounds.setCategoryEnabled(cat, enabled)
    if (cat === 'message') setCatMessage(enabled)
    if (cat === 'join') setCatJoin(enabled)
    if (cat === 'ui') setCatUi(enabled)
    if (enabled) sounds.play('lightTick')
  }

  /** Master desktop-notification toggle. The first enable requests browser
   *  permission (never on boot); a denied browser leaves it off and shows
   *  the blocked state. */
  function toggleNotify(enabled: boolean) {
    if (!enabled) {
      notifications.setEnabled(false)
      setNotifyEnabled(false)
      return
    }
    const perm = notifications.getPermission()
    if (perm === 'granted') {
      notifications.setEnabled(true)
      setNotifyEnabled(true)
      return
    }
    if (perm === 'denied') {
      setNotifyEnabled(false)
      return
    }
    void notifications.requestPermission().then((p) => {
      setNotifyPermission(p)
      const granted = p === 'granted'
      notifications.setEnabled(granted)
      setNotifyEnabled(granted)
      if (granted) sounds.play('lightTick')
    })
  }

  function toggleNotifyCat(cat: 'dm' | 'mention', enabled: boolean) {
    notifications.setCategoryEnabled(cat, enabled)
    if (cat === 'dm') setNotifyDm(enabled)
    else setNotifyMention(enabled)
    if (enabled) sounds.play('lightTick')
  }

  /** Swap the voice one event plays; picking the stock voice clears the
   *  override so the select always mirrors the effective choice. */
  function setVoice(event: SoundEvent, voice: SoundName, stock: SoundName) {
    const override = voice === stock ? null : voice
    sounds.setEventVoice(event, override)
    setVoices((v) => ({ ...v, [event]: override }))
    sounds.previewVoice(voice)
  }

  function resetVoices() {
    sounds.resetEventVoices()
    setVoices({ msg: null, msgunfocused: null, join: null, ping: null, error: null, ui: null })
    sounds.play('lightTick')
  }

  return (
    <div className="fixed inset-0 z-50 bg-app-chat overflow-y-auto scroll-thin fade-in" role="dialog" aria-label="settings">
      <div className="max-w-3xl mx-auto px-4 sm:px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-extrabold tracking-tight">Settings</h1>
          <button
            onClick={() => setAccountOpen(false)}
            className="p-2 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            aria-label="close settings"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* tab rail */}
        <div className="flex items-center gap-1 mb-8 overflow-x-auto scroll-thin pb-1" role="tablist" aria-label="settings sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => {
                sounds.play('lightTick')
                setTab(t.id)
              }}
              className={cn(
                'px-3.5 py-2 text-[13px] font-semibold rounded-sm border transition-colors shrink-0',
                tab === t.id
                  ? 'bg-hyper/15 border-hyper/60 text-hyper'
                  : 'border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ---------------- APPEARANCE ---------------- */}
        {tab === 'appearance' && (
          <section className="fade-in" aria-label="appearance settings">
            <div className="bg-app-sidebar border border-white/10 rounded-sm divide-y divide-white/10">
              <div className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <Gauge className="size-4 text-muted-foreground" />
                  <p className="text-sm font-semibold">compact messages</p>
                </div>
                <Switch
                  checked={appearance.compact}
                  onCheckedChange={(v) => {
                    sounds.play('lightTick')
                    setAppearance({ compact: v })
                  }}
                  aria-label="compact messages"
                />
              </div>
              <div className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <MessageSquareText className="size-4 text-muted-foreground" />
                  <p className="text-sm font-semibold">chat text size</p>
                </div>
                <div className="flex items-center gap-1">
                  {FONT_STEPS.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => {
                        sounds.play('lightTick')
                        setAppearance({ font: f.id })
                      }}
                      className={cn(
                        'w-11 h-8 grid place-items-center font-bold rounded-sm border transition-colors',
                        f.glyph,
                        appearance.font === f.id
                          ? 'bg-hyper/20 border-hyper text-hyper'
                          : 'border-white/10 text-muted-foreground hover:text-foreground hover:border-white/25'
                      )}
                      aria-pressed={appearance.font === f.id}
                      title={f.label}
                    >
                      A
                      <span className="sr-only">{f.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <Clock3 className="size-4 text-muted-foreground" />
                  <p className="text-sm font-semibold">24-hour clock</p>
                </div>
                <Switch
                  checked={appearance.clock24}
                  onCheckedChange={(v) => {
                    sounds.play('lightTick')
                    setAppearance({ clock24: v })
                  }}
                  aria-label="24-hour clock"
                />
              </div>
              <div className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <Eye className="size-4 text-muted-foreground" />
                  <p className="text-sm font-semibold">timestamps on grouped messages</p>
                </div>
                <Switch
                  checked={appearance.showTimestamps}
                  onCheckedChange={(v) => {
                    sounds.play('lightTick')
                    setAppearance({ showTimestamps: v })
                  }}
                  aria-label="timestamps on grouped messages"
                />
              </div>
              <div className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <Sparkles className="size-4 text-muted-foreground" />
                  <p className="text-sm font-semibold">animations</p>
                </div>
                <Switch
                  checked={!appearance.reducedMotion}
                  onCheckedChange={(v) => {
                    sounds.play('lightTick')
                    setAppearance({ reducedMotion: !v })
                  }}
                  aria-label="animations"
                />
              </div>
            </div>

            {/* live preview: a fake conversation between someone else and you,
                rendered with the exact classes the real chat uses. the last
                line is yours, the same greeting the app ships with. */}
            <div className="mt-4 rounded-sm border border-white/10 bg-app-chat overflow-hidden">
              <div className="px-4 py-2 border-b border-white/10 text-[10px] font-bold tracking-widest text-muted-foreground flex items-center justify-between">
                <span>preview</span>
                <span className="font-semibold normal-case tracking-normal">
                  {appearance.compact ? 'compact' : 'cozy'} · {appearance.font}
                </span>
              </div>
              <div className="px-3 py-3 space-y-0.5">
                <div className="msg-row leader relative flex gap-3 rounded-sm px-2 -mx-1 pt-2.5 pb-0.5">
                  <Avatar name="alex" color="#3d3d3d" size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-[15px] font-bold tracking-tight msg-author-name">alex</span>
                      <span className="text-[11px] text-muted-foreground">
                        {appearance.clock24 ? 'today at 16:17' : 'Today at 4:17 PM'}
                      </span>
                    </div>
                    <div className="chat-font leading-[1.4] text-foreground/95 break-words">
                      How does the new size feel?
                    </div>
                  </div>
                </div>
                <div className={cn('msg-row grouped relative flex gap-3 rounded-sm px-2 -mx-1 py-px', !appearance.showTimestamps && 'hidden')}>
                  <span className="w-8 shrink-0 hidden sm:block text-[9px] text-muted-foreground/40 text-right leading-none self-center tabular-nums whitespace-nowrap" aria-hidden="true">
                    {appearance.clock24 ? '16:18' : '4:18'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="chat-font leading-[1.4] text-foreground/95 break-words">
                      So much easier to read!
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      <span className="flex items-center gap-1.5 h-7 px-2 rounded-sm border bg-hyper/20 border-hyper/60 text-foreground">
                        <span className="text-[16px] leading-none">🔥</span>
                        <span className="text-[11px] font-semibold tabular-nums text-muted-foreground">2</span>
                      </span>
                      <span className="flex items-center gap-1.5 h-7 px-2 rounded-sm border bg-app-raise/70 border-white/10 text-foreground/90">
                        <span className="text-[16px] leading-none">😂</span>
                        <span className="text-[11px] font-semibold tabular-nums text-muted-foreground">1</span>
                      </span>
                    </div>
                  </div>
                </div>
                <div className="msg-row leader relative flex gap-3 rounded-sm px-2 -mx-1 pt-2.5 pb-0.5">
                  <Avatar name={me.username} color={me.avatarColor} url={me.avatarUrl} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-[15px] font-bold tracking-tight msg-author-name">{me.displayName || me.username}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {appearance.clock24 ? 'today at 16:19' : 'Today at 4:19 PM'}
                      </span>
                    </div>
                    <div className="chat-font leading-[1.4] text-foreground/95 break-words">
                      Thanks for using Hyperion!
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ---------------- NOTIFICATIONS ---------------- */}
        {tab === 'notifications' && (
          <section className="fade-in" aria-label="notification settings">
            <div className="bg-app-sidebar border border-white/10 rounded-sm divide-y divide-white/10">
              <div className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <Volume2 className="size-4 text-muted-foreground" />
                  <p className="text-sm font-semibold">sounds</p>
                </div>
                <Switch checked={soundEnabled} onCheckedChange={toggleSounds} aria-label="toggle sounds" />
              </div>
              {soundEnabled && (
                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <p className="text-sm font-semibold">volume</p>
                  <div className="flex items-center gap-3 shrink-0">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={Math.round(volume * 100)}
                      onChange={(e) => changeVolume(Number(e.target.value) / 100)}
                      className="w-36 accent-hyper"
                      aria-label="sound volume"
                    />
                    <span className="text-xs text-muted-foreground tabular-nums w-9 text-right">
                      {Math.round(volume * 100)}%
                    </span>
                  </div>
                </div>
              )}
              {soundEnabled && (
                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <MessageSquareText className="size-4 text-muted-foreground shrink-0" />
                    <p className="text-sm font-semibold">message</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <select
                      value={voices.msg ?? 'msg'}
                      onChange={(e) => setVoice('msg', e.target.value as SoundName, 'msg')}
                      className="bg-app-raise border border-white/10 rounded-sm px-1.5 py-1 text-xs outline-none focus:border-hyper/60 max-w-[132px] text-ellipsis"
                      aria-label="message sound voice"
                    >
                      {VOICES.map((v) => (
                        <option key={v.id} value={v.id}>{v.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => sounds.previewVoice(voices.msg ?? 'msg')}
                      className="text-[11px] font-semibold px-2 py-1 rounded-sm border border-white/10 hover:border-hyper/60 hover:text-hyper transition-colors"
                      aria-label="preview message sound"
                    >
                      preview
                    </button>
                    <Switch checked={catMessage} onCheckedChange={(v) => toggleCat('message', v)} aria-label="message sounds" />
                  </div>
                </div>
              )}
              {soundEnabled && (
                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <p className="text-sm font-semibold pl-7 min-w-0">unfocused</p>
                  <div className="flex items-center gap-2 shrink-0">
                    <select
                      value={voices.msgunfocused ?? 'msgunfocused'}
                      onChange={(e) => setVoice('msgunfocused', e.target.value as SoundName, 'msgunfocused')}
                      className="bg-app-raise border border-white/10 rounded-sm px-1.5 py-1 text-xs outline-none focus:border-hyper/60 max-w-[132px]"
                      aria-label="unfocused message sound voice"
                    >
                      {VOICES.map((v) => (
                        <option key={v.id} value={v.id}>{v.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => sounds.previewVoice(voices.msgunfocused ?? 'msgunfocused')}
                      className="text-[11px] font-semibold px-2 py-1 rounded-sm border border-white/10 hover:border-hyper/60 hover:text-hyper transition-colors"
                      aria-label="preview unfocused message sound"
                    >
                      preview
                    </button>
                  </div>
                </div>
              )}
              {soundEnabled && (
                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Bell className="size-4 text-muted-foreground shrink-0" />
                    <p className="text-sm font-semibold">reminder ping</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <select
                      value={voices.ping ?? 'ping'}
                      onChange={(e) => setVoice('ping', e.target.value as SoundName, 'ping')}
                      className="bg-app-raise border border-white/10 rounded-sm px-1.5 py-1 text-xs outline-none focus:border-hyper/60 max-w-[132px]"
                      aria-label="reminder ping sound voice"
                    >
                      {VOICES.map((v) => (
                        <option key={v.id} value={v.id}>{v.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => sounds.previewVoice(voices.ping ?? 'ping')}
                      className="text-[11px] font-semibold px-2 py-1 rounded-sm border border-white/10 hover:border-hyper/60 hover:text-hyper transition-colors"
                      aria-label="preview reminder ping sound"
                    >
                      preview
                    </button>
                  </div>
                </div>
              )}
              {soundEnabled && (
                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <UserRoundPlus className="size-4 text-muted-foreground shrink-0" />
                    <p className="text-sm font-semibold">join</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <select
                      value={voices.join ?? 'join'}
                      onChange={(e) => setVoice('join', e.target.value as SoundName, 'join')}
                      className="bg-app-raise border border-white/10 rounded-sm px-1.5 py-1 text-xs outline-none focus:border-hyper/60 max-w-[132px]"
                      aria-label="join sound voice"
                    >
                      {VOICES.map((v) => (
                        <option key={v.id} value={v.id}>{v.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => sounds.previewVoice(voices.join ?? 'join')}
                      className="text-[11px] font-semibold px-2 py-1 rounded-sm border border-white/10 hover:border-hyper/60 hover:text-hyper transition-colors"
                      aria-label="preview join sound"
                    >
                      preview
                    </button>
                    <Switch checked={catJoin} onCheckedChange={(v) => toggleCat('join', v)} aria-label="join sounds" />
                  </div>
                </div>
              )}
              {soundEnabled && (
                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <AlertCircle className="size-4 text-muted-foreground shrink-0" />
                    <p className="text-sm font-semibold">error</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <select
                      value={voices.error ?? 'error'}
                      onChange={(e) => setVoice('error', e.target.value as SoundName, 'error')}
                      className="bg-app-raise border border-white/10 rounded-sm px-1.5 py-1 text-xs outline-none focus:border-hyper/60 max-w-[132px]"
                      aria-label="error sound voice"
                    >
                      {VOICES.map((v) => (
                        <option key={v.id} value={v.id}>{v.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => sounds.previewVoice(voices.error ?? 'error')}
                      className="text-[11px] font-semibold px-2 py-1 rounded-sm border border-white/10 hover:border-hyper/60 hover:text-hyper transition-colors"
                      aria-label="preview error sound"
                    >
                      preview
                    </button>
                  </div>
                </div>
              )}
              {soundEnabled && (
                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Sparkles className="size-4 text-muted-foreground shrink-0" />
                    <p className="text-sm font-semibold">clicks</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <select
                      value={voices.ui ?? 'click'}
                      onChange={(e) => setVoice('ui', e.target.value as SoundName, 'click')}
                      className="bg-app-raise border border-white/10 rounded-sm px-1.5 py-1 text-xs outline-none focus:border-hyper/60 max-w-[132px]"
                      aria-label="click sound voice"
                    >
                      {VOICES.map((v) => (
                        <option key={v.id} value={v.id}>{v.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => sounds.previewVoice(voices.ui ?? 'click')}
                      className="text-[11px] font-semibold px-2 py-1 rounded-sm border border-white/10 hover:border-hyper/60 hover:text-hyper transition-colors"
                      aria-label="preview click sound"
                    >
                      preview
                    </button>
                    <Switch checked={catUi} onCheckedChange={(v) => toggleCat('ui', v)} aria-label="click sounds" />
                  </div>
                </div>
              )}
              {soundEnabled && (voices.msg || voices.msgunfocused || voices.join || voices.ping || voices.error || voices.ui) && (
                <div className="px-4 py-2.5 flex justify-end">
                  <button
                    onClick={resetVoices}
                    className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <RotateCcw className="size-3" />
                    reset voices
                  </button>
                </div>
              )}
              <div className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Focus className="size-4 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">focus mode</p>
                    {focusUntil && (
                      <p className="text-xs text-hyper font-semibold">
                        on until {new Date(focusUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {focusUntil ? (
                    <Button variant="outline" size="sm" className="rounded-sm h-7 px-2 text-xs" onClick={() => setFocus(null)}>
                      turn off
                    </Button>
                  ) : (
                    <>
                      {[15, 60, 240].map((mins) => (
                        <Button
                          key={mins}
                          variant="outline"
                          size="sm"
                          className="rounded-sm h-7 px-2 text-xs"
                          onClick={() => applyFocus(mins)}
                        >
                          {mins >= 60 ? `${mins / 60}h` : `${mins}m`}
                        </Button>
                      ))}
                      <input
                        type="number"
                        min={1}
                        max={1440}
                        value={focusMinutes}
                        onChange={(e) => setFocusMinutes(e.target.value)}
                        placeholder="min"
                        aria-label="custom focus minutes"
                        className="w-14 bg-transparent border border-white/10 rounded-sm px-1.5 py-1 text-[11px] outline-none focus:border-hyper/60"
                      />
                      <button
                        disabled={!(Number(focusMinutes) >= 1)}
                        onClick={() => {
                          const n = Number(focusMinutes)
                          if (Number.isFinite(n) && n >= 1 && n <= 1440) applyFocus(Math.round(n))
                        }}
                        className="px-2 py-1 text-[11px] font-semibold rounded-sm border border-hyper/50 text-hyper hover:bg-hyper/10 transition-colors disabled:opacity-40 disabled:border-white/10 disabled:text-muted-foreground"
                      >
                        set
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* desktop notifications: quiet, precise, opt-in */}
            <div className="mt-4 rounded-sm border border-white/10 bg-app-sidebar divide-y divide-white/10">
              <div className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <Bell className="size-4 text-muted-foreground" />
                  <p className="text-sm font-semibold">desktop notifications</p>
                </div>
                <Switch
                  checked={notifyEnabled}
                  onCheckedChange={toggleNotify}
                  disabled={notifyPermission === 'unsupported'}
                  aria-label="toggle desktop notifications"
                />
              </div>
              {notifyEnabled && (
                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <p className="text-sm font-semibold">direct messages</p>
                  <Switch checked={notifyDm} onCheckedChange={(v) => toggleNotifyCat('dm', v)} aria-label="direct message notifications" />
                </div>
              )}
              {notifyEnabled && (
                <div className="px-4 py-3 flex items-center justify-between gap-4">
                  <p className="text-sm font-semibold">mentions</p>
                  <Switch checked={notifyMention} onCheckedChange={(v) => toggleNotifyCat('mention', v)} aria-label="mention notifications" />
                </div>
              )}
              {notifyPermission === 'denied' && (
                <div className="px-4 py-3 text-xs text-muted-foreground">
                  blocked by the browser. allow notifications in your browser settings to turn these on.
                </div>
              )}
            </div>
          </section>
        )}

        {/* ---------------- PRIVACY ---------------- */}
        {tab === 'privacy' && (
          <section className="fade-in" aria-label="privacy settings">
            <p className="text-xs font-bold tracking-widest text-muted-foreground mb-3">blocked users</p>
            <div className="bg-app-sidebar border border-white/10 rounded-sm divide-y divide-white/10">
              {blockedUsers.length === 0 && (
                <p className="px-4 py-3 text-xs text-muted-foreground">nobody is blocked.</p>
              )}
              {blockedUsers.map((user) => (
                <div key={user.id} className="px-4 py-2.5 flex items-center gap-3">
                  <Avatar name={user.username} color={user.avatarColor} url={user.avatarUrl} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{user.displayName || user.username}</p>
                    <p className="text-[11px] text-muted-foreground truncate">@{user.username}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-sm shrink-0"
                    onClick={() => {
                      void unblockUser(user.id)
                      setBlockedUsers((list) => list.filter((u) => u.id !== user.id))
                    }}
                  >
                    <UserX className="size-3.5" />
                    unblock
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ---------------- ACCOUNT ---------------- */}
        {tab === 'account' && (
          <section className="space-y-8 fade-in" aria-label="account settings">
            <div className="bg-app-sidebar border border-white/10 rounded-sm divide-y divide-white/10">
              <div className="px-4 py-3 flex items-center justify-between gap-4">
                <p className="text-sm font-semibold">username</p>
                <p className="text-sm font-bold tracking-tight">{me.username}</p>
              </div>
              <div className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold">email</p>
                    {me.email && me.emailVerifiedAt ? (
                      <span className="flex items-center gap-1 text-[10px] font-bold text-hyper border border-hyper/40 bg-hyper/10 rounded-sm px-1.5 py-0.5">
                        <ShieldCheck className="size-3" />
                        verified
                      </span>
                    ) : me.email ? (
                      <span className="text-[10px] font-bold text-muted-foreground border border-border rounded-sm px-1.5 py-0.5">
                        unverified
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm truncate text-muted-foreground">{me.email || 'none on file yet'}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-sm h-7 px-2 text-xs shrink-0"
                  onClick={() => {
                    sounds.play('lightTick')
                    setEmailDialogOpen(true)
                  }}
                >
                  <Mail className="size-3.5" />
                  {me.email && me.emailVerifiedAt ? 'change' : me.email ? 'verify' : 'add'}
                </Button>
              </div>
              <div className="px-4 py-3 flex items-center justify-between gap-4">
                <p className="text-sm font-semibold">member since</p>
                <p className="text-sm text-muted-foreground">{formatJoinDate(me.createdAt)}</p>
              </div>
              <div className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <UserRoundPlus className="size-4 text-muted-foreground" />
                  <p className="text-sm font-semibold">your profile</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-sm h-7 px-2 text-xs"
                  onClick={() => {
                    sounds.play('lightTick')
                    setAccountOpen(false)
                    setProfileEditorOpen(true)
                  }}
                >
                  edit profile
                </Button>
              </div>
            </div>

            <div>
              <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-3">
                <Bookmark className="size-4 text-muted-foreground" />
                your stuff
              </h3>
              <div className="grid sm:grid-cols-2 gap-2">
                <button
                  onClick={() => {
                    sounds.play('lightTick')
                    setSavedOpen(true)
                  }}
                  className="rounded-sm border border-white/10 bg-app-sidebar px-3 py-2.5 text-left hover:border-hyper/60 transition-colors"
                >
                  <p className="text-[13px] font-semibold">saved messages</p>
                </button>
                <button
                  onClick={() => {
                    sounds.play('lightTick')
                    setScheduledOpen(true)
                  }}
                  className="rounded-sm border border-white/10 bg-app-sidebar px-3 py-2.5 text-left hover:border-hyper/60 transition-colors"
                >
                  <p className="text-[13px] font-semibold">scheduled</p>
                </button>
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                <KeyRound className="size-4 text-muted-foreground" />
                change password
              </h3>
              {!(me.email && me.emailVerifiedAt) ? (
                <div className="rounded-sm border border-hyper/40 bg-hyper/5 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold">needs a verified email</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      password changes confirm with a one-time code sent to your email.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    className="rounded-sm"
                    onClick={() => {
                      sounds.play('lightTick')
                      setEmailDialogOpen(true)
                    }}
                  >
                    <Mail className="size-3.5" />
                    verify an email
                  </Button>
                </div>
              ) : (
                <>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="currentPassword">current password</Label>
                      <Input
                        id="currentPassword"
                        type="password"
                        value={currentPassword}
                        onChange={(e) => setCurrentPassword(e.target.value)}
                        autoComplete="current-password"
                        className="rounded-sm"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="newPassword">new password</Label>
                      <Input
                        id="newPassword"
                        type="password"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder="at least 8 characters"
                        autoComplete="new-password"
                        className="rounded-sm"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5 max-w-xs">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="passwordCode">email code</Label>
                      <button
                        className="text-xs text-hyper font-semibold hover:underline disabled:opacity-50 disabled:no-underline"
                        disabled={sendingCode || !currentPassword || newPassword.length < 8}
                        onClick={() => void requestCode()}
                      >
                        {sendingCode ? 'sending...' : deliveredCode ? 'resend code' : 'send code'}
                      </button>
                    </div>
                    <Input
                      id="passwordCode"
                      inputMode="numeric"
                      maxLength={6}
                      value={passwordCode}
                      onChange={(e) => setPasswordCode(e.target.value.replace(/\D/g, ''))}
                      placeholder="000000"
                      className="rounded-sm tracking-[0.3em] text-center tabular-nums"
                    />
                    {deliveredCode && (
                      <p className="text-xs text-muted-foreground rounded-sm border border-border bg-app-raise px-2.5 py-1.5">
                        sent to {me.email}. no mail server in this build, so the code is here:{' '}
                        <span className="text-foreground font-semibold tabular-nums">{deliveredCode}</span>
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-sm press"
                    disabled={!currentPassword || newPassword.length < 8 || passwordCode.length !== 6 || savingPassword}
                    onClick={() => void savePassword()}
                  >
                    <Check className="size-4" />
                    {savingPassword ? 'changing' : 'change password'}
                  </Button>
                </>
              )}
            </div>

            <div>
              <Button variant="destructive" size="sm" className="rounded-sm" onClick={() => void doLogout()}>
                <LogOut className="size-4" />
                sign out
              </Button>
            </div>
          </section>
        )}
      </div>

      <EmailVerifyDialog
        open={emailDialogOpen}
        onOpenChange={setEmailDialogOpen}
        reason="account"
        initialEmail={me.email}
      />
    </div>
  )
}
