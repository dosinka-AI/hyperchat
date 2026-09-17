'use client'

import { useEffect } from 'react'
import { useChatStore } from '@/lib/client/store'
import { HyperionMark } from '@/components/hyperion/Logo'
import LandingView from '@/components/hyperion/LandingView'
import AuthView from '@/components/hyperion/AuthView'
import PrivacyView from '@/components/hyperion/PrivacyView'
import TermsView from '@/components/hyperion/TermsView'
import ChatApp from '@/components/hyperchat/ChatApp'
import SuspendedView from '@/components/hyperchat/SuspendedView'
import { Spinner } from '@/components/ui/spinner'

function Splash() {
  return (
    <div className="min-h-screen bg-background grid place-items-center">
      <div className="flex flex-col items-center gap-4">
        <HyperionMark className="w-12 h-12" />
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Spinner />
          loading HyperChat
        </div>
      </div>
    </div>
  )
}

export default function Home() {
  const booted = useChatStore((s) => s.booted)
  const view = useChatStore((s) => s.view)
  const boot = useChatStore((s) => s.boot)

  useEffect(() => {
    void boot()
  }, [boot])

  if (!booted) {
    return <Splash />
  }

  switch (view) {
    case 'app':
      return <ChatApp />
    case 'suspended':
      return <SuspendedView />
    case 'login':
    case 'register':
      return <AuthView />
    case 'privacy':
      return <PrivacyView />
    case 'terms':
      return <TermsView />
    default:
      return <LandingView />
  }
}
