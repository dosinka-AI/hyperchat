/**
 * Node-only realtime supervisor. Imported only from instrumentation.ts after
 * the NEXT_RUNTIME === 'nodejs' guard so the Edge bundler never sees these
 * Node APIs.
 */

const CONTROL_HEALTH = 'http://127.0.0.1:3004/health'
const SERVICE_DIR = 'mini-services/chat-service'

async function serviceHealthy(): Promise<boolean> {
  try {
    const res = await fetch(CONTROL_HEALTH, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

/** Resolve a bun binary. ENOENT must never become an uncaughtException. */
async function resolveBun(): Promise<string | null> {
  const { accessSync, constants } = await import('node:fs')
  const { homedir } = await import('node:os')
  const path = await import('node:path')
  const candidates = [
    process.env.BUN_PATH,
    path.join(homedir(), '.bun', 'bin', 'bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ].filter((v): v is string => typeof v === 'string' && v.length > 0)

  for (const bin of candidates) {
    try {
      accessSync(bin, constants.X_OK)
      return bin
    } catch {
      /* try next */
    }
  }

  try {
    const { execFileSync } = await import('node:child_process')
    const found = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
    if (found) return found
  } catch {
    /* bun not on PATH */
  }
  return null
}

let spawnWarned = false

async function ensureChatService(): Promise<void> {
  if (await serviceHealthy()) return
  try {
    const bunBin = await resolveBun()
    if (!bunBin) {
      if (!spawnWarned) {
        spawnWarned = true
        console.error(
          '[instrumentation] bun is not installed. Install it (https://bun.sh) then restart, or run: curl -fsSL https://bun.sh/install | bash'
        )
      }
      return
    }

    const { spawn } = await import('node:child_process')
    const path = await import('node:path')
    const cwd = path.join(process.cwd(), SERVICE_DIR)
    const child = spawn(bunBin, ['run', 'dev'], {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        PATH: `${path.dirname(bunBin)}:${process.env.PATH ?? ''}`,
      },
    })
    child.on('error', (err) => {
      if (!spawnWarned) {
        spawnWarned = true
        console.error('[instrumentation] failed to spawn realtime service:', err.message)
      }
    })
    child.unref()
    if (child.pid) {
      console.log('[instrumentation] realtime service was down; respawned pid', child.pid)
    }
  } catch (err) {
    console.error('[instrumentation] failed to respawn realtime service:', err)
  }
}

export async function startNodeInstrumentation(): Promise<void> {
  await ensureChatService()
  setInterval(() => {
    void ensureChatService()
  }, 20000).unref()

  const startScheduler = async () => {
    const { schedulerTick, sweepExpiredMessages, sweepExpiredFriendships, sweepExpiredStories } = await import('./lib/scheduler')
    setInterval(() => {
      void schedulerTick()
    }, 15000).unref()
    setInterval(() => {
      void sweepExpiredMessages()
    }, 60000).unref()
    setInterval(() => {
      void sweepExpiredFriendships()
    }, 60000).unref()
    setInterval(() => {
      void sweepExpiredStories()
    }, 60000).unref()
  }
  void startScheduler()
}
