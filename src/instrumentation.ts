/**
 * Server-startup hook. The node-only supervisor work lives in
 * ./instrumentation-node so the edge runtime never parses node: imports;
 * everything below runs only in the nodejs server runtime.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  const { IS_SERVERLESS } = await import('./lib/server-env')

  // 1. the database must exist WITH its schema before the first request:
  //    serverless /tmp files and bare clones bootstrap themselves here.
  const { ensureDatabaseReady } = await import('./lib/db-bootstrap')
  await ensureDatabaseReady().catch((err) =>
    console.error('[instrumentation] database bootstrap failed:', err)
  )

  // 1b. cherry-picked alpha mode: seed three fixed-credential tester
  //     accounts on an empty database (see DEPLOY.md for the tradeoffs)
  if (process.env.SEED_DEMO === 'true') {
    const { seedDemoAccounts } = await import('./lib/seed-demo')
    await seedDemoAccounts().catch((err) =>
      console.error('[instrumentation] demo seed failed:', err)
    )
  }

  // 2. a persistent production host without a configured signing key is
  //    running on the shared development secret - worth a loud log line.
  if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    console.warn('[instrumentation] JWT_SECRET is not set; sessions are signed with the development key. Set it in the host dashboard.')
  }

  if (IS_SERVERLESS) {
    // Serverless functions have no long-lived process and no bundled
    // realtime sidecar: the background schedulers (send-later, sweeps)
    // would double-fire across scaled instances, and spawning the
    // mini-service is impossible. The app itself runs fine without them:
    // HTTP polling (/api/sync) keeps chats updating and the connection
    // status pill degrades to "offline". Note that both the database and
    // uploaded files live in /tmp here and reset on cold starts - see
    // netlify.toml for the durable-host story.
    console.log('[instrumentation] serverless mode: background workers disabled, data lives in /tmp')
    return
  }

  const { ensureChatService } = await import('./instrumentation-node')
  await ensureChatService()
  setInterval(() => {
    void ensureChatService()
  }, 20000).unref()

  // scheduled-message delivery tick: due rows are persisted + broadcast here,
  // so "send later" works even when the author's browser is closed
  const startScheduler = async () => {
    const { schedulerTick, sweepExpiredMessages, sweepExpiredFriendships, sweepExpiredStories } = await import('./lib/scheduler')
    setInterval(() => {
      void schedulerTick()
    }, 15000).unref()
    // temporary-message sweeper: expired rows are deleted + broadcast every
    // minute, so auto-deleting DMs disappear even with every browser closed
    setInterval(() => {
      void sweepExpiredMessages()
    }, 60000).unref()
    // temporary-friendship sweeper: expired friendships dissolve on their own
    setInterval(() => {
      void sweepExpiredFriendships()
    }, 60000).unref()
    // story sweeper: expired 24h stories are deleted every minute so rings
    // gray out and feeds forget them even with every browser closed
    setInterval(() => {
      void sweepExpiredStories()
    }, 60000).unref()
  }
  void startScheduler()
}
