/** The hidden celebration token and its display form. Server routes and the
 *  client's optimistic echo both swap the token for MARKER_DISPLAY before
 *  the words ever render, so every surface (previews included) reads "???"
 *  while the renderer can still tell the marker apart from a plain ??? the
 *  user typed on purpose: only the marker earns the rainbow. The leading
 *  zero-width space is invisible everywhere and never survives a copy from
 *  the rendered message. */

export const MARKER_TOKEN = ':fniger:'

/** ZWSP + ???, the sentinel that distinguishes the marker from plain ???. */
export const MARKER_DISPLAY = '\u200B???'

/** Case-insensitive token swap for storage and optimistic echoes. */
export function swapMarker(content: string): string {
  if (!content.toLowerCase().includes(MARKER_TOKEN)) return content
  return content.replace(/:fniger:/gi, MARKER_DISPLAY)
}
