// Reproduce pin + reaction bugs reported by the user
const BASE = 'http://localhost:3000'

async function j(method, path, body, cookie) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data, cookie: res.headers.get('set-cookie') }
}

const uniq = Date.now().toString(36)
const user = { username: `pinprobe${uniq}`, email: `pinprobe${uniq}@t.local`, password: 'testpassword123', displayName: 'Pin Probe' }

// register + create server
const reg = await j('POST', '/api/auth/register', user)
const cookie = reg.cookie?.split(';')[0]
console.log('register:', reg.status)

const sv = await j('POST', '/api/servers', { name: 'Pin Probe Server' }, cookie)
console.log('create server:', sv.status, sv.data?.server?.id)
const serverId = sv.data?.server?.id ?? sv.data?.id
const svDetail = await j('GET', `/api/servers/${serverId}`, null, cookie)
const channel = (svDetail.data?.channels ?? svDetail.data?.server?.channels ?? [])[0]
console.log('channel:', channel?.id, channel?.name, 'myPerms:', svDetail.data?.myPerms)

// send a message
const msg = await j('POST', `/api/channels/${channel.id}/messages`, { content: 'pin me' }, cookie)
console.log('send message:', msg.status, msg.data?.message?.id ?? msg.data?.id)
const messageId = msg.data?.message?.id ?? msg.data?.id

// PIN as server owner
const pin = await j('POST', `/api/messages/${messageId}/pin`, {}, cookie)
console.log('PIN:', pin.status, JSON.stringify(pin.data).slice(0, 200))

// UNPIN
const unpin = await j('DELETE', `/api/messages/${messageId}/pin`, null, cookie)
console.log('UNPIN:', unpin.status, JSON.stringify(unpin.data).slice(0, 120))

// pins list
const pins = await j('GET', `/api/channels/${channel.id}/pins`, null, cookie)
console.log('pins list:', pins.status, JSON.stringify(pins.data).slice(0, 150))

// reactions: allowed emoji
const r1 = await j('POST', `/api/messages/${messageId}/reactions`, { emoji: '🔥' }, cookie)
console.log('reaction 🔥 (allowlisted):', r1.status)

// reactions: emoji from picker but OUTSIDE the 8-allowlist
const r2 = await j('POST', `/api/messages/${messageId}/reactions`, { emoji: '🚀' }, cookie)
console.log('reaction 🚀 (picker emoji, not allowlisted):', r2.status, JSON.stringify(r2.data).slice(0, 150))

const r3 = await j('POST', `/api/messages/${messageId}/reactions`, { emoji: '😄' }, cookie)
console.log('reaction 😄 (picker emoji, not allowlisted):', r3.status, JSON.stringify(r3.data).slice(0, 150))

// toggle-off the same reaction twice quickly (race check)
const r4 = await j('POST', `/api/messages/${messageId}/reactions`, { emoji: '🔥' }, cookie)
console.log('toggle off 🔥:', r4.status)
const r5 = await j('POST', `/api/messages/${messageId}/reactions`, { emoji: '🔥' }, cookie)
console.log('toggle on 🔥 again:', r5.status)
