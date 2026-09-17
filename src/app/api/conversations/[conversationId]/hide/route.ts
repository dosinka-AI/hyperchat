import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { notFound, serverError, unauthorized } from '@/lib/realtime'

type Params = { params: Promise<{ conversationId: string }> }

export async function POST(_req: NextRequest, { params }: Params) {
  // close (hide) a direct message. A new message brings it back.
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { conversationId } = await params
    const participant = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId: me.id } },
    })
    if (!participant) return notFound('Conversation not found.')

    await db.conversationParticipant.update({
      where: { id: participant.id },
      data: { hidden: true },
    })

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
