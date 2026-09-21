// Round 27b pure-function verification. Run with: bun scripts/verify-27b.ts
import {
  shouldNotify,
  notificationPreview,
  type NotifyMessage,
  type NotifyPrefs,
} from '../src/lib/client/notifications'
import { parseTableBlock } from '../src/lib/client/table'

let passed = 0
let failed = 0

function ok(name: string, cond: boolean): void {
  if (cond) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`FAIL   ${name}`)
  }
}

function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`FAIL   ${name}\n        got  ${g}\n        want ${w}`)
  }
}

const prefs: NotifyPrefs = { enabled: true, dm: true, mention: true }
const me = 'quasar'

console.log('\nshouldNotify')
ok('dm notifies when unfocused', shouldNotify({ authorId: 'a', content: 'hey', room: 'conversation:1' }, prefs, null, me) === true)
ok('dm silent when its room is focused', shouldNotify({ authorId: 'a', content: 'hey', room: 'conversation:1' }, prefs, 'conversation:1', me) === false)
ok('dm silent when master off', shouldNotify({ authorId: 'a', content: 'hey', room: 'conversation:1' }, { ...prefs, enabled: false }, null, me) === false)
ok('dm silent when dm category off', shouldNotify({ authorId: 'a', content: 'hey', room: 'conversation:1' }, { ...prefs, dm: false }, null, me) === false)
ok('own message never notifies', shouldNotify({ authorId: 'a', content: 'hey', room: 'conversation:1', mine: true }, prefs, null, me) === false)
ok('system row never notifies', shouldNotify({ authorId: 'a', content: null, room: 'conversation:1', systemKind: 'pin' }, prefs, null, me) === false)
ok('mention in a channel notifies', shouldNotify({ authorId: 'a', content: 'hi @quasar!', room: 'channel:9' }, prefs, null, me) === true)
ok('mention silent when its channel is focused', shouldNotify({ authorId: 'a', content: 'hi @quasar!', room: 'channel:9' }, prefs, 'channel:9', me) === false)
ok('mention silent when mention category off', shouldNotify({ authorId: 'a', content: 'hi @quasar!', room: 'channel:9' }, { ...prefs, mention: false }, null, me) === false)
ok('plain channel message does not notify', shouldNotify({ authorId: 'a', content: 'hello world', room: 'channel:9' }, prefs, null, me) === false)
ok('everyone ping notifies when permitted', shouldNotify({ authorId: 'a', content: '@everyone hi', room: 'channel:9', pingsEveryone: true }, prefs, null, me) === true)
ok('everyone ping ignored without permission', shouldNotify({ authorId: 'a', content: '@everyone hi', room: 'channel:9', pingsEveryone: false }, prefs, null, me) === false)
ok('mention match is case-insensitive', shouldNotify({ authorId: 'a', content: 'HI @QUASAR', room: 'channel:9' }, prefs, null, me) === true)
ok('empty room never notifies', shouldNotify({ authorId: 'a', content: 'hi', room: '' }, prefs, null, me) === false)

console.log('\nnotificationPreview')
eq('strips markup tokens', notificationPreview('**bold** and `code` and ||spoil||'), 'bold and code and spoil')
eq('strips rich-text wrappers', notificationPreview('[c=#547cff]blue[/c] text'), 'blue text')
eq('truncates to max with ellipsis', notificationPreview('a'.repeat(200), 100), 'a'.repeat(100) + '...')

console.log('\nparseTableBlock')
eq('valid 2-col', parseTableBlock(['a | b', '--- | ---', '1 | 2']), { header: ['a', 'b'], aligns: ['left', 'left'], rows: [['1', '2']] })
eq(
  'valid 3-col with alignment',
  parseTableBlock(['l | c | r', ':--- | :--: | ---:', 'x | y | z']),
  { header: ['l', 'c', 'r'], aligns: ['left', 'center', 'right'], rows: [['x', 'y', 'z']] }
)
eq('malformed separator is null', parseTableBlock(['a | b', '|--|']), null)
eq(
  'header + separator only renders empty body',
  parseTableBlock(['a | b', '--- | ---']),
  { header: ['a', 'b'], aligns: ['left', 'left'], rows: [] }
)
eq(
  'pipe inside inline code still splits cells',
  parseTableBlock(['a | b', '--- | ---', '`x|y`']),
  { header: ['a', 'b'], aligns: ['left', 'left'], rows: [['`x', 'y`']] }
)
eq('single non-table line is null', parseTableBlock(['just text']), null)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
