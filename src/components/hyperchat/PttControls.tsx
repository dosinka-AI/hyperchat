'use client'

/**
 * Push-to-talk controls, shared by the voice-room control row and the call
 * control row. One preference drives both engines (see lib/client/ptt-prefs):
 * enable it anywhere and it applies everywhere.
 *
 * Two pieces: the walkie-talkie toggle, and (while enabled) a key chip that
 * opens a press-any-key capture to rebind the hold-to-talk key.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { RadioTower } from 'lucide-react'
import { useChatStore } from '@/lib/client/store'
import { pttPrefs, onPttPrefsChanged, pttKeyLabel } from '@/lib/client/ptt-prefs'
import { sounds } from '@/lib/client/sounds'
import { cn } from '@/lib/utils'

function usePttPrefs() {
  const subscribe = useCallback((cb: () => void) => onPttPrefsChanged(cb), [])
  const enabled = useSyncExternalStore(subscribe, () => pttPrefs.enabled)
  const key = useSyncExternalStore(subscribe, () => pttPrefs.key)
  return { enabled, key }
}

export function PttControls({ iconSize = 'size-4', buttonClassName }: { iconSize?: string; buttonClassName?: string }) {
  const togglePushToTalk = useChatStore((s) => s.togglePushToTalk)
  const setPushToTalkKey = useChatStore((s) => s.setPushToTalkKey)
  const prefs = usePttPrefs()
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent) => {
      // consume the key completely: the PTT router listens on the same node
      // in the same phase and must never see a capture-mode keystroke
      e.preventDefault()
      e.stopImmediatePropagation()
      if (e.code !== 'Escape') setPushToTalkKey(e.code)
      setCapturing(false)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [capturing, setPushToTalkKey])

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => {
          sounds.play('lightTick')
          togglePushToTalk()
        }}
        className={cn(
          'grid place-items-center shrink-0',
          buttonClassName ?? 'p-1.5 rounded-sm transition-colors border border-transparent',
          prefs.enabled
            ? 'bg-hyper/15 text-hyper ring-1 ring-hyper/50'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        )}
        aria-pressed={prefs.enabled}
        aria-label={prefs.enabled ? 'disable push to talk' : 'enable push to talk'}
        title={prefs.enabled ? 'push to talk on' : 'push to talk'}
      >
        <RadioTower className={iconSize} aria-hidden="true" />
      </button>
      {prefs.enabled && (
        <button
          onClick={() => setCapturing(true)}
          onBlur={() => setCapturing(false)}
          className={cn(
            'h-6 min-w-6 px-1.5 rounded-sm border text-[10px] font-bold uppercase tracking-wide transition-colors',
            capturing
              ? 'bg-hyper/20 text-hyper border-hyper animate-pulse'
              : 'text-muted-foreground border-white/15 hover:text-foreground hover:border-white/30'
          )}
          aria-label={`push to talk key ${pttKeyLabel(prefs.key)}, click to rebind`}
          title="click, then press any key to rebind (esc cancels)"
        >
          {capturing ? '···' : pttKeyLabel(prefs.key)}
        </button>
      )}
    </div>
  )
}
