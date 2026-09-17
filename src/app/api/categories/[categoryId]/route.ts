import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { emitToRooms, forbidden, notFound, serverError, unauthorized, userRoom } from '@/lib/realtime'
import { getMemberContext } from '@/lib/serverPerms'
import { hasPerm, PERM } from '@/lib/perm'
import { logServerEvent } from '@/lib/audit'

type Params = { params: Promise<{ categoryId: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { categoryId } = await params
    const category = await db.channelCategory.findUnique({ where: { id: categoryId } })
    if (!category) return notFound('Category not found.')

    const ctx = await getMemberContext(category.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_CHANNELS)) return forbidden('Only moderators with the Manage Channels permission can rename categories.')

    const body = await req.json()
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 32) : ''
    if (!name) return NextResponse.json({ error: 'Category names cannot be empty.' }, { status: 400 })

    const updated = await db.channelCategory.update({
      where: { id: categoryId },
      data: { name },
    })

    await logServerEvent({
      serverId: category.serverId,
      type: 'category_update',
      actorId: me.id,
      data: { name },
    })

    const members = await db.serverMember.findMany({ where: { serverId: category.serverId }, select: { userId: true } })
    await emitToRooms(
      members.map((m) => userRoom(m.userId)),
      'server:refresh',
      { serverId: category.serverId }
    )

    return NextResponse.json({ category: { id: updated.id, name: updated.name, position: updated.position } })
  } catch {
    return serverError()
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { categoryId } = await params
    const category = await db.channelCategory.findUnique({ where: { id: categoryId } })
    if (!category) return notFound('Category not found.')

    const ctx = await getMemberContext(category.serverId, me.id)
    if (!ctx) return forbidden('You are not a member of this server.')
    if (!hasPerm(ctx.perms, PERM.MANAGE_CHANNELS)) return forbidden('Only moderators with the Manage Channels permission can delete categories.')

    // channels fall back to the uncategorized group
    await db.channelCategory.delete({ where: { id: categoryId } })

    await logServerEvent({
      serverId: category.serverId,
      type: 'category_delete',
      actorId: me.id,
      data: { name: category.name },
    })

    const members = await db.serverMember.findMany({ where: { serverId: category.serverId }, select: { userId: true } })
    await emitToRooms(
      members.map((m) => userRoom(m.userId)),
      'server:refresh',
      { serverId: category.serverId }
    )

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
