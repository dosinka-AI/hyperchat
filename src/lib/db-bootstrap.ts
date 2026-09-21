import { sqliteUrl } from './server-env'
import { SCHEMA_DDL } from './schema-ddl'

/**
 * Make sure the SQLite file behind DATABASE_URL actually contains the
 * schema. Locally `bun run db:push` does this job, but three real
 * situations boot with no schema at all:
 *
 *   1. serverless functions (Netlify): the database is a fresh /tmp file
 *      that appears empty on every cold start,
 *   2. a bare clone without .env: prisma/db/custom.db does not exist yet,
 *   3. a container image that only copied source files.
 *
 * Instead of letting the first request die with "no such table: User",
 * this runs the full DDL straight into the empty file. It is
 * self-detecting (asks sqlite_master, using the engine's own path
 * resolution - no filesystem guessing) and idempotent: a database that
 * already has the User table is never touched, so locally this costs one
 * trivial SELECT at boot and nothing else.
 */

let ensurePromise: Promise<void> | null = null

/** Run once per process; concurrent callers share the first attempt. */
export function ensureDatabaseReady(): Promise<void> {
  if (!ensurePromise) {
    ensurePromise = run().catch((err) => {
      // allow a later request to retry after a hard failure
      ensurePromise = null
      throw err
    })
  }
  return ensurePromise
}

async function run(): Promise<void> {
  const url = sqliteUrl()
  if (!url.startsWith('file:')) return // remote databases manage their own schema

  const { db } = await import('./db')

  const existing = await db.$queryRawUnsafe<{ cnt: number | bigint }[]>(
    "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type='table' AND name='User'"
  ).catch(() => null)
  if (existing && Number(existing[0]?.cnt ?? 0) > 0) return

  // fresh file: create every table and index, in dependency order
  const statements = SCHEMA_DDL.split(';')
    .map((chunk) =>
      chunk
        .replace(/^--.*$/gm, '') // strip the "-- CreateTable" comments
        .trim()
    )
    .filter(Boolean)

  let applied = 0
  for (const statement of statements) {
    try {
      await db.$executeRawUnsafe(statement)
      applied++
    } catch (err) {
      // a table can legitimately already exist (partial bootstrap, racing
      // workers); anything else still leaves a loud trace in the logs
      const message = err instanceof Error ? err.message : String(err)
      if (!/already exists/i.test(message)) {
        console.error('[db] bootstrap statement failed:', message.slice(0, 200))
      }
    }
  }
  console.log(`[db] fresh database bootstrapped at ${url} (${applied}/${statements.length} statements)`)
}
