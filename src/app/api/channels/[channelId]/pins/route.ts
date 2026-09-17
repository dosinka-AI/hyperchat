import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { AUTHOR_INCLUDE, toClientMessage } from '@/lib/messages'
import { channelRoom, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'

type Params = { params: Promise<{ channelId: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { channelId } = await params
    const channel = await db.channel.findUnique({
      where: { id: channelId },
      include: { server: { include: { members: { select: { userId: true } } } } },
    })
    if (!channel) return notFound('Channel not found.')
    if (!channel.server.members.some((m) => m.userId === me.id)) {
      return forbidden('You are not a member of this server.')
    }

    const pinned = await db.message.findMany({
      where: { channelId, pinned: true },
      orderBy: { pinnedAt: 'desc' },
      take: 50,
      include: AUTHOR_INCLUDE,
    })

    return NextResponse.json({
      messages: pinned.map((m) => toClientMessage(m, channelRoom(channelId))),
    })
  } catch {
    return serverError()
  }
}
