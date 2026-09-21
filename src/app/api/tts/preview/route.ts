import { NextRequest, NextResponse } from 'next/server'
import { readFile, mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { getSessionUser } from '@/lib/auth'
import { uploadsDir } from '@/lib/server-env'
import { serverError, unauthorized } from '@/lib/realtime'
import { coerceTtsSpeed, coerceTtsVoice } from '@/lib/tts-voices'

/** Voice preview for the speech settings picker: synthesizes one fixed
 *  English sentence with the requested voice + speed so users can audition
 *  before committing. Cached per voice+speed on disk. */
const PREVIEW_TEXT = "Hey, this is my voice. I can read your messages out loud, like this one."

export async function GET(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const params = req.nextUrl.searchParams
    const voice = coerceTtsVoice(params.get('voice'))
    const speed = coerceTtsSpeed(params.get('speed'))

    const file = path.join(uploadsDir(), `tts-preview-${voice}-${Math.round(speed * 100)}.wav`)

    let bytes: Buffer
    try {
      bytes = await readFile(file)
    } catch {
      const ZAI = (await import('z-ai-web-dev-sdk')).default
      const zai = await ZAI.create()
      const res = await zai.audio.tts.create({
        input: PREVIEW_TEXT,
        voice,
        speed,
        response_format: 'wav',
        stream: false,
      })
      const arrayBuffer = await res.arrayBuffer()
      bytes = Buffer.from(new Uint8Array(arrayBuffer))
      if (bytes.length === 0) return serverError()
      try {
        await mkdir(uploadsDir(), { recursive: true })
        await writeFile(file, bytes)
      } catch {
        /* preview cache is best-effort */
      }
    }

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(bytes.length),
        'Cache-Control': 'private, max-age=86400',
      },
    })
  } catch {
    return serverError()
  }
}
