import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import {
  VAULT_CHUNK_SIZE,
  VAULT_MAX_CHUNKS,
  VAULT_MAX_FILE_BYTES,
  formatVaultBytes,
  sanitizeVaultFilename,
  sanitizeVaultMime,
  sweepVault,
  vaultDailyUserBytes,
  vaultExpiryFor,
} from '@/lib/vault'

/**
 * THE VAULT — step 1 of a chunked send. The client asks for a slot; the
 * server stamps the size-tiered expiry up front so nothing can outlive its
 * tier, then hands back the chunk geometry.
 */

/** Concurrent in-flight (status=uploading) sends per user. */
const MAX_ACTIVE_UPLOADS = 5

export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    // lazy TTL pass rides every vault call: expired sends die before anything new starts
    await sweepVault()

    const body = await req.json()
    const size = typeof body.size === 'number' ? Math.floor(body.size) : Number.NaN
    if (!Number.isInteger(size) || size < 1 || size > VAULT_MAX_FILE_BYTES) {
      return badRequest('Files must be between 1 byte and 1 GiB.')
    }

    const filename = sanitizeVaultFilename(typeof body.filename === 'string' ? body.filename : '')
    if (!filename) return badRequest('Attach a filename.')
    const mime = sanitizeVaultMime(body.mime)

    const conversationId = typeof body.conversationId === 'string' ? body.conversationId : ''
    if (!conversationId) return badRequest('Vault sends need a conversation.')
    const conversation = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true },
    })
    if (!conversation) return notFound('Conversation not found.')
    const participant = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId: me.id } },
      select: { id: true },
    })
    if (!participant) return forbidden('You are not part of this conversation.')

    const totalChunks = Math.ceil(size / VAULT_CHUNK_SIZE)
    if (totalChunks > VAULT_MAX_CHUNKS) {
      return badRequest('File too large.')
    }

    const active = await db.fileUpload.count({
      where: { uploaderId: me.id, status: 'uploading' },
    })
    if (active >= MAX_ACTIVE_UPLOADS) {
      return NextResponse.json(
        { error: 'Too many uploads in flight. Finish or cancel one first.' },
        { status: 429 }
      )
    }

    // per-user DAILY byte quota: one indexed aggregate over the last 24h of
    // this user's uploads — a failsafe against a single account (or a stolen
    // session) filling the drive in a day
    const dailyBudget = vaultDailyUserBytes()
    const dailyUsed = (
      await db.fileUpload.aggregate({
        where: { uploaderId: me.id, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        _sum: { size: true },
      })
    )._sum.size ?? 0
    if (dailyUsed + size > dailyBudget) {
      const left = Math.max(0, dailyBudget - dailyUsed)
      return NextResponse.json(
        {
          error: `Daily upload limit reached — ${formatVaultBytes(left)} left of your ${formatVaultBytes(dailyBudget)} daily budget. It recovers as the last 24h of uploads age out.`,
        },
        { status: 429 }
      )
    }

    const upload = await db.fileUpload.create({
      data: {
        uploaderId: me.id,
        conversationId,
        filename,
        mime,
        size,
        chunkSize: VAULT_CHUNK_SIZE,
        totalChunks,
        status: 'uploading',
        expiresAt: vaultExpiryFor(size),
      },
    })

    return NextResponse.json(
      {
        id: upload.id,
        chunkSize: VAULT_CHUNK_SIZE,
        totalChunks,
        expiresAt: upload.expiresAt.toISOString(),
      },
      { status: 201 }
    )
  } catch {
    return serverError()
  }
}
