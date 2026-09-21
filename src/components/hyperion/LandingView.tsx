'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import {
  Hash,
  AtSign,
  Image as ImageIcon,
  ImagePlay,
  Zap,
  Activity,
  KeyRound,
  ChevronRight,
  Crown,
  Shield,
  Smile,
  Pin,
  Search,
  Eye,
} from 'lucide-react'
import { HyperionMark, HyperionWordmark } from './Logo'
import { useChatStore } from '@/lib/client/store'

function ProductMock() {
  return (
    <div className="rounded-sm border border-border bg-app-chat shadow-2xl overflow-hidden" aria-hidden="true">
      <div className="flex h-[340px] sm:h-[380px] pointer-events-none select-none">
        {/* server rail */}
        <div className="w-14 bg-app-rail flex flex-col items-center gap-2 py-3 border-r border-border/60">
          <div className="w-9 h-9 rounded-sm bg-app-raise border border-white/15 grid place-items-center">
            <HyperionMark className="w-6 h-6 rounded-sm" />
          </div>
          <div className="w-8 h-px bg-border my-1" />
          <div className="relative w-9 h-9 rounded-sm bg-app-raise grid place-items-center text-[11px] font-bold">HO
            <Crown className="absolute -top-1 -right-1 size-3 text-white/70" />
          </div>
          <div className="w-9 h-9 rounded-sm bg-white grid place-items-center text-[11px] font-bold text-black">GA</div>
          <div className="w-9 h-9 rounded-sm bg-app-raise grid place-items-center text-[11px] font-bold">MU</div>
          <div className="w-9 h-9 rounded-sm border border-dashed border-border grid place-items-center text-muted-foreground text-sm">+</div>
        </div>
        {/* channel sidebar */}
        <div className="w-40 sm:w-48 bg-app-sidebar flex flex-col border-r border-border/60">
          <div className="h-11 px-3 flex items-center justify-between border-b border-border/60">
            <span className="text-[13px] font-bold tracking-tight truncate">Game Night</span>
          </div>
          <div className="px-3 pt-3 pb-1 text-[10px] font-bold tracking-widest text-muted-foreground">
            text channels
          </div>
          <div className="px-2 space-y-0.5">
            <div className="px-2 py-1 rounded-sm bg-app-raise text-[13px] flex items-center gap-1.5">
              <Hash className="size-3.5 text-muted-foreground" />
              <span className="font-semibold">general</span>
            </div>
            <div className="px-2 py-1 rounded-sm text-[13px] flex items-center gap-1.5 text-muted-foreground">
              <Hash className="size-3.5" />
              <span>saturday-run</span>
            </div>
            <div className="px-2 py-1 rounded-sm text-[13px] flex items-center gap-1.5 text-muted-foreground">
              <Hash className="size-3.5" />
              <span>clips</span>
              <span className="ml-auto min-w-4 h-4 px-1 bg-hyper text-[9px] font-bold text-white grid place-items-center rounded-sm">3</span>
            </div>
          </div>
          <div className="mt-auto mx-2 mb-2 px-2 py-1.5 rounded-sm bg-app-rail flex items-center gap-2">
            <div className="relative w-6 h-6 rounded-full bg-[#c9c9c9] grid place-items-center text-[10px] font-bold text-black/80">MK</div>
            <span className="text-[12px] text-foreground/90">maya</span>
            <span className="ml-auto size-2 rounded-full bg-online" />
          </div>
        </div>
        {/* chat */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="h-11 px-3 flex items-center gap-2 border-b border-border/60">
            <Hash className="size-4 text-muted-foreground" />
            <span className="text-[13px] font-bold tracking-tight">general</span>
            <span className="text-[11px] text-muted-foreground truncate hidden sm:block">weekly plans and general talk</span>
            <Pin className="ml-auto size-3.5 text-muted-foreground" />
            <Search className="size-3.5 text-muted-foreground" />
          </div>
          <div className="flex-1 px-4 py-4 space-y-3 overflow-hidden">
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-[#c9c9c9] shrink-0 grid place-items-center text-[11px] font-bold text-black/80">MK</div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-bold">maya</span>
                  <span className="text-[10px] text-muted-foreground">Today at 8:02 PM</span>
                </div>
                <p className="text-[13px] text-foreground/90 leading-snug">
                  new map rotation starts <strong className="text-white">friday</strong>, we should lock a squad
                </p>
                <div className="flex gap-1 mt-1">
                  <span className="flex items-center gap-1 h-5 px-1.5 rounded-sm border border-hyper/50 bg-hyper/15 text-[10px]">
                    🔥 <span className="font-semibold">2</span>
                  </span>
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-[#8a8a8a] shrink-0 grid place-items-center text-[11px] font-bold text-white/90">DV</div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-bold">devon</span>
                  <Crown className="size-3 text-white/70" />
                  <span className="text-[10px] text-muted-foreground">Today at 8:04 PM</span>
                </div>
                <p className="text-[13px] text-foreground/90 leading-snug">
                  in. <span className="text-hyper font-medium">@maya</span> can host the voice room too
                </p>
                <div className="mt-1.5 w-44 h-24 rounded-sm border border-border bg-app-raise grid place-items-center">
                  <ImageIcon className="size-5 text-muted-foreground" />
                </div>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="w-8 h-8 rounded-full bg-[#4a4a4a] shrink-0 grid place-items-center text-[11px] font-bold text-white/90">JL</div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-bold">jules</span>
                  <span className="text-[10px] text-muted-foreground">Today at 8:05 PM</span>
                </div>
                <p className="text-[13px] text-foreground/90 leading-snug">posting the highlight clip in #clips after</p>
              </div>
            </div>
          </div>
          <div className="px-4 pb-4">
            <div className="h-9 rounded-sm bg-app-raise border border-border/60 flex items-center px-3 gap-2">
              <span className="text-[12px] text-muted-foreground">message. @ to mention.</span>
              <Smile className="ml-auto size-4 text-muted-foreground" />
              <ImageIcon className="size-4 text-muted-foreground" />
            </div>
          </div>
        </div>
        {/* member list */}
        <div className="w-36 bg-app-sidebar border-l border-border/60 hidden md:flex flex-col py-3 px-2">
          <div className="px-2 pb-2 text-[10px] font-bold tracking-widest text-muted-foreground">owner, 1</div>
          <div className="px-2 py-1 rounded-sm flex items-center gap-2">
            <div className="relative w-5 h-5 rounded-full bg-[#8a8a8a] grid place-items-center text-[9px] font-bold text-white/90">
              DV
              <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-online ring-2 ring-app-sidebar" />
            </div>
            <span className="text-[12px] text-foreground/85">devon</span>
            <Crown className="ml-auto size-2.5 text-white/70" />
          </div>
          <div className="px-2 pt-3 pb-2 text-[10px] font-bold tracking-widest text-muted-foreground">online, 2</div>
          {['maya', 'jules'].map((name) => (
            <div key={name} className="px-2 py-1 rounded-sm flex items-center gap-2">
              <div className="relative w-5 h-5 rounded-full bg-app-raise grid place-items-center text-[9px] font-bold">
                {name.slice(0, 2).toUpperCase()}
                <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-online ring-2 ring-app-sidebar" />
              </div>
              <span className="text-[12px] text-foreground/85">{name}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const FEATURES = [
  {
    icon: Hash,
    title: 'Servers, Roles, and Channels',
    body: 'Make a server and own it. Custom roles with colors and granular permissions, promotion to admin, kick or ban with reasons, channel categories, topics, slowmode, locks, and private channels for chosen roles.',
  },
  {
    icon: Shield,
    title: 'Moderation That Actually Works',
    body: 'Timeout members from 1 minute to a week, purge spam in bulk, block words with server automod, and read the full audit log of who did what. Every action lands on the record.',
  },
  {
    icon: AtSign,
    title: 'Direct Messages With Read Receipts',
    body: 'Message anyone one on one, with read receipts and honest unread counts.',
  },
  {
    icon: ImageIcon,
    title: 'Image Sharing and Profile Pictures',
    body: 'Attach images to any message, upload a profile picture, and give your server an icon. Click any image to open it full size.',
  },
  {
    icon: Zap,
    title: 'Real-Time Delivery',
    body: 'Messages, presence, and typing travel over a live connection, kept current by a quiet sync loop.',
  },
  {
    icon: Activity,
    title: 'Presence, Typing, and Unread Marks',
    body: 'See who is online right now, who is typing, and exactly how much you missed in every channel and DM.',
  },
  {
    icon: KeyRound,
    title: 'Invite Codes You Control',
    body: 'Every server has an 8 character invite code. Owners can regenerate it anytime, and bans keep the wrong people out for good.',
  },
  {
    icon: Smile,
    title: 'Reactions, Pins, and Editing',
    body: 'React to any message, pin the important ones, fix your typos with message editing. Markdown works too: bold, italic, code blocks, quotes, spoilers.',
  },
  {
    icon: Search,
    title: 'Search That Reaches Everything You Can See',
    body: 'Search across your servers and direct messages, then jump straight to any result in its conversation with one click. Private channels stay private.',
  },
  {
    icon: ImagePlay,
    title: 'GIFs and File Sending',
    body: 'Search a reaction GIF without leaving the composer, or drop up to five files of any kind straight into the chat.',
  },
  {
    icon: Eye,
    title: 'Profiles Worth Looking At',
    body: 'Display names, server nicknames, an about-me line, custom status, join dates, and mutual servers, one card deep.',
  },
  {
    icon: Pin,
    title: 'Pinned Messages',
    body: 'Pin rules, links, or jokes to the top of any channel or DM. The pin list is one click from the header and jumps back to context.',
  },
]

export default function LandingView() {
  const setView = useChatStore((s) => s.setView)

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 h-16 flex items-center gap-4">
          <button
            className="flex items-center gap-2.5"
            onClick={() => setView('landing')}
            aria-label="HyperChat home"
          >
            <HyperionMark className="w-7 h-7 rounded-sm" />
            <HyperionWordmark className="text-sm" />
          </button>
          <nav className="ml-6 hidden md:flex items-center gap-1 text-sm">
            <button
              onClick={() => setView('landing')}
              className="px-3 py-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              HyperChat
            </button>
            <Link
              href="/games"
              className="px-3 py-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              Hyperion games
            </Link>
            <Link
              href="/games?tab=browse"
              className="px-3 py-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              browse
            </Link>
            <button
              onClick={() => setView('privacy')}
              className="px-3 py-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              aria-label="privacy (not written yet)"
            >
              ?
            </button>
            <button
              onClick={() => setView('terms')}
              className="px-3 py-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              aria-label="terms (not written yet)"
            >
              ?
            </button>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" className="rounded-sm" onClick={() => setView('login')}>
              Sign In
            </Button>
            <Button size="sm" className="rounded-sm" onClick={() => setView('register')}>
              Create Account
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 sm:px-6">
        {/* hero */}
        <section className="pt-14 sm:pt-20 pb-14 grid lg:grid-cols-[1fr_1.1fr] gap-10 lg:gap-14 items-center">
          <div>
            <p className="text-sm font-bold tracking-[0.2em] text-hyper mb-5">BLAZAR SOFTWARE™ NRC</p>
            <h1 className="flex items-center gap-3 sm:gap-4">
              <HyperionMark className="w-14 h-14 sm:w-16 sm:h-16 rounded-sm" />
              <HyperionWordmark className="text-4xl sm:text-5xl leading-none" />
            </h1>
            <p className="mt-5 text-lg text-muted-foreground leading-relaxed max-w-xl">
              Group chat with servers, roles, channels, direct messages with read receipts,
              reactions, pins, search, and image sharing.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button size="lg" className="rounded-sm" onClick={() => setView('register')}>
                Create an Account
                <ChevronRight className="size-4" />
              </Button>
              <Button size="lg" variant="outline" className="rounded-sm" onClick={() => setView('login')}>
                Sign In
              </Button>
            </div>
          </div>
          <div>
            <ProductMock />
            <p className="mt-3 text-xs text-muted-foreground text-center">
              The HyperChat interface: server rail, channels with unread marks, chat with
              reactions and mentions, roles in the member list.
            </p>
          </div>
        </section>

        {/* features */}
        <section className="py-14 border-t border-border">
          <h2 className="text-2xl font-extrabold tracking-tight">What Is in HyperChat</h2>
          <p className="mt-2 text-muted-foreground max-w-2xl">
            Everything below is in the product today.
          </p>
          <div className="mt-8 grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-sm border border-border bg-card p-5">
                <f.icon className="size-5 text-hyper" />
                <h3 className="mt-3 font-bold tracking-tight">{f.title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">{f.body}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-border mt-auto">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <div className="flex items-center gap-2.5">
            <HyperionMark className="w-6 h-6 rounded-sm" />
            <HyperionWordmark className="text-xs" />
          </div>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <button className="hover:text-foreground transition-colors" onClick={() => setView('landing')}>
              HyperChat
            </button>
            <Link href="/games" className="hover:text-foreground transition-colors">
              Hyperion games
            </Link>
            <Link href="/games?tab=browse" className="hover:text-foreground transition-colors">
              browse
            </Link>
            <button
              className="hover:text-foreground transition-colors"
              onClick={() => setView('privacy')}
              aria-label="privacy (not written yet)"
            >
              ?
            </button>
            <button
              className="hover:text-foreground transition-colors"
              onClick={() => setView('terms')}
              aria-label="terms (not written yet)"
            >
              ?
            </button>
          </nav>
          <p className="sm:ml-auto text-sm text-muted-foreground">© 2026 Blazar Software™ NRC</p>
        </div>
      </footer>
    </div>
  )
}
