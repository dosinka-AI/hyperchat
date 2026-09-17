import type { SessionUser } from '@/lib/types'

/** Local vault of logged-in accounts for the account switcher. The raw
 *  session tokens come from login/register/switch responses; the active
 *  one always lives in the httpOnly cookie, this list is only for picking
 *  between accounts without re-entering passwords. */

export type SavedAccount = {
  id: string
  username: string
  displayName: string | null
  avatarUrl: string | null
  avatarColor: string
  token: string
}

const KEY = 'hyperchat_accounts'
const MAX = 8

function snapshot(user: SessionUser, token: string): SavedAccount {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    avatarColor: user.avatarColor,
    token,
  }
}

export function listAccounts(): SavedAccount[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (a): a is SavedAccount =>
        a && typeof a === 'object' && typeof a.id === 'string' && typeof a.token === 'string'
    )
  } catch {
    return []
  }
}

function write(list: SavedAccount[]): SavedAccount[] {
  if (typeof window === 'undefined') return list
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
  } catch {
    /* private mode etc: the switcher just won't persist */
  }
  return list
}

/** Add or refresh an account in the vault (newest first). */
export function saveAccount(user: SessionUser, token: string): SavedAccount[] {
  const next = [snapshot(user, token), ...listAccounts().filter((a) => a.id !== user.id)]
  return write(next)
}

export function removeAccount(userId: string): SavedAccount[] {
  return write(listAccounts().filter((a) => a.id !== userId))
}
