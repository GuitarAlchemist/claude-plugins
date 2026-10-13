import { expect, test } from 'claude-code/testing'

import {
  addMember,
  canModelSend,
  createGroup,
  editorIsEmpty,
  groupsOf,
  isEveryone,
  isMember,
  matches,
  panesToType,
  parseCommand,
  parseListAgents,
  parsePanes,
  parseRegistry,
  passingGroup,
  recipients,
  removeMember,
  serializeRegistry,
  setPolicy,
  tagged,
  typedPost,
  typedReport,
  untag,
} from './groups'
import type { Registry } from './groups'

// The pure half of working groups: no engine involved.

const REGISTRY: Registry = parseRegistry(
  JSON.stringify({
    version: 1,
    groups: [
      { id: 'ga', kind: 'working-group', title: 'Guitar Alchemist', members: ['ga-*', 'learn-vx'], policy: 'pass' },
      { id: 'ga/chatbot', members: ['music-*'] },
      { id: 'rust-practice', kind: 'community', members: ['learn-*'] },
      { id: 'Bad Id', members: ['x'] },
    ],
  }),
).registry

const LIST = [
  'This session is learn-vx [8c1fa6] — the name other sessions use to message it.',
  '',
  'Peer sessions (4):',
  '  ga-36 [3fede8]  ·  interactive  ·  busy  ·  started 1d ago',
  '  music-7c [0b7f5b]  ·  interactive  ·  idle  ·  started 1d ago',
  '  learn-17 [5e7e1c]  ·  interactive  ·  busy  ·  started 1d ago',
  '  music-7c [99aa00]  ·  interactive  ·  busy  ·  started 2h ago',
].join('\n')

test('the registry keeps valid groups, infers a sub-group from its path and defaults to hold', () => {
  expect(REGISTRY.groups.map(g => g.id)).toEqual(['ga', 'ga/chatbot', 'rust-practice'])
  expect(REGISTRY.groups[1]).toEqual({ id: 'ga/chatbot', kind: 'sub-group', title: '', members: ['music-*'], policy: 'hold' })
  expect(parseRegistry('{oops').error).toContain('not JSON')
  expect(parseRegistry('{"groups": 3}').error).toBe('no "groups" array')
  expect(parseRegistry('').error).toBe('')
})

test('members are exact names or * patterns, and a sub-group\'s members belong to its parent', () => {
  expect(matches('ga-*', 'GA-36')).toBe(true)
  expect(matches('ga-*', 'gaia-bb')).toBe(false)
  expect(matches('learn-vx', 'learn-vx2')).toBe(false)
  expect(isMember(REGISTRY, 'ga', 'music-7c')).toBe(true) // through ga/chatbot
  expect(isMember(REGISTRY, 'ga/chatbot', 'ga-36')).toBe(false)
  expect(groupsOf(REGISTRY, 'learn-vx')).toEqual(['ga', 'rust-practice'])
  expect(groupsOf(REGISTRY, 'music-7c')).toEqual(['ga', 'ga/chatbot'])
})

test('a pass policy needs both ends to be members, whatever the tag says', () => {
  expect(passingGroup(REGISTRY, 'ga-36', 'learn-vx', '')).toBe('ga')
  expect(passingGroup(REGISTRY, 'ga-36', 'learn-vx', 'ga')).toBe('ga')
  expect(passingGroup(REGISTRY, 'tars-60', 'learn-vx', 'ga')).toBe('')
  expect(passingGroup(REGISTRY, 'learn-17', 'learn-vx', 'rust-practice')).toBe('') // a hold group
  expect(passingGroup(REGISTRY, 'ga-36', '', 'ga')).toBe('')
})

test('ListAgents rows give peers; recipients leave this session out and spell shared names with the ref', () => {
  const { self, peers } = parseListAgents(LIST)
  expect(self).toBe('learn-vx')
  expect(peers.map(p => p.name)).toEqual(['ga-36', 'music-7c', 'learn-17', 'music-7c'])
  expect(peers[1]?.state).toBe('idle')
  expect(recipients(REGISTRY, 'ga', peers, self)).toEqual([
    { name: 'ga-36', address: 'ga-36' },
    { name: 'music-7c', address: 'music-7c [0b7f5b]' },
    { name: 'music-7c', address: 'music-7c [99aa00]' },
  ])
})

test('the group tag goes on and comes off', () => {
  expect(tagged('ga/chatbot', '  hello ')).toBe('[group ga/chatbot] hello')
  expect(untag('[group GA] hello\nworld')).toEqual({ group: 'ga', body: 'hello\nworld' })
  expect(untag('no tag')).toEqual({ group: '', body: 'no tag' })
})

test('create, join, leave and policy change a copy and say what they did', () => {
  const made = createGroup({ version: 1, groups: [] }, 'ga/chatbot', '', 'Chatbot')
  if ('error' in made) throw new Error(made.error)
  expect(made.note).toBe('Created sub-group ga/chatbot (its parent ga does not exist yet)')
  expect('error' in createGroup(made.registry, 'ga/chatbot', '', '')).toBe(true)
  expect('error' in createGroup(made.registry, 'Not valid', '', '')).toBe(true)
  expect('error' in createGroup(made.registry, 'x', 'club', '')).toBe(true)

  const joined = addMember(made.registry, 'ga/chatbot', 'music-*')
  if ('error' in joined) throw new Error(joined.error)
  expect(joined.registry.groups[0]?.members).toEqual(['music-*'])
  expect(removeMember(joined.registry, 'ga/chatbot', 'music-7c')).toEqual({ error: 'music-7c is in ga/chatbot through music-*: leave with that pattern' })
  const left = removeMember(joined.registry, 'ga/chatbot', 'MUSIC-*')
  expect('error' in left ? left.error : left.registry.groups[0]?.members).toEqual([])
  const passing = setPolicy(joined.registry, 'ga/chatbot', 'pass')
  expect('error' in passing ? passing.error : passing.registry.groups[0]?.policy).toBe('pass')
  expect(setPolicy(joined.registry, 'nope', 'pass')).toEqual({ error: 'no group nope (/inbox groups lists them)' })
  expect(parseRegistry(serializeRegistry(joined.registry)).registry).toEqual(joined.registry)
})

