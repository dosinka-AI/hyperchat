import path from 'node:path'

/**
 * Host-aware data locations for the parts of the app that touch real files:
 * the SQLite database and the uploads/ directory.
 *
 * - Local development and persistent hosts (the sandbox, a VPS, Render...):
 *   DATABASE_URL comes from .env (absolute path) and uploads live under the
 *   project root, exactly as before.
 * - Serverless function hosts (Netlify, Lambda): the bundle directory is
 *   read-only and thrown away on every cold start, so the only writable
 *   location is /tmp. A missing DATABASE_URL would otherwise crash every
 *   API route with "Environment variable not found" the moment the site
 *   loads, and uploads would fail with EROFS / ENOENT.
 *
 * Data written to /tmp survives only while the function instance stays warm;
 * see netlify.toml for what that means for a Netlify deployment.
 */

export const IS_SERVERLESS = !!process.env.NETLIFY || !!process.env.AWS_LAMBDA_FUNCTION_NAME

/**
 * Resolve the SQLite connection string, memoizing it into DATABASE_URL so
 * the PrismaClient constructor (which reads process.env at instantiation)
 * sees the same value. The default is ABSOLUTE (app-root/db/custom.db) so
 * the running server, the installer's `prisma db push`, and the manager's
 * backup option always land on the very same file — relative `file:` urls
 * are resolved against the prisma/ directory by the CLI but against the
 * bundle location by the client, which can silently split the database.
 */
export function sqliteUrl(): string {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = IS_SERVERLESS
      ? 'file:/tmp/hyperchat.db'
      : 'file:' + path.join(process.cwd(), 'db', 'custom.db')
  }
  return process.env.DATABASE_URL
}

/**
 * Writable directory for uploaded files. The upload route creates it on
 * demand; this just says where it should be.
 *
 * Precedence: an explicit UPLOAD_DIR (the big-drive setup: point it at a
 * subdirectory of a mounted 4TB disk, e.g. /mnt/hyperdrive/uploads) beats
 * the older UPLOADS_DIR spelling, which beats every heuristic below.
 */
export function uploadsDir(): string {
  if (process.env.UPLOAD_DIR) return process.env.UPLOAD_DIR
  if (process.env.UPLOADS_DIR) return process.env.UPLOADS_DIR
  return IS_SERVERLESS ? '/tmp/hyperchat-uploads' : path.join(process.cwd(), 'uploads')
}
