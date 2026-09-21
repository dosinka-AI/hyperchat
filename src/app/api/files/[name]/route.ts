import { NextRequest, NextResponse } from 'next/server'
import { readFile, stat } from 'fs/promises'
import path from 'path'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { uploadsDir } from '@/lib/server-env'
import { forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { canAccessVault, deleteUploadHard, sweepVault, toVaultSummary, type VaultUploadRow } from '@/lib/vault'

const UPLOAD_DIR = uploadsDir()

/** Types safe to render inline in the browser. Everything else downloads. */
const INLINE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  json: 'application/json',
}

/** Known download-only types, so filenames stay meaningful. */
const DOWNLOAD_TYPES: Record<string, string> = {
  zip: 'application/zip',
  gz: 'application/gzip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv; charset=utf-8',
  psd: 'image/vnd.adobe.photoshop',
}

type Params = { params: Promise<{ name: string }> }

/** THE VAULT: upload ids are cuids (c + 24 [a-z0-9]); stored files are
 * `uuid.ext` — the shapes can never collide, so this branch is exact. */
const VAULT_ID_RE = /^c[a-z0-9]{24}$/

/** Vault metadata for a single upload: uploader or conversation participant. */
async function vaultMetadata(name: string) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const upload = await db.fileUpload.findUnique({ where: { id: name } })
    if (!upload) return notFound('File not found.')
    if (!(await canAccessVault(me.id, upload as VaultUploadRow))) {
      return forbidden('You do not have access to that file.')
    }
    // lazy TTL pass rides the call once the row is proven readable (an
    // expired-but-unswept row still answers its summary — expiresAt in the
    // past is the "expired" tell — until the sweep reaps it to 404)
    await sweepVault()
    return NextResponse.json({ file: toVaultSummary(upload as VaultUploadRow) })
  } catch {
    return serverError()
  }
}

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { name } = await params

    // THE VAULT branch: cuid-shaped names are vault uploads → metadata JSON
    if (VAULT_ID_RE.test(name)) return vaultMetadata(name)

    // legacy path: serve a stored upload by its plain filename

    // reject anything that is not a plain, safe filename
    if (!/^[a-zA-Z0-9._-]+$/.test(name) || name.includes('..')) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 })
    }

    const filePath = path.join(UPLOAD_DIR, name)
    const ext = name.split('.').pop()?.toLowerCase() || ''

    const info = await stat(filePath).catch(() => null)
    if (!info?.isFile()) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 })
    }

    const file = await readFile(filePath)
    const inlineType = INLINE_TYPES[ext]
    const downloadType = DOWNLOAD_TYPES[ext]

    if (inlineType) {
      const headers: Record<string, string> = {
        'Content-Type': inlineType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': String(file.length),
        'X-Content-Type-Options': 'nosniff',
      }
      // SVG is the one inline type that can carry scripts: opened as a
      // document from this same origin it would run with the site's
      // cookies. A strict CSP turns an uploaded svg into a static image
      // document — embedding via <img> is unaffected (scripts never run in
      // an image context anyway).
      if (ext === 'svg') {
        headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
      }
      return new NextResponse(new Uint8Array(file), {
        headers,
      })
    }

    // everything else: a download with a useful filename
    return new NextResponse(new Uint8Array(file), {
      headers: {
        'Content-Type': downloadType ?? 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': String(file.length),
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  }
}

/** THE VAULT: uploader-only early kill — wipes the chunk files + rows so an
 * abandoned or regretted send dies before its tier expires. A file-only
 * carrier message dies with it (see deleteUploadHard); a message with text
 * survives and just loses its card. */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const { name } = await params
    const upload = await db.fileUpload.findUnique({ where: { id: name } })
    if (!upload) return notFound('File not found.')
    if (upload.uploaderId !== me.id) return forbidden('Only the uploader can delete this file.')
    await deleteUploadHard(upload.id)
    await sweepVault() // lazy TTL pass rides the call once the kill is done
    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
