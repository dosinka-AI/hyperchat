import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'

type Params = { params: Promise<{ serverId: string }> }

/** Rail layout for one of my servers: which folder it sits in and whether
 *  it is pinned to the top. Purely personal state on the membership row —
 *  no audit event, no broadcast (only my own rail cares). */
export async function POST(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { serverId } = await params
    const member = await db.serverMember.findUnique({
      where: { userId_serverId: { userId: me.id, serverId } },
    })
    if (!member) return forbidden('You are not a member of this server.')

    const body = await req.json()

    const data: { folderId?: string | null; favorite?: boolean } = {}

    if ('folderId' in body) {
      const raw = body.folderId
      if (raw === null || raw === '') {
        data.folderId = null
      } else {
        if (typeof raw !== 'string') return badRequest('folderId must be a folder id or null.')
        const folder = await db.serverFolder.findUnique({ where: { id: raw } })
        if (!folder || folder.userId !== me.id) return notFound('Folder not found.')
        data.folderId = folder.id
      }
    }

    if ('favorite' in body) {
      if (typeof body.favorite !== 'boolean') return badRequest('favorite must be true or false.')
      data.favorite = body.favorite
    }

    if (Object.keys(data).length === 0) return badRequest('Nothing to update.')

    const updated = await db.serverMember.update({
      where: { userId_serverId: { userId: me.id, serverId } },
      data,
    })
    return NextResponse.json({
      serverId,
      folderId: updated.folderId,
      favorite: updated.favorite,
    })
  } catch {
    return serverError()
  }
}
