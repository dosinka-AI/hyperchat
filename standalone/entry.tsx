/* HyperChat, the standalone single-file build.
 *
 * Same app, same components, same store: only the transports differ. The
 * flag flips before anything else loads, the fetch interceptor answers
 * /api/* from the in-page backend, and the "socket" is a BroadcastChannel.
 * The landing page is skipped: the file opens straight on the login screen.
 *
 * Build: bun build standalone/entry.tsx --format=iife ... then inline into
 * the html shell together with the compiled stylesheet. */

import './flag'
import { installStandaloneBackend, registerGifPool, startStandaloneScheduler, setStandaloneUser } from './backend'
import { GIF_CATALOG } from '../src/components/hyperchat/gif-catalog'
import { useChatStore } from '../src/lib/client/store'
import { HyperionMark } from '../src/components/hyperion/Logo'
import AuthView from '../src/components/hyperion/AuthView'
import PrivacyView from '../src/components/hyperion/PrivacyView'
import TermsView from '../src/components/hyperion/TermsView'
import ChatApp from '../src/components/hyperchat/ChatApp'
import SuspendedView from '../src/components/hyperchat/SuspendedView'
import { Toaster } from '../src/components/ui/toaster'
import { Spinner } from '../src/components/ui/spinner'
import { createRoot } from 'react-dom/client'
import { createElement, useEffect } from 'react'


// the gif library rides along: the catalog urls are CDN links, so GIFs work
// whenever the file is opened with internet access
registerGifPool(GIF_CATALOG.map((g) => ({ id: g.id, url: g.url, title: g.title })))

installStandaloneBackend()
startStandaloneScheduler()

function Splash() {
  return createElement(
    'div',
    { className: 'min-h-screen bg-background grid place-items-center' },
    createElement(
      'div',
      { className: 'flex flex-col items-center gap-4' },
      createElement(HyperionMark, { className: 'w-12 h-12' }),
      createElement(
        'div',
        { className: 'flex items-center gap-2 text-muted-foreground text-sm' },
        createElement(Spinner),
        'loading hyperchat'
      )
    )
  )
}

function Root() {
  const booted = useChatStore((s) => s.booted)
  const view = useChatStore((s) => s.view)
  const boot = useChatStore((s) => s.boot)
  const me = useChatStore((s) => s.me)

  useEffect(() => {
    void boot()
  }, [boot])

  // keep the local backend pointed at the signed-in user
  useEffect(() => {
    setStandaloneUser(me?.id ?? null)
  }, [me?.id])

  let child: any
  if (!booted) child = createElement(Splash)
  else if (view === 'app') child = createElement(ChatApp)
  else if (view === 'suspended') child = createElement(SuspendedView)
  else if (view === 'login' || view === 'register') child = createElement(AuthView)
  else if (view === 'privacy') child = createElement(PrivacyView)
  else if (view === 'terms') child = createElement(TermsView)
  // the single-file build never shows the landing page
  else child = createElement(AuthView)

  return createElement(
    'div',
    { className: 'min-h-screen bg-background text-foreground antialiased' },
    child,
    createElement(Toaster)
  )
}

const mount = document.getElementById('__hyperchat_root')
if (mount) {
  createRoot(mount).render(createElement(Root))
}
