/** Two-client call state machine test against the live sidecar (:81 gateway).
 *  Verifies: start -> ring -> state(ringing) -> accept -> state(active)
 *  -> signal routing -> hangup-by-one (call CONTINUES) -> peer-left
 *  -> last hangup -> call:ended. Plus let-ring leaving the call alive. */

type Evt = Record<string, unknown>

const BASE = 'http://localhost:81'
let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log('  ok -', name) }
  else { fail++; console.log('  FAIL -', name) }
}

async function register(username: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'Calltest1!' }),
  })
  const json = await res.json() as { token?: string; error?: string }
  if (json.token) return json.token
  // exists already? log in
  const lres = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: username, password: 'Calltest1!' }),
  })
  const ljson = await lres.json() as { token?: string }
  if (!ljson.token) throw new Error('no token for ' + username + ': ' + JSON.stringify(json))
  return ljson.token
}

const { io } = await import('socket.io-client')

async function connect(token: string) {
  const sock = io(BASE + '/?XTransformPort=3003', { path: '/', auth: { token }, transports: ['websocket', 'polling'] })
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', resolve)
    sock.once('connect_error', (e: Error) => reject(new Error('connect: ' + e.message)))
  })
  return sock
}

function waitFor(sock: { on: (e: string, cb: (d: never) => void) => void; off?: unknown }, event: string, pred: (d: never) => boolean, ms = 4000): Promise<never> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting ' + event)), ms)
    const handler = (d: never) => {
      if (pred(d)) { clearTimeout(t); sock.off?.(event, handler); resolve(d) }
    }
    sock.on(event, handler)
  })
}

// --- setup ---
const tokenA = await register('qacalla')
const tokenB = await register('qacallb')
const A = await connect(tokenA)
const B = await connect(tokenB)
console.log('both sockets connected')

// find/create DM conversation (userId based)
const search = await (await fetch(`${BASE}/api/users?q=qacallb`, { headers: { cookie: `hyperchat_session=${tokenA}` } })).json() as { users?: { id: string }[] }
const otherId = search.users?.[0]?.id
if (!otherId) throw new Error('user search failed')
const convRes = await fetch(`${BASE}/api/conversations`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `hyperchat_session=${tokenA}` },
  body: JSON.stringify({ userId: otherId }),
})
const convJson = await convRes.json() as { conversationId?: string; conversation?: { id: string } }
const convId = convJson.conversationId ?? convJson.conversation?.id
if (!convId) throw new Error('no conversation: ' + JSON.stringify(convJson))
console.log('conversation', convId)

// subscribe both to the conversation room
A.emit('subscribe', { rooms: [`conversation:${convId}`] })
B.emit('subscribe', { rooms: [`conversation:${convId}`] })
await new Promise((r) => setTimeout(r, 300))

// --- 1: start -> both receive ring + ringing state ---
A.emit('call:start', { conversationId: convId, video: false, profile: { displayName: 'caller a' } })
const ringB = await waitFor(B, 'call:ring', (d: Record<string, unknown>) => (d as { conversationId?: string }).conversationId === convId)
check('callee receives call:ring', ringB.conversationId === convId)
const stateRing = await waitFor(B, 'call:state', (d: Record<string, unknown>) => (d as { conversationId?: string }).conversationId === convId && (d as { state?: string }).state === 'ringing')
check('state=ringing broadcast', stateRing.state === 'ringing' && Array.isArray(stateRing.participants) && (stateRing.participants as unknown[]).length === 1)

// --- 2: accept -> active state, call:accepted ---
B.emit('call:accept', { callId: (ringB as { callId?: string }).callId })
const accepted = await waitFor(A, 'call:accepted', (d: Record<string, unknown>) => typeof d.callId === 'string')
check('caller sees call:accepted', !!accepted.callId)
const stateActive = await waitFor(A, 'call:state', (d: Record<string, unknown>) => (d as { state?: string }).state === 'active' && Array.isArray((d as { participants?: unknown[] }).participants) && ((d as { participants?: unknown[] }).participants as unknown[]).length === 2)
check('state=active with 2 participants', stateActive.state === 'active')

