/** QA helper: a headless socket.io client that silently joins a call space
 *  (a group-call channel room) as the given user, mimicking the browser
 *  engine's joinCall protocol. Used to hold a call-channel presence alive
 *  while only two browser sessions are allowed on the 4GB box. */

const BASE = 'http://127.0.0.1:81'

async function login(identifier, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  })
  const json = await res.json()
  if (!json.token) throw new Error('login failed: ' + JSON.stringify(json))
  return json.token
}

const identifier = process.argv[2] || 'qacall2'
const password = process.argv[3] || 'qacall2pass'
const spaceId = process.argv[4] // e.g. <convId>~gaming
const participantIds = (process.argv[5] || '').split(',').filter(Boolean)
const holdSeconds = Number(process.argv[6] || 600)

const token = await login(identifier, password)
const { io } = await import('socket.io-client')
const sock = io(`${BASE}/?XTransformPort=3003`, { path: '/', auth: { token }, transports: ['websocket', 'polling'] })
await new Promise((resolve, reject) => {
  sock.once('connect', resolve)
  sock.once('connect_error', (e) => reject(new Error('connect: ' + e.message)))
})
console.log(`[qa-join-space] connected as ${identifier}`)

sock.emit('subscribe', { rooms: [`conversation:${spaceId.split('~')[0]}`, `conversation:${spaceId}`] })
sock.emit('call:start', {
  conversationId: spaceId,
  video: false,
  silent: true,
  group: true,
  profile: { username: identifier },
  participantIds,
})
console.log(`[qa-join-space] silent join emitted for ${spaceId}`)

setTimeout(() => {
  sock.emit('call:hangup', {})
  sock.disconnect()
  console.log('[qa-join-space] released; exiting')
  process.exit(0)
}, holdSeconds * 1000)
