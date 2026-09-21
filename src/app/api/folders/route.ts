import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, serverError, unauthorized } from '@/lib/realtime'

/** Rail folders (Discord-style): a user-owned grouping of servers. The
 *  folder list rides the bootstrap + sync payloads; membership lives on
 *  ServerMember rows (folderId), so a folder only ever shows servers the
 *  user is actually in. */
export async function GET() {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const folders = await db.serverFolder.findMany({
      where: { userId: me.id },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        position: true,
        members: { select: { serverId: true }, orderBy: { joinedAt: 'asc' } },
      },
    })
    return NextResponse.json({
      folders: folders.map((f) => ({
        id: f.id,
        name: f.name,
        position: f.position,
        serverIds: f.members.map((m) => m.serverId),
      })),
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
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 32) : ''
    if (name.length < 1) return badRequest('Give the folder a name.')

    // a rail only has so much room: 20 folders is already plenty
    const count = await db.serverFolder.count({ where: { userId: me.id } })
    if (count >= 20) return badRequest('You already have 20 folders. Delete one first.')

    const last = await db.serverFolder.findFirst({
      where: { userId: me.id },
      orderBy: { position: 'desc' },
      select: { position: true },
    })
    const folder = await db.serverFolder.create({
      data: { userId: me.id, name, position: (last?.position ?? -1) + 1 },
    })
    return NextResponse.json({ folder: { id: folder.id, name: folder.name, position: folder.position, serverIds: [] } }, { status: 201 })
  } catch {
    return serverError()
  }
}
