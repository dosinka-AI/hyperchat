import { PrismaClient } from '@prisma/client'
import { sqliteUrl } from './server-env'

// Resolve the SQLite location BEFORE the client constructor reads
// process.env.DATABASE_URL: .env locally, /tmp on serverless hosts, and a
// prisma-relative default anywhere else (fresh clones self-bootstrap their
// schema through src/lib/db-bootstrap.ts at server boot).
sqliteUrl()

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // every single query logged is a dev luxury; production hosts only
    // want failures in their function logs
    log: process.env.NODE_ENV === 'production' ? ['error', 'warn'] : ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
