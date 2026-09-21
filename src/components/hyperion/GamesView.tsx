'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ExternalLink, Search, X } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { HyperionMark } from './Logo'
import { HYPER_GAMES, type HyperGame } from '@/lib/games-catalog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const easeOut = [0.22, 1, 0.36, 1] as const

type Tab = 'games' | 'browse'

export default function GamesView({ initialTab = 'games' }: { initialTab?: Tab }) {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>(initialTab)
  const [activeId, setActiveId] = useState<string | null>(null)
  const active = useMemo(
    () => HYPER_GAMES.find((g) => g.id === activeId) ?? null,
    [activeId]
  )

  const selectTab = (next: Tab) => {
    setTab(next)
    router.replace(next === 'browse' ? '/games?tab=browse' : '/games', { scroll: false })
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans relative">
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 h-16 flex items-center gap-4">
          <Link href="/" className="flex items-center gap-2.5" aria-label="Hyperion home">
            <HyperionMark className="w-7 h-7 rounded-sm" />
            <span className="text-sm font-extrabold italic tracking-tight text-white uppercase">
              HYPERION
            </span>
          </Link>
          <nav className="ml-6 flex items-center gap-1 text-sm">
            <Link
              href="/"
              className="px-3 py-1.5 rounded-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors hidden md:inline-flex"
            >
              Hyperion
            </Link>
            <button
              type="button"
              onClick={() => selectTab('games')}
              className={cn(
                'px-3 py-1.5 rounded-sm font-semibold transition-colors',
                tab === 'games'
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              )}
            >
              games
            </button>
            <button
              type="button"
              onClick={() => selectTab('browse')}
              className={cn(
                'px-3 py-1.5 rounded-sm font-semibold transition-colors',
                tab === 'browse'
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              )}
            >
              browse
            </button>
          </nav>
        </div>
      </header>

      <AnimatePresence mode="wait">
        {tab === 'games' ? (
          <motion.div
            key="games"
            className="flex-1 flex flex-col"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.28, ease: easeOut }}
          >
            <GamesPanel onOpenGame={setActiveId} />
          </motion.div>
        ) : (
          <motion.div
            key="browse"
            className="flex-1 flex flex-col relative overflow-hidden"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.28, ease: easeOut }}
          >
            <Starfield />
            <BrowsePanel />
          </motion.div>
        )}
      </AnimatePresence>

      <footer className="border-t border-border mt-auto relative z-10 bg-black">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-12 flex flex-col gap-6">
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <Link href="/" className="hover:text-foreground transition-colors">
              Hyperion
            </Link>
            <button
              type="button"
              onClick={() => selectTab('games')}
              className={cn('hover:text-foreground transition-colors', tab === 'games' && 'text-foreground')}
            >
              games
            </button>
            <button
              type="button"
              onClick={() => selectTab('browse')}
              className={cn('hover:text-foreground transition-colors', tab === 'browse' && 'text-foreground')}
            >
              browse
            </button>
          </nav>
          <p className="text-sm font-bold tracking-[0.2em] text-white">
            BLAZAR SOFTWARE™ NRC
          </p>
          <motion.p
            className="text-3xl sm:text-4xl font-extrabold italic tracking-tight text-white"
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{ duration: 0.6, ease: easeOut }}
          >
            <span className="uppercase">HYPERION</span> {tab === 'browse' ? 'browse' : 'games'}
          </motion.p>
        </div>
      </footer>

      <AnimatePresence>
        {active ? <GamePlayer game={active} onClose={() => setActiveId(null)} /> : null}
      </AnimatePresence>
    </div>
  )
}

