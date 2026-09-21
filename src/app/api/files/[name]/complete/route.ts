import { NextRequest, NextResponse } from 'next/server'
import { readFile, stat } from 'fs/promises'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { startVirusScan } from '@/lib/virusscan'
import {
  chunkFilePath,
  hashWholeFile,
  sweepVault,
  toVaultSummary,
  vaultSafetyWarnings,
  type VaultUploadRow,
} from '@/lib/vault'

/**
 * THE VAULT — step 3: every chunk meta present and every chunk file verified
 * on disk (size included) before the upload is blessed "ready". The
 * whole-file sha256 is computed by streaming the chunks through the running
 * hash — the file is never assembled in memory.
 */

type Params = { params: Promise<{ name: string }> }

export async function POST(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { name } = await params
    const upload = await db.fileUpload.findUnique({ where: { id: name } })
    if (!upload) return notFound('Upload not found.')
    if (upload.uploaderId !== me.id) return forbidden('This upload belongs to someone else.')
    if (upload.expiresAt.getTime() <= Date.now()) {
      // 410 first, sweep second (see the download route for the reasoning)
      return NextResponse.json({ error: 'This upload expired.' }, { status: 410 })
    }
    // idempotent: completing a finished upload just re-answers the metadata
    if (upload.status === 'ready') {
      return NextResponse.json({ file: toVaultSummary(upload as VaultUploadRow) })
    }
    if (upload.status !== 'uploading') {
      return badRequest('This upload can no longer be completed.')
    }
    // lazy TTL pass rides the call once the row is proven alive
    await sweepVault()

    const metas = await db.fileChunkMeta.findMany({
      where: { uploadId: upload.id },
      orderBy: { chunkIndex: 'asc' },
      select: { chunkIndex: true, size: true, sha256: true },
    })
    if (metas.length !== upload.totalChunks) {
      return badRequest(`Upload incomplete: ${metas.length}/${upload.totalChunks} chunks stored.`)
    }
    // verify every chunk file exists at its content address with the recorded size
    for (const m of metas) {
      const info = await stat(chunkFilePath(m.sha256)).catch(() => null)
      if (!info || info.size !== m.size) {
        return badRequest('A chunk file went missing. Restart the upload.')
      }
    }

    const sha256 = await hashWholeFile(metas)

    // dangerous-file sniff: the first 4 MiB (chunk 0) carries the magic bytes
    // of anything pretending to be a document — MZ/ELF executables, zip
    // containers that contradict the claimed mime — plus the filename rules
    // (.pdf.exe baits, bare .exe/.scr/... suffixes). A warning, never a block.
    const head = await readFile(chunkFilePath(metas[0].sha256))
    const warnings = vaultSafetyWarnings(upload.filename, upload.mime, head)

    const updated = await db.fileUpload.update({
      where: { id: upload.id },
      data: {
        status: 'ready',
        sha256,
        warnings: warnings.length ? JSON.stringify(warnings) : null,
      },
    })

    // virus scan hook: env-gated, fire-and-forget — it never throws into the
    // request path and without a key it just marks the row 'skipped'
    void startVirusScan(upload.id).catch(() => {})

    return NextResponse.json({ file: toVaultSummary(updated as VaultUploadRow) })
  } catch {
    return serverError()
  }
}
