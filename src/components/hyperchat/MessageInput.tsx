'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { emitTyping, emitTypingStop } from '@/lib/client/socket'
import { apiClient, ApiError } from '@/lib/client/api'
import { formatBytes } from '@/lib/client/format'
import { sounds } from '@/lib/client/sounds'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useToast } from '@/hooks/use-toast'
import { Paperclip, Send, X, AtSign, Reply as ReplyIcon, Clock, Lock, Gauge, CalendarClock, Check, AlertCircle, FileText, FileArchive, FileAudio, FileVideo, FileSpreadsheet, FileCode, Ghost, Film, Plus, Timer, Bold, Italic, Underline, Strikethrough, Code, Palette, Type, EyeOff, Mic } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PublicUser } from '@/lib/types'
import { PERM, hasPerm } from '@/lib/perm'
import { renderMessageContent } from '@/lib/client/markdown'
import { Avatar } from './Avatar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { EmojiPicker, expandShortcodes, exactShortcode, rememberRecent, rememberUsage, searchShortcodes } from './EmojiPicker'
import { confirmDialog } from './ConfirmDialog'
import { EmojiText } from '@/lib/client/serverEmoji'
import {
  VoiceRecorderBar,
  VOICE_BAR_COUNT,
  VOICE_MIN_SECONDS,
  VOICE_CAP_SECONDS,
  createLevelChannel,
  resampleWaveform,
} from './VoiceRecorderBar'

const MAX_IMAGE_DIM = 1600

/** Rich-text swatches for the advanced formatting drawer: readable on the
 *  dark chat surface, one tap each, plus a free hex field. */
const TEXT_COLORS = ['#ff5f6d', '#ff9f43', '#ffe259', '#5edc9a', '#4cc9f0', '#a78bfa', '#f472b6', '#ffffff'] as const
const TEXT_SIZES = [14, 17, 20, 24] as const

/** true when the draft carries any renderable markup: the live preview
 *  only earns its row when there is something to preview. */
