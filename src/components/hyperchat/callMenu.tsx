'use client'

import { Phone, PhoneForwarded, BellRing } from 'lucide-react'
import type { ContextMenuItem } from './ContextMenu'
import { useChatStore } from '@/lib/client/store'
import { sounds } from '@/lib/client/sounds'

/** Call entries for user context menus (member lists, DM rows, message
 *  authors, friends): one builder so every surface agrees on the rules.
 *
 *  - I am in a call and they are not in it -> the green "add to call"
 *    (rings them into MY call, even when they cannot see its messages).
 *  - I am in a voice channel and they are not in it -> "ring into <channel>"
 *    (the server-call invite).
 *  - Otherwise -> plain "call" (opens/reuses the DM and rings it).
 *  Never for myself, never while I already have an incoming ring up. */
export function callMenuItems(target: { id: string; username: string; displayName: string | null }): ContextMenuItem[] {
  const s = useChatStore.getState()
  const me = s.me
  if (!me || me.id === target.id) return []

  const name = target.displayName || target.username
  const active = s.activeCall
  const voice = s.voiceConnected

  // in a call they have not joined: the green add-to-call. A GROUP whose
  // owner turned cross-ringing off never offers it — only existing members
  // can be rung, and the target is by definition not in the call
  if (active && !active.participants.some((p) => p.userId === target.id)) {
    const conv = s.conversations.find((c) => c.id === active.conversationId.split('~')[0])
    const crossRingBlocked = conv?.kind === 'GROUP' && conv.allowCrossRing === false
    if (!crossRingBlocked) {
      return [
        {
          label: 'add to call',
          icon: PhoneForwarded,
          accent: true,
          onSelect: () => {
            sounds.play('lightTick')
            s.ringUserIntoCall(target.id)
          },
        },
      ]
    }
  }

  // sitting in a voice channel they have not joined: ring them into it
  if (voice && !(s.voiceParticipants[voice.channelId] ?? []).some((p) => p.userId === target.id)) {
    const channel = s.servers
      .find((sv) => sv.id === voice.serverId)
      ?.channels.find((c) => c.id === voice.channelId)
    return [
      {
        label: `ring into ${channel?.name ?? 'voice'}`,
        icon: BellRing,
        accent: true,
        onSelect: () => {
          sounds.play('lightTick')
          s.ringUserIntoVoice(voice.channelId, voice.serverId, target.id)
        },
      },
    ]
  }

  // idle: a plain call (DM ring). Hidden while an incoming ring waits on me
  if (s.incomingCall) return []
  return [
    {
      label: `call ${name}`,
      icon: Phone,
      onSelect: () => {
        sounds.play('lightTick')
        void s.callUser(target.id)
      },
    },
  ]
}
