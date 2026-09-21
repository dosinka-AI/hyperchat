'use client'

import { useEffect, useRef, useState } from 'react'
import { useChatStore, consumePermalinkHash } from '@/lib/client/store'
import { initSocket, destroySocket, trackActiveRoom, subscribeRoom, unsubscribeRoom, subscribeServerRoom } from '@/lib/client/socket'
import { initPushToTalk } from '@/lib/client/ptt'
import { sounds } from '@/lib/client/sounds'
import { getAppearance } from '@/lib/client/appearance'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ServerRail } from './ServerRail'
import { ChannelSidebar } from './ChannelSidebar'
import { ChatHeader } from './ChatHeader'
import { MessageList } from './MessageList'
import { MessageInput } from './MessageInput'
import { MemberList } from './MemberList'
import { GroupMemberList } from './GroupMemberList'
import { MediaPlayer } from './MediaPlayer'
import { AddServerDialog } from './modals/AddServerDialog'
import { CreateChannelDialog } from './modals/CreateChannelDialog'
import { InviteDialog } from './modals/InviteDialog'
import { FindUserDialog } from './modals/FindUserDialog'
import { ServerSettingsDialog } from './ServerSettingsDialog'
import { ChannelSettingsDialog } from './ChannelSettingsDialog'
import { PurgeDialog } from './PurgeDialog'
import { SearchDialog, type SearchScope } from './SearchDialog'
import { SummarizeDialog } from './SummarizeDialog'
import { GroupSettingsDialog } from './GroupSettingsDialog'
import { PinsDialog } from './PinsDialog'
import { RemindersDialog } from './RemindersDialog'
import { QuickSwitcher } from './QuickSwitcher'
import { AccountView } from './AccountView'
import { AdminPanel } from './AdminPanel'
import { ProfileEditor } from './ProfileEditor'
import { ProfileCard } from './ProfileCard'
import { FriendsView } from './FriendsView'
import { DMProfilePanel } from './DMProfilePanel'
import { SavedMessagesDialog } from './SavedMessagesDialog'
import { ScheduledDialog } from './ScheduledDialog'
import { ThreadPanel } from './ThreadPanel'
import { VoiceRoom } from './VoiceRoom'
import { ForumView } from './ForumView'
import { ForwardDialog } from './ForwardDialog'
import { ShortcutsDialog } from './ShortcutsDialog'
import { ConfirmDialogHost } from './ConfirmDialog'
import { ContextMenuHost } from './ContextMenu'
import { EmojiPopHost } from './EmojiPop'
import { CallOverlay, CallDock, CallStage, CallSpectatorStrip } from './CallOverlay'
import { GuestVoiceRoom } from './GuestVoiceRoom'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { HyperionMark, HyperionWordmark } from '@/components/hyperion/Logo'
import { MessageSquarePlus, Plus, UserPlus } from 'lucide-react'
import { cn } from '@/lib/utils'

const SYNC_INTERVAL_MS = 5000

/** Offline means offline: past the grace window the app is replaced by a
 *  full-screen reconnect state, so nobody browses a stale world. */
const OFFLINE_GRACE_MS = 4000

function ReconnectScreen({ seconds }: { seconds: number }) {
  return (
    <div className="h-dvh w-full bg-background grid place-items-center fade-in">
      <div className="flex flex-col items-center gap-4">
        <HyperionMark className="w-12 h-12" />
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Spinner />
          Reconnecting{seconds > 0 ? ` · ${seconds}s` : ''}
        </div>
      </div>
    </div>
  )
}

function HomeMain({ onCreate, onJoin, onFind }: { onCreate: () => void; onJoin: () => void; onFind: () => void }) {
  const me = useChatStore((s) => s.me)

  return (
    <div className="flex-1 grid place-items-center p-6 overflow-y-auto scroll-thin">
      <div className="max-w-md w-full text-center">
        <HyperionMark className="w-16 h-16 mx-auto rounded-sm" />
        <h1 className="mt-4 text-2xl font-extrabold tracking-tight">
          welcome, {me?.displayName || me?.username}
        </h1>
        <div className="mt-7 grid gap-2.5">
          <Button size="lg" className="justify-start rounded-sm" onClick={onCreate}>
            <Plus className="size-4" />
            create a server
          </Button>
          <Button size="lg" variant="outline" className="justify-start rounded-sm" onClick={onJoin}>
            <UserPlus className="size-4" />
            join with an invite code
          </Button>
          <Button size="lg" variant="outline" className="justify-start rounded-sm" onClick={onFind}>
            <MessageSquarePlus className="size-4" />
            find a direct message
          </Button>
        </div>
        <p className="mt-8 text-[11px] text-muted-foreground flex items-center justify-center gap-1.5">
          <HyperionWordmark className="text-sm" />
        </p>
      </div>
    </div>
  )
}

