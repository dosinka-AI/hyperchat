'use client'

import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { ShieldCheck, ArrowLeft } from 'lucide-react'
import { useChatStore } from '@/lib/client/store'
import { apiClient, ApiError } from '@/lib/client/api'
import { useToast } from '@/hooks/use-toast'

/** Why the dialog is open — shown as a one-line context above the form. */
export type EmailVerifyReason = 'join' | 'password' | 'account'

const REASON_COPY: Record<EmailVerifyReason, string> = {
  join: 'verify an email to join more than one server.',
  password: 'verify an email to change your password.',
  account: 'add a verified email to your account.',
}

/**
 * Two-step email verification: address (format + real DNS MX check happen
 * server-side) then a 6-digit code. This build has no SMTP transport, so the
 * code is delivered inline in the response and surfaced here — the MX check
 * is the anti-fake-email gate, the code completes the flow.
 */
export function EmailVerifyDialog({
  open,
  onOpenChange,
  reason,
  onVerified,
  initialEmail,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  reason: EmailVerifyReason
  onVerified?: (email: string) => void
  initialEmail?: string | null
}) {
  const me = useChatStore((s) => s.me)
  const applyMe = useChatStore((s) => s.applyMe)
  const { toast } = useToast()

  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [deliveredCode, setDeliveredCode] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setStep('email')
      setCode('')
      setDeliveredCode(null)
      setError(null)
      setEmail(initialEmail ?? me?.email ?? '')
    }
  }, [open, initialEmail, me?.email])

  async function sendCode() {
    setError(null)
    setBusy(true)
    try {
      const res = await apiClient.sendEmailCode({ email: email.trim(), purpose: 'verify' })
      setDeliveredCode(res.delivery === 'inline' ? (res.code ?? null) : null)
      setStep('code')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not send the code. try again.')
    } finally {
      setBusy(false)
    }
  }

  async function verify() {
    setError(null)
    setBusy(true)
    try {
      const { user } = await apiClient.verifyEmail({ email: email.trim(), code: code.trim() })
      applyMe(user)
      toast({ title: 'email verified' })
      onOpenChange(false)
      onVerified?.(email.trim())
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'wrong code. try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm p-0 border-border bg-app-sidebar overflow-hidden rounded-sm top-6 translate-y-0 flex flex-col"
        aria-describedby={undefined}
      >
        <div className="px-5 pt-5 pb-4 border-b border-border/60">
          <div className="flex items-center gap-2.5">
            {step === 'code' ? (
              <button
                onClick={() => setStep('email')}
                className="size-7 grid place-items-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                aria-label="back to the email step"
              >
                <ArrowLeft className="size-4" />
              </button>
            ) : (
              <ShieldCheck className="size-5 text-hyper" />
            )}
            <DialogTitle className="text-base font-bold tracking-tight">
              {step === 'email' ? 'verify an email' : 'enter the code'}
            </DialogTitle>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">{REASON_COPY[reason]}</p>
        </div>

        <div className="p-5 space-y-4">
          {step === 'email' ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="verify-email">email</Label>
                <Input
                  id="verify-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      if (email.trim() && !busy) void sendCode()
                    }
                  }}
                  required
                />
              </div>
              {error && (
                <p className="text-sm text-destructive rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-2">
                  {error}
                </p>
              )}
              <Button className="w-full rounded-sm" disabled={busy || !email.trim()} onClick={() => void sendCode()}>
                {busy && <Spinner />}
                send code
              </Button>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="verify-code">6-digit code</Label>
                <Input
                  id="verify-code"
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="000000"
                  className="text-lg tracking-[0.35em] text-center tabular-nums"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      if (code.length === 6 && !busy) void verify()
                    }
                  }}
                />
              </div>
              {deliveredCode && (
                <p className="text-xs text-muted-foreground rounded-sm border border-border bg-app-raise px-3 py-2 leading-relaxed">
                  sent to {email}. this build has no mail server, so the code is here:{' '}
                  <span className="text-foreground font-semibold tabular-nums">{deliveredCode}</span>
                </p>
              )}
              {error && (
                <p className="text-sm text-destructive rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-2">
                  {error}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1 rounded-sm"
                  disabled={busy}
                  onClick={() => void sendCode()}
                >
                  resend
                </Button>
                <Button className="flex-1 rounded-sm" disabled={busy || code.length !== 6} onClick={() => void verify()}>
                  {busy && <Spinner />}
                  verify
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
