import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSessionUser } from '@/lib/auth'
import { badRequest, serverError, unauthorized } from '@/lib/realtime'

/** Saved whisper groups: a named set of people I whisper to often. One
 *  click in the composer's whisper popover re-targets all of them. */

const MAX_LISTS = 20
const MAX_MEMBERS = 8

function toSummary(l: { id: string; name: string; memberIds: string; memberNames: string; createdAt: Date }) {
  return {
    id: l.id,
    name: l.name,
    memberIds: l.memberIds ? l.memberIds.split(',').filter(Boolean) : [],
    memberNames: l.memberNames ? l.memberNames.split(',').filter(Boolean) : [],
    createdAt: l.createdAt.toISOString(),
  }
}

export async function GET(_req: NextRequest) {
  const me = await getSessionUser()
  if (!me) return unauthorized()
  try {
    const lists = await db.whisperList.findMany({
      where: { ownerId: me.id },
      orderBy: { createdAt: 'asc' },
    })
    return NextResponse.json({ lists: lists.map(toSummary) })
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
    const memberIds: string[] = Array.isArray(body.memberIds)
      ? body.memberIds.filter((id: unknown): id is string => typeof id === 'string').slice(0, MAX_MEMBERS)
      : []
    if (name.length < 1 || name.length > 32) {
      return badRequest('List names are 1-32 characters.')
    }
    if (memberIds.length < 1) {
      return badRequest('Pick at least one person for the list.')
    }
    if (memberIds.includes(me.id)) {
      return badRequest('You cannot whisper to yourself.')
    }
    const users = await db.user.findMany({
      where: { id: { in: memberIds } },
      select: { id: true, username: true },
    })
    if (users.length !== memberIds.length) {
      return badRequest('One of those people no longer exists.')
    }
    const count = await db.whisperList.count({ where: { ownerId: me.id } })
    if (count >= MAX_LISTS) {
      return badRequest(`You can only keep ${MAX_LISTS} whisper lists.`)
    }
    const list = await db.whisperList.create({
      data: {
        ownerId: me.id,
        name,
        memberIds: memberIds.join(','),
        memberNames: users.map((u) => u.username).join(','),
      },
    })
    return NextResponse.json({ list: toSummary(list) }, { status: 201 })
  } catch {
    return serverError()
  }
}
