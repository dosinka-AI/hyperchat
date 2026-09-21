// WebSocket stability probe: connects through the Caddy gateway (:81)
// and logs exactly when/why the connection drops. Run from project root.
import { io } from 'socket.io-client'

const url = process.argv[2] || 'http://localhost:81/?XTransformPort=3003'
const transport = process.argv[3] || 'websocket'
const durationMs = Number(process.argv[4] || 90000)
const token = process.argv[5] || ''

const socket = io(url, {
  transports: [transport],
  reconnection: false,
  timeout: 10000,
  auth: token ? { token } : undefined,
})

const start = Date.now()
const t = () => `${Math.round((Date.now() - start) / 1000)}s`

socket.on('connect', () => {
  console.log(`[+] connected at ${t()} id=${socket.id}`)
})

socket.io.on('ping', () => console.log(`[ping] ${t()}`))
socket.io.on('pong', (ms) => console.log(`[pong] ${t()} latency=${ms}ms`))

socket.on('disconnect', (reason, details) => {
  console.log(`[-] DISCONNECTED after ${t()} reason=${reason} details=${details?.description ?? ''}`)
  process.exit(0)
})

socket.on('connect_error', (err) => {
  console.log(`[!] connect_error at ${t()}: ${err.message}`)
  process.exit(1)
})

setTimeout(() => {
  console.log(`[OK] STILL CONNECTED after ${Math.round(durationMs / 1000)}s`)
  socket.disconnect()
  process.exit(0)
}, durationMs)
