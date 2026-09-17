'use client'

import { useMemo, useState } from 'react'
import { useChatStore } from '@/lib/client/store'
import { Avatar } from './Avatar'
import { sounds } from '@/lib/client/sounds'
import { cn } from '@/lib/utils'
import { openContextMenu } from './ContextMenu'
import { HeadphoneOff, Headphones, Mic, MicOff, PhoneOff, Volume2, Phone, UserPlus } from 'lucide-react'

/** The voice stage: full-width main-area panel for voice channels. Shows live
 *  participant tiles with speaking rings, in-call controls, and a friend
 *  ring-in control so you can pull friends into the channel. */
export function VoiceRoom() {
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const servers = useChatStore((s) => s.servers)
  const me = useChatStore((s) => s.me)
  const friends = useChatStore((s) => s.friends)
  const onlineUserIds = useChatStore((s) => s.onlineUserIds)
  const voiceConnected = useChatStore((s) => s.voiceConnected)
  const voiceSelf = useChatStore((s) => s.voiceSelf)
  const voiceUnavailable = useChatStore((s) => s.voiceUnavailable)
  const participants = useChatStore((s) => (s.activeChannelId ? s.voiceParticipants[s.activeChannelId] ?? [] : []))
  const joinVoice = useChatStore((s) => s.joinVoice)
  const leaveVoice = useChatStore((s) => s.leaveVoice)
  const toggleVoiceMute = useChatStore((s) => s.toggleVoiceMute)
  const toggleVoiceDeafen = useChatStore((s) => s.toggleVoiceDeafen)
  const ringFriendIntoVoice = useChatStore((s) => s.ringFriendIntoVoice)
  const [ringOpen, setRingOpen] = useState(false)

  const channel = servers.flatMap((s) => s.channels).find((c) => c.id === activeChannelId) ?? null
  const server = servers.find((s) => s.channels.some((c) => c.id === activeChannelId)) ?? null
  const connectedHere = !!activeChannelId && voiceConnected?.channelId === activeChannelId

  const ringableFriends = useMemo(() => {
    const inCall = new Set(participants.map((p) => p.userId))
    return friends.filter((f) => !inCall.has(f.user.id) && !!onlineUserIds[f.user.id])
  }, [friends, participants, onlineUserIds])

  if (!channel) return null

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-app-chat">
      <div className="h-12 px-3 flex items-center justify-between border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Volume2 className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
          <span className="font-bold text-sm tracking-tight truncate">{channel.name}</span>
          <span className="text-[10px] font-semibold text-muted-foreground tabular-nums shrink-0">
            {connectedHere ? participants.length : 0}
          </span>
        </div>
        {connectedHere && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                sounds.play('lightTick')
                setRingOpen((v) => !v)
              }}
              className={cn(
                'p-1.5 rounded-sm transition-colors',
                ringOpen ? 'bg-hyper/20 text-hyper' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              )}
              aria-label="ring a friend in"
              title="ring a friend in"
            >
              <UserPlus className="size-4" />
            </button>
            <button
              onClick={() => {
                sounds.play('lightTick')
                toggleVoiceMute()
              }}
              className={cn(
                'p-1.5 rounded-sm transition-colors',
                voiceSelf.muted ? 'bg-destructive/20 text-destructive' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              )}
              aria-label={voiceSelf.muted ? 'unmute' : 'mute'}
              title={voiceSelf.muted ? 'unmute' : 'mute'}
            >
              {voiceSelf.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </button>
            <button
              onClick={() => {
                sounds.play('lightTick')
                toggleVoiceDeafen()
              }}
              className={cn(
                'p-1.5 rounded-sm transition-colors',
                voiceSelf.deafened ? 'bg-destructive/20 text-destructive' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              )}
              aria-label={voiceSelf.deafened ? 'undeafen' : 'deafen'}
              title={voiceSelf.deafened ? 'undeafen' : 'deafen'}
            >
              {voiceSelf.deafened ? <HeadphoneOff className="size-4" /> : <Headphones className="size-4" />}
            </button>
            <button
              onClick={() => {
                sounds.play('lightTick')
                leaveVoice()
              }}
              className="p-1.5 rounded-sm bg-destructive/15 text-destructive hover:bg-destructive/25 transition-colors"
              aria-label="leave voice"
              title="leave voice"
            >
              <PhoneOff className="size-4" />
            </button>
          </div>
        )}
      </div>

      {voiceUnavailable ? (
        <div className="flex-1 grid place-items-center px-6">
          <p className="text-sm text-muted-foreground">voice unavailable in this build</p>
        </div>
      ) : connectedHere ? (
        <div className="flex-1 overflow-y-auto scroll-thin p-6">
          {ringOpen && (
            <div className="max-w-3xl mx-auto mb-4 rounded-sm border border-white/10 bg-app-raise p-3">
              <p className="text-[11px] font-bold tracking-widest text-muted-foreground mb-2">ring a friend in</p>
              {ringableFriends.length === 0 ? (
                <p className="text-xs text-muted-foreground">no online friends available</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {ringableFriends.map((f) => (
                    <button
                      key={f.friendshipId}
                      type="button"
                      onClick={() => {
                        sounds.play('lightTick')
                        ringFriendIntoVoice(f.user.id)
                        setRingOpen(false)
                      }}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-sm hover:bg-accent transition-colors text-left"
                    >
                      <Avatar name={f.user.username} color={f.user.avatarColor} url={f.user.avatarUrl} size="sm" />
                      <span className="flex-1 text-sm font-semibold truncate">{f.user.displayName || f.user.username}</span>
                      <Phone className="size-3.5 text-hyper" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 max-w-3xl mx-auto">
            {participants.map((p) => {
              const isSelf = p.userId === me?.id
              const isDeafened = p.deafened
              const isMuted = p.muted
              return (
                <div
                  key={`${p.userId}:${p.sessionId}`}
                  className={cn(
                    'bg-app-raise border border-white/10 rounded-sm p-4 flex flex-col items-center gap-2.5 transition-all',
                    p.speaking && 'border-white/30'
                  )}
                  onContextMenu={(e) => {
                    if (isSelf) return
                    openContextMenu(e, [
                      {
                        label: 'ring again',
                        icon: Phone,
                        onSelect: () => ringFriendIntoVoice(p.userId),
                        disabled: !friends.some((f) => f.user.id === p.userId),
                      },
                    ], { title: p.displayName || p.username })
                  }}
                >
                  <div className="relative">
                    <div
                      className={cn(
                        'rounded-full transition-transform duration-100',
                        p.speaking && 'ring-2 ring-white scale-[1.06]'
                      )}
                    >
                      <Avatar name={p.username} color={p.avatarColor} url={p.avatarUrl} size="lg" />
                    </div>
                    {(isMuted || isDeafened) && (
                      <span className="absolute -bottom-0.5 -right-0.5 grid place-items-center size-5 rounded-full bg-black ring-2 ring-app-raise">
                        {isDeafened ? (
                          <HeadphoneOff className="size-3 text-destructive" />
                        ) : (
                          <MicOff className="size-3 text-destructive" />
                        )}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 max-w-full text-center">
                    <div className="text-[13px] font-semibold tracking-tight truncate">
                      {p.displayName || p.username}
                      {isSelf && <span className="text-muted-foreground/70"> · you</span>}
                    </div>
                    {p.speaking && <div className="text-[10px] text-hyper mt-0.5">speaking</div>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="flex-1 grid place-items-center p-6">
          <button
            onClick={() => {
              if (!activeChannelId || !server) return
              void joinVoice(activeChannelId, server.id)
            }}
            className="flex items-center gap-2 px-4 py-2.5 rounded-sm bg-hyper text-white text-sm font-semibold hover:bg-hyper/90 transition-colors"
          >
            <Volume2 className="size-4" />
            join voice
          </button>
        </div>
      )}
    </div>
  )
}
