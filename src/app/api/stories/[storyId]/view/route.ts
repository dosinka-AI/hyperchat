import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { notFound, serverError, unauthorized } from '@/lib/realtime'

type Params = { params: Promise<{ storyId: string }> }

/** Mark a story as watched by the caller. Idempotent; the author's own
 *  stories never need a marker. */
export async function POST(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { storyId } = await params
    const story = await db.story.findUnique({
      where: { id: storyId },
      select: { id: true, authorId: true, expiresAt: true },
    })
    if (!story || story.expiresAt.getTime() <= Date.now()) return notFound('Story not found.')

    if (story.authorId !== me.id) {
      await db.storyView.upsert({
        where: { storyId_userId: { storyId, userId: me.id } },
        create: { storyId, userId: me.id },
        update: {},
      })
    }

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
