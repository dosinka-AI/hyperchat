import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { notFound, serverError, unauthorized } from '@/lib/realtime'

type Params = { params: Promise<{ username: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { username } = await params
    const user = await db.user.findUnique({
      where: { username: username.toLowerCase() },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
        avatarColor: true,
        bio: true,
        role: true,
        customStatus: true,
        pronouns: true,
        bannerColor: true,
        bannerUrl: true,
        createdAt: true,
      },
    })
    if (!user) return notFound('No user goes by that name.')

    // mutual servers: shared membership names for the profile card
    const myServers = await db.serverMember.findMany({
      where: { userId: me.id },
      select: { serverId: true },
    })
    const mutual = myServers.length
      ? await db.server.findMany({
          where: {
            id: { in: myServers.map((m) => m.serverId) },
            members: { some: { userId: user.id } },
          },
          select: { name: true },
          take: 6,
        })
      : []

    return NextResponse.json({ user, mutualServers: mutual.map((m) => m.name) })
  } catch {
    return serverError()
  }
}
