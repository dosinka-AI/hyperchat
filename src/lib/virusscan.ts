import { readFile } from 'fs/promises'
import { db } from './db'
import { chunkFilePath, chunkMetasFor } from './vault'

/**
 * Virus scan hook (VirusTotal, env-gated, honest about being off).
 *
 * The complete route fires this as `void startVirusScan(id).catch(() => {})`
 * the moment an upload turns ready — it never blocks the request path and
 * never throws into it. Without VIRUSTOTALE_API_KEY the upload is marked
 * 'skipped' and the UI shows nothing about scanning (no fake safety).
 *
 * Public-API limits are respected: only files <= 32 MB are submitted, the
 * scan is a single POST + a bounded poll loop, and any network/API problem
 * degrades to 'failed' (download keeps working; only 'detected' blocks).
 */

const VT_MAX_BYTES = 32 * 1024 * 1024 // public API upload limit
const VT_POLL_MS = 15_000
const VT_POLL_TRIES = 6

type VtAnalysis = {
  data?: {
    id?: string
    attributes?: {
      status?: string
      stats?: { malicious?: number; suspicious?: number; timedOut?: number }
    }
  }
}

export async function startVirusScan(uploadId: string): Promise<void> {
  try {
    const apiKey = process.env.VIRUSTOTALE_API_KEY
    if (!apiKey) {
      // honest no-key behavior: scanned = skipped, the card shows nothing
      await db.fileUpload.update({ where: { id: uploadId }, data: { scanStatus: 'skipped' } }).catch(() => {})
      return
    }

    const upload = await db.fileUpload.findUnique({ where: { id: uploadId } })
    if (!upload || upload.status !== 'ready') return

    if (upload.size > VT_MAX_BYTES) {
      await db.fileUpload.update({ where: { id: uploadId }, data: { scanStatus: 'skipped' } }).catch(() => {})
      return
    }

    await db.fileUpload.update({ where: { id: uploadId }, data: { scanStatus: 'pending' } }).catch(() => {})

    // assemble from the content-addressed chunks (bounded by the 32 MB gate)
    const metas = await chunkMetasFor(upload.id)
    const parts: Buffer[] = []
    for (const m of metas) parts.push(await readFile(chunkFilePath(m.sha256)))
    const whole = Buffer.concat(parts, upload.size)

    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(whole)]), upload.filename)
    const res = await fetch('https://www.virustotal.com/api/v3/files', {
      method: 'POST',
      headers: { 'x-apikey': apiKey },
      body: form,
    })
    if (!res.ok) throw new Error(`virustotal upload failed (${res.status})`)
    const submitted = (await res.json()) as VtAnalysis
    const analysisId = submitted.data?.id
    if (!analysisId) throw new Error('virustotal returned no analysis id')

    for (let attempt = 0; attempt < VT_POLL_TRIES; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, VT_POLL_MS))
      let poll: Response
      try {
        poll = await fetch(`https://www.virustotal.com/api/v3/analyses/${analysisId}`, {
          headers: { 'x-apikey': apiKey },
        })
      } catch {
        continue // transient network hiccup: keep polling within the budget
      }
      if (!poll.ok) continue
      const verdict = (await poll.json()) as VtAnalysis
      const attrs = verdict.data?.attributes
      const stats = attrs?.stats
      if (stats && (stats.malicious ?? 0) > 0) {
        await db.fileUpload
          .update({
            where: { id: uploadId },
            data: {
              scanStatus: 'detected',
              scanResult: JSON.stringify({ by: 'virustotal', malicious: stats.malicious ?? 0, suspicious: stats.suspicious ?? 0 }),
            },
          })
          .catch(() => {})
        return
      }
      if (attrs?.status === 'completed') {
        await db.fileUpload
          .update({
            where: { id: uploadId },
            data: {
              scanStatus: 'clean',
              scanResult: JSON.stringify({ by: 'virustotal', malicious: stats?.malicious ?? 0, suspicious: stats?.suspicious ?? 0 }),
            },
          })
          .catch(() => {})
        return
      }
    }
    // polls exhausted with the analysis still queued — honest failure, not a
    // fake clean; the file stays downloadable
    await db.fileUpload
      .update({
        where: { id: uploadId },
        data: { scanStatus: 'failed', scanResult: JSON.stringify({ by: 'virustotal', note: 'analysis still pending after polling budget' }) },
      })
      .catch(() => {})
  } catch {
    await db.fileUpload.update({ where: { id: uploadId }, data: { scanStatus: 'failed' } }).catch(() => {})
  }
}
