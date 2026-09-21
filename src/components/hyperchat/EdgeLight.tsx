'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Sun } from 'lucide-react'
import { useChatStore } from '@/lib/client/store'
import { sounds } from '@/lib/client/sounds'
import { cn } from '@/lib/utils'

/** Mac-style edge lighting for the camera: a soft warm room glow around the
 *  screen edges while YOUR camera is on (the video-lighting cue). Purely
 *  ambient — pointer-events-none, faint by design (max alpha ~0.16 so it
 *  never washes out text), and portaled to the body below the z-[90] call
 *  takeover, so fullscreen call stages keep their ink. Experimental and
 *  toggleable per device; default on. */

const PREF_KEY = 'hc_edge_light'

function readEdgeLightPref(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(PREF_KEY) !== 'off'
  } catch {
    return true // storage blocked: default on for the session
  }
}

function writeEdgeLightPref(on: boolean) {
  try {
    window.localStorage.setItem(PREF_KEY, on ? 'on' : 'off')
  } catch {
    /* private mode: the toggle still works, it just does not persist */
  }
}

/** my camera is live in EITHER surface: a dm/group call or a server voice room */
function useCameraOn(): boolean {
  return useChatStore((s) => s.callSelf.cameraOn || s.voiceSelf.cameraOn)
}

/** the persisted edge-light preference (default on). read once at mount —
 *  the button only lives inside client-only call/voice surfaces, so there
 *  is no hydration divergence to smooth over */
export function useEdgeLightPref(): [boolean, (next: boolean) => void] {
  const [on, setOn] = useState(readEdgeLightPref)
  const set = (next: boolean) => {
    setOn(next)
    writeEdgeLightPref(next)
  }
  return [on, set]
}

/** the ambient layer itself: a warm glow spilling in from the top edge plus
 *  a faint brightness lift along the edges, breathing very slowly. Rendered
 *  through a portal so backdrop-blur/filter ancestors cannot trap its fixed
 *  positioning. */
export function EdgeLightLayer() {
  const cameraOn = useCameraOn()
  if (!cameraOn || typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[35] pointer-events-none edge-light-breathe" aria-hidden="true">
      {/* warm light from the top edge */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_18%_at_50%_0%,rgba(255,244,214,0.16),transparent_70%)]" />
      {/* faint brightness lift along the side + top edges */}
      <div className="absolute inset-0 shadow-[inset_0_0_120px_rgba(255,240,200,0.07)]" />
    </div>,
    document.body
  )
}

/** the toggle for call/voice control rows: a small circular sun button next
 *  to the camera toggle. Owns the preference and carries the ambient layer —
 *  only one control row is live at a time (call stage, call dock or voice
 *  room), so the layer never doubles up. */
export function EdgeLightButton({ className, iconClass }: { className?: string; iconClass?: string }) {
  const [on, setOn] = useEdgeLightPref()
  const cameraOn = useCameraOn()
  return (
    <>
      <button
        type="button"
        onClick={() => {
          sounds.play('lightTick')
          setOn(!on)
        }}
        aria-pressed={on}
        aria-label={on ? 'camera edge light on' : 'camera edge light off'}
        title={on ? 'edge light on' : 'edge light off'}
        className={cn(
          'grid place-items-center rounded-full call-btn shrink-0',
          on
            ? 'text-amber-200 bg-amber-400/15 hover:bg-amber-400/25'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent',
          className
        )}
      >
        <Sun className={iconClass ?? 'size-4'} />
      </button>
      {cameraOn && on && <EdgeLightLayer />}
    </>
  )
}
