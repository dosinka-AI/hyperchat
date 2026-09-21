'use client'

/**
 * Client-side preview of the dangerous-file sniff the server runs at upload
 * completion (vaultSafetyWarnings in src/lib/vault.ts): the same filename
 * rules, checked before the send so the uploader sees the amber "careful"
 * chip on the pending attachment. Magic-byte checks stay server-side —
 * file bytes are only trusted once they land.
 *
 * Keep the two suffix lists in sync with vault.ts.
 */

/** Filename suffixes that are programs or scripts on the owner's boxes. */
const DANGEROUS_SUFFIXES = new Set(['exe', 'scr', 'bat', 'cmd', 'com', 'pif', 'vbs', 'js', 'jar', 'apk', 'msi'])
/** Suffixes that read as "plain script" rather than "program". */
const SCRIPT_SUFFIXES = new Set(['vbs', 'js'])
/** Double-extension baits: a safe-looking document/media extension directly
 * before a dangerous one ("invoice.pdf.exe", "photo.jpg.scr"). */
const BAIT_PREFIX_EXTS = new Set([
  'pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'txt', 'doc', 'docx', 'xls',
  'xlsx', 'ppt', 'pptx', 'mp3', 'mp4', 'avi', 'mkv', 'zip', 'csv',
])

/** Same short codes the server stores: 'executable' | 'script' | 'double-extension'. */
export function clientFileWarnings(name: string): string[] {
  const out = new Set<string>()
  const parts = name.toLowerCase().split('.')
  if (parts.length < 2) return []
  const last = parts[parts.length - 1]
  const prev = parts.length >= 3 ? parts[parts.length - 2] : ''
  if (DANGEROUS_SUFFIXES.has(last)) {
    out.add(SCRIPT_SUFFIXES.has(last) ? 'script' : 'executable')
    if (BAIT_PREFIX_EXTS.has(prev)) out.add('double-extension')
  }
  return [...out]
}
