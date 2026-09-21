import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { forbidden, notFound, serverError, unauthorized } from '@/lib/realtime'

type Params = { params: Promise<{ listId: string }> }

export async function DELETE(_req: NextRequest, { params }: Params) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const { listId } = await params
    const list = await db.whisperList.findUnique({ where: { id: listId } })
    if (!list) return notFound('No such whisper list.')
    if (list.ownerId !== me.id) return forbidden('That list is not yours.')
    await db.whisperList.delete({ where: { id: listId } })
    return NextResponse.json({ ok: true })
  } catch {
    return serverError()
  }
}
