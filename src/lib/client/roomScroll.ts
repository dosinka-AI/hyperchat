/** Per-room scroll memory, kept OUT of the zustand store: MessageList
 *  writes on every scroll (a store write per scroll event would churn
 *  subscribers), and jumpToMessage reads it when a reply/permalink jump is
 *  about to move the viewport, so the "return to where you were" pill can
 *  put you back exactly. */

const scrollMemory = new Map<string, number>()

/** Remember where a room's list is currently scrolled to. */
export function rememberRoomScroll(room: string, scrollTop: number): void {
  scrollMemory.set(room, Math.max(0, Math.round(scrollTop)))
}

/** The last known scroll offset of a room (0 when never viewed). */
export function roomScrollOf(room: string): number {
  return scrollMemory.get(room) ?? 0
}
