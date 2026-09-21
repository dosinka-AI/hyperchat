import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { readFile, mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { uploadsDir } from '@/lib/server-env'
import { forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { coerceTtsSpeed, coerceTtsVoice } from '@/lib/tts-voices'

type Params = { params: Promise<{ messageId: string }> }

/** Speak a message: /tts rows render a play control that hits this route.
 *  The audio is synthesized per LISTENER (their chosen voice + speed, the
 *  same audio engine settings they previewed) and cached on disk keyed by
 *  message + content hash + voice + speed, so edits re-synthesize, voice
 *  switches re-synthesize, and replays are free. Long bodies are split at
 *  sentence boundaries and stitched back into one WAV so nothing past the
 *  engine's 1024-char input cap is silently dropped. */
export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { messageId } = await params
    const message = await db.message.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        content: true,
        isTts: true,
        authorId: true,
        channelId: true,
        conversationId: true,
        whisperTargetId: true,
      },
    })
    if (!message) return notFound('Message not found.')
    if (!message.isTts || !message.content) {
      return badRequestRow()
    }

    // visibility: exactly the read rules of the owning room
    if (message.channelId) {
      const channel = await db.channel.findUnique({
        where: { id: message.channelId },
        include: { access: { select: { roleId: true } } },
      })
      if (!channel) return notFound('Message not found.')
      const ctx = await getMemberContext(channel.serverId, me.id)
      if (!ctx) return forbidden('You are not a member of this server.')
      if (!ctx.canReadChannel(channel)) return forbidden('This channel is limited to specific roles.')
      if (message.whisperTargetId && me.id !== message.authorId && me.id !== message.whisperTargetId) {
        return forbidden('That whisper was not meant for you.')
      }
    } else if (message.conversationId) {
      const participant = await db.conversationParticipant.findUnique({
        where: {
          conversationId_userId: { conversationId: message.conversationId, userId: me.id },
        },
      })
      if (!participant) return forbidden('You are not part of this conversation.')
    } else {
      return notFound('Message not found.')
    }

    // the listener's speech prefs (session already carries them; DB row is
    // the fallback for older sessions)
    const voice = coerceTtsVoice(me.ttsVoice ?? undefined)
    const speed = coerceTtsSpeed(me.ttsSpeed ?? undefined)

    const chunks = speechChunksOf(message.content)
    if (chunks.length === 0) return badRequestRow()

    // disk cache keyed by message + content hash + voice + speed: content
    // edits and voice/speed switches re-speak, replays are free
    const hash = createHash('sha256').update(message.content).digest('hex').slice(0, 12)
    const file = path.join(uploadsDir(), `tts-${message.id}-${hash}-${voice}-${Math.round(speed * 100)}.wav`)

    let bytes: Buffer
    try {
      bytes = await readFile(file)
    } catch {
      // first play (or pruned cache): synthesize through the SDK
      bytes = await synthesize(chunks, voice, speed)
      if (bytes.length === 0) return serverError()
      try {
        await mkdir(uploadsDir(), { recursive: true })
        await writeFile(file, bytes)
      } catch {
        // cache write failing never blocks the audio itself
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

function badRequestRow() {
  return NextResponse.json({ error: 'That message has nothing to speak.' }, { status: 400 })
}

/** Synthesize every chunk through the engine and stitch the PCM payloads
 *  back into a single WAV (the engine emits 24 kHz mono 16-bit PCM WAVs;
 *  a short silence is inserted at the seams so sentence boundaries breathe). */
async function synthesize(chunks: string[], voice: string, speed: number): Promise<Buffer> {
  const ZAI = (await import('z-ai-web-dev-sdk')).default
  const zai = await ZAI.create()

  const parts: Buffer[] = []
  for (let i = 0; i < chunks.length; i++) {
    const res = await zai.audio.tts.create({
      input: chunks[i],
      voice,
      speed,
      response_format: 'wav',
      stream: false,
    })
    const arrayBuffer = await res.arrayBuffer()
    const wav = Buffer.from(new Uint8Array(arrayBuffer))
    if (wav.length === 0) continue
    const pcm = pcmOf(wav)
    if (pcm) parts.push(pcm)
    if (i < chunks.length - 1) parts.push(SILENCE_120MS)
  }
  if (parts.length === 0) return Buffer.alloc(0)
  return buildWav(parts)
}

// 24 kHz mono 16-bit: 120 ms of silence = 24000 * 0.12 * 2 bytes
const SAMPLE_RATE = 24000
const SILENCE_120MS = Buffer.alloc(5760)

/** Extract the PCM data payload from a RIFF/WAVE buffer. Returns null for
 *  malformed audio (callers skip the chunk rather than fail the row). */
function pcmOf(wav: Buffer): Buffer | null {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null
  // walk the chunk list to the "data" chunk (robust against extra chunks)
  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') {
      const start = offset + 8
      const end = Math.min(start + size, wav.length)
      return end > start ? wav.subarray(start, end) : null
    }
    offset += 8 + size + (size % 2)
  }
  return null
}