test('/inbox arguments', () => {
  expect(parseCommand('')).toEqual({ kind: 'open' })
  expect(parseCommand('PASS')).toEqual({ kind: 'mode', mode: 'pass' })
  expect(parseCommand('send ga  hello  there')).toEqual({ kind: 'send', group: 'ga', text: 'hello  there' })
  expect(parseCommand('send ga')).toEqual({ kind: 'usage' })
  expect(parseCommand('group create rust community Rust practice')).toEqual({ kind: 'create', group: 'rust', groupKind: 'community', title: 'Rust practice' })
  expect(parseCommand('group create ga Guitar Alchemist')).toEqual({ kind: 'create', group: 'ga', groupKind: '', title: 'Guitar Alchemist' })
  expect(parseCommand('group join ga')).toEqual({ kind: 'join', group: 'ga', member: '' })
  expect(parseCommand('group leave ga music-*')).toEqual({ kind: 'leave', group: 'ga', member: 'music-*' })
  expect(parseCommand('group policy ga PASS')).toEqual({ kind: 'policy', group: 'ga', policy: 'pass' })
  expect(parseCommand('help')).toEqual({ kind: 'usage' })
})

test('the model may post three times in ten minutes', () => {
  const t0 = 1_000_000
  expect(canModelSend([t0, t0 + 1, t0 + 2], t0 + 3).ok).toBe(false)
  expect(canModelSend([t0, t0 + 1, t0 + 2], t0 + 10 * 60_000)).toEqual({ ok: true, recent: [t0 + 1, t0 + 2] })
})

const STATES = JSON.stringify({
  states: [
    { surfaceId: 'surf-me', sessionId: 's0', state: 'working', runDepth: 1, blockedReason: null, sessionProvider: 'claude' },
    { surfaceId: 'surf-idle', sessionId: 's1', state: 'idle', runDepth: 0, blockedReason: null, sessionProvider: 'claude' },
    { surfaceId: 'surf-busy', sessionId: 's2', state: 'working', runDepth: 1, blockedReason: null, sessionProvider: 'claude' },
    { surfaceId: 'surf-asked', sessionId: 's3', state: 'blocked', runDepth: 1, blockedReason: 'permission: Bash', sessionProvider: 'claude' },
    { surfaceId: 'surf-twin-a', sessionId: 's4', state: 'idle', runDepth: 0, blockedReason: null, sessionProvider: 'claude' },
    { surfaceId: 'surf-twin-b', sessionId: 's4', state: 'idle', runDepth: 0, blockedReason: null, sessionProvider: 'claude' },
    { surfaceId: 'surf-shell', sessionId: null, state: 'idle', runDepth: 0, blockedReason: null, sessionProvider: null },
  ],
})

test('wmux panes: only an idle Claude pane is typed into, never this one, never one of two that share a session', () => {
  expect(panesToType(parsePanes(STATES), 'surf-me')).toEqual({ chosen: ['surf-idle'], busy: 3, shared: 2 })
  expect(parsePanes('{"state":{"surfaceId":"surf-idle","sessionId":"s1","state":"idle","runDepth":0,"sessionProvider":"claude"}}')).toEqual([
    { surface: 'surf-idle', session: 's1', isIdle: true },
  ])
  expect(parsePanes('not json')).toEqual([])
})

test('a prompt box is empty only when it is seen whole and holds nothing', () => {
  const edge = '─'.repeat(40)
  expect(editorIsEmpty(`● done\n${edge}\n> \n${edge}\n  auto mode on`)).toBe(true)
  expect(editorIsEmpty(`● done\n${edge}\n❯ \n${edge}`)).toBe(true)
  expect(editorIsEmpty(`${edge}\n> a draft\n${edge}`)).toBe(false)
  expect(editorIsEmpty(`${edge}\n> \n  second line of a draft\n${edge}`)).toBe(false)
  expect(editorIsEmpty(`${edge}\n> `)).toBe(false) // the bottom edge is off screen
  expect(editorIsEmpty('PS C:\\> ')).toBe(false)
  expect(editorIsEmpty('')).toBe(false)
})

test('a typed post is one line, tagged, and says who posted it and how it arrived', () => {
  expect(typedPost('fleet', 'learn-vx', 'main is red\n  do not rebase')).toBe(
    '[group fleet] main is red do not rebase (posted by the user from learn-vx with /inbox send, typed here by wmux)',
  )
  expect(untag(typedPost('fleet', '', 'hi')).group).toBe('fleet')
  expect(typedReport('fleet', { typed: 2, busy: 1, shared: 0, unknown: 0 })).toBe(
    'Typed by wmux into 2 panes of fleet. 1 pane left alone (busy, or a draft in the editor): post again later for those.',
  )
  expect(isEveryone({ id: 'fleet', kind: 'working-group', title: '', members: ['*'], policy: 'hold' })).toBe(true)
  expect(isEveryone({ id: 'ga', kind: 'working-group', title: '', members: ['ga-*'], policy: 'hold' })).toBe(false)
})
