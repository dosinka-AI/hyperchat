import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToRooms, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { effectiveOwnerId } from '@/lib/convo-owner'

const EPOCH = new Date(0)

const PUBLIC_USER = {
  id: true,
  username: true,
  displayName: true,
  avatarUrl: true,
  avatarColor: true,
  bio: true,
  customStatus: true,
  bannerColor: true,
  bannerUrl: true,
} as const

export async function GET() {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const participations = await db.conversationParticipant.findMany({
      where: { userId: me.id, hidden: false },
      include: {
        conversation: {
          include: {
            participants: {
              include: { user: { select: PUBLIC_USER } },
            },
            messages: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { id: true, content: true, imageUrl: true, createdAt: true, authorId: true },
            },
          },
        },
      },
      orderBy: { conversation: { createdAt: 'desc' } },
    })

    const readStates = await db.readState.findMany({
      where: { userId: me.id, scopeKey: { startsWith: 'conversation:' } },
    })
    const myReadAt = new Map(readStates.map((r) => [r.scopeKey.slice('conversation:'.length), r.lastReadAt]))

    const conversations = await Promise.all(
      participations.map(async (p) => {
        const conversation = p.conversation
        const isGroup = conversation.kind === 'GROUP'
        // DM: the single other side. GROUP: first other participant keeps the
        // non-null otherUser contract for existing consumers.
        const others = conversation.participants.filter((pt) => pt.userId !== me.id)
        const other = others[0]?.user ?? conversation.participants[0]?.user
        if (!other) return null
        const last = conversation.messages[0]
        const conversationId = p.conversationId
        const since = myReadAt.get(conversationId) ?? EPOCH
        const unreadCount = await db.message.count({
          where: { conversationId, createdAt: { gt: since } },
        })

        const otherRead = await db.readState.findUnique({
          where: {
            userId_scopeKey: {
              userId: other.id,
              scopeKey: `conversation:${conversationId}`,
            },
          },
        })

        // group read receipts: WHO else has read, keyed by userId. DMs keep
        // the single-partner shape from the row we already fetched (harmless
        // and keeps one payload shape); groups fan out to every other
        // participant — filtered to CURRENT members so a departed member's
        // stale read row never haunts the receipt row.
        let othersReadAt: Record<string, string> = {}
        if (isGroup) {
          const othersRead = await db.readState.findMany({
            where: { scopeKey: `conversation:${conversationId}`, userId: { not: me.id } },
          })
          const memberIds = new Set(others.map((pt) => pt.userId))
          for (const r of othersRead) {
            if (memberIds.has(r.userId)) othersReadAt[r.userId] = r.lastReadAt.toISOString()
          }
        } else if (otherRead) {
          othersReadAt[other.id] = otherRead.lastReadAt.toISOString()
        }

        return {
          id: conversationId,
          kind: isGroup ? 'GROUP' : 'DM',
          name: isGroup ? conversation.name : null,
          iconUrl: isGroup ? conversation.iconUrl : null,
          ownerId: isGroup ? effectiveOwnerId(conversation.ownerId, conversation.participants) : null,
          limitRaised: isGroup ? conversation.limitRaised : false,
          editPolicy: isGroup ? conversation.editPolicy : undefined,
          invitePolicy: isGroup ? conversation.invitePolicy : undefined,
          allowCrossRing: isGroup ? conversation.allowCrossRing : undefined,
          tempExpiryMinutes: isGroup ? null : conversation.tempExpiryMinutes,
          otherUser: {
            id: other.id,
            username: other.username,
            displayName: other.displayName,
            avatarUrl: other.avatarUrl,
            avatarColor: other.avatarColor,
            bio: other.bio,
            customStatus: other.customStatus,
            bannerColor: other.bannerColor,
            bannerUrl: other.bannerUrl,
          },
          participants: isGroup
            ? conversation.participants.map((pt) => ({
                id: pt.user.id,
                username: pt.user.username,
                displayName: pt.user.displayName,
                avatarUrl: pt.user.avatarUrl,
                avatarColor: pt.user.avatarColor,
              }))
            : undefined,
          hidden: p.hidden,
          pinned: p.pinned,
          lastMessage: last
            ? {
                id: last.id,
                content: last.content,
                imageUrl: last.imageUrl,
                createdAt: last.createdAt.toISOString(),
                authorId: last.authorId,
              }
            : null,
          otherLastReadAt: otherRead ? otherRead.lastReadAt.toISOString() : null,
          othersReadAt,
          unreadCount,
        }
      })
    )

    return NextResponse.json({
      conversations: conversations
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .sort((a, b) => {
          // pinned conversations float to the top, then by latest activity
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
          const aTime = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0
          const bTime = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0
          return bTime - aTime
        }),
    })
  } catch {
    return serverError()
  }
}

