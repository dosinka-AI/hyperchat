'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { AlertTriangle, Trash2, Ban, UserMinus, ShieldAlert, HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sounds } from '@/lib/client/sounds'

export type ConfirmTone = 'danger' | 'warning' | 'neutral'

export type ConfirmRequest = {
  id: number
  title: string
  body?: string
  tone?: ConfirmTone
  confirmLabel?: string
  cancelLabel?: string
  /** when set, an input is shown and its value resolves instead of true */
  input?: {
    placeholder?: string
    initial?: string
    optional?: boolean
    maxLength?: number
  }
  resolve: (value: string | boolean | null) => void
}

let seq = 0
let pushRequest: ((r: ConfirmRequest) => void) | null = null

/** Open a custom confirmation dialog. Returns true/false. Replaces
 *  window.confirm for every destructive action. */
export function confirmDialog(opts: {
  title: string
  body?: string
  tone?: ConfirmTone
  confirmLabel?: string
  cancelLabel?: string
}): Promise<boolean> {
  return new Promise((resolve) => {
    const wrapped = (v: string | boolean | null) => resolve(v === true)
    pushRequest?.({
      id: ++seq,
      title: opts.title,
      body: opts.body,
      tone: opts.tone,
      confirmLabel: opts.confirmLabel,
      cancelLabel: opts.cancelLabel,
      resolve: wrapped,
    })
  })
}

/** Open a dialog with a text input (reason fields, names). Resolves the
 *  string, or null when cancelled / left empty+optional. */
export function promptDialog(opts: {
  title: string
  body?: string
  tone?: ConfirmTone
  placeholder?: string
  initial?: string
  optional?: boolean
  confirmLabel?: string
  cancelLabel?: string
  maxLength?: number
}): Promise<string | null> {
  return new Promise((resolve) => {
    const wrapped = (v: string | boolean | null) => resolve(typeof v === 'string' ? v : null)
    pushRequest?.({
      id: ++seq,
      title: opts.title,
      body: opts.body,
      tone: opts.tone,
      confirmLabel: opts.confirmLabel,
      input: {
        placeholder: opts.placeholder,
        initial: opts.initial,
        optional: opts.optional,
        maxLength: opts.maxLength,
      },
      resolve: wrapped,
    })
  })
}

const TONE_ICON: Record<ConfirmTone, typeof AlertTriangle> = {
  danger: Trash2,
  warning: ShieldAlert,
  neutral: HelpCircle,
}

const TONE_CLASS: Record<ConfirmTone, string> = {
  danger: 'text-destructive',
  warning: 'text-idle',
  neutral: 'text-muted-foreground',
}

export function ConfirmDialogHost() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef<ConfirmRequest | null>(null)

  useEffect(() => {
    requestRef.current = request
  }, [request])

  useEffect(() => {
    pushRequest = (r) => {
      sounds.play('midTick')
      setRequest(r)
      setDraft(r.input?.initial ?? '')
    }
    return () => {
      pushRequest = null
    }
  }, [])

  useEffect(() => {
    if (request?.input) {
      const t = setTimeout(() => inputRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
  }, [request])

  if (!request || typeof document === 'undefined') return null

  const Icon = TONE_ICON[request.tone ?? 'neutral']
  const danger = request.tone === 'danger'

  function settle(value: string | boolean | null) {
    requestRef.current?.resolve(value)
    setRequest(null)
  }

  function onKey(e: React.KeyboardEvent) {
    const req = requestRef.current
    if (!req) return
    if (e.key === 'Escape') {
      e.stopPropagation()
      settle(req.input ? null : false)
    } else if (e.key === 'Enter') {
      e.stopPropagation()
      confirm()
    }
  }

  function confirm() {
    const req = requestRef.current
    if (!req) return
    if (req.input) {
      const value = draft.trim()
      if (!value && !req.input.optional) return
      settle(value || null)
    } else {
      settle(true)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[90] grid place-items-center bg-black/70 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) settle(request.input ? null : false)
      }}
      role="presentation"
    >
      <div
        className="w-full max-w-sm glass-raise border border-border rounded-sm shadow-2xl dialog-in"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onKeyDown={onKey}
      >
        <div className="flex items-start gap-3 p-4 pb-3">
          <span className={cn('mt-0.5 shrink-0', TONE_CLASS[request.tone ?? 'neutral'])}>
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 id="confirm-title" className="text-sm font-bold tracking-tight">
              {request.title}
            </h3>
            {request.body && (
              <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{request.body}</p>
            )}
          </div>
        </div>

        {request.input && (
          <div className="px-4 pb-1">
            <input
              ref={inputRef}
              value={draft}
              maxLength={request.input.maxLength ?? 190}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={request.input.placeholder ?? ''}
              className="w-full bg-app-raise border border-white/15 rounded-sm px-2.5 py-1.5 text-sm outline-none focus:border-hyper/60 transition-colors"
              aria-label={request.input.placeholder ?? 'input'}
            />
            {request.input.optional && (
              <p className="mt-1 text-[11px] text-muted-foreground">optional. leave empty to skip.</p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 p-4 pt-3">
          <Button
            variant="ghost"
            size="sm"
            className="rounded-sm"
            onClick={() => settle(request.input ? null : false)}
          >
            {request.cancelLabel ?? 'cancel'}
          </Button>
          <Button
            size="sm"
            className={cn('rounded-sm press', danger && 'bg-destructive hover:bg-destructive/90 text-white')}
            onClick={confirm}
            disabled={!!request.input && !draft.trim() && !request.input.optional}
          >
            {request.confirmLabel ?? (request.input ? 'save' : 'confirm')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}
