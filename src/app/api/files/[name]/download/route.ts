import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import {
  assembleSmallFile,
  canAccessVault,
  chunkMetasFor,
  parseRangeHeader,
  streamUploadRange,
  sweepVault,
  vaultContentDisposition,
  type VaultUploadRow,
} from '@/lib/vault'

/**
 * THE VAULT — smart reads. Range math decides which chunk files cover the
 * requested span; exactly those files are streamed, in order. Whole-file GETs
 * of small files (< 2 MiB) serve from the RAM cache; everything else streams
 * chunk-by-chunk, holding at most one 4 MiB chunk in memory at a time. The
 * file is NEVER assembled in memory here.
 */

type Params = { params: Promise<{ name: string }> }

export async function GET(req: NextRequest, { params }: Params) {
  return serve(req, params, true)
}

export async function HEAD(req: NextRequest, { params }: Params) {
  return serve(req, params, false)
}

async function serve(req: NextRequest, params: Params['params'], countDownload: boolean) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { name } = await params
    const upload = await db.fileUpload.findUnique({ where: { id: name } })
    if (!upload) return notFound('File not found.')
    if (!(await canAccessVault(me.id, upload as VaultUploadRow))) {
      return forbidden('You do not have access to that file.')
    }
    if (upload.status !== 'ready') {
      return NextResponse.json({ error: 'This file is still uploading.' }, { status: 409 })
    }
    if (upload.expiresAt.getTime() <= Date.now()) {
      // 410 first, sweep second: an expired file answers Gone until the lazy
      // pass (this call's tail or the 60s interval) reaps rows + chunk files
      return NextResponse.json({ error: 'This file has expired.' }, { status: 410 })
    }
    // positive virus verdict: the download dies here for everyone (the
    // uploader can still DELETE the row — that path stays uploader-only)
    if (upload.scanStatus === 'detected') {
      return NextResponse.json(
        { error: 'This file was flagged by the virus scan and is blocked from download.' },
        { status: 403 }
      )
    }
    // lazy TTL pass rides the call after the row is proven alive — the
    // sweep can never touch a row that just passed the checks above
    await sweepVault()

    const metas = await chunkMetasFor(upload.id)
    if (metas.length !== upload.totalChunks) {
      return NextResponse.json({ error: 'This file is missing chunks.' }, { status: 500 })
    }

    // headers every variant carries
    const headers: Record<string, string> = {
      'Content-Type': upload.mime,
      'Content-Disposition': vaultContentDisposition(upload.filename),
      'Accept-Ranges': 'bytes',
      ETag: `"${upload.id}-${upload.size}"`,
      'Cache-Control': 'private, no-store', // ephemeral content can vanish at any moment
    }

    const range = parseRangeHeader(req.headers.get('range'), upload.size)
    if (range.kind === 'unsatisfiable') {
      return new NextResponse(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${upload.size}` },
      })
    }
    // malformed Range headers degrade to a full 200 body (RFC 9110)

    const bump = () => {
      if (!countDownload) return
      void db.fileUpload
        .update({ where: { id: upload.id }, data: { downloadCount: { increment: 1 } } })
        .catch(() => {/* counter is best-effort */})
    }

    if (range.kind === 'range') {
      const length = range.end - range.start + 1
      bump()
      if (!countDownload) {
        // HEAD: the same headers a GET would answer with, no body
        return new NextResponse(null, {
          status: 206,
          headers: {
            ...headers,
            'Content-Length': String(length),
            'Content-Range': `bytes ${range.start}-${range.end}/${upload.size}`,
          },
        })
      }
      return new NextResponse(streamUploadRange(metas, upload.chunkSize, range.start, range.end), {
        status: 206,
        headers: {
          ...headers,
          'Content-Length': String(length),
          'Content-Range': `bytes ${range.start}-${range.end}/${upload.size}`,
        },
      })
    }

    // whole file: small ones from the RAM buffer cache, big ones streamed
    bump()
    if (!countDownload) {
      return new NextResponse(null, {
        status: 200,
        headers: { ...headers, 'Content-Length': String(upload.size) },
      })
    }
    const small = await assembleSmallFile(upload.id, metas, upload.size)
    if (small) {
      const view = new Uint8Array(small)
      return new NextResponse(view, {
        status: 200,
        headers: { ...headers, 'Content-Length': String(upload.size) },
      })
    }
    return new NextResponse(streamUploadRange(metas, upload.chunkSize, 0, upload.size - 1), {
      status: 200,
      headers: { ...headers, 'Content-Length': String(upload.size) },
    })
  } catch {
    return serverError()
  }
}
