import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { fetchVoiceParticipants, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'

type Params = { params: Promise<{ channelId: string }> }

/** Current voice participants for a voice channel, for the initial sidebar
 *  render. Voice presence is ephemeral sidecar state; this route proxies the
 *  sidecar's /voice endpoint and enriches userIds with profile snapshots. */
export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { channelId } = await params
    const channel = await db.channel.findUnique({
      where: { id: channelId },
      include: { access: { select: { roleId: true } } },
    })
    if (!channel) return notFound('Channel not found.')
    if (channel.type !== 'voice') return forbidden('This is not a voice channel.')

    const ctx = await getMemberContext(channel.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!ctx.canReadChannel(channel)) return forbidden('This channel is limited to specific roles.')

    const raw = await fetchVoiceParticipants(channelId)
    const userIds = raw.map((p) => p.userId)
    const profiles = userIds.length
      ? await db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, username: true, displayName: true, avatarUrl: true, avatarColor: true },
        })
      : []
    const byId = new Map(profiles.map((u) => [u.id, u]))

    const participants = raw.map((p) => {
      const profile = byId.get(p.userId)
      return {
        userId: p.userId,
        username: profile?.username ?? p.username,
        displayName: profile?.displayName ?? null,
        avatarUrl: profile?.avatarUrl ?? null,
        avatarColor: profile?.avatarColor ?? '#2e2e2e',
        sessionId: p.sessionId,
        muted: p.muted,
        deafened: p.deafened,
        speaking: false,
        volume: 0,
      }
    })

    return NextResponse.json({ participants })
  } catch {
    return serverError()
  }
}
