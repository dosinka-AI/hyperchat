'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { HyperionMark, HyperionWordmark } from './Logo'
import { useChatStore, STANDALONE } from '@/lib/client/store'
import { apiClient } from '@/lib/client/api'
import { ApiError } from '@/lib/client/api'
import { sounds } from '@/lib/client/sounds'

export default function AuthView() {
  const view = useChatStore((s) => s.view)
  const setView = useChatStore((s) => s.setView)
  const doLogin = useChatStore((s) => s.doLogin)
  const doRegister = useChatStore((s) => s.doRegister)
  const me = useChatStore((s) => s.me)

  const isRegister = view === 'register'

  const [identifier, setIdentifier] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // the device decides whether this signup needs an email (second+ account
  // on the same browser). no explanation is shown — the field is simply there.
  const [emailRequired, setEmailRequired] = useState(false)

  useEffect(() => {
    if (!isRegister) return
    let cancelled = false
    apiClient
      .registerHint()
      .then((hint) => {
        if (!cancelled) setEmailRequired(hint.emailRequired)
      })
      .catch(() => {
        /* offline hint: field stays hidden, server enforces the truth */
      })
    return () => {
      cancelled = true
    }
  }, [isRegister])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (isRegister) {
        await doRegister(username.trim(), emailRequired ? email.trim() : undefined, password)
      } else {
        await doLogin(identifier.trim(), password)
      }
    } catch (err) {
      sounds.play('error')
      setError(err instanceof ApiError ? err.message : 'something went wrong. try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-dvh bg-background flex flex-col pt-[env(safe-area-inset-top)]">
      <header className="border-b border-border">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 h-16 flex items-center gap-3">
          <button onClick={() => setView('landing')} className={STANDALONE ? 'hidden' : 'flex items-center gap-2.5'} aria-label="back to home">
            <HyperionMark className="w-7 h-7 rounded-sm" />
            <HyperionWordmark className="text-sm" />
          </button>
        </div>
      </header>

      <main className="flex-1 grid place-items-center px-4 py-10">
        <div className="w-full max-w-sm">
          {me && (
            <div className="mb-4 rounded-sm border border-border bg-card px-4 py-3 flex items-center gap-3">
              <div
                className="size-8 rounded-full grid place-items-center text-xs font-bold text-black/80 shrink-0"
                style={{ backgroundColor: me.avatarColor }}
              >
                {me.username.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">still signed in as {me.username}</p>
                <p className="text-xs text-muted-foreground">adding another account keeps this one saved</p>
              </div>
              <Button variant="outline" size="sm" className="ml-auto rounded-sm" onClick={() => setView('app')}>
                back
              </Button>
            </div>
          )}

          <div className="rounded-sm border border-border bg-card p-6 sm:p-8">
            <h1 className="text-xl font-extrabold tracking-tight">
              {isRegister ? 'create your Hyperion account' : 'sign in to Hyperion'}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {isRegister ? 'pick a username and a password. that is all it takes.' : 'welcome back. your servers are waiting.'}
            </p>

            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              {isRegister ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="username">username</Label>
                    <Input
                      id="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="lowercase, 3 to 20 characters"
                      autoComplete="username"
                      minLength={3}
                      maxLength={20}
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      lowercase letters, numbers, and underscores. this is your name in chat.
                    </p>
                  </div>
                  {emailRequired && (
                    <div className="space-y-1.5">
                      <Label htmlFor="email">email</Label>
                      <Input
                        id="email"
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="you@example.com"
                        autoComplete="email"
                        required
                      />
                    </div>
                  )}
                </>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="identifier">username or email</Label>
                  <Input
                    id="identifier"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="your username"
                    autoComplete="username"
                    required
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="password">password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isRegister ? 'at least 8 characters' : 'your password'}
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  minLength={isRegister ? 8 : undefined}
                  required
                />
              </div>

              {error && (
                <p className="text-sm text-destructive rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-2">
                  {error}
                </p>
              )}

              <Button type="submit" className="w-full rounded-sm" disabled={busy}>
                {busy && <Spinner />}
                {isRegister ? 'create account' : 'sign in'}
              </Button>
            </form>

            <p className="mt-5 text-sm text-muted-foreground text-center">
              {isRegister ? 'already have an account?' : 'new to Hyperion?'}{' '}
              <button
                className="text-hyper hover:underline font-semibold"
                onClick={() => setView(isRegister ? 'login' : 'register')}
              >
                {isRegister ? 'sign in' : 'create an account'}
              </button>
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}
