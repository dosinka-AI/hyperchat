'use client'

import { Button } from '@/components/ui/button'
import { ArrowLeft } from 'lucide-react'
import { HyperionMark, HyperionWordmark } from './Logo'
import { useChatStore } from '@/lib/client/store'

/** The terms of service do not exist yet. The entire document is the
 *  words "not written"; swap the body for the real document when it
 *  exists. */
export default function TermsView() {
  const setView = useChatStore((s) => s.setView)

  return (
    <div className="min-h-dvh bg-background flex flex-col">
      <header className="border-b border-border">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 h-16 flex items-center gap-3">
          <button onClick={() => setView('landing')} className="flex items-center gap-2.5" aria-label="back to home">
            <HyperionMark className="w-7 h-7" />
            <HyperionWordmark className="text-sm" />
          </button>
        </div>
      </header>

      <main className="flex-1 grid place-items-center px-4 py-16">
        <div className="max-w-md w-full text-center">
          <p className="font-mono text-[11px] tracking-widest text-muted-foreground">legal</p>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight">Terms</h1>
          <p className="mt-4 text-muted-foreground text-pretty">not written</p>
          <Button variant="outline" className="rounded-sm mt-8" onClick={() => setView('landing')}>
            <ArrowLeft className="size-4" />
            Back to home
          </Button>
        </div>
      </main>

      <footer className="border-t border-border mt-auto">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 flex items-center gap-4 text-sm text-muted-foreground">
          <button className="hover:text-foreground transition-colors" onClick={() => setView('privacy')}>
            Privacy Policy
          </button>
          <button className="hover:text-foreground transition-colors" onClick={() => setView('landing')}>
            Hyperion
          </button>
        </div>
      </footer>
    </div>
  )
}
