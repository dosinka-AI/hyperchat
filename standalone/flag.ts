/* Set the standalone flag before any app module evaluates. This must be the
 * first import in entry.tsx: the store reads it at module scope to decide
 * whether the file build skips the landing page. */

export {}

;(window as unknown as { HYPERCHAT_STANDALONE?: boolean }).HYPERCHAT_STANDALONE = true

// the local socket needs to know who is typing / who may see whispers
