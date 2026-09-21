/**
 * Shared ICE server list for both WebRTC engines (voice rooms + calls).
 *
 * Defaults to dual STUN (Google x2 + Cloudflare, so one blocked provider
 * cannot strand peers on unroutable host candidates). Deployments behind
 * symmetric NATs - where STUN alone cannot punch through and calls silently
 * carry no audio - can add a TURN relay with three build-time env vars:
 *
 *   NEXT_PUBLIC_TURN_URL       e.g. turn:turn.example.com:3478
 *                              (comma-separated for multiple servers)
 *   NEXT_PUBLIC_TURN_USERNAME  the REST/long-term username
 *   NEXT_PUBLIC_TURN_CREDENTIAL  the matching credential
 *
 * With a URL but no username the server is added as an open-relay entry.
 * See DEPLOY.md ("honest limits") for running coturn.
 */

const STUN: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

function buildIceServers(): RTCIceServer[] {
  const rawUrl = process.env.NEXT_PUBLIC_TURN_URL?.trim()
  if (!rawUrl) return STUN
  const username = process.env.NEXT_PUBLIC_TURN_USERNAME?.trim()
  const credential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL
  const turn: RTCIceServer[] = rawUrl
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
    .map((urls) =>
      username
        ? { urls, username, credential: credential ?? '' }
        : { urls }
    )
  return [...turn, ...STUN]
}

/** Evaluated once per module load (env vars are inlined at build time). */
export const ICE_SERVERS: RTCIceServer[] = buildIceServers()
