import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'

type Params = { params: Promise<{ folderId: string }> }

/** Rename or delete one of my rail folders. Deleting unassigns its servers
 *  (SetNull), never touching the memberships themselves. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { folderId } = await params
    const folder = await db.serverFolder.findUnique({ where: { id: folderId } })
    if (!folder || folder.userId !== me.id) return notFound('Folder not found.')

    const body = await req.json()
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 32) : ''
    if (name.length < 1) return badRequest('Give the folder a name.')
    if (name === folder.name) {
      return NextResponse.json({ folder: { id: folder.id, name: folder.name } })
    }

    const updated = await db.serverFolder.update({ where: { id: folderId }, data: { name } })
    return NextResponse.json({ folder: { id: updated.id, name: updated.name } })
  } catch {
    return serverError()
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { folderId } = await params
    const folder = await db.serverFolder.findUnique({ where: { id: folderId } })
    if (!folder || folder.userId !== me.id) return notFound('Folder not found.')

    // SetNull frees the member rows first; the folder row itself cascades nothing
    await db.serverMember.updateMany({ where: { folderId }, data: { folderId: null } })
    await db.serverFolder.delete({ where: { id: folderId } })
    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
