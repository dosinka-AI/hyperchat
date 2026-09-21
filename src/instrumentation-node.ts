/**
 * Node-only half of the startup hook. Kept in its own module so the edge
 * runtime never even parses these imports (importing node:child_process
 * from instrumentation.ts directly made Turbopack warn on every compile).
 *
 * The realtime chat service must never silently die: this sandbox can reap
 * the socket.io process at any time, leaving the app alive with no realtime
 * layer. This module makes the Next.js server itself the supervisor: on
 * startup, and every 20 seconds after, it health-checks the service on its
 * control port and respawns it when missing. The check is idempotent, so
 * multiple server instances never double-spawn.
 */

const CONTROL_HEALTH = 'http://127.0.0.1:3004/health'

/**
 * Where the realtime sidecar lives on this host. The dev server runs with
 * cwd = the repo root, but a production `next start`-style standalone boot
 * chdir's into .next/standalone (Next writes process.chdir(__dirname) into
 * server.js), leaving the service folder one or two levels up. An explicit
 * REALTIME_SERVICE_DIR wins over every heuristic, for exotic layouts.
 */
async function serviceDir(): Promise<string | null> {
  const path = await import('node:path')
  const { stat } = await import('node:fs/promises')
  const cwd = process.cwd()
  const candidates = [
    process.env.REALTIME_SERVICE_DIR,
    path.join(cwd, 'mini-services', 'chat-service'),
    path.join(cwd, '..', 'mini-services', 'chat-service'),
    path.join(cwd, '..', '..', 'mini-services', 'chat-service'),
  ].filter((dir): dir is string => !!dir)
  for (const dir of candidates) {
    if (await stat(dir).then(() => true).catch(() => false)) return dir
  }
  return null
}

async function serviceHealthy(): Promise<boolean> {
  try {
    const res = await fetch(CONTROL_HEALTH, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

export async function ensureChatService(): Promise<void> {
  if (await serviceHealthy()) return
  try {
    const { spawn } = await import('node:child_process')
    const cwd = await serviceDir()
    // hosts that deploy without the mini-service would otherwise log a
    // spawn failure here every 20 seconds
    if (!cwd) return
    // production runs the plain entry (no file watcher); dev keeps hot
    // reload so editing the service reloads it live. Bun hosts use
    // 'bun run dev' (bun --hot); plain-Node hosts (the sandbox once lost
    // its bun binary) run node --watch on the entry directly.
    const isProd = process.env.NODE_ENV === 'production'
    const isBun = !!process.versions.bun
    const command = isBun ? 'bun' : 'node'
    const args = isBun
      ? ['run', isProd ? 'start' : 'dev']
      : isProd
        ? ['index.ts']
        : ['--watch', 'index.ts']
    // detached + unref: the child survives Next.js dev-server restarts, and
    // the next health check adopts it instead of spawning a duplicate
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    })
    child.unref()
    console.log(`[instrumentation] realtime service was down; respawned pid ${child.pid} via '${command} ${args.join(' ')}'`)
  } catch (err) {
    console.error('[instrumentation] failed to respawn realtime service:', err)
  }
}
