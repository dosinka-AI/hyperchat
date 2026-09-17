import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { notFound, serverError, unauthorized } from '@/lib/realtime'

type Params = { params: Promise<{ conversationId: string }> }

export async function POST(_req: NextRequest, { params }: Params) {
  // pin or unpin a direct message conversation for the caller
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { conversationId } = await params
    const participant = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId: me.id } },
    })
    if (!participant) return notFound('Conversation not found.')

    const updated = await db.conversationParticipant.update({
      where: { id: participant.id },
      data: { pinned: !participant.pinned },
    })

    return NextResponse.json({ ok: true, pinned: updated.pinned })
  } catch {
    return serverError()
  }
}
