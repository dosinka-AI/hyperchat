'use client'

import { useEffect } from 'react'
import { useChatStore } from '@/lib/client/store'
import { VoiceStageContent } from './VoiceRoom'
import { LogOut, DoorOpen } from 'lucide-react'
import { sounds } from '@/lib/client/sounds'
import type { ChannelSummary } from '@/lib/types'

/** The guest voice session: you were rung into a voice channel of a server
 *  you are not a member of, and this is the whole deal - the VC, the people
 *  in it, your own controls, and the way out. No channel list, no member
 *  sidebar, no history: those belong to the server's members. Leaving the
 *  channel ends the guest session and hands the app back to your own
 *  worlds. The stage itself is the exact component members see, so tiles,
 *  volume, screenshares, chat pairing and every control behave the same. */
export function GuestVoiceView({
  serverId,
  channelId,
  channelName,
}: {
  serverId: string
  channelId: string
  channelName: string
}) {
  const voiceConnected = useChatStore((s) => s.voiceConnected)
  const leaveVoice = useChatStore((s) => s.leaveVoice)

  // the ring may have died under us (socket drop, takeover): an orphaned
  // guest view with no live voice session folds back to the normal app
  const live = !!voiceConnected && voiceConnected.channelId.split('~')[0] === channelId.split('~')[0]
  useEffect(() => {
    if (!live) useChatStore.getState().clearGuestVoice()
  }, [live])

  if (!live) return null

  // synthetic channel: the stage only needs identity + name + type
  const channel: ChannelSummary = {
    id: channelId,
    serverId,
    name: channelName || 'voice',
    topic: null,
    position: 0,
    categoryId: null,
    type: 'voice',
    slowmodeSeconds: 0,
    locked: false,
    private: false,
    accessRoleIds: [],
  }

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-app-chat">
      <header className="h-12 shrink-0 flex items-center gap-2.5 px-4 border-b border-white/10 bg-app-sidebar/40">
        <span
          className="grid place-items-center size-7 rounded-sm bg-emerald-400/15 border border-emerald-400/30 text-emerald-300 shrink-0"
          aria-hidden="true"
        >
          <DoorOpen className="size-4" />
        </span>
        <div className="min-w-0">
          <h1 className="text-sm font-bold tracking-tight truncate leading-tight">{channelName || 'voice channel'}</h1>
          <p className="text-[11px] text-muted-foreground truncate leading-tight">
            guest voice · you only see this channel — nothing else of the server
          </p>
        </div>
        <button
          onClick={() => {
            sounds.play('lightTick')
            leaveVoice()
          }}
          className="ml-auto flex items-center gap-1.5 px-3 h-9 rounded-sm border border-white/10 text-xs font-semibold text-muted-foreground hover:text-destructive hover:border-destructive/50 hover:bg-destructive/10 transition-colors shrink-0"
          aria-label="leave the voice channel"
          title="leave the voice channel"
        >
          <LogOut className="size-3.5" />
          leave
        </button>
      </header>
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        <VoiceStageContent channel={channel} server={null} variant="inline" />
      </div>
    </div>
  )
}
