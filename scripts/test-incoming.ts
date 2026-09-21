/** qacalla calls qa28x through the gateway; holds the call open for the
 *  browser-side incoming-screen test, reporting everything it hears. */
const BASE = 'http://localhost:81'
const res = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ identifier: 'qacalla', password: 'Calltest1!' }),
})
const { token } = await res.json() as { token: string }
const { io } = await import('socket.io-client')
const sock = io(BASE + '/?XTransformPort=3003', { path: '/', auth: { token }, transports: ['websocket', 'polling'] })
await new Promise<void>((resolve, reject) => {
  sock.once('connect', resolve)
  sock.once('connect_error', (e: Error) => reject(new Error(e.message)))
})
const search = await (await fetch(`${BASE}/api/users?q=qa28x`, { headers: { cookie: `hyperchat_session=${token}` } })).json() as { users?: { id: string }[] }
const convRes = await fetch(`${BASE}/api/conversations`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: `hyperchat_session=${token}` },
  body: JSON.stringify({ userId: search.users?.[0]?.id }),
})
const conv = await convRes.json() as { conversationId?: string }
const convId = conv.conversationId!
sock.emit('subscribe', { rooms: [`conversation:${convId}`] })
await new Promise((r) => setTimeout(r, 400))
const meSearch = await (await fetch(`${BASE}/api/auth/me`, { headers: { cookie: `hyperchat_session=${token}` } })).json() as { user?: { id: string } }
const meId = meSearch.user?.id
sock.emit('call:start', { conversationId: convId, video: false, profile: { displayName: 'caller a' }, participantIds: [search.users?.[0]?.id].filter(Boolean) as string[] })
console.log('RINGING qa28x in', convId)
for (const ev of ['call:accepted', 'call:declined', 'call:state', 'call:ended', 'message:new']) {
  sock.on(ev, (d: Record<string, unknown>) => {
    console.log('EVENT', ev, JSON.stringify(d).slice(0, 160))
  })
}
setTimeout(() => { sock.disconnect(); process.exit(0) }, 45000)
