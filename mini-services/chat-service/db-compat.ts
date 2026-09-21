/// <reference types="bun-types" />

/** One small SQLite facade over whichever runtime executes this service:
 *  bun:sqlite under Bun (the production/deploy runtime), node:sqlite under
 *  Node 24+ (the dev fallback — the sandbox once lost its bun binary to a
 *  poisoned-inode incident and the realtime service had to keep running).
 *
 *  All methods are synchronous and fail soft: callers already treat a null
 *  database as "skip this cosmetic write / fail open". */

export type SqliteDb = {
  exec(sql: string): void
  run(sql: string, params: unknown[]): void
  all<T>(sql: string): T[]
  get<T>(sql: string, params: unknown[]): T | null
}

export function isBunRuntime(): boolean {
  return typeof globalThis !== 'undefined' && typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

/** Open the database or return null. `readonly` maps to bun's readonly mode
 *  and node:sqlite's readOnly option; the write mode never creates files. */
export async function openSqlite(path: string, opts: { readonly?: boolean } = {}): Promise<SqliteDb | null> {
  if (isBunRuntime()) {
    try {
      const { Database } = (await import('bun:sqlite')) as {
        Database: new (p: string, o?: { readonly?: boolean; readwrite?: boolean; create?: boolean }) => {
          exec(s: string): void
          run(s: string, p?: unknown[]): unknown
          query(s: string): { all(): unknown[]; get(p?: unknown[]): unknown }
        }
      }
      const db = new Database(path, opts.readonly ? { readonly: true } : { readwrite: true, create: false })
      return {
        exec: (sql) => db.exec(sql),
        run: (sql, params) => void db.run(sql, params),
        all: (sql) => db.query(sql).all() as unknown[],
        get: (sql, params) => (db.query(sql).get(params) ?? null) as unknown,
      } as SqliteDb
    } catch {
      return null
    }
  }
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as {
      DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => {
        exec(s: string): void
        prepare(s: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown }
      }
    }
    const db = new DatabaseSync(path, { readOnly: !!opts.readonly })
    return {
      exec: (sql) => db.exec(sql),
      run: (sql, params) => void db.prepare(sql).run(...params),
      all: (sql) => db.prepare(sql).all() as unknown[],
      get: (sql, params) => (db.prepare(sql).get(...params) ?? null) as unknown,
    }
  } catch {
    return null
  }
}
