import { db } from '@/lib/db'

export type AuditEventType =
  | 'member_join'
  | 'member_leave'
  | 'member_kick'
  | 'member_ban'
  | 'member_unban'
  | 'member_timeout'
  | 'timeout_clear'
  | 'role_change'
  | 'role_create'
  | 'role_update'
  | 'role_delete'
  | 'role_assign'
  | 'nickname_change'
  | 'channel_create'
  | 'channel_delete'
  | 'channel_update'
  | 'channel_purge'
  | 'message_delete'
  | 'category_create'
  | 'category_update'
  | 'category_delete'
  | 'server_update'

/** Append an entry to a server's audit log. Never throws: the log must not
 *  break the action that produced it. */
export async function logServerEvent(input: {
  serverId: string
  type: AuditEventType
  actorId?: string | null
  targetUserId?: string | null
  data?: Record<string, unknown>
}): Promise<void> {
  try {
    await db.serverEvent.create({
      data: {
        serverId: input.serverId,
        type: input.type,
        actorId: input.actorId ?? null,
        targetUserId: input.targetUserId ?? null,
        data: JSON.stringify(input.data ?? {}),
      },
    })
    // keep the log bounded: drop anything beyond the most recent 200 events
    const count = await db.serverEvent.count({ where: { serverId: input.serverId } })
    if (count > 200) {
      const stale = await db.serverEvent.findMany({
        where: { serverId: input.serverId },
        orderBy: { createdAt: 'desc' },
        skip: 200,
        select: { id: true },
      })
      if (stale.length) {
        await db.serverEvent.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } })
      }
    }
  } catch (err) {
    console.error('[audit] failed to log event:', err instanceof Error ? err.message : err)
  }
}
