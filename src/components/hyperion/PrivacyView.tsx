'use client'

import { HyperionMark, HyperionWordmark } from './Logo'
import { useChatStore } from '@/lib/client/store'

/** Placeholder: the real policy is not written yet, so the page is just a
 *  question mark. Swap the body for the real document when it exists. */
export default function PrivacyView() {
  const setView = useChatStore((s) => s.setView)

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 h-16 flex items-center gap-3">
          <button onClick={() => setView('landing')} className="flex items-center gap-2.5" aria-label="back to home">
            <HyperionMark className="w-7 h-7" />
            <HyperionWordmark className="text-sm" />
          </button>
        </div>
      </header>

      <main className="flex-1 grid place-items-center px-4 py-16">
        <div className="text-center select-none">
          <p className="text-sm font-bold tracking-widest text-muted-foreground lowercase">privacy</p>
          <p className="mt-3 text-7xl font-extrabold tracking-tight text-muted-foreground/80" aria-label="privacy policy not written yet">
            ?
          </p>
        </div>
      </main>
    </div>
  )
}