/** Wrap concatenated PCM payloads in a fresh canonical 44-byte PCM header. */
function buildWav(parts: Buffer[]): Buffer {
  const dataLen = parts.reduce((n, p) => n + p.length, 0)
  const out = Buffer.alloc(44 + dataLen)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + dataLen, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16) // PCM chunk size
  out.writeUInt16LE(1, 20) // PCM format
  out.writeUInt16LE(1, 22) // mono
  out.writeUInt32LE(SAMPLE_RATE, 24)
  out.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate (16-bit mono)
  out.writeUInt16LE(2, 32) // block align
  out.writeUInt16LE(16, 34) // bits per sample
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(dataLen, 40)
  let at = 44
  for (const p of parts) {
    p.copy(out, at)
    at += p.length
  }
  return out
}

/** Words worth saying, tuned for ENGLISH listeners: markdown falls away,
 *  code fences become "code block", bare URLs become "link", emoji are
 *  stripped (the engine stumbles on them), and a few chat shorthands
 *  expand so they stop sounding like typos. */
export function speechTextOf(content: string): string {
  let text = content
    // fenced code blocks: say that they are code instead of reading it
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`\n]+)`/g, '$1')
    // spoiler bars fall away; the words stay (like Discord reading them out)
    .replace(/\|\|([^|]+)\|\|/g, '$1')
    // links keep their label text; BARE urls read as "link"
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<?https?:\/\/[^\s>]+>?/gi, ' link ')
    .replace(/(^|\s)www\.[^\s]+/gi, '$1link')
    // blockquote, heading, list markers
    .replace(/^>\s?/gm, '')
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    // emphasis markers
    .replace(/(\*\*\*|\*\*|__|~~|\*|_)/g, '')
    // mentions read naturally without the sigil
    .replace(/[@:]/g, ' ')
  text = expandEnglishShorthand(text)
  text = stripEmoji(text)
  text = text.replace(/\s+/g, ' ').trim()
  return text
}

/** Chat shorthand that genuinely misreads aloud expands to its spoken
 *  form; everything else keeps its shape. */
function expandEnglishShorthand(text: string): string {
  return text
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/&/g, ' and ')
    .replace(/\bw\/(?=\s)/gi, 'with ')
    .replace(/\bthx\b/gi, 'thanks')
    .replace(/\bpls\b/gi, 'please')
    .replace(/\bbrb\b/gi, 'be right back')
    .replace(/\bidk\b/gi, "i don't know")
    .replace(/\bimo\b/gi, 'in my opinion')
    .replace(/\bbtw\b/gi, 'by the way')
    .replace(/\bngl\b/gi, 'not gonna lie')
    .replace(/\bimma\b/gi, "i'm going to")
    .replace(/\bcuz\b|\bcos\b/gi, 'because')
    .replace(/\bu\b/gi, 'you')
    .replace(/\bur\b/gi, 'your')
    .replace(/\brn\b/gi, 'right now')
}

/** Strip emoji / pictographs / modifiers the speech engine chokes on. */
function stripEmoji(text: string): string {
  return text.replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{20E3}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu,
    ' '
  )
}

/** Split speech text into engine-sized chunks at sentence boundaries so
 *  nothing past the 1024-char input cap is dropped. Falls back to word
 *  boundaries for run-on sentences. Capped at 5 chunks (~the message cap
 *  twice over); anything longer is cut with an ellipsis. */
export function speechChunksOf(content: string): string[] {
  const text = speechTextOf(content)
  if (!text) return []
  const MAX = 950
  if (text.length <= MAX) return [text]

  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text]
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    let piece = sentence.trim()
    if (!piece) continue
    // a single sentence longer than the cap is split at word boundaries
    while (piece.length > MAX) {
      let cut = piece.lastIndexOf(' ', MAX)
      if (cut <= 0) cut = MAX
      chunks.push(piece.slice(0, cut).trim())
      piece = piece.slice(cut).trim()
    }
    if (current.length + piece.length + 1 <= MAX) {
      current = current ? `${current} ${piece}` : piece
    } else {
      if (current) chunks.push(current)
      current = piece
    }
  }
  if (current) chunks.push(current)

  if (chunks.length > 5) {
    const kept = chunks.slice(0, 5)
    kept[4] = `${kept[4].slice(0, MAX - 3).trimEnd()}...`
    return kept
  }
  return chunks.filter((c) => c.length > 0)
}