export default function ChatApp() {
  const me = useChatStore((s) => s.me)
  const view = useChatStore((s) => s.view)
  const activeChannelId = useChatStore((s) => s.activeChannelId)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const activeServerId = useChatStore((s) => s.activeServerId)
  const servers = useChatStore((s) => s.servers)
  // DM profile panel is for 1:1 conversations only: groups hide it
  const activeConversationIsDM = useChatStore((s) =>
    s.activeConversationId
      ? (s.conversations.find((c) => c.id === s.activeConversationId)?.kind ?? 'DM') === 'DM'
      : false
  )
  // groups get the server-like member column on the right instead
  const activeConversationIsGroup = useChatStore((s) =>
    s.activeConversationId
      ? (s.conversations.find((c) => c.id === s.activeConversationId)?.kind ?? 'DM') === 'GROUP'
      : false
  )
  const pruneTyping = useChatStore((s) => s.pruneTyping)
  const syncNow = useChatStore((s) => s.syncNow)
  const maybeMarkRead = useChatStore((s) => s.maybeMarkRead)
  const tickReminders = useChatStore((s) => s.tickReminders)
  const scheduled = useChatStore((s) => s.scheduled)
  const focusUntil = useChatStore((s) => s.focusUntil)

  const friendsViewOpen = useChatStore((s) => s.friendsViewOpen)
  const accountOpen = useChatStore((s) => s.accountOpen)
  const openThreadId = useChatStore((s) => s.openThreadId)
  const selectChannel = useChatStore((s) => s.selectChannel)
  const selectConversation = useChatStore((s) => s.selectConversation)
  // call surfaces gate themselves: the inline stage (CallStage) decides its
  // own visibility so it can also run its closing animation when a call
  // ends while the conversation stays open; the dock and overlay do the same

  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [mobileMembersOpen, setMobileMembersOpen] = useState(false)
  // the DM profile column is open by default on desktop; on phones it would
  // bury the chat, so it starts closed and opens as an overlay from the header

  // ---- mobile drawer gestures ----
  // swipe from the left edge of the screen opens the sidebar drawer; a
  // leftward swipe on the open drawer closes it. both cancel the moment
  // the gesture turns vertical so scrolling lists never fights the drawer.
  const drawerRef = useRef<HTMLDivElement>(null)
  const swipe = useRef<{ x: number; y: number; mode: 'open' | 'close' | null } | null>(null)
  const setMobileSidebar = (open: boolean) => setMobileSidebarOpen(open)
  const onMainTouchStart = (e: React.TouchEvent) => {
    if (mobileSidebarOpen) return
    const t = e.touches[0]
    // only a touch born within 28px of the screen edge can become a swipe
    swipe.current = t.clientX <= 28 ? { x: t.clientX, y: t.clientY, mode: 'open' } : null
  }
  const onMainTouchMove = (e: React.TouchEvent) => {
    const sw = swipe.current
    if (!sw || sw.mode !== 'open') return
    const t = e.touches[0]
    // vertical intent cancels: that is a scroll, not a swipe
    if (Math.abs(t.clientY - sw.y) > 24) swipe.current = null
  }
  const onMainTouchEnd = (e: React.TouchEvent) => {
    const sw = swipe.current
    swipe.current = null
    if (!sw || sw.mode !== 'open') return
    const t = e.changedTouches[0]
    if (t.clientX - sw.x > 56) setMobileSidebar(true)
  }
  const onDrawerTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    // swipes that begin on the drawer's own surface close it
    swipe.current = { x: t.clientX, y: t.clientY, mode: 'close' }
  }
  const onDrawerTouchMove = (e: React.TouchEvent) => {
    const sw = swipe.current
    if (!sw || sw.mode !== 'close') return
    const t = e.touches[0]
    if (Math.abs(t.clientY - sw.y) > 24) swipe.current = null
  }
  const onDrawerTouchEnd = (e: React.TouchEvent) => {
    const sw = swipe.current
    swipe.current = null
    if (!sw || sw.mode !== 'close') return
    const t = e.changedTouches[0]
    if (sw.x - t.clientX > 56) setMobileSidebar(false)
  }
  const [dmProfileOpen, setDmProfileOpen] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 1024px)').matches
  )
  // switching DMs auto-closes the overlay column on phones so each new chat
  // starts on the conversation, not on the previous person's profile
  const [lastConversationId, setLastConversationId] = useState(activeConversationId)
  if (activeConversationId !== lastConversationId) {
    setLastConversationId(activeConversationId)
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 1024px)').matches) {
      setDmProfileOpen(false)
    }
  }

  // connection gate: once the socket has been down past the grace window the
  // whole app swaps to the reconnect screen until the line returns
  const connected = useChatStore((s) => s.connected)
  const [offlineFor, setOfflineFor] = useState(0)
  useEffect(() => {
    if (connected) {
      queueMicrotask(() => setOfflineFor(0))
      return
    }
    const started = Date.now()
    queueMicrotask(() => setOfflineFor(0))
    const t = setInterval(() => setOfflineFor(Date.now() - started), 1000)
    return () => clearInterval(t)
  }, [connected])
  const offlineBlocked = !connected && offlineFor >= OFFLINE_GRACE_MS

  const [addServerOpen, setAddServerOpen] = useState(false)
  const [createChannelOpen, setCreateChannelOpen] = useState(false)
  const [createChannelCategory, setCreateChannelCategory] = useState<string | null>(null)
  const [createCategoryOpen, setCreateCategoryOpen] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [findUserOpen, setFindUserOpen] = useState(false)
  const [serverSettingsOpen, setServerSettingsOpen] = useState(false)
  const [channelSettingsOpen, setChannelSettingsOpen] = useState(false)
  const [purgeOpen, setPurgeOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchScope, setSearchScope] = useState<SearchScope>('room')
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [groupSettingsOpen, setGroupSettingsOpen] = useState(false)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // the pins overlay is store-driven: the header button AND "x pinned a
  // message" system rows both open the same overlay
  const pinsOpen = useChatStore((s) => s.pinsOpen)
  const setPinsOpen = useChatStore((s) => s.setPinsOpen)

  // Ctrl+K opens the quick switcher anywhere in the app; alt+arrows walk
  // channels (server view) or DMs (home); shift+? is the cheat sheet
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        sounds.play('lightTick')
        setSwitcherOpen((v) => !v)
        return
      }
      const target = e.target as HTMLElement | null
      const typing =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (e.key === '?' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        sounds.play('lightTick')
        setShortcutsOpen(true)
        return
      }
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        if (typing) return
        e.preventDefault()
        const s = useChatStore.getState()
        if (s.activeServerId) {
          const server = s.servers.find((sv) => sv.id === s.activeServerId)
          if (!server) return
          const list = [...server.channels].sort((a, b) => a.position - b.position)
          const idx = list.findIndex((c) => c.id === s.activeChannelId)
          const next = e.key === 'ArrowDown' ? idx + 1 : idx - 1
          const targetChannel = list[(next + list.length) % list.length]
          if (targetChannel) {
            sounds.play('lightTick')
            void selectChannel(targetChannel.id)
          }
        } else {
          const list = s.conversations
          const idx = list.findIndex((c) => c.id === s.activeConversationId)
          const next = e.key === 'ArrowDown' ? idx + 1 : idx - 1
          const targetConvo = list[(next + list.length) % list.length]
          if (targetConvo) {
            sounds.play('lightTick')
            void selectConversation(targetConvo.id)
          }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectChannel, selectConversation])

  // unread total in the document title: (3) HyperChat
  const totalUnread = useChatStore((s) => {
    const channelTotal = Object.values(s.channelUnread).reduce((a, b) => a + b, 0)
    const dmTotal = s.conversations.reduce((a, c) => a + c.unreadCount, 0)
    return channelTotal + dmTotal
  })
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) Hyperion` : 'Hyperion'
  }, [totalUnread])

  // realtime lifecycle: the persisted presence choice rides the handshake
  useEffect(() => {
    getAppearance() // applies compact + font size data attributes at boot
    initSocket(me?.presence)
    initPushToTalk() // hold-to-talk key router (voice rooms + calls)
    sounds.play('enter')
    return () => {
      destroySocket()
    }
  }, [])

  // apply a presence learned after socket init (boot completes late)
  useEffect(() => {
    if (me?.presence) initSocket(me.presence)
  }, [me?.presence])

  // reminder ticker: fires due reminders as toasts every 20s, and the
  // instant the window regains focus (nothing fires or decays while the
  // tab is hidden — reminders wait for you to look)
  useEffect(() => {
    const t = setInterval(() => tickReminders(), 20000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') tickReminders()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [tickReminders])

  // scheduled queue: refresh every 30s so deliveries from OTHER devices show up
  useEffect(() => {
    if (view !== 'app') return
    const t = setInterval(() => {
      void useChatStore.getState().refreshScheduled()
    }, 30000)
    return () => clearInterval(t)
  }, [view])

  // focus mode expiry: restore sounds when the window closes
  useEffect(() => {
    if (!focusUntil) return
    const remaining = focusUntil - Date.now()
    if (remaining <= 0) {
      useChatStore.getState().setFocus(null)
      return
    }
    const t = setTimeout(() => useChatStore.getState().setFocus(null), remaining)
    return () => clearTimeout(t)
  }, [focusUntil])

  // expire stale typing indicators once a second
  useEffect(() => {
    const t = setInterval(() => pruneTyping(), 1000)
    return () => clearInterval(t)
  }, [pruneTyping])

  // HTTP sync fallback: keeps presence, messages and lists moving even when
  // the websocket is dead behind a proxy. This is why nothing needs a reload.
  useEffect(() => {
    if (view !== 'app') return
    void syncNow()
    const t = setInterval(() => void syncNow(), SYNC_INTERVAL_MS)
    const onFocus = () => {
      void syncNow()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', onFocus)
    }
  }, [view, syncNow])

  // mark the open room read whenever the window regains focus — but only
  // honestly: maybeMarkRead re-checks the read gate (focus + recent input,
  // active room, bottom-parked), so a focus ping on an idle machine or a
  // history-parked reader claims nothing
  useEffect(() => {
    const onFocus = () => {
      const s = useChatStore.getState()
      const room = s.activeChannelId
        ? `channel:${s.activeChannelId}`
        : s.activeConversationId
          ? `conversation:${s.activeConversationId}`
          : null
      if (room) maybeMarkRead(room)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [maybeMarkRead])

  // permalink navigation: #msg=<id> links clicked in-session (pasted into
  // chats) jump without a reload; the boot path handles deep links
  useEffect(() => {
    if (view !== 'app') return
    const onHash = () => {
      const id = consumePermalinkHash()
      if (id) void useChatStore.getState().jumpToMessage(id)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [view])

  // follow the active conversation into its socket room
  const activeRoom = activeChannelId
    ? `channel:${activeChannelId}`
    : activeConversationId
      ? `conversation:${activeConversationId}`
      : null

  useEffect(() => {
    if (!activeRoom) return
    subscribeRoom(activeRoom)
    trackActiveRoom(activeRoom)
    // channel switches click instead of whooming: a light tick reads as a
    // single crisp navigation event
    sounds.play('click')
    return () => {
      unsubscribeRoom(activeRoom)
    }
  }, [activeRoom])

  // the server room carries live voice:state so the sidebar can show who is
  // in a voice channel even when this client is not in the call
  useEffect(() => {
    subscribeServerRoom(activeServerId)
    return () => subscribeServerRoom(null)
  }, [activeServerId])

  if (!me || view !== 'app') return null

  if (offlineBlocked) {
    return <ReconnectScreen seconds={Math.floor(offlineFor / 1000)} />
  }

  const hasConversationOpen = !!activeRoom
  const activeChannel = activeChannelId
    ? servers.flatMap((s) => s.channels).find((c) => c.id === activeChannelId) ?? null
    : null
  const channelName = activeChannel?.name ?? null
  const channelType = activeChannel?.type ?? 'text'

  return (
    <TooltipProvider delayDuration={300}>
      <div className="h-dvh w-full overflow-hidden bg-app-chat flex flex-col text-foreground">
        {/* the collapsed call docks here, Discord-style: a medium strip
            pinned just below the top bar, spanning the app. It carries the
            call's video thumbnails, avatars, status, and controls wherever
            you browse, and one click returns you to the call location */}
        <div className="pt-[env(safe-area-inset-top)] shrink-0">
          <CallDock />
        </div>
        <div className="flex-1 min-h-0 flex">
          {/* server rail + channel sidebar, one shell: static columns on
              desktop; a single slide-in drawer on mobile where the rail
              rides INSIDE the drawer so the chat column gets the full
              screen width. swipe from the left edge to open, swipe the
              drawer left to close. */}
          <div
            ref={drawerRef}
            className={cn(
              'fixed inset-y-0 left-0 z-40 flex transition-transform duration-150 md:static md:translate-x-0 md:visible md:z-auto',
              mobileSidebarOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full invisible md:visible'
            )}
            onTouchStart={onDrawerTouchStart}
            onTouchMove={onDrawerTouchMove}
            onTouchEnd={onDrawerTouchEnd}
          >
            <ServerRail
              onAddServer={() => setAddServerOpen(true)}
              onNavigated={() => setMobileSidebar(false)}
            />
            <div className="w-72 max-w-[calc(100vw-4.5rem)] md:w-60 md:max-w-none shrink-0 flex flex-col">
              <ChannelSidebar
                onInvite={() => setInviteOpen(true)}
                onOpenSidebarSearch={() => {
                  setSearchScope('conversations')
                  setSearchOpen(true)
                }}
                onCreateChannel={(categoryId) => {
                  setCreateChannelCategory(categoryId ?? null)
                  setCreateChannelOpen(true)
                }}
                onCreateCategory={() => setCreateCategoryOpen(true)}
                onFindUser={() => setFindUserOpen(true)}
                onServerSettings={() => setServerSettingsOpen(true)}
                onNavigated={() => setMobileSidebar(false)}
              />
            </div>
          </div>
        {mobileSidebarOpen && (
          <button
            className="fixed inset-0 z-30 bg-black/70 md:hidden"
            onClick={() => setMobileSidebar(false)}
            aria-label="close channel list"
          />
        )}

        {/* main column */}
        <main
          className="flex-1 min-w-0 flex flex-col bg-app-chat"
          onTouchStart={onMainTouchStart}
          onTouchMove={onMainTouchMove}
          onTouchEnd={onMainTouchEnd}
        >
          {friendsViewOpen ? (
            <FriendsView />
          ) : (
            <>
              <ChatHeader
                onToggleSidebar={() => setMobileSidebarOpen((v) => !v)}
                onToggleMembers={() => setMobileMembersOpen((v) => !v)}
                membersOpen={mobileMembersOpen}
                membersAvailable={!!activeServerId || (!!activeConversationId && activeConversationIsGroup)}
                onOpenSearch={() => {
                  setSearchScope('room')
                  setSearchOpen(true)
                }}
                onOpenSummary={() => setSummaryOpen(true)}
                onOpenGroupSettings={() => setGroupSettingsOpen(true)}
                onOpenPins={() => setPinsOpen(true)}
                onOpenChannelSettings={() => setChannelSettingsOpen(true)}
                onOpenPurge={() => setPurgeOpen(true)}
                onOpenShortcuts={() => setShortcutsOpen(true)}
                dmProfileOpen={dmProfileOpen}
                onToggleDmProfile={
                  !activeServerId && activeConversationId ? () => setDmProfileOpen((v) => !v) : undefined
                }
              />
              {/* the content pane is keyed by room: every channel or DM switch
                  replays the focus-pull transition (blur + settle) instead of
                  hard-cutting between conversations. min-h-0 is load-bearing:
                  without it a flex child's default min-height:auto lets the
                  message list inflate this pane to full content height, the
                  document grows a scrollbar at the ROOT, and any
                  scrollIntoView walks the whole app out of view (sidebars
                  vanish, the composer disappears, everything looks frozen). */}
              <div key={activeRoom || 'home'} className="flex-1 min-w-0 min-h-0 flex flex-col view-in">
                {hasConversationOpen ? (
                  activeChannelId && channelType === 'voice' ? (
                    <VoiceRoom />
                  ) : activeChannelId && channelType === 'forum' ? (
                    <ForumView />
                  ) : (
                    <>
                      {/* the Discord-style inline call stage: sits in the
                          conversation above the chat while a call is live
                          here, so texting and talking coexist. Below it, the
                          spectator band for a live call I am NOT in (a group
                          chat running a call). Both render
                          unmounted-clean on their own (and animate out when
                          the call ends) */}
                      <CallStage />
                      <CallSpectatorStrip />
                      <MessageList room={activeRoom} />
                      <MessageInput room={activeRoom} />
                    </>
                  )
                ) : (
                  <HomeMain
                    onCreate={() => setAddServerOpen(true)}
                    onJoin={() => setAddServerOpen(true)}
                    onFind={() => setFindUserOpen(true)}
                  />
                )}
              </div>
            </>
          )}
        </main>

        {/* thread panel: takes the right column while a thread is open
            (member list and DM profile give way) */}
        {openThreadId ? (
          <ThreadPanel />
        ) : (
          <>
            {/* DM profile panel: the person you are talking to, at reading distance.
                Groups get the members popover in the header instead. */}
            {!activeServerId && activeConversationId && activeConversationIsDM && dmProfileOpen && (
              <DMProfilePanel conversationId={activeConversationId} onClose={() => setDmProfileOpen(false)} />
            )}

            {/* member list: static on desktop (server or group), drawer on mobile */}
            {(activeServerId || (activeConversationId && activeConversationIsGroup)) && (
              <>
                {mobileMembersOpen && (
                  <button
                    className="fixed inset-0 z-40 bg-black/70 md:hidden"
                    onClick={() => setMobileMembersOpen(false)}
                    aria-label="close member list"
                  />
                )}
                <div
                  className={cn(
                    'fixed inset-y-0 right-0 z-40 w-64 max-w-[80vw] transition-transform duration-150 md:static md:w-60 md:translate-x-0 md:visible md:z-auto',
                    mobileMembersOpen ? 'translate-x-0 shadow-2xl' : 'translate-x-full invisible'
                  )}
                >
                  {activeServerId ? (
                    <MemberList onOpenProfile={() => setMobileMembersOpen(false)} />
                  ) : (
                    <GroupMemberList
                      conversationId={activeConversationId as string}
                      onOpenProfile={() => setMobileMembersOpen(false)}
                    />
                  )}
                </div>
              </>
            )}
          </>
        )}
        </div>
      </div>

      <AddServerDialog open={addServerOpen} onOpenChange={setAddServerOpen} />
      <CreateChannelDialog
        open={createChannelOpen}
        onOpenChange={(open) => {
          setCreateChannelOpen(open)
          if (!open) setCreateChannelCategory(null)
        }}
        categoryId={createChannelCategory}
      />
      <CreateChannelDialog open={createCategoryOpen} onOpenChange={setCreateCategoryOpen} categoryMode />
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <FindUserDialog open={findUserOpen} onOpenChange={setFindUserOpen} />
      <ServerSettingsDialog open={serverSettingsOpen} onOpenChange={setServerSettingsOpen} />
      {activeChannelId && (
        <ChannelSettingsDialog open={channelSettingsOpen} onOpenChange={setChannelSettingsOpen} />
      )}
      {activeChannelId && <PurgeDialog open={purgeOpen} onOpenChange={setPurgeOpen} />}
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} scope={searchScope} />
      <SummarizeDialog open={summaryOpen} onOpenChange={setSummaryOpen} />
      {activeConversationId && (
        <GroupSettingsDialog
          open={groupSettingsOpen}
          onOpenChange={setGroupSettingsOpen}
          conversationId={activeConversationId}
        />
      )}
      <QuickSwitcher open={switcherOpen} onOpenChange={setSwitcherOpen} />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <ForwardDialog />
      {activeRoom && (
        <PinsDialog open={pinsOpen} onOpenChange={setPinsOpen} room={activeRoom} channelName={channelName} />
      )}
      {/* key remount: every open seeds fresh form state from the current profile,
          so partial saves (banner apply) never wipe unsaved edits */}
      <AccountView key={`acct-${accountOpen}`} />
      <AdminPanel />
      <ProfileEditor />
      <ProfileCard />
      <SavedMessagesDialog />
      <ScheduledDialog />
      <RemindersDialog />
      <ConfirmDialogHost />
      <ContextMenuHost />
      <EmojiPopHost />
      <CallOverlay />
      <GuestVoiceRoom />
      <MediaPlayer />
    </TooltipProvider>
  )
}