// --- 3: signaling relay routes only between participants ---
B.emit('call:signal', { callId: (ringB as { callId?: string }).callId, to: 'nobody', data: { type: 'ice', candidate: { candidate: 'x' } } })
const sig = await waitFor(A, 'call:signal', () => true, 1500).catch(() => null)
check('signal relay gated by participants', sig === null)

// --- 4: B hangs up -> call CONTINUES with A ---
B.emit('call:hangup', { callId: stateActive.callId as string })
const leftA = await waitFor(A, 'call:peer-left', (d: Record<string, unknown>) => typeof d.callId === 'string')
check('caller told peer-left', !!leftA.callId)
const stateAfterLeave = await waitFor(A, 'call:state', (d: Record<string, unknown>) => (d as { participants?: unknown[] }).participants !== undefined && ((d as { participants?: unknown[] }).participants as unknown[]).length === 1 && (d as { state?: string }).state === 'active')
check('call still active with 1 participant after hangup', stateAfterLeave.state === 'active')
let endedEarly = false
A.on('call:ended', () => { endedEarly = true })
await new Promise((r) => setTimeout(r, 500))
check('no call:ended after individual hangup', !endedEarly)

// --- 5: A hangs up (last participant) -> call:ended ---
A.emit('call:hangup', { callId: stateActive.callId as string })
await waitFor(A, 'call:ended', (d: Record<string, unknown>) => typeof d.callId === 'string')
check('call:ended when the last participant leaves', true)

// --- 6: let-ring -> call stays alive for the caller ---
A.emit('call:start', { conversationId: convId, video: false })
const ring2 = await waitFor(B, 'call:ring', (d: Record<string, unknown>) => (d as { conversationId?: string }).conversationId === convId)
B.emit('call:let-ring', { callId: (ring2 as { callId?: string }).callId })
await new Promise((r) => setTimeout(r, 400))
// caller-side: no ended, no declined
let declinedSeen = false
A.on('call:declined', () => { declinedSeen = true })
await new Promise((r) => setTimeout(r, 400))
check('let-ring keeps the call alive (no decline broadcast)', !declinedSeen)
A.emit('call:cancel', { callId: (ring2 as { callId?: string }).callId })
await waitFor(A, 'call:ended', (d: Record<string, unknown>) => typeof d.callId === 'string')
check('caller cancel ends the call', true)

// --- 7: media-state propagation (the stop-share contract) ---
A.emit('call:start', { conversationId: convId, video: true })
const ring3 = await waitFor(B, 'call:ring', (d: Record<string, unknown>) => (d as { conversationId?: string }).conversationId === convId)
B.emit('call:accept', { callId: (ring3 as { callId?: string }).callId })
await waitFor(A, 'call:state', (d: Record<string, unknown>) => (d as { state?: string }).state === 'active')
A.emit('call:media-state', { callId: (ring3 as { callId?: string }).callId, screen: true })
const screenState = await waitFor(B, 'call:state', (d: Record<string, unknown>) => {
  const p = (d as { participants?: { userId?: string; screen?: boolean }[] }).participants
  return Array.isArray(p) && p.some((x) => x.userId && x.screen === true)
})
check('screen flag propagates to the receiver state', !!screenState)
A.emit('call:media-state', { callId: (ring3 as { callId?: string }).callId, screen: false })
const screenOff = await waitFor(B, 'call:state', (d: Record<string, unknown>) => {
  const p = (d as { participants?: { userId?: string; screen?: boolean }[] }).participants
  return Array.isArray(p) && p.every((x) => !x.screen)
})
check('screen-off flag propagates (receiver detaches, no freeze)', !!screenOff)
A.emit('call:hangup', { callId: (ring3 as { callId?: string }).callId })
// B is still in the call: it must survive A's departure
const survived = await waitFor(B, 'call:state', (d: Record<string, unknown>) => {
  const p = (d as { participants?: unknown[] }).participants
  return Array.isArray(p) && p.length === 1
})
check('call survives when the screen-sharer hangs up first', Array.isArray((survived as { participants?: unknown[] }).participants))
B.emit('call:hangup', { callId: (ring3 as { callId?: string }).callId })
await waitFor(B, 'call:ended', (d: Record<string, unknown>) => typeof d.callId === 'string')
check('final hangup ends the call', true)

A.disconnect()
B.disconnect()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
