'use client'

/**
 * Voice & audio settings (Discord's "voice & video" panel, Hyperion-sized):
 * one dialog shared by voice rooms and calls, driving the shared audio prefs
 * both engines read (lib/client/audio-prefs.ts). Everything applies live —
 * sensitivity is read every analyser tick, output routing re-targets the
 * playing elements, and input device / processing changes re-acquire the mic
 * and replaceTrack it into every live peer without renegotiation.
 *
 * The dialog meters the mic independently (a short-lived getUserMedia +
 * analyser) so tuning works before joining anything; the meter reflects the
 * exact acquisition constraints the engines will use.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Settings2, RotateCcw, AudioLines } from 'lucide-react'
import {
  audioPrefs,
  commitAudioPrefs,
  resetAudioPrefs,
  onAudioPrefsChanged,
  micAudioConstraints,
  micConstraintsKey,
  SENSITIVITY_MIN,
  SENSITIVITY_MAX,
} from '@/lib/client/audio-prefs'
import { callPrefs, onCallPrefsChanged, setCameraDeviceId } from '@/lib/client/call-prefs'
import { sounds } from '@/lib/client/sounds'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'

/** sentinel for Radix Select, which forbids empty-string item values */
const DEFAULT_DEVICE = '__default__'

function useAudioPrefsFields() {
  // select primitives individually: the prefs object is shared + mutable, so
  // selecting the object itself would never change identity on commit
  const subscribe = useCallback((cb: () => void) => onAudioPrefsChanged(cb), [])
  const inputDeviceId = useSyncExternalStore(subscribe, () => audioPrefs.inputDeviceId)
  const outputDeviceId = useSyncExternalStore(subscribe, () => audioPrefs.outputDeviceId)
  const sensitivity = useSyncExternalStore(subscribe, () => audioPrefs.sensitivity)
  const echoCancellation = useSyncExternalStore(subscribe, () => audioPrefs.echoCancellation)
  const noiseSuppression = useSyncExternalStore(subscribe, () => audioPrefs.noiseSuppression)
  const autoGainControl = useSyncExternalStore(subscribe, () => audioPrefs.autoGainControl)
  return { inputDeviceId, outputDeviceId, sensitivity, echoCancellation, noiseSuppression, autoGainControl }
}

type DeviceInfo = { deviceId: string; label: string }

/** Enumerate input/output/camera devices while the dialog is open; labels
 *  populate once the meter (or a join) has granted mic permission. */
function useDevices(active: boolean, permissionGranted: boolean): { inputs: DeviceInfo[]; outputs: DeviceInfo[]; cameras: DeviceInfo[] } {
  const [devices, setDevices] = useState<{ inputs: DeviceInfo[]; outputs: DeviceInfo[]; cameras: DeviceInfo[] }>({ inputs: [], outputs: [], cameras: [] })

  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return
    let alive = true
    const refresh = () => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((list) => {
          if (!alive) return
          const inputs = list
            .filter((d) => d.kind === 'audioinput')
            .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `microphone ${i + 1}` }))
          const outputs = list
            .filter((d) => d.kind === 'audiooutput')
            .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `output ${i + 1}` }))
          const cameras = list
            .filter((d) => d.kind === 'videoinput')
            .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `camera ${i + 1}` }))
          setDevices({ inputs, outputs, cameras })
        })
        .catch(() => {})
    }
    refresh()
    // labels only exist after a getUserMedia grant in some browsers
    if (permissionGranted) refresh()
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh)
    return () => {
      alive = false
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh)
    }
  }, [active, permissionGranted])

  return devices
}

/** Live mic level while `active`: acquires a metering stream under the
 *  CURRENT prefs (so it reflects the device + processing exactly), computes
 *  RMS at ~20Hz, and cleans up on stop. Re-acquires when the acquisition
 *  constraints change. Returns level 0..1 (1 == SENSITIVITY_MAX) and whether
 *  the mic could be opened at all. */
