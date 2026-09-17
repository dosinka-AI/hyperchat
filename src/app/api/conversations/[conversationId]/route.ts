import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { effectiveOwnerId } from '@/lib/convo-owner'

type Params = { params: Promise<{ conversationId: string }> }

const TEMP_EXPIRY_CHOICES = [60, 1440, 10080]
const POLICY_CHOICES = ['ALL', 'OWNER'] as const

/** Notify every member's client that the conversation changed (name, limit,
 *  temp-message window): each refreshes its conversation list, so sidebars
 *  and headers update live on every side. Reuses the conversation:new
 *  channel the DM flow already notifies the other side through. */
async function notifyParticipants(conversationId: string, extra: Record<string, unknown> = {}): Promise<void> {
  const participants = await db.conversationParticipant.findMany({
    where: { conversationId },
    select: { userId: true },
  })
  await emitToRooms(
    participants.map((p) => userRoom(p.userId)),
    'conversation:new',
    { conversationId, ...extra }
  )
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { conversationId } = await params
    const participant = await db.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId: me.id } },
    })
    if (!participant) return notFound('Conversation not found.')
    const conversation = await db.conversation.findUnique({ where: { id: conversationId } })
    if (!conversation) return notFound('Conversation not found.')
    const isGroup = conversation.kind === 'GROUP'

    const body = await req.json()

    // owner id resolved once for policy checks below
    const participantRows = isGroup
      ? await db.conversationParticipant.findMany({
          where: { conversationId },
          orderBy: { id: 'asc' },
          select: { id: true, userId: true },
        })
      : []
    const ownerId = isGroup ? effectiveOwnerId(conversation.ownerId, participantRows) : null
    const iOwn = ownerId === me.id || me.role === 'ADMIN'
    /** edit policy gates who may rename the group or change its photo */
    const canEditGroup = !isGroup || conversation.editPolicy !== 'OWNER' || iOwn

    // ---- group settings (owner only): who can edit the name/photo and
    //     who can invite. defaults are permissive (ALL = everyone). ----
    if (body.editPolicy !== undefined || body.invitePolicy !== undefined) {
      if (!isGroup) return forbidden('Only groups have settings.')
      if (!iOwn) return forbidden('Only the group owner can change group settings.')
      const nextEdit = body.editPolicy !== undefined ? body.editPolicy : conversation.editPolicy
      const nextInvite = body.invitePolicy !== undefined ? body.invitePolicy : conversation.invitePolicy
      if (!POLICY_CHOICES.includes(nextEdit) || !POLICY_CHOICES.includes(nextInvite)) {
        return badRequest('Pick everyone or owner only.')
      }
      const updated = await db.conversation.update({
        where: { id: conversationId },
        data: { editPolicy: nextEdit, invitePolicy: nextInvite },
      })
      await notifyParticipants(conversationId, { editPolicy: nextEdit, invitePolicy: nextInvite })
      return NextResponse.json({
        conversation: {
          id: updated.id,
          kind: updated.kind,
          name: updated.name,
          ownerId: updated.ownerId,
          editPolicy: updated.editPolicy,
          invitePolicy: updated.invitePolicy,
        },
      })
    }

    // ---- temporary messages: 1:1 DMs only, either side can toggle ----
    if ('tempExpiryMinutes' in body) {
      if (isGroup) {
        return forbidden('Temporary messages are for direct messages, not groups.')
      }
      const raw = body.tempExpiryMinutes
      const value = raw === null ? null : typeof raw === 'number' ? raw : NaN
      if (value !== null && !TEMP_EXPIRY_CHOICES.includes(value)) {
        return badRequest('Pick 1 hour, 24 hours, 7 days, or off.')
      }
      const updated = await db.conversation.update({
        where: { id: conversationId },
        data: { tempExpiryMinutes: value },
      })
      await notifyParticipants(conversationId, { tempExpiryMinutes: value })
      return NextResponse.json({
        conversation: {
          id: updated.id,
          kind: updated.kind,
          name: updated.name,
          limitRaised: updated.limitRaised,
          tempExpiryMinutes: updated.tempExpiryMinutes,
        },
      })
    }

    // ---- member limit: 5 <-> 50, groups only, owner only. `limitRaised`
    //     is the current body; legacy `raiseLimit: true` is an alias kept
    //     for older clients ----
    if (body.limitRaised !== undefined || body.raiseLimit === true) {
      if (!isGroup) return forbidden('Only groups have a member limit.')
      const rows = await db.conversationParticipant.findMany({
        where: { conversationId },
        orderBy: { id: 'asc' },
        select: { id: true, userId: true },
      })
      const owner = effectiveOwnerId(conversation.ownerId, rows)
      if (owner !== me.id && me.role !== 'ADMIN') {
        return forbidden('Only the group owner can change the member limit.')
      }
      const raised = body.limitRaised !== undefined ? body.limitRaised === true : true
      if (raised === conversation.limitRaised) {
        return NextResponse.json({
          conversation: {
            id: conversation.id,
            kind: conversation.kind,
            name: conversation.name,
            ownerId: conversation.ownerId,
            limitRaised: conversation.limitRaised,
            tempExpiryMinutes: conversation.tempExpiryMinutes,
          },
        })
      }
      if (!raised && rows.length > 5) {
        return badRequest(
          `Lower the member count first: ${rows.length} people are in this group.`
        )
      }
      const updated = await db.conversation.update({
        where: { id: conversationId },
        data: { limitRaised: raised },
      })
      await notifyParticipants(conversationId, { limitRaised: raised })
      return NextResponse.json({
        conversation: {
          id: updated.id,
          kind: updated.kind,
          name: updated.name,
          ownerId: updated.ownerId,
          limitRaised: updated.limitRaised,
          tempExpiryMinutes: updated.tempExpiryMinutes,
        },
      })
    }

    // ---- rename (groups only; anyone unless the owner locked it) ----
    if (typeof body.name === 'string') {
      if (!isGroup) return forbidden('Only groups can be renamed.')
      if (!canEditGroup) {
        return forbidden('Only the group owner can rename this group.')
      }
      const name = body.name.trim().slice(0, 60)
      if (name.length < 2) return badRequest('Give the group a name (2 or more characters).')
      const updated = await db.conversation.update({
        where: { id: conversationId },
        data: { name },
      })
      await notifyParticipants(conversationId, { name })
      return NextResponse.json({
        conversation: {
          id: updated.id,
          kind: updated.kind,
          name: updated.name,
          limitRaised: updated.limitRaised,
          tempExpiryMinutes: updated.tempExpiryMinutes,
        },
      })
    }

    // ---- group photo (groups only; anyone unless the owner locked it;
    //     null clears it back to the stacked-members icon) ----
    if ('iconUrl' in body) {
      if (!isGroup) return forbidden('Only groups can have a photo.')
      if (!canEditGroup) {
        return forbidden('Only the group owner can change the group photo.')
      }
      const raw = body.iconUrl
      const iconUrl =
        raw === null || raw === ''
          ? null
          : typeof raw === 'string' && /^(https?:\/\/|\/api\/files\/)/.test(raw) && raw.length <= 2048
            ? raw
            : null
      if (raw !== null && raw !== '' && iconUrl === null) {
        return badRequest('That image cannot be used as a group photo.')
      }
      const updated = await db.conversation.update({
        where: { id: conversationId },
        data: { iconUrl },
      })
      await notifyParticipants(conversationId, { iconUrl })
      return NextResponse.json({
        conversation: {
          id: updated.id,
          kind: updated.kind,
          name: updated.name,
          iconUrl: updated.iconUrl,
          limitRaised: updated.limitRaised,
          tempExpiryMinutes: updated.tempExpiryMinutes,
        },
      })
    }

    return badRequest('Nothing to update.')
  } catch {
    return serverError()
  }
}
