'use client'

import { useEffect } from 'react'

/** App-level error boundary: if anything in the client tree throws, show a
 *  calm recovery screen instead of a white page. */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[HyperChat] render error:', error)
  }, [error])

  return (
    <div className="min-h-screen bg-[#111] text-[#f5f5f5] grid place-items-center p-6">
      <div className="max-w-md w-full text-center">
        <div className="mx-auto size-12 rounded-sm bg-[#1e1e1e] border border-white/10 grid place-items-center font-extrabold text-lg">
          H
        </div>
        <h1 className="mt-4 text-xl font-extrabold tracking-tight">Something broke</h1>
        <p className="mt-2 text-sm text-white/60 leading-relaxed">
          HyperChat hit an unexpected error. Your messages and servers are safe on the server.
          Reload the page, or try again below.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <button
            onClick={reset}
            className="px-4 h-9 text-sm font-semibold bg-white text-black rounded-sm hover:bg-white/90 transition-colors"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-4 h-9 text-sm font-semibold border border-white/15 text-white/80 rounded-sm hover:border-white/30 transition-colors"
          >
            Reload
          </button>
        </div>
        {error.digest && (
          <p className="mt-6 text-[10px] text-white/30 font-mono">ref: {error.digest}</p>
        )}
      </div>
    </div>
  )
}