function useMicMeter(active: boolean): { level: number; granted: boolean; constraintsKey: string } {
  const [level, setLevel] = useState(0)
  const [granted, setGranted] = useState(false)
  const constraintsKey = useSyncExternalStore(
    useCallback((cb: () => void) => onAudioPrefsChanged(cb), []),
    () => micConstraintsKey()
  )
  const levelRef = useRef(0)

  useEffect(() => {
    if (!active || typeof navigator === 'undefined') return
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let raf = 0
    let alive = true
    let lastPush = 0

    const run = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: micAudioConstraints() })
      } catch {
        if (alive) {
          setGranted(false)
          setLevel(0)
        }
        return
      }
      if (!alive) {
        for (const t of stream.getTracks()) t.stop()
        return
      }
      setGranted(true)
      ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      analyser.smoothingTimeConstant = 0.5
      source.connect(analyser)
      const data = new Uint8Array(analyser.fftSize)
      const tick = () => {
        if (!alive) return
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / data.length)
        levelRef.current = Math.min(1, rms / SENSITIVITY_MAX)
        const now = performance.now()
        if (now - lastPush > 50) {
          lastPush = now
          setLevel(levelRef.current)
        }
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    }
    void run()

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      for (const t of stream?.getTracks() ?? []) t.stop()
      if (ctx) void ctx.close().catch(() => {})
    }
  }, [active, constraintsKey])

  return { level, granted, constraintsKey }
}

/** A thin horizontal live-level bar with the sensitivity threshold marked;
 *  the fill turns hyper while speaking (level above the marker). */
function SensitivityMeter({ level, sensitivity, granted }: { level: number; sensitivity: number; granted: boolean }) {
  const thresholdPct = Math.min(100, (sensitivity / SENSITIVITY_MAX) * 100)
  const speaking = level * SENSITIVITY_MAX > sensitivity
  return (
    <div className="relative h-8 rounded-sm border border-white/10 bg-black/40 overflow-hidden" role="img"
      aria-label={granted ? `mic level meter, sensitivity ${Math.round(thresholdPct)} percent` : 'mic level meter unavailable'}
    >
      {/* scale ruler marks every 25% */}
      {[25, 50, 75].map((p) => (
        <span key={p} className="absolute top-0 bottom-0 w-px bg-white/5" style={{ left: `${p}%` }} aria-hidden="true" />
      ))}
      <div
        className={cn(
          'absolute inset-y-0 left-0 transition-[width] duration-75',
          speaking ? 'bg-hyper/45' : 'bg-white/15'
        )}
        style={{ width: `${Math.min(100, level * 100)}%` }}
        aria-hidden="true"
      />
      {/* threshold marker */}
      <div className="absolute inset-y-0 w-0.5 bg-hyper" style={{ left: `calc(${thresholdPct}% - 1px)` }} aria-hidden="true">
        <span className="absolute -top-0.5 left-1/2 -translate-x-1/2 size-1.5 rounded-full bg-hyper" aria-hidden="true" />
      </div>
      <div className="absolute inset-0 flex items-center justify-end px-2 pointer-events-none">
        <span className="text-[10px] font-semibold text-muted-foreground/60 tabular-nums">{Math.round(level * 100)}%</span>
      </div>
    </div>
  )
}

function SettingsRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="text-[12px] font-semibold tracking-tight">{label}</p>
      </div>
      {children}
    </div>
  )
}

