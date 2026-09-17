import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToAll, serverError, unauthorized } from '@/lib/realtime'

const FILE_URL_RE = /^\/api\/files\/[a-zA-Z0-9._-]+$/
const STORY_TTL_MS = 24 * 60 * 60 * 1000

/** Post a story. The image rides the existing upload flow: the client
 *  uploads the file first and hands the returned /api/files URL here. */
export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json()
    const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl : ''
    if (!FILE_URL_RE.test(imageUrl)) return badRequest('Attach an image.')

    const story = await db.story.create({
      data: {
        authorId: me.id,
        imageUrl,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + STORY_TTL_MS),
      },
    })

    await emitToAll('profile:refresh', { username: me.username })

    return NextResponse.json(
      { story: { id: story.id, imageUrl: story.imageUrl, createdAt: story.createdAt.toISOString(), expiresAt: story.expiresAt.toISOString() } },
      { status: 201 }
    )
  } catch {
    return serverError()
  }
}
