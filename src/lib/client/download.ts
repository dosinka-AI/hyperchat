'use client'

/**
 * Iframe-safe file downloads.
 *
 * The app is often embedded in a sandboxed iframe (preview panels), where the
 * classic blob-object-URL + programmatic `<a download>` click is silently
 * dropped — the user clicks download and nothing happens. This helper runs
 * the blob path in normal top-level windows and falls back to a top-level
 * `window.open(url)` navigation when embedded (or when the blob path throws):
 * the download routes answer with `Content-Disposition: attachment`, so the
 * navigation lands in a save dialog instead of leaving the app.
 */

export type DownloadStatusKind =
  | 'expired' // 410 from the vault route: the file's TTL ran out
  | 'notready' // 409: chunks still landing
  | 'flagged' // 403: blocked by the virus scan
  | 'failed' // network error / non-OK status
  | 'blocked-fallback' // window.open returned null (popup blocker)

/** True when this page is embedded in an iframe. Cross-origin embedding makes
 * reading window.top throw — that throw itself proves we are embedded. */
function embeddedInIframe(): boolean {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}

export async function downloadFile(opts: {
  url: string
  filename: string
  onStatus?: (kind: DownloadStatusKind) => void
}): Promise<void> {
  const { url, filename, onStatus } = opts

  // top-level window: fetch -> blob -> object URL -> a.download click
  if (!embeddedInIframe()) {
    try {
      const res = await fetch(url)
      if (res.status === 410) {
        onStatus?.('expired')
        return
      }
      if (res.status === 409) {
        onStatus?.('notready')
        return
      }
      if (res.status === 403) {
        onStatus?.('flagged')
        return
      }
      if (!res.ok) throw new Error(`download failed (${res.status})`)
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      try {
        const a = document.createElement('a')
        a.href = objectUrl
        a.download = filename
        document.body.appendChild(a)
        a.click()
        a.remove()
      } finally {
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000)
      }
      return
    } catch {
      // fall through to the top-level navigation fallback
    }
  }

  // embedded (or the blob path failed): a top-level navigation — the download
  // routes set Content-Disposition: attachment, so this saves the file
  const win = window.open(url, '_blank')
  if (!win) {
    // popup blocker: the caller tells the user to open the app in a real tab
    onStatus?.('blocked-fallback')
  }
}
