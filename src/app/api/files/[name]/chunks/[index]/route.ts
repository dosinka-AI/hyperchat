import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { expectedChunkSize, sweepVault, writeChunkFile } from '@/lib/vault'

/**
 * THE VAULT — step 2: PUT one raw chunk (application/octet-stream body, read
 * as bytes — never JSON). The chunk lands at its content address on disk;
 * identical bytes already stored by another upload simply dedupe. Re-PUTs of
 * the same index are idempotent (upsert), so flaky networks can retry freely.
 */

type Params = { params: Promise<{ name: string; index: string }> }

export async function PUT(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { name, index } = await params
    const idx = Number.parseInt(index, 10)
    if (!Number.isInteger(idx) || idx < 0) {
      return badRequest('Bad chunk index.')
    }

    const upload = await db.fileUpload.findUnique({ where: { id: name } })
    if (!upload) return notFound('Upload not found.')
    if (upload.uploaderId !== me.id) return forbidden('This upload belongs to someone else.')
    if (upload.status !== 'uploading') return badRequest('This upload already finished.')
    if (upload.expiresAt.getTime() <= Date.now()) {
      // 410 first, sweep second (see the download route for the reasoning)
      return NextResponse.json({ error: 'This upload expired.' }, { status: 410 })
    }
    if (idx >= upload.totalChunks) return badRequest('Chunk index out of range.')

    // the last chunk may be short: expected = size - index*chunkSize, clamped
    const expected = expectedChunkSize(upload.size, upload.chunkSize, idx)
    const buf = Buffer.from(await req.arrayBuffer())
    if (buf.length === 0) {
      return badRequest('Empty chunk.')
    }
    if (buf.length !== expected) {
      return badRequest(`Chunk ${idx} should be ${expected} bytes (got ${buf.length}).`)
    }

    const sha256 = createHash('sha256').update(buf).digest('hex')
    await writeChunkFile(sha256, buf) // dedupes against identical chunks already on disk

    await db.fileChunkMeta.upsert({
      where: { uploadId_chunkIndex: { uploadId: upload.id, chunkIndex: idx } },
      create: { uploadId: upload.id, chunkIndex: idx, size: buf.length, sha256 },
      update: { size: buf.length, sha256 },
    })

    const agg = await db.fileChunkMeta.aggregate({
      where: { uploadId: upload.id },
      _sum: { size: true },
    })

    // lazy TTL pass rides the call once this row's chunk is safely stored
    await sweepVault()

    return NextResponse.json({
      index: idx,
      received: buf.length,
      totalReceived: agg._sum.size ?? 0,
    })
  } catch {
    return serverError()
  }
}
