import { io } from 'socket.io-client'

const BASE = 'http://localhost:3000'

async function login(identifier) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password: 'password123' }),
  })
  const setCookie = res.headers.get('set-cookie') || ''
  const token = setCookie.split(';')[0]
  const data = await res.json()
  return { token, user: data.user }
}

const { token, user } = await login('apitest')
console.log('logged in as', user.username)

const socket = io('http://localhost:3003', {
  path: '/',
  transports: ['websocket'],
  extraHeaders: { cookie: token },
  reconnection: false,
  timeout: 5000,
})

const timeout = setTimeout(() => {
  console.error('TEST TIMEOUT')
  process.exit(1)
}, 15000)

socket.on('connect', () => {
  console.log('socket connected, id:', socket.id)
  socket.emit('subscribe', { rooms: ['channel:cmtxfwxa10003mcxe8t2c3fvn'] })
  console.log('subscribed to test channel')
})

socket.on('message:new', (msg) => {
  if (msg.content !== 'realtime pipeline test') return
  console.log('RECEIVED message:new:', msg.author.username, '->', msg.content)
})

// second socket as apitest2 subscribes; typing from apitest must reach it
const { token: token2 } = await login('apitest2')
const socket2 = io('http://localhost:3003', {
  path: '/',
  transports: ['websocket'],
  extraHeaders: { cookie: token2 },
  reconnection: false,
  timeout: 5000,
})

socket2.on('connect', () => {
  console.log('socket2 connected (apitest2)')
  socket2.emit('subscribe', { rooms: ['channel:cmtxfwxa10003mcxe8t2c3fvn'] })
  setTimeout(async () => {
    // post a message through the HTTP API as apitest2
    await fetch(`${BASE}/api/channels/cmtxfwxa10003mcxe8t2c3fvn/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: token2 },
      body: JSON.stringify({ content: 'realtime pipeline test' }),
    })
    console.log('posted message via HTTP as apitest2')
    setTimeout(() => {
      console.log('apitest emits typing:start')
      socket.emit('typing:start', { room: 'channel:cmtxfwxa10003mcxe8t2c3fvn' })
    }, 300)
  }, 300)
})

socket2.on('typing', (data) => {
  if (data.typing) {
    console.log('socket2 RECEIVED typing event from', data.username)
    clearTimeout(timeout)
    console.log('ALL REALTIME TESTS PASSED')
    socket.disconnect()
    socket2.disconnect()
    process.exit(0)
  }
})

socket.on('connect_error', (err) => {
  console.error('connect_error:', err.message)
  process.exit(1)
})
