/**
 * API integration test for the HyperChat moderation system.
 * Two users, one server; exercises roles, permissions, slowmode, lock,
 * private channels, automod, timeouts, purge and @everyone gating.
 */
const BASE = 'http://localhost:3000'

function makeClient() {
  let cookie = ''
  return {
    async call(method, path, body) {
      const res = await fetch(BASE + path, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const setCookie = res.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]
      let data = null
      try {
        data = await res.json()
      } catch {}
      return { status: res.status, data }
    },
  }
}

const t1 = makeClient() // server owner
const t2 = makeClient() // regular member -> role holder

function assert(cond, label) {
  if (cond) console.log(`  ok: ${label}`)
  else {
    console.error(`  FAIL: ${label}`)
    process.exitCode = 1
  }
}

const rnd = Math.floor(Math.random() * 100000)
async function main() {
  console.log('register users')
  const u1 = await t1.call('POST', '/api/auth/register', {
    username: `moda${rnd}`,
    email: `moda${rnd}@test.local`,
    password: 'password123',
  })
  const u2 = await t2.call('POST', '/api/auth/register', {
    username: `modb${rnd}`,
    email: `modb${rnd}@test.local`,
    password: 'password123',
  })
  assert(u1.status === 201 && u2.status === 201, 'both registered')
  const u1id = u1.data.user.id
  const u2id = u2.data.user.id

  console.log('create server')
  const srv = await t1.call('POST', '/api/servers', { name: 'Mod Test' })
  assert(srv.status === 201, 'server created')
  const serverId = srv.data.server.id
  assert(srv.data.server.myPerms !== undefined && srv.data.server.myPerms !== 0, 'owner has myPerms bits')

  const invite = srv.data.server.inviteCode
  const joined = await t2.call('POST', '/api/servers/join', { inviteCode: invite })
  assert(joined.status === 201 && joined.data.server.myPerms === 0, 'member joins with zero perms')

  console.log('create channel + messages')
  const ch = await t1.call('POST', `/api/servers/${serverId}/channels`, { name: 'general' })
  assert(ch.status === 400 || ch.status === 201, 'channel create call handled') // general exists already
  const servers1 = await t1.call('GET', '/api/servers')
  const channelId = servers1.data.servers.find((s) => s.id === serverId).channels[0].id

  const m1 = await t2.call('POST', `/api/channels/${channelId}/messages`, { content: 'hello from member' })
  assert(m1.status === 201, 'member can send')

  console.log('member cannot use mod endpoints')
  const badChannel = await t2.call('PATCH', `/api/channels/${channelId}`, { slowmodeSeconds: 5 })
  assert(badChannel.status === 403, 'member cannot set slowmode')
  const badPurge = await t2.call('POST', `/api/channels/${channelId}/purge`, { count: 5 })
  assert(badPurge.status === 403, 'member cannot purge')
  const badKick = await t2.call('DELETE', `/api/servers/${serverId}/members/${u1id}`)
  assert(badKick.status === 403 || badKick.status === 400, 'member cannot kick owner')

  console.log('roles: create, assign, verify')
  const role = await t1.call('POST', `/api/servers/${serverId}/roles`, {
    name: 'Moderator',
    color: '#547cff',
    permissions: 128 + 64 + 256, // MANAGE_MESSAGES + TIMEOUT_MEMBERS + MENTION_EVERYONE
  })
  assert(role.status === 201, 'role created')
  const roleId = role.data.role.id

  const assign = await t1.call('PATCH', `/api/servers/${serverId}/members/${u2id}`, { roleId })
  assert(assign.status === 200, 'role assigned')

  const detail2 = await t2.call('GET', `/api/servers/${serverId}`)
  assert(detail2.status === 200 && detail2.data.myPerms === 128 + 64 + 256, 'role holder sees exact perms')
  assert(
    detail2.data.members.some((m) => m.id === u2id && m.roleName === 'Moderator'),
    'member summary carries role name'
  )

  console.log('role holder: timeout + delete others + mention everyone')
  const everyone = await t2.call('POST', `/api/channels/${channelId}/messages`, { content: 'ping @everyone now' })
  assert(everyone.status === 201 && everyone.data.message.pingsEveryone === true, '@everyone ping recorded with perm')

  const delOther = await t2.call('DELETE', `/api/messages/${m1.data.message.id}`)
  assert(delOther.status === 200, 'role holder deletes another member message')

  console.log('slowmode + lock (plain member t3 is the victim)')
  const t3a = makeClient()
  await t3a.call('POST', '/api/auth/register', {
    username: `modc${rnd}`,
    email: `modc${rnd}@test.local`,
    password: 'password123',
  })
  const joined3 = await t3a.call('POST', '/api/servers/join', { inviteCode: invite })
  assert(joined3.status === 201, 'third member joined')
  const t3id = joined3.data.user?.id ?? null

  const slow = await t1.call('PATCH', `/api/channels/${channelId}`, { slowmodeSeconds: 5 })
  assert(slow.status === 200 && slow.data.channel.slowmodeSeconds === 5, 'slowmode set')

  const s1 = await t3a.call('POST', `/api/channels/${channelId}/messages`, { content: 'first' })
  assert(s1.status === 201, 'first message passes')
  const s2 = await t3a.call('POST', `/api/channels/${channelId}/messages`, { content: 'second' })
  assert(s2.status === 429, 'slowmode blocks the immediate second (429)')
  const s1owner = await t1.call('POST', `/api/channels/${channelId}/messages`, { content: 'owner bypass' })
  assert(s1owner.status === 201, 'owner bypasses slowmode')

  const lock = await t1.call('PATCH', `/api/channels/${channelId}`, { locked: true })
  assert(lock.status === 200 && lock.data.channel.locked === true, 'channel locked')
  const s3 = await t2.call('POST', `/api/channels/${channelId}/messages`, { content: 'still mod' })
  assert(s3.status === 201, 'mod posts through the lock')
  const s4 = await t3a.call('POST', `/api/channels/${channelId}/messages`, { content: 'member locked out' })
  assert(s4.status === 403, 'plain member blocked by the lock')
  await t1.call('PATCH', `/api/channels/${channelId}`, { locked: false, slowmodeSeconds: 0 })

  console.log('automod')
  const words = await t1.call('PATCH', `/api/servers/${serverId}`, { blockedWords: 'scam\nfree money' })
  assert(words.status === 200, 'automod words saved')
  const bad = await t2.call('POST', `/api/channels/${channelId}/messages`, { content: 'this is a total Scam everyone' })
  assert(bad.status === 400 && /automod/i.test(bad.data.error || ''), 'automod rejects blocked word (case-insensitive)')
  const ok = await t2.call('POST', `/api/channels/${channelId}/messages`, { content: 'perfectly fine' })
  assert(ok.status === 201, 'clean message passes automod')

  console.log('nickname')
  const nick = await t2.call('PATCH', `/api/servers/${serverId}/members/${u2id}`, { nickname: 'Moddy' })
  assert(nick.status === 200, 'self nickname set')
  const nickOther = await t2.call('PATCH', `/api/servers/${serverId}/members/${u1id}`, { nickname: 'Hacked' })
  assert(nickOther.status === 400 || nickOther.status === 403, 'nickname on owner denied')

  console.log('private channel')
  const priv = await t1.call('POST', `/api/servers/${serverId}/channels`, { name: 'staff-room' })
  assert(priv.status === 201, 'private-capable channel created')
  const privId = priv.data.channel.id
  const setPriv = await t1.call('PATCH', `/api/channels/${privId}`, { private: true, accessRoleIds: [roleId] })
  assert(setPriv.status === 200 && setPriv.data.channel.private === true, 'channel made private with role access')

  const t2servers = await t2.call('GET', '/api/servers')
  const t2srv = t2servers.data.servers.find((s) => s.id === serverId)
  assert(t2srv.channels.some((c) => c.id === privId), 'role holder sees the private channel')

  const post3 = await t2.call('POST', `/api/channels/${privId}/messages`, { content: 'staff only' })
  assert(post3.status === 201, 'role holder posts in private channel')

  // a third user without the role must NOT see or post
  const t3servers = await t3a.call('GET', '/api/servers')
  const t3srv = t3servers.data.servers.find((s) => s.id === serverId)
  assert(!t3srv.channels.some((c) => c.id === privId), 'plain member cannot see the private channel')
  const t3post = await t3a.call('POST', `/api/channels/${privId}/messages`, { content: 'sneak' })
  assert(t3post.status === 403, 'plain member cannot post in the private channel')

  console.log('timeout')
  const detailT1 = await t1.call('GET', `/api/servers/${serverId}`)
  const t3member = detailT1.data.members.find((m) => m.username === `modc${rnd}`)
  const to = await t2.call('PATCH', `/api/servers/${serverId}/members/${t3member.id}`, { timeoutMinutes: 1 })
  assert(to.status === 200, 'mod sets a 1m timeout')
  const t3msg = await t3a.call('POST', `/api/channels/${channelId}/messages`, { content: 'am I muted?' })
  assert(t3msg.status === 403 && /timed out/i.test(t3msg.data.error || ''), 'timed-out member blocked with message')
  const clear = await t2.call('PATCH', `/api/servers/${serverId}/members/${t3member.id}`, { timeoutMinutes: null })
  assert(clear.status === 200, 'timeout cleared')

  console.log('purge')
  await t1.call('POST', `/api/channels/${channelId}/messages`, { content: 'bulk one' })
  await t1.call('POST', `/api/channels/${channelId}/messages`, { content: 'bulk two' })
  await t1.call('POST', `/api/channels/${channelId}/messages`, { content: 'bulk three' })
  const purge = await t1.call('POST', `/api/channels/${channelId}/purge`, { count: 2 })
  assert(purge.status === 200 && purge.data.deleted === 2, 'purged exactly 2 newest')
  const after = await t1.call('GET', `/api/channels/${channelId}/messages`)
  const contents = after.data.messages.map((m) => m.content)
  assert(!contents.includes('bulk two') && !contents.includes('bulk three'), 'purged messages gone from history')

  console.log('role cleanup: delete role strips access')
  const delRole = await t1.call('DELETE', `/api/servers/${serverId}/roles/${roleId}`)
  assert(delRole.status === 200, 'role deleted')
  const t2servers2 = await t2.call('GET', '/api/servers')
  const t2srv2 = t2servers2.data.servers.find((s) => s.id === serverId)
  assert(!t2srv2.channels.some((c) => c.id === privId), 'private channel vanished with the role')
  assert(t2srv2.myPerms === 0, 'perms fell back to zero')

  console.log('audit log')
  const events = await t1.call('GET', `/api/servers/${serverId}/events`)
  assert(events.status === 200, 'audit log readable')
  const types = events.data.events.map((e) => e.type)
  assert(types.includes('role_create') && types.includes('member_timeout') && types.includes('channel_purge'), 'audit log has the new event types')

  console.log('nickname shows in messages')
  const nm = await t1.call('GET', `/api/channels/${channelId}/messages`)
  const nickMsg = nm.data.messages.find((m) => m.authorId === u2id && m.content === 'perfectly fine')
  assert(nickMsg && nickMsg.authorNickname === 'Moddy', 'message carries authorNickname')

  console.log('done')
}

main().catch((err) => {
  console.error('script crashed:', err)
  process.exitCode = 1
})
