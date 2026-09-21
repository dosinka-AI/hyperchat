// Round 26 cleanup: only throwaway users created for this round's QA.
// Guards: usernames must match ^qa26[a-z0-9]+$; real users must survive;
// conversations only when EVERY participant is a throwaway.
import { Database } from 'bun:sqlite'

const db = new Database('/home/z/my-project/db/custom.db')
const REAL = ['blazar', 'kkkkwwwaaaa', 'quasar', 'autobot']
const RE = /^qa26[a-z0-9]+$/

const before = (db.query('SELECT username FROM User').all() as { username: string }[]).map(u => u.username)
const targets = before.filter(u => RE.test(u))
console.log('users before:', before.length, '| targets:', targets.join(', '))
if (targets.some(u => REAL.includes(u))) throw new Error('GUARD FAIL: target overlaps real user')

// servers owned by throwaways (cascade members/channels/messages/join logs)
const servers = db.query('SELECT id, name FROM Server WHERE ownerId IN (SELECT id FROM User WHERE username IN (' + targets.map(() => '?').join(',') + '))').all(...targets) as { id: string; name: string }[]
console.log('servers to drop:', servers.map(s => s.name).join(', ') || 'none')

// conversations where EVERY participant is a throwaway
const convos = db.query(`
  SELECT c.id FROM Conversation c
  WHERE NOT EXISTS (
    SELECT 1 FROM ConversationParticipant p JOIN User u ON u.id = p.userId
    WHERE p.conversationId = c.id AND u.username NOT IN (${targets.map(() => '?').join(',') || "''"})
  ) AND EXISTS (
    SELECT 1 FROM ConversationParticipant p JOIN User u ON u.id = p.userId
    WHERE p.conversationId = c.id AND u.username IN (${targets.map(() => '?').join(',') || "''"})
  )
`).all(...targets, ...targets) as { id: string }[]
console.log('conversations to drop:', convos.length)

for (const s of servers) db.run('DELETE FROM Server WHERE id = ?', [s.id])
for (const c of convos) db.run('DELETE FROM Conversation WHERE id = ?', [c.id])
// messages authored by throwaways in rooms that survive (DMs already gone; servers gone)
db.run('DELETE FROM Message WHERE authorId IN (SELECT id FROM User WHERE username IN (' + targets.map(() => '?').join(',') + '))', ...targets)
db.run('DELETE FROM EmailCode WHERE email LIKE ?', ['qa26%'])
db.run('DELETE FROM User WHERE username IN (' + targets.map(() => '?').join(',') + ')', ...targets)

const after = (db.query('SELECT username FROM User').all() as { username: string }[]).map(u => u.username)
console.log('users after:', after.join(', '))
const missing = REAL.filter(u => !after.includes(u))
if (missing.length) throw new Error('GUARD FAIL: real users missing: ' + missing.join(', '))
console.log('OK: all real users intact; join logs now:', (db.query('SELECT COUNT(*) c FROM ServerJoinLog').get() as { c: number }).c)
