import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireSiteAdmin } from '@/lib/siteAdmin'
import { emitToRooms, userRoom } from '@/lib/realtime'

/**
 * PUT /api/admin/users/[userId] — per-row admin actions (Task 6-c).
 * Site-admin only. One action per call:
 *
 *   { action: 'verify' }   toggle the account's email-verified state
 *   { action: 'admin' }    toggle the siteAdmin flag (CANNOT target yourself —
 *                          a lone admin must not lock himself out of the panel)
 *   { action: 'ban', reason? }    create a UserBan row (session + login + the
 *                          socket all die immediately; admins cannot be banned)
 *   { action: 'unban' }    delete the UserBan row — the account can log in again
 *
 * Returns the refreshed user row (same shape as the directory listing).
 */

type Params = { params: Promise<{ userId: string }> }

async function userSummary(userId: string) {
  const u = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      displayName: true,
      email: true,
      emailVerifiedAt: true,
      siteAdmin: true,
      avatarUrl: true,
      avatarColor: true,
      createdAt: true,
      siteBan: { select: { reason: true, bannedAt: true, bannedBy: true } },
      _count: { select: { memberships: true, messages: true } },
    },
  })
  if (!u) return null
  const last = await db.message.findFirst({
    where: { authorId: u.id },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    verified: u.emailVerifiedAt !== null,
    siteAdmin: u.siteAdmin,
    avatarUrl: u.avatarUrl,
    avatarColor: u.avatarColor,
    createdAt: u.createdAt.toISOString(),
    serverCount: u._count.memberships,
    messageCount: u._count.messages,
    lastMessageAt: last?.createdAt.toISOString() ?? null,
    banned: u.siteBan
      ? { reason: u.siteBan.reason, bannedAt: u.siteBan.bannedAt.toISOString(), bannedBy: u.siteBan.bannedBy }
      : null,
  }
}

export async function PUT(req: NextRequest, { params }: Params) {
  const gate = await requireSiteAdmin()
  if (!gate.ok) return gate.response
  const me = gate.me

  try {
    const { userId } = await params
    if (userId === me.id) {
      return NextResponse.json({ error: 'You cannot target your own account here.' }, { status: 400 })
    }

    const body = (await req.json().catch(() => ({}))) as { action?: unknown; reason?: unknown }
    const action = typeof body.action === 'string' ? body.action : ''
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : ''

    const target = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, siteAdmin: true, emailVerifiedAt: true },
    })
    if (!target) return NextResponse.json({ error: 'User not found.' }, { status: 404 })

    if (action === 'verify') {
      await db.user.update({
        where: { id: userId },
        data: { emailVerifiedAt: target.emailVerifiedAt ? null : new Date() },
      })
      await emitToRooms([userRoom(userId)], 'user:update', { userId })
    } else if (action === 'admin') {
      await db.user.update({
        where: { id: userId },
        data: { siteAdmin: !target.siteAdmin },
      })
      // the target's client learns its own flag flipped: a fresh me snapshot
      // arrives through the user:update nudge
      await emitToRooms([userRoom(userId)], 'user:update', { userId })
    } else if (action === 'ban') {
      if (target.siteAdmin) {
        return NextResponse.json({ error: 'Site admins cannot be banned.' }, { status: 400 })
      }
      await db.userBan.upsert({
        where: { userId },
        update: { reason: reason || null, bannedBy: me.id, bannedAt: new Date() },
        create: { userId, reason: reason || null, bannedBy: me.id },
      })
      // kill their live session client-side: the same flow the legacy
      // suspension used — the client drops to the suspended screen and
      // disconnects; the sidecar handshake also refuses reconnects (UserBan
      // check in isSuspended)
      await emitToRooms([userRoom(userId)], 'account:suspended', { reason: reason || null, until: null })
    } else if (action === 'unban') {
      await db.userBan.deleteMany({ where: { userId } })
      await emitToRooms([userRoom(userId)], 'user:update', { userId })
    } else {
      return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
    }

    const user = await userSummary(userId)
    return NextResponse.json({ user })
  } catch {
    return NextResponse.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
}
