import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/auth'
import { badRequest, serverError, unauthorized } from '@/lib/realtime'

/** Message translation: any language in, English out (the app's language).
 *  The LLM detects the source; already-English text comes back untouched. */
export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json()
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : ''
    if (!text) return badRequest('Nothing to translate.')

    const { default: ZAI } = await import('z-ai-web-dev-sdk')
    const zai = await ZAI.create()
    const completion = await zai.chat.completions.create({
      messages: [
        {
          role: 'assistant',
          content:
            'You translate chat messages into English. Reply with the translation only: no quotes, no notes, no explanation. If the text is already English, return it unchanged.',
        },
        { role: 'user', content: text },
      ],
      thinking: { type: 'disabled' },
    })
    const translated = completion.choices[0]?.message?.content?.trim() ?? ''
    if (!translated) return serverError()
    return NextResponse.json({ text: translated.slice(0, 2000) })
  } catch {
    return serverError()
  }
}
