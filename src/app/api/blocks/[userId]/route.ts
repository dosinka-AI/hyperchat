import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { emitToRooms, userRoom, notFound, serverError, unauthorized } from '@/lib/realtime'

type Params = { params: Promise<{ userId: string }> }

export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()

  try {
    const { userId } = await params
    const existing = await db.userBlock.findUnique({
      where: { blockerId_blockedId: { blockerId: me.id, blockedId: userId } },
    })
    if (!existing) return notFound('That user is not blocked.')

    await db.userBlock.delete({ where: { id: existing.id } })
    await emitToRooms([userRoom(me.id)], 'blocks:update', {})

    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