function GamesPanel({ onOpenGame }: { onOpenGame: (id: string) => void }) {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 sm:px-6 flex-1">
      <section className="pt-6 sm:pt-8 pb-8">
        <motion.h1
          className="text-4xl sm:text-5xl font-extrabold italic tracking-tight text-white"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: easeOut }}
        >
          <span className="uppercase">HYPERION</span> games
        </motion.h1>
        <motion.p
          className="mt-3 text-lg text-muted-foreground leading-relaxed max-w-xl"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.08, ease: easeOut }}
        >
          pick a tile to play. games load in-page when an embed url is set, or open externally when linked.
        </motion.p>
      </section>

      <section className="pb-16 border-t border-border pt-10">
        <motion.div
          className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4"
          initial="hidden"
          animate="show"
          variants={{
            hidden: {},
            show: { transition: { staggerChildren: 0.05, delayChildren: 0.12 } },
          }}
        >
          {HYPER_GAMES.map((game) => (
            <GameTile key={game.id} game={game} onOpen={() => onOpenGame(game.id)} />
          ))}
        </motion.div>
      </section>
    </main>
  )
}

function BrowsePanel() {
  return (
    <div className="relative z-10 flex-1 flex flex-col min-h-[calc(100vh-4rem)]">
      <main className="relative mx-auto w-full max-w-3xl px-4 sm:px-6 flex-1 flex flex-col justify-center py-16">
        <motion.h1
          className="text-4xl sm:text-5xl font-extrabold italic tracking-tight text-white text-center"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: easeOut }}
        >
          <span className="uppercase">HYPERION</span> browse
        </motion.h1>
        <motion.p
          className="mt-3 text-lg text-muted-foreground leading-relaxed text-center"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.08, ease: easeOut }}
        >
          search the web. swap this bar for your own DuckDuckGo embed anytime.
        </motion.p>

        {/* placeholder search — replace or restyle with your DuckDuckGo bar */}
        <motion.form
          action="https://duckduckgo.com/"
          method="get"
          target="_blank"
          rel="noreferrer"
          className="mt-10"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.16, ease: easeOut }}
        >
          <label htmlFor="hyperion-browse-q" className="sr-only">
            search
          </label>
          <div className="flex items-center gap-2 rounded-sm border border-white/15 bg-black/50 backdrop-blur-md px-3 py-2.5 focus-within:border-white/35 transition-colors">
            <Search className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
            <input
              id="hyperion-browse-q"
              name="q"
              type="search"
              placeholder="search with DuckDuckGo…"
              className="flex-1 min-w-0 bg-transparent text-sm text-white placeholder:text-muted-foreground outline-none"
              autoComplete="off"
            />
            <Button type="submit" size="sm" className="rounded-sm shrink-0">
              go
            </Button>
          </div>
        </motion.form>
      </main>
    </div>
  )
}

type Star = {
  x: number
  y: number
  size: number
  baseAlpha: number
  twinkle: number
  twinkleSpeed: number
  driftX: number
  driftY: number
}

function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let width = 0
    let height = 0
    let stars: Star[] = []

    const density = 0.00018 // stars per px² ≈ 180 on 1080p

    const makeStar = (): Star => ({
      x: Math.random() * width,
      y: Math.random() * height,
      size: 0.4 + Math.random() * 1.6,
      baseAlpha: 0.25 + Math.random() * 0.7,
      twinkle: Math.random() * Math.PI * 2,
      twinkleSpeed: 0.008 + Math.random() * 0.02,
      driftX: (Math.random() - 0.5) * 0.04,
      driftY: (Math.random() - 0.5) * 0.03,
    })

    const rebuild = () => {
      const count = Math.max(120, Math.floor(width * height * density))
      stars = Array.from({ length: count }, makeStar)
    }

    const resize = () => {
      width = window.innerWidth
      height = window.innerHeight
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      rebuild()
    }

    resize()

    const draw = () => {
      ctx.fillStyle = '#0a0a0a'
      ctx.fillRect(0, 0, width, height)

      for (const star of stars) {
        star.twinkle += star.twinkleSpeed
        star.x += star.driftX
        star.y += star.driftY

        if (star.x < -2) star.x = width + 2
        else if (star.x > width + 2) star.x = -2
        if (star.y < -2) star.y = height + 2
        else if (star.y > height + 2) star.y = -2

        const flicker = 0.55 + 0.45 * Math.sin(star.twinkle)
        const alpha = Math.min(1, star.baseAlpha * flicker)

        ctx.beginPath()
        ctx.fillStyle = `rgba(255,255,255,${alpha})`
        ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2)
        ctx.fill()
      }

      raf = requestAnimationFrame(draw)
    }

    const onResize = () => resize()
    window.addEventListener('resize', onResize)
    raf = requestAnimationFrame(draw)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 z-0 pointer-events-none"
      aria-hidden="true"
    />
  )
}

