import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { AUTHOR_INCLUDE, toClientMessage } from '@/lib/messages'
import { conversationRoom, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'

type Params = { params: Promise<{ conversationId: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { conversationId } = await params
    const participant = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId: me.id } },
    })
    if (!participant) return forbidden('You are not part of this conversation.')

    const pinned = await db.message.findMany({
      where: { conversationId, pinned: true },
      orderBy: { pinnedAt: 'desc' },
      take: 50,
      include: AUTHOR_INCLUDE,
    })

    return NextResponse.json({
      messages: pinned.map((m) => toClientMessage(m, conversationRoom(conversationId))),
    })
  } catch {
    return serverError()
  }
}