export function VoiceSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const prefs = useAudioPrefsFields()
  const meter = useMicMeter(open)
  const devices = useDevices(open, meter.granted)
  const cameraDeviceId = useSyncExternalStore(
    useCallback((cb: () => void) => onCallPrefsChanged(cb), []),
    () => callPrefs.cameraDeviceId
  )

  const set = (mut: () => void) => {
    mut()
    commitAudioPrefs()
  }

  const sensitivityPct = (prefs.sensitivity / SENSITIVITY_MAX) * 100

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 border-border glass overflow-hidden rounded-sm top-6 translate-y-0" aria-describedby={undefined}>
        <DialogTitle className="sr-only">voice and audio settings</DialogTitle>

        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/10">
          <AudioLines className="size-4 text-hyper shrink-0" />
          <p className="text-sm font-bold tracking-tight">voice &amp; audio</p>
        </div>

        <div className="max-h-[65vh] overflow-y-auto scroll-thin divide-y divide-white/5">
          {/* ---- input ---- */}
          <section className="px-4 py-3" aria-label="input settings">
            <p className="text-[10px] font-bold tracking-widest text-muted-foreground mb-1">input</p>

            <SettingsRow label="microphone">
              <Select
                value={prefs.inputDeviceId || DEFAULT_DEVICE}
                onValueChange={(v) => set(() => { audioPrefs.inputDeviceId = v === DEFAULT_DEVICE ? '' : v })}
              >
                <SelectTrigger className="w-[190px] h-8 rounded-sm text-[12px]" aria-label="input device">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-sm max-h-64">
                  <SelectItem value={DEFAULT_DEVICE} className="text-[12px]">system default</SelectItem>
                  {devices.inputs.map((d) => (
                    <SelectItem key={d.deviceId} value={d.deviceId || `input-${d.label}`} className="text-[12px]">
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>

            <div className="py-2.5">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[12px] font-semibold tracking-tight">input sensitivity</p>
                <span className="text-[11px] text-muted-foreground tabular-nums">{sensitivityPct.toFixed(0)}%</span>
              </div>
              <SensitivityMeter level={meter.level} sensitivity={prefs.sensitivity} granted={meter.granted} />
              <div className="mt-2.5">
                <Slider
                  value={[prefs.sensitivity]}
                  min={SENSITIVITY_MIN}
                  max={SENSITIVITY_MAX}
                  step={0.001}
                  onValueChange={(v) => set(() => { audioPrefs.sensitivity = v[0] ?? prefs.sensitivity })}
                  aria-label="input sensitivity"
                />
              </div>
            </div>

            <div className="rounded-sm border border-white/10 divide-y divide-white/5 mt-1">
              <SettingsRow label="echo cancellation">
                <Switch
                  checked={prefs.echoCancellation}
                  onCheckedChange={(v) => { sounds.play('lightTick'); set(() => { audioPrefs.echoCancellation = v }) }}
                  aria-label="echo cancellation"
                />
              </SettingsRow>
              <SettingsRow label="noise suppression">
                <Switch
                  checked={prefs.noiseSuppression}
                  onCheckedChange={(v) => { sounds.play('lightTick'); set(() => { audioPrefs.noiseSuppression = v }) }}
                  aria-label="noise suppression"
                />
              </SettingsRow>
              <SettingsRow label="automatic gain">
                <Switch
                  checked={prefs.autoGainControl}
                  onCheckedChange={(v) => { sounds.play('lightTick'); set(() => { audioPrefs.autoGainControl = v }) }}
                  aria-label="automatic gain control"
                />
              </SettingsRow>
            </div>
          </section>

          {/* ---- output ---- */}
          <section className="px-4 py-3" aria-label="output settings">
            <p className="text-[10px] font-bold tracking-widest text-muted-foreground mb-1">output</p>
            <SettingsRow label="output device">
              <Select
                value={prefs.outputDeviceId || DEFAULT_DEVICE}
                onValueChange={(v) => set(() => { audioPrefs.outputDeviceId = v === DEFAULT_DEVICE ? '' : v })}
              >
                <SelectTrigger className="w-[190px] h-8 rounded-sm text-[12px]" aria-label="output device">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-sm max-h-64">
                  <SelectItem value={DEFAULT_DEVICE} className="text-[12px]">system default</SelectItem>
                  {devices.outputs.map((d) => (
                    <SelectItem key={d.deviceId} value={d.deviceId || `output-${d.label}`} className="text-[12px]">
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
          </section>

          {/* ---- camera ---- */}
          <section className="px-4 py-3" aria-label="camera settings">
            <p className="text-[10px] font-bold tracking-widest text-muted-foreground mb-1">camera</p>
            <SettingsRow label="camera">
              <Select
                value={cameraDeviceId || DEFAULT_DEVICE}
                onValueChange={(v) => {
                  sounds.play('lightTick')
                  setCameraDeviceId(v === DEFAULT_DEVICE ? '' : v)
                }}
              >
                <SelectTrigger className="w-[190px] h-8 rounded-sm text-[12px]" aria-label="camera device">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="rounded-sm max-h-64">
                  <SelectItem value={DEFAULT_DEVICE} className="text-[12px]">system default</SelectItem>
                  {devices.cameras.map((d) => (
                    <SelectItem key={d.deviceId} value={d.deviceId || `camera-${d.label}`} className="text-[12px]">
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingsRow>
          </section>
        </div>

        <div className="flex items-center justify-end px-4 py-3 border-t border-white/10">
          <button
            type="button"
            onClick={() => { sounds.play('lightTick'); resetAudioPrefs() }}
            className="flex items-center gap-1.5 px-2.5 h-7 rounded-sm border border-white/10 text-[11px] font-semibold text-muted-foreground hover:text-foreground hover:border-white/25 transition-colors"
          >
            <RotateCcw className="size-3" />
            reset to defaults
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Gear button + dialog, dropped into the voice-room header and the call
 *  control row. Self-contained: owns its own open state. */
export function VoiceSettingsButton({ iconSize = 'size-4' }: { iconSize?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => { sounds.play('lightTick'); setOpen(true) }}
        className={cn(
          'p-1.5 rounded-sm transition-colors border text-muted-foreground hover:text-foreground hover:bg-accent hover:border-white/20',
          open ? 'border-hyper/50 bg-hyper/15 text-hyper' : 'border-transparent'
        )}
        aria-label="voice and audio settings"
        title="voice & audio settings"
      >
        <Settings2 className={iconSize} aria-hidden="true" />
      </button>
      <VoiceSettingsDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