function GameTile({ game, onOpen }: { game: HyperGame; onOpen: () => void }) {
  const playable = Boolean(game.embedUrl || game.externalUrl)
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      variants={{
        hidden: { opacity: 0, y: 16 },
        show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: easeOut } },
      }}
      whileHover={{ y: -4, borderColor: 'rgba(255,255,255,0.28)' }}
      whileTap={{ scale: 0.985 }}
      transition={{ type: 'spring', stiffness: 380, damping: 28 }}
      className="group text-left rounded-sm border border-border bg-black overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-hyper/60"
    >
      <div className="aspect-square bg-black border-b border-border/60 relative overflow-hidden">
        <motion.div
          className="absolute inset-0 bg-gradient-to-t from-white/10 to-transparent opacity-0 group-hover:opacity-100"
          transition={{ duration: 0.25 }}
        />
      </div>
      <div className="px-3 py-2.5 bg-background/80">
        <p className="text-sm font-bold tracking-tight truncate text-white">{game.title}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">{game.blurb}</p>
        <p className="mt-2 text-[10px] font-bold tracking-widest text-hyper lowercase">
          {playable ? 'play' : 'soon'}
        </p>
      </div>
    </motion.button>
  )
}

function GamePlayer({ game, onClose }: { game: HyperGame; onClose: () => void }) {
  return (
    <motion.div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex flex-col font-sans"
      role="dialog"
      aria-modal="true"
      aria-label={game.title}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <motion.div
        className="h-14 shrink-0 border-b border-border bg-background px-4 flex items-center gap-3"
        initial={{ y: -12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.3, ease: easeOut }}
      >
        <HyperionMark className="w-6 h-6 rounded-sm" />
        <div className="min-w-0">
          <p className="text-sm font-bold tracking-tight truncate text-white">{game.title}</p>
          <p className="text-[11px] text-muted-foreground truncate">{game.blurb}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {game.externalUrl ? (
            <Button asChild size="sm" variant="outline" className="rounded-sm">
              <a href={game.externalUrl} target="_blank" rel="noreferrer">
                open site
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" className="rounded-sm" onClick={onClose} aria-label="close game">
            <X className="size-4" />
          </Button>
        </div>
      </motion.div>

      <motion.div
        className="flex-1 min-h-0 bg-black"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, delay: 0.05, ease: easeOut }}
      >
        {game.embedUrl ? (
          <iframe
            title={game.title}
            src={game.embedUrl}
            className="w-full h-full border-0"
            allow="fullscreen; gamepad; autoplay"
            allowFullScreen
          />
        ) : game.externalUrl ? (
          <div className="h-full grid place-items-center px-6 text-center">
            <div>
              <p className="text-muted-foreground text-sm max-w-md">
                this game opens on its own site instead of inside Hyperion games.
              </p>
              <Button asChild className="mt-4 rounded-sm">
                <a href={game.externalUrl} target="_blank" rel="noreferrer">
                  launch
                  <ExternalLink className="size-3.5" />
                </a>
              </Button>
            </div>
          </div>
        ) : (
          <div className="h-full grid place-items-center px-6 text-center">
            <div>
              <div className="mx-auto w-24 h-24 rounded-sm bg-black border border-border" />
              <p className="mt-5 text-sm text-muted-foreground max-w-md">
                no embed yet. add an embed url or external url for this game in the catalog.
              </p>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}
