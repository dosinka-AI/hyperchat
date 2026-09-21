// Shared search-query filter parsing (Discord-style tokens).
// Used by BOTH the search API route (authoritative filtering) and the
// search dialog (filter chips + token removal), so the syntax can never
// drift between client and server.

export type SearchQueryParts = {
  /** the free-text needle with every filter token stripped */
  needle: string
  /** from:username - only messages by this author */
  from: string | null
  /** in:channel (or group name) - scope the results */
  in: string | null
  /** has:image | has:link | has:file - content filters (all must match) */
  has: string[]
}

const TOKEN_RE = /(^|\s)(from|in|has):(\S+)/gi

/** Parse a raw search box string into the needle + structured filters.
 *  Unknown has: values are dropped (kept out of the needle so typos do not
 *  silently become search text). */
export function parseSearchQuery(raw: string): SearchQueryParts {
  const found: { from?: string; in?: string; has?: string }[] = []
  const rest = raw.replace(TOKEN_RE, (_all: string, _pre: string, key: string, val: string) => {
    const k = key.toLowerCase()
    if (k === 'from') {
      found.push({ from: val.replace(/^@/, '').toLowerCase() })
    } else if (k === 'in') {
      found.push({ in: val.replace(/^#/, '').toLowerCase() })
    } else {
      const v = val.toLowerCase()
      if (v === 'image' || v === 'link' || v === 'file') found.push({ has: v })
    }
    return ' '
  })
  return {
    needle: rest.replace(/\s+/g, ' ').trim(),
    from: found.find((f) => f.from)?.from ?? null,
    in: found.find((f) => f.in)?.in ?? null,
    has: found.map((f) => f.has).filter((v): v is string => !!v),
  }
}

/** Remove one raw token (e.g. "from:blazar") from a query string, used by
 *  the dialog's filter-chip X buttons. */
export function stripSearchToken(raw: string, token: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|\\s)${escaped}(?=\\s|$)`, 'i')
  return raw.replace(re, ' ').replace(/\s+/g, ' ').trim()
}