export async function POST(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json()

    // ---- group creation: me + 2-4 members = a 5-member group out of the box ----
    if (body.kind === 'GROUP') {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : ''
      if (name.length < 2) return badRequest('Give the group a name (2 or more characters).')

      const rawIds: unknown[] = Array.isArray(body.memberIds) ? body.memberIds : []
      const memberIds = Array.from(
        new Set(rawIds.filter((id): id is string => typeof id === 'string' && !!id))
      )
      if (memberIds.length < 2 || memberIds.length > 4) {
        return badRequest('Pick 2 to 4 friends for your group.')
      }
      if (memberIds.includes(me.id)) return badRequest('You are already in the group.')

      const members = await db.user.findMany({
        where: { id: { in: memberIds } },
        select: { id: true, username: true },
      })
      if (members.length !== memberIds.length) return notFound('One of those users does not exist.')

      // blocks gate groups the same way they gate DMs (both directions)
      const block = await db.userBlock.findFirst({
        where: {
          OR: memberIds.flatMap((id) => [
            { blockerId: me.id, blockedId: id },
            { blockerId: id, blockedId: me.id },
          ]),
        },
      })
      if (block) {
        return NextResponse.json({ error: 'You cannot add one of those users.' }, { status: 403 })
      }

      const conversation = await db.conversation.create({
        data: {
          kind: 'GROUP',
          name,
          ownerId: me.id,
          participants: {
            create: [{ userId: me.id }, ...memberIds.map((id) => ({ userId: id }))],
          },
        },
      })

      await emitToRooms(
        [userRoom(me.id), ...memberIds.map((id) => userRoom(id))],
        'conversation:new',
        {
          conversationId: conversation.id,
          group: true,
          name,
          users: [
            { id: me.id, username: me.username },
            ...members.map((m) => ({ id: m.id, username: m.username })),
          ],
        }
      )

      return NextResponse.json({ conversationId: conversation.id, existing: false }, { status: 201 })
    }

    // ---- 1:1 DM creation (existing behavior) ----
    const userId = typeof body.userId === 'string' ? body.userId : ''
    if (!userId || userId === me.id) return badRequest('Pick someone to message.')

    const other = await db.user.findUnique({
      where: { id: userId },
      select: PUBLIC_USER,
    })
    if (!other) return notFound('User not found.')

    // blocks gate DMs in both directions
    const block = await db.userBlock.findFirst({
      where: {
        OR: [
          { blockerId: me.id, blockedId: other.id },
          { blockerId: other.id, blockedId: me.id },
        ],
      },
    })
    if (block) {
      return NextResponse.json({ error: 'You cannot message this user.' }, { status: 403 })
    }

    // find an existing 1:1 DM between the two users (groups never match:
    // sharing a group with someone does not make it your DM thread)
    const mine = await db.conversationParticipant.findMany({
      where: { userId: me.id, conversation: { kind: 'DM' } },
      select: { conversationId: true },
    })
    const myConvIds = mine.map((m) => m.conversationId)
    const shared = myConvIds.length
      ? await db.conversationParticipant.findFirst({
          where: { conversationId: { in: myConvIds }, userId: other.id },
        })
      : null

    if (shared) {
      // re-open if it was closed
      await db.conversationParticipant.update({
        where: { id: shared.id },
        data: { hidden: false },
      })
      return NextResponse.json({ conversationId: shared.conversationId, existing: true })
    }

    const conversation = await db.conversation.create({
      data: {
        participants: {
          create: [
            { userId: me.id },
            { userId: other.id },
          ],
        },
      },
    })

    await emitToRooms(
      [userRoom(me.id), userRoom(other.id)],
      'conversation:new',
      {
        conversationId: conversation.id,
        users: [
          { id: me.id, username: me.username },
          { id: other.id, username: other.username },
        ],
      }
    )

    return NextResponse.json({ conversationId: conversation.id, existing: false }, { status: 201 })
  } catch {
    return serverError()
  }
}