const MARKUP_RE = /(\*\*|__|~~|(?<![*])\*(?!\*)|\|\||\|`|\[c=|\[s=|#{1,3} |^> )/m

/** Slash commands: Discord muscle memory plus a couple of extras. Applied on
 *  send, so they stay invisible until used. Unknown /words pass through. */
function applySlashCommands(raw: string): string {
  if (!raw.startsWith('/')) return raw
  const spaceIdx = raw.indexOf(' ')
  const cmd = spaceIdx === -1 ? raw.slice(1) : raw.slice(1, spaceIdx)
  const rest = spaceIdx === -1 ? '' : raw.slice(spaceIdx + 1).trim()
  switch (cmd.toLowerCase()) {
    case 'shrug':
      return [rest, '¯\\_(ツ)_/¯'].filter(Boolean).join(' ')
    case 'tableflip':
      return [rest, '(╯°□°)╯︵ ┻━┻'].filter(Boolean).join(' ')
    case 'unflip':
      return [rest, '┬─┬ ノ( ゜-゜ノ)'].filter(Boolean).join(' ')
    case 'lenny':
      return [rest, '( ͡° ͜ʖ ͡°)'].filter(Boolean).join(' ')
    case 'me':
      return rest ? `*${rest}*` : raw
    case 'spoiler':
      return rest ? `||${rest}||` : raw
    default:
      return raw
  }
}
const MAX_ATTACHMENTS = 5
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_FILE_BYTES = 25 * 1024 * 1024
const IMAGE_MIME_RE = /^image\/(png|jpeg|gif|webp)$/i

/** timed-message windows for 1:1 DMs, offered in the "+" menu: rare
 *  enough to live behind a dropdown instead of a dedicated control */
const TEMP_CHOICES: { value: number | null; label: string }[] = [
  { value: null, label: 'off' },
  { value: 60, label: '1 hour' },
  { value: 1440, label: '24 hours' },
  { value: 10080, label: '7 days' },
]

/** The slash palette: shown while the first word of the draft is being
 *  typed. Args in brackets, one short line each, lowercase. */
const SLASH_COMMANDS: { name: string; args?: string; desc: string }[] = [
  { name: 'shrug', desc: 'appends ¯\\_(ツ)_/¯' },
  { name: 'tableflip', desc: 'appends (╯°□°)╯︵ ┻━┻' },
  { name: 'unflip', desc: 'appends ┬─┬ ノ( ゜-゜ノ)' },
  { name: 'lenny', desc: 'appends ( ͡° ͜ʖ ͡°)' },
  { name: 'me', args: 'message', desc: 'italic action text' },
  { name: 'spoiler', args: 'text', desc: 'hides text until tapped' },
  { name: 'whisper', args: '@user message', desc: 'private aside (servers, groups)' },
  { name: 'giphy', args: 'query', desc: 'sends a gif for the query' },
  { name: 'nick', args: 'name', desc: 'changes your server nickname' },
  { name: 'roll', args: 'NdM', desc: 'rolls dice, like d20 or 2d6' },
]

type UploadResult = { url: string; name: string; size: number; type: string }

type PendingAttachment = {
  id: string
  file: File
  kind: 'image' | 'file'
  /** object URL for image previews, revoked on remove/clear */
  previewUrl: string | null
  name: string
  size: number
  state: 'uploading' | 'done' | 'error'
  result?: UploadResult
}

/** Map a mime type (plus filename fallback) to its chip icon. */
function fileIconFor(mime: string, name: string): typeof FileText {
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
  if (mime.startsWith('audio/')) return FileAudio
  if (mime.startsWith('video/')) return FileVideo
  if (/^(zip|rar|7z|gz|tar)$/.test(ext) || /zip|rar|7z|compressed/.test(mime)) return FileArchive
  if (/^(csv|xls|xlsx)$/.test(ext) || /csv|excel|spreadsheet/.test(mime)) return FileSpreadsheet
  if (/^(js|mjs|cjs|ts|tsx|jsx|html|htm|css)$/.test(ext) || /javascript|typescript|html|css/.test(mime)) return FileCode
  return FileText
}

/** Downscale large raster images in the browser before upload. GIFs pass through
 *  untouched because canvas re-encoding would strip their animation. */
async function processImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif' || file.size <= 300 * 1024) {
    return file
  }
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(bitmap.width, bitmap.height))
    const w = Math.round(bitmap.width * scale)
    const h = Math.round(bitmap.height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    return blob && blob.size < file.size ? blob : file
  } catch {
    return file
  }
}

/** Detect the @token the caret currently sits in, for mention autocomplete. */
function activeMentionToken(content: string, caret: number): string | null {
  const before = content.slice(0, caret)
  const match = before.match(/(^|\s)@([a-z0-9_]*)$/i)
  if (!match) return null
  return match[2].toLowerCase()
}

/** Detect the :shortcode the caret currently sits in, for :emoji: autocomplete. */
function activeEmojiToken(content: string, caret: number): string | null {
  const before = content.slice(0, caret)
  const match = before.match(/(^|\s):([a-z0-9_+\-]*)$/i)
  if (!match) return null
  return match[2].toLowerCase()
}

/** The moment a :shortcode: gets its closing colon, the emoji drops in
 *  straight away: no enter, no picker, just the character replacing the
 *  token. Returns null when the token is not a known shortcode. */
function autofillClosedColon(value: string, caret: number): { value: string; caret: number; char: string } | null {
  const before = value.slice(0, caret)
  const m = before.match(/(^|\s):([a-z0-9_+\-]+):$/i)
  if (!m) return null
  const hit = exactShortcode(m[2].toLowerCase())
  if (!hit) return null
  const start = caret - m[0].length + m[1].length
  const next = value.slice(0, start) + hit.char + ' ' + value.slice(caret)
  return { value: next, caret: start + hit.char.length + 1, char: hit.char }
}

export function MessageInput({ room }: { room: string }) {
  const sendMessage = useChatStore((s) => s.sendMessage)
  const me = useChatStore((s) => s.me)
  const activeServerId = useChatStore((s) => s.activeServerId)
  const serverMembers = useChatStore((s) => s.serverMembers)
  const servers = useChatStore((s) => s.servers)
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const replyTo = useChatStore((s) => s.replyTo)
  const setReplyTo = useChatStore((s) => s.setReplyTo)
  const requestEdit = useChatStore((s) => s.requestEdit)
  const roomState = useChatStore((s) => s.rooms[room])
  const drafts = useChatStore((s) => s.drafts)
  const setDraft = useChatStore((s) => s.setDraft)
  const scheduleMessage = useChatStore((s) => s.scheduleMessage)
  const scheduled = useChatStore((s) => s.scheduled)
  const refreshScheduled = useChatStore((s) => s.refreshScheduled)
  const setScheduledOpen = useChatStore((s) => s.setScheduledOpen)
  const pendingInsert = useChatStore((s) => s.pendingInsert)
  const serverEmoji = useChatStore((s) => s.serverEmoji)
  const { toast } = useToast()

  const [content, setContent] = useState('')
  const [items, setItems] = useState<PendingAttachment[]>([])
  const [sending, setSending] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const itemSeq = useRef(0)
  const [slowLeft, setSlowLeft] = useState(0)
  const [showSchedule, setShowSchedule] = useState(false)
  const [scheduleAt, setScheduleAt] = useState('')
  const [formatOpen, setFormatOpen] = useState(false)
  const [hexDraft, setHexDraft] = useState('')
  /** live voice recording (false when idle): the recorder, meter graph and
   *  sample buffer all live in refs so the composer never re-renders while
   *  talking — only the recording bar does, fed by the level channel */
  const [voiceActive, setVoiceActive] = useState(false)
  /** mic capture exists only where MediaRecorder does; flips after mount so
   *  the server-rendered tree matches hydration (button hidden, then shown) */
  const [voiceSupported, setVoiceSupported] = useState(false)
  const voiceRecorder = useRef<MediaRecorder | null>(null)
  const voiceStream = useRef<MediaStream | null>(null)
  const voiceChunks = useRef<Blob[]>([])
  const voiceLoop = useRef<ReturnType<typeof setInterval> | null>(null)
  const voiceStartedAt = useRef(0)
  const voiceSamples = useRef<number[]>([])
  const voiceAudio = useRef<{ ctx: AudioContext; analyser: AnalyserNode; buf: Uint8Array<ArrayBuffer> } | null>(null)
  const voiceChannel = useMemo(() => createLevelChannel(), [])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [emojiQuery, setEmojiQuery] = useState<string | null>(null)
  const [emojiIndex, setEmojiIndex] = useState(0)
  // slash palette: live while the draft is "/word" with no space yet
  const [slashDismissed, setSlashDismissed] = useState<string | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  // whisper mode: a toggle + target, not a command. Every message goes as a
  // private aside to this member until it is turned back off.
  const [whisperTarget, setWhisperTarget] = useState<PublicUser | null>(null)
  // "+" menu -> picker open request (bump `at` to open in a mode)
  const [pickerRequest, setPickerRequest] = useState<{ mode: 'emoji' | 'gifs'; at: number } | undefined>()

  // mic capture support is a browser fact: settled after mount so the
  // server tree (no mic button) hydrates identically, then the button
  // appears where MediaRecorder exists and never where it does not
  useEffect(() => {
    setVoiceSupported(!!navigator.mediaDevices?.getUserMedia && typeof window.MediaRecorder !== 'undefined')
  }, [])

  // a recording cannot outlive its composer: stop tracks and timers quietly
  // on unmount (room switches cancel explicitly in their own reset block)
  useEffect(() => {
    return () => {
      if (voiceLoop.current) clearInterval(voiceLoop.current)
      try {
        voiceRecorder.current?.stop()
      } catch {
        /* already stopped */
      }
      voiceStream.current?.getTracks().forEach((t) => t.stop())
      const audio = voiceAudio.current
      if (audio) void audio.ctx.close().catch(() => {})
    }
  }, [])

  // ---- channel moderation context ----
  const activeChannelId = room.startsWith('channel:') ? room.slice('channel:'.length) : null
  const server = activeServerId ? servers.find((s) => s.id === activeServerId) : null
  const channel = activeChannelId ? server?.channels.find((c) => c.id === activeChannelId) ?? null : null
  const myPerms = server?.myPerms ?? 0
  const canMod = (myPerms & (PERM.ADMINISTRATOR | PERM.MANAGE_MESSAGES)) !== 0
  const myMembership = activeServerId
    ? (serverMembers[activeServerId] ?? []).find((m) => m.id === me?.id) ?? null
    : null
  const timeoutLeftMs = myMembership?.timeoutUntil
    ? Math.max(0, new Date(myMembership.timeoutUntil).getTime() - Date.now())
    : 0
  const locked = !!channel?.locked && !canMod
  const slowmode = channel && channel.slowmodeSeconds > 0 && !canMod ? channel.slowmodeSeconds : 0

  const pendingHere = useMemo(
    () => scheduled.filter((r) => r.scopeKey === room).length,
    [scheduled, room]
  )

  // slowmode countdown: distance to my last message in this room
  useEffect(() => {
    if (!slowmode) {
      setSlowLeft(0)
      return
    }
    const compute = () => {
      const mine = (roomState?.messages ?? []).filter((m) => m.authorId === me?.id)
      const last = mine[mine.length - 1]
      if (!last) {
        setSlowLeft(0)
        return
      }
      const elapsed = (Date.now() - new Date(last.createdAt).getTime()) / 1000
      setSlowLeft(elapsed < slowmode ? Math.ceil(slowmode - elapsed) : 0)
    }
    compute()
    const t = setInterval(compute, 1000)
    return () => clearInterval(t)
  }, [slowmode, roomState?.messages, me?.id, room])

  // who can be mentioned here
  const mentionCandidates: PublicUser[] = useMemo(() => {
    if (activeServerId) {
      return (serverMembers[activeServerId] ?? []).filter((m) => m.id !== me?.id)
    }
    const convo = conversations.find((c) => c.id === activeConversationId)
    return convo ? [convo.otherUser] : []
  }, [activeServerId, serverMembers, me?.id, conversations, activeConversationId])

  const mentionMatches = useMemo(() => {
    if (mentionQuery === null) return []
    const q = mentionQuery.toLowerCase()
    return mentionCandidates
      .filter((u) => u.username.toLowerCase().includes(q))
      .slice(0, 6)
  }, [mentionQuery, mentionCandidates])

  const emojiMatches = useMemo(() => {
    if (emojiQuery === null) return []
    // custom server emoji first, then unicode shortcodes
    const custom = (activeServerId ? serverEmoji[activeServerId] ?? [] : [])
      .filter((e) => e.name.includes(emojiQuery))
      .slice(0, 4)
      .map((e) => ({ char: `:${e.name}:`, code: e.name }))
    return [...custom, ...searchShortcodes(emojiQuery, 8)]
  }, [emojiQuery, activeServerId, serverEmoji])

  // slash palette: matches for the "/word" being typed (no space yet)
  const slashMatches = useMemo(() => {
    if (!content.startsWith('/') || content.includes(' ') || content.length > 24) return []
    if (slashDismissed !== null && slashDismissed === content) return []
    const q = content.slice(1).toLowerCase()
    if (q === '') return SLASH_COMMANDS
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(q))
  }, [content, slashDismissed])

  useEffect(() => {
    setSlashIndex(0)
  }, [content])

  /** Fill the command into the draft with a trailing space. */
  function pickSlashCommand(name: string) {
    sounds.play('lightTick')
    const next = `/${name} `
    setContent(next)
    const el = textareaRef.current
    if (el) {
      el.focus()
      requestAnimationFrame(() => el.setSelectionRange(next.length, next.length))
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 132)}px`
    }
  }

  /** /giphy query: search the gif endpoint, send the first hit. */
  async function runGiphyCommand(query: string) {
    if (locked || slowLeft > 0 || timeoutLeftMs > 0) return
    setSending(true)
    clearComposer()
    try {
      const res = await fetch(`/api/gifs?q=${encodeURIComponent(query)}`)
      if (!res.ok) throw new Error('gif search failed')
      const data = (await res.json()) as { gifs?: { url: string; title: string }[] }
      const first = data.gifs?.[0]
      if (!first) {
        toast({ title: 'no gifs for that' })
        sounds.play('error')
        return
      }
      await sendMessage({ imageUrl: first.url, content: query || undefined })
    } catch {
      sounds.play('error')
      toast({ title: 'gif search failed' })
    } finally {
      setSending(false)
    }
  }

  /** /nick name: change my nickname in the current server. */
  async function runNickCommand(name: string) {
    if (!activeServerId || !me) {
      toast({ title: 'nicknames are for servers' })
      return
    }
    try {
      await apiClient.setMemberNickname(activeServerId, me.id, name.trim().slice(0, 32) || null)
      sounds.play('midTick')
      toast({ title: 'nickname updated' })
      clearComposer()
    } catch (err) {
      sounds.play('error')
      toast({ title: 'could not set nickname', description: err instanceof ApiError ? err.message : 'Try again.' })
    }
  }

  /** /roll NdM: dice roll posted as a message. */
  async function runRollCommand(spec: string) {
    const m = spec.trim().match(/^(\d{0,2})d(\d{1,4})$/i)
    let count = 1
    let sides = 20
    if (m) {
      count = Math.max(1, Math.min(20, parseInt(m[1] || '1', 10)))
      sides = Math.max(2, Math.min(1000, parseInt(m[2], 10)))
    } else if (/^\d{1,4}$/.test(spec.trim())) {
      sides = Math.max(2, Math.min(1000, parseInt(spec.trim(), 10)))
      count = 1
    }
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides))
    const total = rolls.reduce((a, b) => a + b, 0)
    const dice = `${count}d${sides}`
    const text =
      count === 1
        ? `rolled ${dice}: **${total}**`
        : `rolled ${dice}: ${rolls.join(' + ')} = **${total}**`
    clearComposer()
    try {
      await sendMessage({ content: text })
    } catch {
      // the failed row carries its own retry UI
    }
  }

  // who can receive a whisper here: server members, or group participants
  // (1:1 DMs are already private, so no whisper toggle is offered)
  const whisperCandidates: PublicUser[] = useMemo(() => {
    if (activeServerId) {
      return (serverMembers[activeServerId] ?? []).filter((m) => m.id !== me?.id)
    }
    const convo = conversations.find((c) => c.id === activeConversationId)
    if (convo?.kind === 'GROUP') {
      return (convo.participants ?? []).filter((p) => p.id !== me?.id)
    }
    return []
  }, [activeServerId, serverMembers, me?.id, conversations, activeConversationId])

  // ---- timed messages (1:1 DMs, from the "+" menu) ----
  const setTempExpiry = useChatStore((s) => s.setTempExpiry)
  const conversation = useMemo(
    () => conversations.find((c) => c.id === activeConversationId),
    [conversations, activeConversationId]
  )
  const isDmConversation = !activeServerId && conversation?.kind === 'DM'
  const activeTemp = conversation?.tempExpiryMinutes ?? null
  const [tempBusy, setTempBusy] = useState(false)

  async function pickTempExpiry(value: number | null) {
    if (!conversation || tempBusy || value === activeTemp) return
    setTempBusy(true)
    try {
      await setTempExpiry(conversation.id, value)
      sounds.play('lightTick')
    } catch {
      sounds.play('error')
      toast({ title: 'could not change the timer' })
    } finally {
      setTempBusy(false)
    }
  }

  // the selected target must still be a candidate for this room
  useEffect(() => {
    if (whisperTarget && !whisperCandidates.some((c) => c.id === whisperTarget.id)) {
      setWhisperTarget(null)
    }
  }, [whisperCandidates, whisperTarget])

  useEffect(() => {
    setMentionIndex(0)
  }, [mentionQuery])

  useEffect(() => {
    setEmojiIndex(0)
  }, [emojiQuery])

  // clear the reply banner when switching rooms
  useEffect(() => {
    setReplyTo(null)
    setWhisperTarget(null)
  }, [room])

  // restore the draft when switching rooms, persist it on every keystroke
  const [enteredRoom, setEnteredRoom] = useState<string | null>(null)
  if (room !== enteredRoom) {
    setEnteredRoom(room)
    setContent(drafts[room] ?? '')
    // a recording belongs to the room it started in: switching rooms
    // cancels it rather than shipping it to the wrong conversation
    if (voiceRecorder.current) stopVoiceRecording(false)
    // pending uploads belong to the room they were picked in
    setItems((cur) => {
      cur.forEach((i) => {
        if (i.previewUrl) URL.revokeObjectURL(i.previewUrl)
      })
      return []
    })
  }
  useEffect(() => {
    setDraft(room, content)

  }, [content])

  // keep the caret in the box: focus the input whenever the room changes (desktop only,
  // so phones do not get a keyboard shoved at them)
  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) {
      textareaRef.current?.focus()
    }

  }, [room])

  // the sidebar (right-click invite to server) can drop text into this
  // composer: consume one-shot inserts addressed to this room
  const lastInsertAt = useRef(0)
  useEffect(() => {
    if (!pendingInsert || pendingInsert.room !== room) return
    if (pendingInsert.at === lastInsertAt.current) return
    lastInsertAt.current = pendingInsert.at
    const el = textareaRef.current
    setContent((c) => (c ? `${c} ${pendingInsert.text}` : pendingInsert.text))
    sounds.play('lightTick')
    requestAnimationFrame(() => {
      el?.focus()
      const pos = el?.value.length ?? 0
      el?.setSelectionRange(pos, pos)
      if (el) autogrow(el)
    })
  }, [pendingInsert, room])

  function autogrow(el: HTMLTextAreaElement) {
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  function refreshAutocomplete(value: string, caret: number) {
    const mention = activeMentionToken(value, caret)
    const emoji = mention === null ? activeEmojiToken(value, caret) : null
    setMentionQuery(mention)
    setEmojiQuery(emoji)
  }

  function pickMention(user: PublicUser) {
    const el = textareaRef.current
    if (!el) return
    const caret = el.selectionStart ?? content.length
    const before = content.slice(0, caret)
    const after = content.slice(caret)
    // replace the @token with the full username
    const replaced = before.replace(/@([a-z0-9_]*)$/i, `@${user.username} `)
    const next = replaced + after
    setContent(next)
    setMentionQuery(null)
    sounds.play('lightTick')
    requestAnimationFrame(() => {
      el.focus()
      const pos = replaced.length
      el.setSelectionRange(pos, pos)
    })
  }

  /** Replace the :token with the literal emoji character. */
  function pickEmoji(char: string) {
    const el = textareaRef.current
    rememberRecent(char)
    rememberUsage(char)
    if (!el) return
    const caret = el.selectionStart ?? content.length
    const before = content.slice(0, caret)
    const after = content.slice(caret)
    const replaced = before.replace(/:([a-z0-9_+\-]*)$/i, `${char} `)
    const next = replaced + after
    setContent(next)
    setEmojiQuery(null)
    sounds.play('lightTick')
    requestAnimationFrame(() => {
      el.focus()
      const pos = replaced.length
      el.setSelectionRange(pos, pos)
      autogrow(el)
    })
  }

  function insertEmoji(emoji: string) {
    const el = textareaRef.current
    if (!el) {
      setContent((c) => c + emoji)
      return
    }
    const caret = el.selectionStart ?? content.length
    const next = content.slice(0, caret) + emoji + content.slice(caret)
    setContent(next)
    requestAnimationFrame(() => {
      el.focus()
      const pos = caret + emoji.length
      el.setSelectionRange(pos, pos)
      autogrow(el)
    })
  }

  /** Advanced formatting: wrap the textarea's current selection (or drop a
   *  placeholder at the caret) with a markup pair. The selection survives
   *  so chains like color-then-bold feel like one gesture. */
  function wrapSelection(before: string, after: string, placeholder = 'text') {
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart ?? content.length
    const end = el.selectionEnd ?? start
    const selected = content.slice(start, end) || placeholder
    const next = content.slice(0, start) + before + selected + after + content.slice(end)
    setContent(next)
    sounds.play('lightTick')
    requestAnimationFrame(() => {
      el.focus()
      const from = start + before.length
      el.setSelectionRange(from, from + selected.length)
      autogrow(el)
    })
  }

  /** Rich text (color + size) is free in dms and group chats, permission
   *  gated in servers — the drawer dims the locked half with the reason. */
  const inServerChannel = room.startsWith('channel:')
  const myServerPerms = servers.find((s) => s.id === activeServerId)?.myPerms ?? 0
  const richAllowed = !inServerChannel || hasPerm(myServerPerms, PERM.FANCY_FORMAT)

  const previewable = content.trim().length > 0 && MARKUP_RE.test(content)

  /** Send a picked GIF straight away, Discord-style; any typed text rides
   *  along as the caption. The optimistic row handles pending/failure. */
  async function sendGif(gif: { url: string; title: string }) {
    if (locked || slowLeft > 0 || timeoutLeftMs > 0) return
    const caption = expandShortcodes(content.trim())
    clearComposer()
    emitTypingStop(room)
    try {
      await sendMessage({ content: caption || undefined, imageUrl: gif.url })
    } catch {
      // the failed row carries its own retry UI
    }
  }

  /* ---- voice messages ---- */

  /** Start capture: MediaRecorder for the bits, an AnalyserNode for live
   *  RMS levels (sampled ~12 Hz into the level channel and the sample
   *  buffer). While live, the recording bar replaces the composer row;
   *  enter sends, esc cancels, and 3:00 auto-stops and sends. */
  async function startVoiceRecording() {
    if (voiceActive || locked) return
    if (!voiceSupported) {
      toast({ title: 'recording unavailable', description: 'this browser cannot record audio.' })
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      toast({ title: 'microphone unavailable', description: 'allow mic access to record a voice message.' })
      return
    }
    try {
      const mime =
        ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(
          (m) => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(m)
        ) ?? ''
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      voiceChunks.current = []
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) voiceChunks.current.push(e.data)
      }
      recorder.start(250)
      voiceRecorder.current = recorder
      voiceStream.current = stream

      // RMS meter: source -> analyser only, nothing routes to the speakers
      try {
        const ctx = new AudioContext()
        const source = ctx.createMediaStreamSource(stream)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 2048
        source.connect(analyser)
        if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
        voiceAudio.current = { ctx, analyser, buf: new Uint8Array(analyser.fftSize) }
      } catch {
        voiceAudio.current = null // metering is optional; the recording itself continues
      }

      voiceSamples.current = []
      voiceStartedAt.current = Date.now()
      sounds.play('lightTick')
      setVoiceActive(true)
      voiceChannel.push({ seconds: 0, levels: [] })

      voiceLoop.current = setInterval(() => {
        const audio = voiceAudio.current
        let level = 0
        if (audio) {
          audio.analyser.getByteTimeDomainData(audio.buf)
          let sum = 0
          for (let i = 0; i < audio.buf.length; i++) {
            const d = audio.buf[i] - 128
            sum += d * d
          }
          // perceptual fill: speech RMS sits around 0.05-0.3, x3 fills the bar
          level = Math.min(1, (Math.sqrt(sum / audio.buf.length) / 128) * 3)
        }
        voiceSamples.current.push(level)
        const seconds = (Date.now() - voiceStartedAt.current) / 1000
        voiceChannel.push({ seconds, levels: voiceSamples.current.slice(-VOICE_BAR_COUNT) })
        // hard cap: auto stop + send at 3:00
        if (seconds >= VOICE_CAP_SECONDS) stopVoiceRecording(true)
      }, 80)
    } catch {
      stream.getTracks().forEach((t) => t.stop())
      toast({ title: 'recording unavailable', description: 'this browser cannot record audio.' })
    }
  }

  /** Stop the session: send=true uploads and sends the voice message,
   *  anything under 0.5s (or with no bytes) is discarded as an accidental
   *  tap with a quiet toast. */
  function stopVoiceRecording(send: boolean) {
    const recorder = voiceRecorder.current
    const stream = voiceStream.current
    voiceRecorder.current = null
    voiceStream.current = null
    if (voiceLoop.current) {
      clearInterval(voiceLoop.current)
      voiceLoop.current = null
    }
    const audio = voiceAudio.current
    voiceAudio.current = null
    if (audio) void audio.ctx.close().catch(() => {})
    const duration = voiceStartedAt.current ? (Date.now() - voiceStartedAt.current) / 1000 : 0
    voiceStartedAt.current = 0
    setVoiceActive(false)
    if (!recorder) {
      stream?.getTracks().forEach((t) => t.stop())
      return
    }
    const finish = () => {
      stream?.getTracks().forEach((t) => t.stop())
      const type = recorder.mimeType || 'audio/webm'
      const blob = new Blob(voiceChunks.current, { type })
      voiceChunks.current = []
      if (!send) {
        sounds.play('lightTick')
        return
      }
      if (blob.size === 0 || duration < VOICE_MIN_SECONDS) {
        toast({ title: 'recording too short' })
        return
      }
      void sendVoiceMessage(blob, type, duration, resampleWaveform(voiceSamples.current))
    }
    if (recorder.state === 'recording' || recorder.state === 'paused') {
      recorder.onstop = finish
      recorder.stop()
    } else {
      finish()
    }
  }

  /** A finished recording uploads through the same attachment endpoint as
   *  any file and sends immediately as a normal message carrying a voice
   *  attachment ({ kind: 'voice', duration, waveform: 40 ints 0..100 });
   *  text typed before the recording rides along as the caption. */
  async function sendVoiceMessage(blob: Blob, type: string, duration: number, waveform: number[]) {
    if (locked || slowLeft > 0 || timeoutLeftMs > 0) return
    const caption = expandShortcodes(content.trim())
    const ext = type.includes('mp4') ? 'm4a' : 'webm'
    const file = new File([blob], `voice message.${ext}`, { type })
    const whisperTo = whisperTarget ? whisperTarget.username.toLowerCase() : undefined
    try {
      const res = await apiClient.uploadFile(file)
      // clear only the text; pending tray attachments stay for the next send
      setContent('')
      setMentionQuery(null)
      setEmojiQuery(null)
      emitTypingStop(room)
      await sendMessage({
        content: caption || undefined,
        attachments: [
          {
            url: res.url,
            name: 'voice message',
            size: res.size,
            mime: res.type,
            kind: 'voice',
            duration: Math.round(duration * 10) / 10,
            waveform,
          },
        ],
        whisperTo,
      })
    } catch {
      toast({ title: 'could not send the voice message', description: 'try again in a moment.' })
      sounds.play('error')
    }
  }

  /** Drop a picked/dropped File into the tray and start its upload right away. */
  function intakeFiles(list: FileList | File[]) {
    const incoming = Array.from(list)
    if (incoming.length === 0) return
    const slots = MAX_ATTACHMENTS - items.length
    if (slots <= 0) {
      toast({ title: 'attachment limit', description: 'up to 5 files per message.' })
      return
    }
    const accepted = incoming.slice(0, slots)
    if (accepted.length < incoming.length) {
      toast({ title: 'attachment limit', description: 'up to 5 files per message.' })
    }
    const next: PendingAttachment[] = [...items]
    let added = false
    for (const file of accepted) {
      const isImage = IMAGE_MIME_RE.test(file.type)
      if (!isImage && file.size > MAX_FILE_BYTES) {
        toast({ title: 'file too large', description: 'files must stay under 25 MB' })
        continue
      }
      // GIFs bypass the downscale, so they must fit the image cap as picked
      if (isImage && file.type === 'image/gif' && file.size > MAX_IMAGE_BYTES) {
        toast({ title: 'file too large', description: 'images must stay under 8 MB' })
        continue
      }
      const item: PendingAttachment = {
        id: `at-${++itemSeq.current}`,
        file,
        kind: isImage ? 'image' : 'file',
        previewUrl: isImage ? URL.createObjectURL(file) : null,
        name: file.name,
        size: file.size,
        state: 'uploading',
      }
      next.push(item)
      added = true
      void startUpload(item)
    }
    if (added) {
      setItems(next)
      sounds.play('lightTick')
    }
  }

  /** Upload one tray item now (used at intake and on retry). Images run through
   *  the downscale first; GIFs pass through untouched. */
  async function startUpload(item: PendingAttachment) {
    setItems((cur) => cur.map((i) => (i.id === item.id ? { ...i, state: 'uploading' as const, result: undefined } : i)))
    try {
      let blob: Blob = item.file
      if (item.kind === 'image') {
        blob = await processImage(item.file)
        if (blob.size > MAX_IMAGE_BYTES) {
          toast({ title: 'file too large', description: 'images must stay under 8 MB' })
          removeItem(item.id)
          return
        }
      }
      const res = await apiClient.uploadFile(asNamedFile(item.file, blob))
      setItems((cur) =>
        cur.map((i) =>
          i.id === item.id
            ? { ...i, state: 'done' as const, result: { url: res.url, name: res.name, size: res.size, type: res.type } }
            : i
        )
      )
    } catch {
      // the chip shows the error state; clicking it retries
      setItems((cur) => cur.map((i) => (i.id === item.id ? { ...i, state: 'error' as const, result: undefined } : i)))
    }
  }

  function retryUpload(id: string) {
    const item = items.find((i) => i.id === id)
    if (!item || item.state === 'uploading') return
    void startUpload(item)
  }

  function removeItem(id: string) {
    setItems((cur) => {
      const doomed = cur.find((i) => i.id === id)
      if (doomed?.previewUrl) URL.revokeObjectURL(doomed.previewUrl)
      return cur.filter((i) => i.id !== id)
    })
  }

  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    // snapshot BEFORE the value reset: clearing input.value empties the live
    // FileList in every browser, which silently dropped every picked file
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (files.length === 0) return
    intakeFiles(files)
  }

  /** Rebuild a File with the original filename, fixing the extension when
   *  processImage re-encoded the blob (png -> jpeg keeps serving correctly). */
  function asNamedFile(original: File, blob: Blob): File {
    if (blob instanceof File && blob.name === original.name) return blob
    const ext = (blob.type.split('/')[1] ?? '').toLowerCase()
    const cur = original.name.includes('.') ? (original.name.split('.').pop() ?? '').toLowerCase() : ''
    const same = ext === cur || (ext === 'jpeg' && cur === 'jpg') || (ext === 'jpg' && cur === 'jpeg')
    let name = original.name
    if (ext && !same) {
      name = `${original.name.replace(/\.[a-zA-Z0-9]{1,8}$/, '') || 'upload'}.${ext}`
    }
    return new File([blob], name, { type: blob.type || original.type })
  }

  // ---- drag & drop intake on the composer wrapper ----
  function hasFileDrag(e: React.DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files')
  }
  function handleDragEnter(e: React.DragEvent) {
    if (!hasFileDrag(e)) return
    e.preventDefault()
    dragDepth.current += 1
    setDragActive(true)
  }
  function handleDragOver(e: React.DragEvent) {
    if (!hasFileDrag(e)) return
    e.preventDefault()
  }
  function handleDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragActive(false)
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    dragDepth.current = 0
    setDragActive(false)
    const files = e.dataTransfer?.files
    if (files && files.length > 0) intakeFiles(files)
  }

  const doneResults = items.filter((i) => i.state === 'done' && i.result).map((i) => i.result!)
  const uploadingAny = items.some((i) => i.state === 'uploading')

  /** Optimistic submit: text clears instantly, the row appears dimmed with a
   *  clock, and the network round trip happens behind it. Failures surface on
   *  the row itself with retry / discard. */
  async function submit() {
    const raw = content.trim()
    if ((!raw && doneResults.length === 0) || sending) return
    // uploads settle first: the send button spins until then
    if (uploadingAny) return
    const attachments = doneResults.map((r) => ({ url: r.url, name: r.name, size: r.size, mime: r.type }))

    // /nick: a server action, not a message
    const nm = raw.match(/^\/nick\s+(.+)$/i)
    if (nm) {
      await runNickCommand(nm[1])
      return
    }
    // /giphy query: the gif rides as the message itself
    const gm = raw.match(/^\/giphy\s+(.+)$/i)
    if (gm) {
      await runGiphyCommand(gm[1])
      return
    }
    // /roll [NdM]: dice roll as a message
    const rm = raw.match(/^\/roll(?:\s+([^\s]+))?$/i)
    if (rm) {
      await runRollCommand(rm[1] ?? 'd20')
      return
    }

    // /whisper @user message still works for muscle memory, but the toggle
    // is the primary path: whisperTarget rides every send while it is on
    let whisperTo: string | undefined
    let body = raw
    const wm = raw.match(/^\/(?:whisper|w)\s+@?([a-z0-9_]+)\s+([\s\S]+)$/i)
    if (wm) {
      const convo = conversations.find((c) => c.id === activeConversationId)
      const isDM = !room.startsWith('channel:') && (!convo || (convo.participants?.length ?? 2) <= 2)
      if (isDM) {
        toast({ title: 'whispers are for servers and groups' })
        return
      }
      whisperTo = wm[1].toLowerCase()
      body = wm[2]
    } else if (whisperTarget) {
      whisperTo = whisperTarget.username.toLowerCase()
    }

    const text = expandShortcodes(applySlashCommands(body))
    clearComposer()
    emitTypingStop(room)
    try {
      await sendMessage({
        content: body ? text : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
        whisperTo,
      })
    } catch {
      // failed row shows retry / discard inline
    }
  }

  function clearComposer() {
    setContent('')
    setMentionQuery(null)
    setEmojiQuery(null)
    setItems((cur) => {
      cur.forEach((i) => {
        if (i.previewUrl) URL.revokeObjectURL(i.previewUrl)
      })
      return []
    })
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  /** Schedule the current draft for later delivery. */
  async function submitScheduled() {
    const text = expandShortcodes(content.trim())
    if (!text) return
    let when: Date
    if (scheduleAt) {
      when = new Date(scheduleAt)
    } else {
      when = new Date(Date.now() + 15 * 60 * 1000)
    }
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now() + 5000) {
      toast({ title: 'pick a later time', description: 'Scheduled messages need a time at least a few seconds ahead.' })
      return
    }
    setSending(true)
    try {
      await scheduleMessage(room, text, when)
      sounds.play('midTick')
      clearComposer()
      setShowSchedule(false)
      setScheduleAt('')
      toast({
        title: 'message scheduled',
        description: `Scheduled for ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`,
      })
      void refreshScheduled()
    } catch (err) {
      sounds.play('error')
      toast({ title: 'could not schedule', description: err instanceof ApiError ? err.message : 'Try again.' })
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // slash command palette navigation (first: it swallows Enter/Tab/Arrows)
    if (slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex((i) => (i + 1) % slashMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pickSlashCommand(slashMatches[slashIndex].name)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissed(content)
        return
      }
    }

    // :emoji: autocomplete navigation
    if (emojiQuery !== null && emojiMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setEmojiIndex((i) => (i + 1) % emojiMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setEmojiIndex((i) => (i - 1 + emojiMatches.length) % emojiMatches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pickEmoji(emojiMatches[emojiIndex].char)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setEmojiQuery(null)
        return
      }
    }

    // mention autocomplete navigation
    if (mentionQuery !== null && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((i) => (i + 1) % mentionMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pickMention(mentionMatches[mentionIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionQuery(null)
        return
      }
    }

    // up-arrow on an empty input edits my last message (Discord muscle memory)
    if (e.key === 'ArrowUp' && content === '' && items.length === 0) {
      const mine = (roomState?.messages ?? []).filter((m) => m.authorId === me?.id && m.content)
      const last = mine[mine.length - 1]
      if (last) {
        e.preventDefault()
        sounds.play('lightTick')
        requestEdit(last.id)
      }
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
      // the box keeps focus through the send: nothing disables it, so the
      // caret never leaves and the next sentence is already typing
    }
  }

  const canSend = (!!content.trim() || doneResults.length > 0) && !locked && slowLeft === 0 && timeoutLeftMs === 0

  // a locked or timed-out member sees the reason instead of a composer
  const blockedReason = timeoutLeftMs > 0
    ? `You are timed out for ${Math.ceil(timeoutLeftMs / 60000)} more minute${Math.ceil(timeoutLeftMs / 60000) === 1 ? '' : 's'}.`
    : locked
      ? 'This channel is locked. Only moderators can post.'
      : null

  return (
    <div className="shrink-0 px-3 sm:px-4 pb-4 pt-1 relative">
      {/* slash command palette */}
      {slashMatches.length > 0 && (
        <div
          className="absolute bottom-full left-3 sm:left-4 mb-2 w-72 bg-popover border border-border rounded-sm shadow-xl overflow-hidden z-20"
          role="listbox"
          aria-label="slash commands"
        >
          <div className="px-2.5 py-1.5 text-[10px] font-bold tracking-widest text-muted-foreground border-b border-border">
            commands
          </div>
          <div className="max-h-64 overflow-y-auto scroll-thin">
            {slashMatches.map((c, i) => (
              <button
                key={c.name}
                role="option"
                aria-selected={i === slashIndex}
                onClick={() => pickSlashCommand(c.name)}
                onMouseEnter={() => setSlashIndex(i)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors',
                  i === slashIndex ? 'bg-accent text-foreground' : 'text-foreground/80 hover:bg-accent/60'
                )}
              >
                <span className="text-sm font-semibold text-foreground shrink-0">/{c.name}</span>
                {c.args && <span className="text-[11px] text-muted-foreground shrink-0 truncate">{c.args}</span>}
                <span className="ml-auto text-[10px] text-muted-foreground truncate">{c.desc}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {/* :emoji: shortcode autocomplete */}
      {emojiQuery !== null && emojiMatches.length > 0 && (
        <div
          className="absolute bottom-full left-3 sm:left-4 mb-2 w-64 bg-popover border border-border rounded-sm shadow-xl overflow-hidden z-20"
          role="listbox"
          aria-label="emoji suggestions"
        >
          <div className="px-2.5 py-1.5 text-[10px] font-bold tracking-widest text-muted-foreground border-b border-border">
            emoji
          </div>
          {emojiMatches.map((m, i) => (
            <button
              key={`${m.char}-${m.code}`}
              role="option"
              aria-selected={i === emojiIndex}
              onClick={() => pickEmoji(m.char)}
              onMouseEnter={() => setEmojiIndex(i)}
              className={cn(
                'w-full flex items-center gap-2.5 px-2.5 py-1.5 text-sm text-left transition-colors',
                i === emojiIndex ? 'bg-accent text-foreground' : 'text-foreground/80 hover:bg-accent/60'
              )}
            >
              <span className="text-base leading-none">
                <EmojiText emoji={m.char} />
              </span>
              <span className="truncate text-xs text-muted-foreground font-mono">:{m.code}:</span>
            </button>
          ))}
        </div>
      )}

      {/* mention autocomplete */}
      {mentionQuery !== null && mentionMatches.length > 0 && (
        <div
          className="absolute bottom-full left-3 sm:left-4 mb-2 w-64 bg-popover border border-border rounded-sm shadow-xl overflow-hidden z-20"
          role="listbox"
          aria-label="mention suggestions"
        >
          <div className="px-2.5 py-1.5 text-[10px] font-bold tracking-widest text-muted-foreground border-b border-border">
            members
          </div>
          {mentionMatches.map((user, i) => (
            <button
              key={user.id}
              role="option"
              aria-selected={i === mentionIndex}
              onClick={() => pickMention(user)}
              onMouseEnter={() => setMentionIndex(i)}
              className={cn(
                'w-full flex items-center gap-2 px-2.5 py-1.5 text-sm text-left transition-colors',
                i === mentionIndex ? 'bg-accent text-foreground' : 'text-foreground/80 hover:bg-accent/60'
              )}
            >
              <AtSign className="size-3.5 text-muted-foreground shrink-0" />
              <span className="truncate font-medium">{user.username}</span>
              {user.displayName && (
                <span className="truncate text-xs text-muted-foreground ml-auto">{user.displayName}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* schedule composer */}
      {showSchedule && (
        <div className="absolute bottom-full right-3 sm:right-4 mb-2 w-72 bg-popover border border-border rounded-sm shadow-xl p-3 z-20 dialog-in">
          <div className="flex items-center gap-2 mb-2">
            <CalendarClock className="size-4 text-hyper shrink-0" />
            <p className="text-[13px] font-bold">schedule this message</p>
            <button
              onClick={() => setShowSchedule(false)}
              className="ml-auto p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              aria-label="close scheduler"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="flex flex-wrap gap-1 mb-2">
            {[
              { label: '+15m', ms: 15 * 60 * 1000 },
              { label: '+1h', ms: 60 * 60 * 1000 },
              { label: '+8h', ms: 8 * 60 * 60 * 1000 },
              { label: 'tomorrow', ms: 24 * 60 * 60 * 1000 },
            ].map((p) => (
              <button
                key={p.label}
                onClick={() => {
                  const d = new Date(Date.now() + p.ms)
                  setScheduleAt(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)
                }}
                className="px-2 py-1 text-[11px] font-semibold rounded-sm border border-white/15 hover:border-hyper/60 hover:text-hyper transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="datetime-local"
            value={scheduleAt}
            onChange={(e) => setScheduleAt(e.target.value)}
            className="w-full bg-app-raise border border-white/15 rounded-sm px-2 py-1.5 text-xs outline-none focus:border-hyper/60 transition-colors mb-2"
            aria-label="send time"
          />
          <Button size="sm" className="w-full rounded-sm press" disabled={!content.trim()} onClick={() => void submitScheduled()}>
            <CalendarClock className="size-3.5" /> schedule
          </Button>
        </div>
      )}

      <div
        data-composer-root
        className={cn('relative rounded-sm bg-app-raise border border-white/10 focus-within:border-hyper/50 transition-colors')}
        onDragEnter={blockedReason ? undefined : handleDragEnter}
        onDragOver={blockedReason ? undefined : handleDragOver}
        onDragLeave={blockedReason ? undefined : handleDragLeave}
        onDrop={blockedReason ? undefined : handleDrop}
      >
        {dragActive && (
          <div className="absolute inset-0 z-10 rounded-sm ring-1 ring-hyper bg-hyper/5 pointer-events-none flex items-center justify-center text-sm font-semibold text-hyper">
            drop to attach
          </div>
        )}
        {blockedReason ? (
          <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground select-none">
            {timeoutLeftMs > 0 ? <Clock className="size-4 text-destructive shrink-0" /> : <Lock className="size-4 shrink-0" />}
            <span className="truncate">{blockedReason}</span>
          </div>
        ) : (
          <>
        {/* reply banner */}
        {replyTo && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/10 text-xs text-muted-foreground">
            <ReplyIcon className="size-3.5 shrink-0 text-hyper" />
            <span className="shrink-0 font-semibold text-foreground/80">
              replying to {replyTo.author.displayName || replyTo.author.username}
            </span>
            <span className="truncate flex-1 opacity-70">
              {replyTo.content ?? 'image'}
            </span>
            <button
              onClick={() => setReplyTo(null)}
              className="p-1 rounded-sm hover:text-foreground hover:bg-accent transition-colors shrink-0"
              aria-label="cancel reply"
              title="cancel reply"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {/* whisper banner: while the toggle is on, every send is private */}
        {whisperTarget && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/10 text-xs text-muted-foreground fade-in">
            <Ghost className="size-3.5 shrink-0 text-hyper" />
            <span className="shrink-0 font-semibold text-foreground/80">
              whispering to {whisperTarget.displayName || whisperTarget.username}
            </span>
            <span className="flex-1" />
            <button
              onClick={() => {
                sounds.play('lightTick')
                setWhisperTarget(null)
              }}
              className="p-1 rounded-sm hover:text-foreground hover:bg-accent transition-colors shrink-0"
              aria-label="stop whispering"
              title="stop whispering"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {items.length > 0 && (
          <div className="flex flex-wrap gap-2 p-2 border-b border-white/10">
            {items.map((item) =>
              item.previewUrl ? (
                <div
                  key={item.id}
                  className={cn('relative size-14 shrink-0', item.state === 'error' && 'cursor-pointer')}
                  onClick={item.state === 'error' ? () => retryUpload(item.id) : undefined}
                  title={item.state === 'error' ? 'Retry upload' : item.name}
                >
                  <img
                    src={item.previewUrl}
                    alt={`Attachment ${item.name}`}
                    className="size-14 rounded-sm object-cover border border-white/10"
                    draggable={false}
                  />
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeItem(item.id)
                    }}
                    className="absolute top-0.5 right-0.5 grid size-4 place-items-center rounded-sm bg-black/70 text-foreground/90 hover:bg-black transition-colors"
                    aria-label={`Remove ${item.name}`}
                    title={`Remove ${item.name}`}
                  >
                    <X className="size-2.5" />
                  </button>
                  {item.state === 'uploading' && (
                    <span className="absolute bottom-0.5 right-0.5 grid size-4 place-items-center rounded-sm bg-black/70">
                      <Spinner className="size-2.5" />
                    </span>
                  )}
                  {item.state === 'done' && (
                    <span className="absolute bottom-0.5 right-0.5 grid size-4 place-items-center rounded-sm bg-black/70">
                      <Check className="size-3 text-hyper" />
                    </span>
                  )}
                  {item.state === 'error' && (
                    <span className="absolute bottom-0.5 right-0.5 grid size-4 place-items-center rounded-sm bg-black/70">
                      <AlertCircle className="size-3 text-destructive" />
                    </span>
                  )}
                </div>
              ) : (
                <div
                  key={item.id}
                  className={cn(
                    'w-44 flex items-center gap-2 rounded-sm border bg-app-chat/50 px-2 py-1.5',
                    item.state === 'error' ? 'border-destructive/50 cursor-pointer' : 'border-white/10'
                  )}
                  onClick={item.state === 'error' ? () => retryUpload(item.id) : undefined}
                  title={item.state === 'error' ? 'Retry upload' : item.name}
                >
                  {(() => {
                    const Icon = fileIconFor(item.file.type, item.name)
                    return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  })()}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium leading-tight">{item.name}</span>
                    <span className="block text-[10px] text-muted-foreground">{formatBytes(item.size)}</span>
                  </span>
                  <span className="grid size-4 shrink-0 place-items-center">
                    {item.state === 'uploading' ? (
                      <Spinner className="size-3" />
                    ) : item.state === 'done' ? (
                      <Check className="size-3 text-hyper" />
                    ) : (
                      <AlertCircle className="size-3 text-destructive" />
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeItem(item.id)
                    }}
                    className="-mr-1 shrink-0 p-1 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    aria-label={`Remove ${item.name}`}
                    title={`Remove ${item.name}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              )
            )}
          </div>
        )}

        {/* advanced formatting drawer: bold/italic/underline/strike/code/
            spoiler wraps plus color and size. the locked half dims with the
            reason when the server has not granted rich formatting */}
        {formatOpen && (
          <div className="mx-2 mb-1 rounded-sm border border-white/10 bg-app-raise/70 px-2.5 py-2 fade-in">
            <div className="flex items-center gap-1.5 mb-2">
              <Type className="size-3.5 text-hyper shrink-0" aria-hidden="true" />
              <span className="text-[10px] font-bold tracking-widest text-muted-foreground lowercase select-none">
                advanced formatting
              </span>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => {
                  sounds.play('lightTick')
                  setFormatOpen(false)
                }}
                className="grid place-items-center size-6 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                aria-label="Close formatting drawer"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              {([
                ['**', '**', 'bold', Bold],
                ['*', '*', 'italic', Italic],
                ['__', '__', 'underline', Underline],
                ['~~', '~~', 'strike', Strikethrough],
                ['`', '`', 'code', Code],
                ['||', '||', 'spoiler', EyeOff],
              ] as const).map(([before, after, label, Icon]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => wrapSelection(before, after, label)}
                  className="grid place-items-center size-7 rounded-sm border border-white/10 bg-app-chat/60 text-foreground/80 hover:text-foreground hover:border-white/25 transition-colors"
                  aria-label={label}
                  title={label}
                >
                  <Icon className="size-3.5" />
                </button>
              ))}
              <span className="w-px h-5 bg-white/10 mx-1" aria-hidden="true" />
              {TEXT_SIZES.map((px) => (
                <button
                  key={px}
                  type="button"
                  disabled={!richAllowed}
                  onClick={() => wrapSelection(`[s=${px}]`, '[/s]')}
                  className={cn(
                    'px-2 py-1 rounded-sm border border-white/10 bg-app-chat/60 tabular-nums transition-colors',
                    richAllowed
                      ? 'text-foreground/80 hover:text-foreground hover:border-white/25'
                      : 'text-muted-foreground/40 cursor-not-allowed'
                  )}
                  style={{ fontSize: `${Math.min(15, px)}px` }}
                  aria-label={`text size ${px}px`}
                  title={richAllowed ? `${px}px` : 'needs the rich formatting permission'}
                >
                  {px}
                </button>
              ))}
              <span className="w-px h-5 bg-white/10 mx-1" aria-hidden="true" />
              {TEXT_COLORS.map((hex) => (
                <button
                  key={hex}
                  type="button"
                  disabled={!richAllowed}
                  onClick={() => wrapSelection(`[c=${hex}]`, '[/c]')}
                  className={cn(
                    'size-5 rounded-full border border-white/20 transition-transform',
                    richAllowed ? 'hover:scale-110 hover:border-white/50' : 'opacity-30 cursor-not-allowed'
                  )}
                  style={{ backgroundColor: hex }}
                  aria-label={`text color ${hex}`}
                  title={richAllowed ? hex : 'needs the rich formatting permission'}
                />
              ))}
              <span
                className={cn('flex items-center gap-1', !richAllowed && 'opacity-40 pointer-events-none')}
                title={richAllowed ? 'custom color' : 'needs the rich formatting permission'}
              >
                <input
                  value={hexDraft}
                  onChange={(e) => setHexDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      const v = hexDraft.trim()
                      if (/^#?[0-9a-fA-F]{6}$/.test(v)) {
                        wrapSelection(`[c=${v.startsWith('#') ? v : `#${v}`}]`, '[/c]')
                        setHexDraft('')
                      }
                    }
                  }}
                  placeholder="#hex"
                  maxLength={7}
                  disabled={!richAllowed}
                  className="w-16 bg-app-chat/60 border border-white/10 rounded-sm px-1.5 py-1 text-[11px] font-mono outline-none focus:border-hyper/60 placeholder:text-muted-foreground"
                  aria-label="custom text color"
                />
              </span>
            </div>
            {!richAllowed && (
              <p className="mt-1.5 text-[10px] text-muted-foreground/80">
                color and size need the rich formatting permission in this server. bold, italic and friends always work.
              </p>
            )}
          </div>
        )}

        {/* live preview: the draft rendered exactly as it will land, shown
            the moment it carries markup so wysiwyg beats guesswork */}
        {previewable && !locked && (
          <div className="mx-2 mb-1 rounded-sm border border-white/10 bg-app-chat/50 px-3 py-2 fade-in" aria-live="off">
            <p className="text-[10px] font-bold tracking-widest text-muted-foreground/70 lowercase mb-1 select-none">preview</p>
            <div className="chat-font text-[13px] leading-relaxed max-h-36 overflow-y-auto scroll-thin break-words">
              {renderMessageContent(content, { myUsername: me?.username })}
            </div>
          </div>
        )}

        {/* while recording, the bar REPLACES the composer row entirely:
            enter sends, escape cancels, the cap auto-sends at 3:00 */}
        {voiceActive ? (
          <VoiceRecorderBar
            channel={voiceChannel}
            onCancel={() => stopVoiceRecording(false)}
            onSend={() => stopVoiceRecording(true)}
          />
        ) : (
        <div className="flex items-end gap-1 p-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="*/*"
            className="hidden"
            onChange={onPickFile}
            aria-hidden="true"
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="p-2 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
            aria-label="attach files"
            title="attach files"
          >
            <Paperclip className="size-5" />
          </button>

          <textarea
            ref={textareaRef}
            value={content}
            autoFocus
            onChange={(e) => {
              const el = e.target
              const caret = el.selectionStart ?? el.value.length
              // closing a :shortcode: swaps the whole token for the emoji
              // before the character even renders: no enter needed
              const auto = autofillClosedColon(el.value, caret)
              if (auto) {
                rememberRecent(auto.char)
                rememberUsage(auto.char)
                setContent(auto.value)
                setEmojiQuery(null)
                sounds.play('lightTick')
                requestAnimationFrame(() => {
                  el.focus()
                  el.setSelectionRange(auto.caret, auto.caret)
                  autogrow(el)
                })
              } else {
                setContent(el.value)
                autogrow(el)
                refreshAutocomplete(el.value, caret)
              }
              emitTyping(room)
            }}
            onKeyDown={onKeyDown}
            onBlur={() => {
              // delay so click-on-suggestion still registers
              setTimeout(() => setMentionQuery((q) => (mentionMatches.length ? q : null)), 120)
            }}
            placeholder={whisperTarget ? `whisper to ${whisperTarget.displayName || whisperTarget.username}` : 'message'}
            rows={1}
            className="chat-font flex-1 resize-none bg-transparent outline-none leading-6 placeholder:text-muted-foreground max-h-40 py-1.5 scroll-thin"
            aria-label="message input"
          />

          {/* mic button: one tap starts a voice message; while recording the
              bar replaces this row entirely, so there is no toggle state.
              hidden entirely where MediaRecorder does not exist */}
          {voiceSupported && (
            <button
              type="button"
              onClick={() => void startVoiceRecording()}
              disabled={locked}
              className="p-2 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="record a voice message"
              title="voice message"
            >
              <Mic className="size-5" />
            </button>
          )}

          {/* dedicated gif button: opens the picker's gif tab straight
              away instead of hiding it behind the "+" menu */}
          <button
            type="button"
            onClick={() => {
              sounds.play('lightTick')
              setPickerRequest({ mode: 'gifs', at: Date.now() })
            }}
            className="p-2 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors shrink-0"
            aria-label="send a GIF"
            title="send a GIF"
          >
            <Film className="size-5" />
          </button>

          {/* emoji picker: one popover, two tabs */}
          <EmojiPicker onPick={insertEmoji} onGif={(gif) => void sendGif(gif)} openRequest={pickerRequest} />

          {/* the "+" menu: the rare send options (schedule, whisper,
              timed messages) live behind one button instead of crowding
              the composer with dedicated controls */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  'p-2 rounded-sm transition-colors shrink-0',
                  showSchedule || whisperTarget || !!conversation?.tempExpiryMinutes
                    ? 'text-hyper hover:bg-hyper/10'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                )}
                aria-label="more send options"
                title="more send options"
              >
                <Plus className="size-5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="end" className="w-48 rounded-sm p-1">
              <DropdownMenuItem
                onClick={() => {
                  sounds.play('lightTick')
                  setShowSchedule(true)
                }}
                className="rounded-sm cursor-pointer"
              >
                <CalendarClock className="size-4" /> schedule
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  sounds.play('lightTick')
                  setFormatOpen(true)
                  requestAnimationFrame(() => textareaRef.current?.focus())
                }}
                className="rounded-sm cursor-pointer"
              >
                <Palette className="size-4" /> advanced formatting
              </DropdownMenuItem>
              {whisperCandidates.length > 0 && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="rounded-sm cursor-pointer">
                    <Ghost className="size-4" /> whisper
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-56 rounded-sm p-1">
                    <div className="max-h-64 overflow-y-auto scroll-thin">
                      {whisperCandidates.map((u) => (
                        <DropdownMenuItem
                          key={u.id}
                          onClick={() => {
                            sounds.play('lightTick')
                            setWhisperTarget(whisperTarget?.id === u.id ? null : u)
                          }}
                          className="rounded-sm cursor-pointer gap-2.5 px-2 py-1.5"
                        >
                          <Avatar name={u.username} color={u.avatarColor} url={u.avatarUrl} size="sm" />
                          <span className="min-w-0 flex-1 leading-tight">
                            <span className="block truncate text-sm font-medium">{u.displayName || u.username}</span>
                            <span className="block truncate text-[11px] text-muted-foreground">@{u.username}</span>
                          </span>
                          {whisperTarget?.id === u.id && <Check className="size-3.5 text-hyper shrink-0" />}
                        </DropdownMenuItem>
                      ))}
                    </div>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              {isDmConversation && (
                <>
                  <DropdownMenuSeparator />
                  <div className="px-2 py-1 flex items-center gap-1.5 text-[10px] font-bold tracking-widest text-muted-foreground lowercase select-none">
                    <Timer className="size-3" /> timed messages
                  </div>
                  {TEMP_CHOICES.map((choice) => (
                    <DropdownMenuItem
                      key={choice.label}
                      onClick={() => void pickTempExpiry(choice.value)}
                      className="rounded-sm cursor-pointer"
                      aria-checked={activeTemp === choice.value}
                    >
                      <span className="size-4 grid place-items-center shrink-0">
                        {activeTemp === choice.value && <Check className="size-3.5 text-hyper" />}
                      </span>
                      {choice.label}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            size="sm"
            className="mb-0.5 shrink-0 rounded-sm press"
            disabled={!canSend || uploadingAny}
            onClick={() => {
              void submit()
              // clicking send must not eat the focus for the next message
              requestAnimationFrame(() => textareaRef.current?.focus())
            }}
            aria-label="send message"
          >
            {sending || uploadingAny ? <Spinner /> : <Send className="size-4" />}
          </Button>
        </div>
        )}
          </>
        )}
      </div>
      <div className="mt-1.5 px-1 flex items-center gap-2 text-[11px] text-muted-foreground">
        {slowLeft > 0 ? (
          <span className="flex items-center gap-1 text-hyper font-semibold" aria-live="polite">
            <Gauge className="size-3" />
            slowmode: wait {slowLeft}s
          </span>
        ) : slowmode > 0 ? (
          <span className="flex items-center gap-1">
            <Gauge className="size-3" />
            Slowmode {slowmode >= 60 ? `${Math.floor(slowmode / 60)}m${slowmode % 60 ? ` ${slowmode % 60}s` : ''}` : `${slowmode}s`}
          </span>
        ) : pendingHere > 0 ? (
          <button
            onClick={() => {
              sounds.play('lightTick')
              setScheduledOpen(true)
            }}
            className="flex items-center gap-1 text-hyper hover:underline underline-offset-2 font-semibold"
            aria-live="polite"
          >
            <CalendarClock className="size-3" />
            {pendingHere} scheduled {pendingHere === 1 ? 'message' : 'messages'} waiting. View queue.
          </button>
        ) : null}
      </div>
    </div>
  )
}
