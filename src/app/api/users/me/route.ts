import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, emitToAll, emitToRooms, serverError, unauthorized, userRoom } from '@/lib/realtime'

const FILE_URL_RE = /^\/api\/files\/[a-zA-Z0-9\-]+\.(png|jpg|jpeg|gif|webp)$/

/** profile fields that change how the user renders for other people. A
 * PATCH that touches none of these (e.g. a pure presence switch) must not
 * trigger the global user:profile broadcast. */
const DISPLAY_FIELDS = [
  'displayName',
  'bio',
  'avatarUrl',
  'avatarColor',
  'customStatus',
  'pronouns',
  'bannerColor',
  'bannerUrl',
] as const

export async function PATCH(req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const body = await req.json()
    const data: {
      displayName?: string | null
      bio?: string
      avatarUrl?: string | null
      avatarColor?: string
      customStatus?: string | null
      pronouns?: string | null
      presence?: 'online' | 'idle' | 'busy' | 'dnd' | 'invisible'
      bannerColor?: string | null
      bannerUrl?: string | null
    } = {}

    if (body.displayName !== undefined) {
      const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 32) : ''
      data.displayName = displayName || null
    }
    if (body.bio !== undefined) {
      const bio = typeof body.bio === 'string' ? body.bio.trim().slice(0, 190) : ''
      data.bio = bio
    }
    if (body.avatarUrl !== undefined) {
      const url = body.avatarUrl === null ? null : typeof body.avatarUrl === 'string' ? body.avatarUrl : ''
      if (url === null) {
        data.avatarUrl = null
      } else if (FILE_URL_RE.test(url)) {
        data.avatarUrl = url
      } else {
        return badRequest('Use an image uploaded through HyperChat.')
      }
    }
    if (body.avatarColor !== undefined && typeof body.avatarColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.avatarColor)) {
      data.avatarColor = body.avatarColor
    }
    if (body.customStatus !== undefined) {
      const customStatus = typeof body.customStatus === 'string' ? body.customStatus.trim().slice(0, 80) : ''
      data.customStatus = customStatus || null
    }
    if (body.pronouns !== undefined) {
      const pronouns = typeof body.pronouns === 'string' ? body.pronouns.trim().slice(0, 40) : ''
      data.pronouns = pronouns || null
    }
    if (body.presence !== undefined) {
      const presence = body.presence
      if (presence === 'online' || presence === 'idle' || presence === 'busy' || presence === 'dnd' || presence === 'invisible') {
        data.presence = presence
      }
    }
    if (body.bannerUrl !== undefined) {
      const url = body.bannerUrl === null ? null : typeof body.bannerUrl === 'string' ? body.bannerUrl : ''
      if (url === null) {
        data.bannerUrl = null
      } else if (FILE_URL_RE.test(url)) {
        data.bannerUrl = url
      } else {
        return badRequest('Use a banner uploaded through HyperChat.')
      }
    }
    if (body.bannerColor !== undefined) {
      const bannerColor = body.bannerColor === null ? null : typeof body.bannerColor === 'string' ? body.bannerColor : ''
      if (bannerColor === null || /^#[0-9a-fA-F]{6}$/.test(bannerColor)) {
        data.bannerColor = bannerColor
      } else {
        return badRequest('Banner color must be a hex value like #547cff.')
      }
    }

    if (Object.keys(data).length === 0) return badRequest('Nothing to update.')

    const user = await db.user.update({
      where: { id: me.id },
      data,
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        avatarUrl: true,
        avatarColor: true,
        bio: true,
        role: true,
        customStatus: true,
        pronouns: true,
        presence: true,
        bannerColor: true,
        bannerUrl: true,
        createdAt: true,
      },
    })

    // everyone who shares a server or DM with this user gets the new
    // profile patched straight into their caches: one lightweight broadcast
    // with the full public snapshot (the client merges field-by-field, so
    // avatars, names, status quotes and banners all update live)
    const myScopes = await Promise.all([
      db.serverMember.findMany({ where: { userId: me.id }, select: { serverId: true } }),
      db.conversationParticipant.findMany({ where: { userId: me.id }, select: { conversationId: true } }),
    ])
    const witnessIds = new Set<string>()
    for (const m of myScopes[0]) {
      const others = await db.serverMember.findMany({
        where: { serverId: m.serverId, userId: { not: me.id } },
        select: { userId: true },
      })
      for (const o of others) witnessIds.add(o.userId)
    }
    for (const c of myScopes[1]) {
      const others = await db.conversationParticipant.findMany({
        where: { conversationId: c.conversationId, userId: { not: me.id } },
        select: { userId: true },
      })
      for (const o of others) witnessIds.add(o.userId)
    }
    await emitToRooms([...witnessIds].map((id) => userRoom(id)), 'user:update', {
      userId: me.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      avatarColor: user.avatarColor,
      bio: user.bio,
      customStatus: user.customStatus,
      pronouns: user.pronouns,
      bannerColor: user.bannerColor,
      bannerUrl: user.bannerUrl,
    })

    // global broadcast: profile changes must reach every online client the
    // moment they happen, not just co-members/DM partners (friends list,
    // search caches, member columns of servers the witness scan missed
    // mid-race, ...). Only fires when a display-relevant field changed.
    if (DISPLAY_FIELDS.some((field) => field in data)) {
      void emitToAll('user:profile', {
        userId: me.id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        avatarColor: user.avatarColor,
        bio: user.bio,
        customStatus: user.customStatus,
        pronouns: user.pronouns,
        bannerColor: user.bannerColor,
        bannerUrl: user.bannerUrl,
      })
    }

    return NextResponse.json({ user })
  } catch {
    return serverError()
  }
}
