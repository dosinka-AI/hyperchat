import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { AUTHOR_INCLUDE, toClientMessage } from '@/lib/messages'
import {
  badRequest,
  conversationRoom,
  emitToRooms,
  forbidden,
  notFound,
  serverError,
  unauthorized,
  userRoom,
} from '@/lib/realtime'

type Params = { params: Promise<{ conversationId: string }> }

async function getParticipantIds(conversationId: string): Promise<string[] | null> {
  const participants = await db.conversationParticipant.findMany({
    where: { conversationId },
    select: { userId: true },
  })
  return participants.length ? participants.map((p) => p.userId) : null
}

type CallSystemData = {
  by: string
  byUserId: string
  video: boolean
  startedAt: number
  durationSec: number | null
  missed: boolean
}

function parseCallData(raw: string | null): CallSystemData | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      by: typeof parsed.by === 'string' ? parsed.by : '',
      byUserId: typeof parsed.byUserId === 'string' ? parsed.byUserId : '',
      video: parsed.video === true,
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : Date.now(),
      durationSec: typeof parsed.durationSec === 'number' ? parsed.durationSec : null,
      missed: parsed.missed === true,
    }
  } catch {
    return null
  }
}

/**
 * The call's chat message: a system row ("x started a call") posted the
 * moment a call begins, carrying a live join affordance while the call runs
 * and the duration once it ends. Only the caller (its author) can update or
 * delete it, which is the point: a withdrawn attempt can be wiped before
 * anyone ever knows it happened.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { conversationId } = await params
    const participantIds = await getParticipantIds(conversationId)
    if (!participantIds) return notFound('Conversation not found.')
    if (!participantIds.includes(me.id)) return forbidden('You are not part of this conversation.')

    const body = await req.json().catch(() => ({}) as Record<string, unknown>)
    const video = body?.video === true

    const data: CallSystemData = {
      by: me.displayName || me.username,
      byUserId: me.id,
      video,
      startedAt: Date.now(),
      durationSec: null,
      missed: false,
    }
    const message = await db.message.create({
      data: {
        conversationId,
        authorId: me.id,
        content: null,
        systemKind: 'call',
        systemData: JSON.stringify(data),
      },
      include: AUTHOR_INCLUDE,
    })

    // a call row un-hides the conversation for everyone in it, like any
    // other message would
    await db.conversationParticipant.updateMany({
      where: { conversationId, hidden: true },
      data: { hidden: false },
    })

    const room = conversationRoom(conversationId)
    const payload = toClientMessage(message, room)
    await emitToRooms([room, ...participantIds.map((id) => userRoom(id))], 'message:new', payload)
    return NextResponse.json({ message: payload }, { status: 201 })
  } catch {
    return serverError()
  }
}

/** Stamp the outcome on the call's row: how long it ran, or that it was
 *  never answered. The caller's client fires this when the service reports
 *  the call ended. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { conversationId } = await params
    const participantIds = await getParticipantIds(conversationId)
    if (!participantIds) return notFound('Conversation not found.')
    if (!participantIds.includes(me.id)) return forbidden('You are not part of this conversation.')

    const body = await req.json().catch(() => ({}) as Record<string, unknown>)
    const messageId = typeof body?.messageId === 'string' ? body.messageId : ''
    if (!messageId) return badRequest('messageId is required.')
    const durationSec = typeof body?.durationSec === 'number' ? Math.max(0, Math.round(body.durationSec)) : null
    const missed = body?.missed === true

    const message = await db.message.findUnique({ where: { id: messageId } })
    if (!message || message.conversationId !== conversationId) return notFound('Message not found.')
    if (message.systemKind !== 'call') return badRequest('That message is not a call row.')
    if (message.authorId !== me.id) return forbidden('Only the caller can update the call message.')

    const data = parseCallData(message.systemData) ?? {
      by: me.displayName || me.username,
      byUserId: me.id,
      video: false,
      startedAt: Date.now(),
      durationSec: null,
      missed: false,
    }
    const updated = await db.message.update({
      where: { id: messageId },
      data: {
        systemData: JSON.stringify({
          ...data,
          durationSec: missed ? null : durationSec,
          missed,
        }),
      },
      include: AUTHOR_INCLUDE,
    })

    const room = conversationRoom(conversationId)
    const payload = toClientMessage(updated, room)
    await emitToRooms([room, ...participantIds.map((id) => userRoom(id))], 'message:update', payload)
    return NextResponse.json({ message: payload })
  } catch {
    return serverError()
  }
}
