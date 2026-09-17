import { NextRequest, NextResponse } from 'next/server'
import { readFile, stat } from 'fs/promises'
import path from 'path'

const UPLOAD_DIR = path.join(process.cwd(), 'uploads')

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

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { name } = await params

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
      return new NextResponse(new Uint8Array(file), {
        headers: {
          'Content-Type': inlineType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Length': String(file.length),
        },
      })
    }

    // everything else: a download with a useful filename
    return new NextResponse(new Uint8Array(file), {
      headers: {
        'Content-Type': downloadType ?? 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Length': String(file.length),
      },
    })
  } catch {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  }
}
