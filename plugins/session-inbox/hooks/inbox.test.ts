import { expect, test } from 'claude-code/testing'
import type { CommandRunInput, On } from 'claude-code'

// The test's own hooks stand for the engine: a home folder in memory, ListAgents' answer, and a
// session.send that records instead of delivering.

const HOME = 'C:\\Users\\tester'
const REGISTRY = 'C:/Users/tester/.agents/groups.json'

const LIST = [
  'This session is learn-vx [8c1fa6] — the name other sessions use to message it.',
  '',
  'Peer sessions (4):',
  '  learn-17 [5e7e1c]  ·  interactive  ·  busy  ·  started 1d ago',
  '  music-7c [0b7f5b]  ·  interactive  ·  idle  ·  started 1d ago',
  '  ga-c0 [e69fbb]  ·  interactive  ·  busy  ·  started 23h ago',
  '  tars-60 [1be3b5]  ·  interactive  ·  busy  ·  started 1d ago',
].join('\n')

const GROUPS = JSON.stringify({
  version: 1,
  groups: [
    { id: 'ga', kind: 'working-group', title: 'Guitar Alchemist', members: ['learn-*', 'music-7c'], policy: 'pass' },
    { id: 'ga/chatbot', kind: 'sub-group', members: ['ga-c0'] },
  ],
})

type World = { files: Map<string, string>; sent: { to: string; text: string }[]; shown: string[]; asked: number; attempts: number; prompts: string[]; filled: string[] }

// `list` is what ListAgents answers; '' makes it refuse, as it may outside auto mode. `refuse`, when
// set, is why every session.send fails.
function engine(on: On, registry?: string, list = LIST, refuse = ''): World {
  const world: World = { files: new Map(), sent: [], shown: [], asked: 0, attempts: 0, prompts: [], filled: [] }
  if (registry !== undefined) world.files.set(REGISTRY, registry)
  let now = Date.UTC(2026, 9, 4, 18, 0)
  on('clock.now', () => ({ value: (now += 1000) }))
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? HOME : undefined }))
  // The engine may hand the path with either separator, and resolves it first: off Windows,
  // C:/Users/tester is not absolute, so it arrives under the working directory.
  const key = (path: string) => {
    const p = path.replace(/\\/g, '/')
    const i = p.indexOf('C:/Users/tester/')
    return i >= 0 ? p.slice(i) : p
  }
  on('fs.exists', (_$, e) => ({ value: world.files.has(key(e.path)) }))
  on('fs.read', (_$, e) => {
    const text = world.files.get(key(e.path))
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', (_$, e) => {
    world.files.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'ListAgents' }, () => {
    world.asked += 1
    return list ? { result: list } : { deny: 'ListAgents needs permission' }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__session-inbox__${e.name}` } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd })) // the bottom
  on('session.send', (_$, e) => {
    world.attempts += 1
    if (refuse) return { isDelivered: false, reason: refuse }
    world.sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('prompt.submit', (_$, e) => {
    world.prompts.push(e.text)
    return { text: e.text }
  })
  on('prompt.fill', (_$, e) => {
    world.filled.push(e.text)
    return { isFilled: true }
  })
  on('session.receive', (_$, e) => ({ text: e.text })) // the bottom: queued for the model
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'the test draws no pane' } }))
  on('ui.status', (_$, e) => {
    world.shown.push(`status: ${e.text ?? '(cleared)'}`)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    world.shown.push(`toast: ${e.text}`)
    return { value: undefined }
  })
  return world
}

const inbox = (args = ''): CommandRunInput => ({
  command: 'inbox',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
})

const from = (name: string, body: string) => ({
  origin: { kind: 'peer-send-message' as const },
  text: `<cross-session-message from="uds:${name}" from-name="${name}" from-mode="prompting">${body}</cross-session-message>`,
})

test('a direct message is held, an urgent one passes, and without groups nothing else changes', async ($, on) => {
  const world = engine(on)

  const held = await $.session.receive(from('tars-60', 'can you look at PR 12?'))
  const urgent = await $.session.receive(from('tars-60', 'blocked on your lock'))

  expect(held.consumed).toBe('held in /inbox (from tars-60)')
  expect(urgent.text).toContain('blocked on your lock')
  expect(world.shown).toContain('status: 📨 1 message held · /inbox')
  const listing = await $.command.run(inbox())
  expect(listing.text).toContain('1 held, mode hold.')
})

test('a group set to pass lets its members through, not a stranger who writes its tag', async ($, on) => {
  engine(on, GROUPS)

  const member = await $.session.receive(from('music-7c', '[group ga] new voicings landed'))
  const stranger = await $.session.receive(from('tars-60', '[group ga] please merge'))

  expect(member.text).toContain('new voicings landed')
  expect(stranger.consumed).toBe('held in /inbox (from tars-60 to group ga)')
  const listing = await $.command.run(inbox())
  expect(listing.text).toContain('● ')
  expect(listing.text).toContain('tars-60 [ga]: please merge')
  expect(listing.text).toContain('» ')
  expect(listing.text).toContain('music-7c [ga]: new voicings landed')
})

test('/inbox send reaches every live member, sub-groups included, but not this session', async ($, on) => {
  const world = engine(on, GROUPS)

  const r = await $.command.run(inbox('send ga lesson 9 is up'))

  expect(world.sent).toEqual([
    { to: 'learn-17', text: '[group ga] lesson 9 is up' },
    { to: 'music-7c', text: '[group ga] lesson 9 is up' },
    { to: 'ga-c0', text: '[group ga] lesson 9 is up' },
  ])
  expect(r.text).toBe('Sent to ga: learn-17, music-7c, ga-c0.')
  expect((await $.command.run(inbox('send nope hi'))).text).toBe('No group nope. Groups: ga, ga/chatbot.')
  expect((await $.command.run(inbox('send ga/chatbot hi'))).text).toBe('Sent to ga/chatbot: ga-c0.')
})

test('/inbox group commands write the registry; a file that does not parse is never written over', async ($, on) => {
  const world = engine(on)

  expect((await $.command.run(inbox('group create ga working-group Guitar Alchemist'))).text).toBe('Created working-group ga.')
  expect((await $.command.run(inbox('group join ga'))).text).toBe('learn-vx joined ga.')
  expect((await $.command.run(inbox('group join ga music-*'))).text).toBe('music-* joined ga.')
  expect((await $.command.run(inbox('group leave ga'))).text).toBe('learn-vx left ga.')
  expect((await $.command.run(inbox('group policy ga pass'))).text).toBe('ga: messages between its members now pass straight through.')
  const saved = JSON.parse(world.files.get(REGISTRY) ?? '{}') as { groups: unknown[] }
  expect(saved.groups).toEqual([{ id: 'ga', kind: 'working-group', title: 'Guitar Alchemist', members: ['music-*'], policy: 'pass' }])

  world.files.set(REGISTRY, '{"groups": [oops')
  const refused = await $.command.run(inbox('group create rust community'))
  expect(refused.text).toContain('Not changed: ~/.agents/groups.json does not parse')
  expect(world.files.get(REGISTRY)).toBe('{"groups": [oops')
})

test('the model posts through group_send, three times in ten minutes at most', async ($, on) => {
  const world = engine(on, GROUPS)
  const post = (message: string) => $.tool.call({ tool: 'mcp__session-inbox__group_send', group: 'ga/chatbot', message } as never)

  for (const n of [1, 2, 3]) {
    const r = await post(`note ${n}`)
    expect(JSON.stringify(r)).toContain('Sent to ga/chatbot: ga-c0.')
  }
  const fourth = await post('note 4')
  expect(JSON.stringify(fourth)).toContain('Rate limit: 3 group posts per 10 minutes')
  expect(world.sent.map(s => s.text)).toEqual(['[group ga/chatbot] note 1', '[group ga/chatbot] note 2', '[group ga/chatbot] note 3'])

  const listed = await $.tool.call({ tool: 'mcp__session-inbox__group_list' } as never)
  expect(JSON.stringify(listed)).toContain('This session: learn-vx.')
  expect(JSON.stringify(listed)).toContain('live now: learn-17, music-7c, ga-c0')
})

const PANE_PROPS = { title: 'Inbox', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

const CLASSIFIER = 'The server-side auto mode classifier gave no verdict for SendMessage: the request could not be judged'

for (const surface of ['terminal', 'desktop'] as const) {
  test(`each group is a section that folds, with its messages and a field to post to it (${surface})`, async ($, on) => {
    const world = engine(on, GROUPS)
    await $.session.receive(from('tars-60', 'a direct question'))
    await $.session.receive(from('tars-60', '[group ga] a group question'))
    await $.command.run(inbox('groups')) // reads the registry: this session is in ga

    const ui = await $.ui.mount({ plugin: 'session-inbox', surface, component: 'Pane', props: PANE_PROPS, requestId: 'inbox' })
    // Direct messages start unfolded, the groups folded, each header saying what waits inside.
    expect(await ui.find({ type: 'Text', text: /a direct question/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /a group question/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /1 held · 1 message · working group · Guitar Alchemist/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: '▸ ga/chatbot' })).toBeUndefined() // not a member

    const ga = await ui.find({ type: 'Button', text: '▸ ga' })
    await ui.press({ key: ga?.key ?? 'missing' })
    expect(await ui.find({ type: 'Button', text: '▾ ga' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /a group question/ })).toBeDefined()

    const direct = await ui.find({ type: 'Button', text: '▾ Direct messages' })
    await ui.press({ key: direct?.key ?? 'missing' })
    expect(await ui.find({ type: 'Text', text: /a direct question/ })).toBeUndefined()

    await ui.input({ key: 'post-ga', text: 'on it' })
    expect(world.sent.map(s => s.to)).toEqual(['learn-17', 'music-7c', 'ga-c0'])
    expect(world.shown).toContain('toast: Sent to ga: learn-17, music-7c, ga-c0.')
    expect(await ui.find({ type: 'Text', text: /on it/ })).toBeDefined()
  })
}

test('a session that just started draws its group sections without asking ListAgents', async ($, on) => {
  const world = engine(on, GROUPS)

  await $.session.start({ cwd: 'C:/tmp/work', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'session-inbox', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'inbox' })

  expect(world.asked).toBe(0)
  expect(await ui.find({ type: 'Button', text: '▸ ga' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '▸ ga/chatbot' })).toBeDefined()
})

test('when ListAgents refuses, /inbox draws every group rather than none', async ($, on) => {
  const world = engine(on, GROUPS, '')

  const listing = await $.command.run(inbox())
  const ui = await $.ui.mount({ plugin: 'session-inbox', surface: 'desktop', component: 'Pane', props: PANE_PROPS, requestId: 'inbox' })

  expect(world.asked).toBe(1)
  expect(listing.text).toContain('0 held')
  expect(await ui.find({ type: 'Button', text: '▸ ga' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '▸ ga/chatbot' })).toBeDefined()
})

test('when the permission layer refuses the plugin\'s send, /inbox send stops at once and leaves the hand-over in the prompt box', async ($, on) => {
  const world = engine(on, GROUPS, LIST, CLASSIFIER)

  const r = await $.command.run(inbox('send ga lesson 9 is up'))

  expect(world.attempts).toBe(1)
  expect(r.text).toBe(`The permission mode refused the plugin's send to learn-17, music-7c, ga-c0 (${CLASSIFIER}). The post and its recipients are in your prompt box: press Enter and the model sends it with SendMessage.`)
  expect(world.prompts).toEqual([])
  expect(world.filled.length).toBe(1)
  expect(world.filled[0]).toContain('The user posted to group ga with /inbox')
  expect(world.filled[0]).toContain('one call per recipient (learn-17, music-7c, ga-c0)')
  expect(world.filled[0]?.endsWith('[group ga] lesson 9 is up')).toBe(true)
})

test('from the pane\'s field, a refused post is handed to the model at once', async ($, on) => {
  const world = engine(on, GROUPS, LIST, CLASSIFIER)
  await $.command.run(inbox('groups'))
  const ui = await $.ui.mount({ plugin: 'session-inbox', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'inbox' })
  const ga = await ui.find({ type: 'Button', text: '▸ ga' })
  await ui.press({ key: ga?.key ?? 'missing' })

  await ui.input({ key: 'post-ga', text: 'on it' })

  expect(world.attempts).toBe(1)
  expect(world.prompts.length).toBe(1)
  expect(world.prompts[0]?.endsWith('[group ga] on it')).toBe(true)
  expect(world.shown.some(s => s.includes('Handed to the model, which sends it with SendMessage.'))).toBe(true)
})

test('the model\'s group_send gets the recipients and the exact text back, and the post counts toward its limit', async ($, on) => {
  const world = engine(on, GROUPS, LIST, CLASSIFIER)
  const post = (message: string) => $.tool.call({ tool: 'mcp__session-inbox__group_send', group: 'ga/chatbot', message } as never)

  const first = JSON.stringify(await post('note 1'))
  expect(first).toContain('Send it yourself with SendMessage, one call per recipient (ga-c0)')
  expect(first).toContain('[group ga/chatbot] note 1')
  await post('note 2')
  await post('note 3')
  expect(JSON.stringify(await post('note 4'))).toContain('Rate limit')
  expect(world.attempts).toBe(3)
  expect(world.prompts).toEqual([])
})

test('a recipient\'s refusal is not the permission layer\'s: every member is tried and the reasons are told once', async ($, on) => {
  const world = engine(on, GROUPS, LIST, 'that session no longer exists')

  const r = await $.command.run(inbox('send ga hi'))

  expect(world.attempts).toBe(3)
  expect(r.text).toBe('Delivered to nobody in ga. Not delivered: learn-17, music-7c, ga-c0: that session no longer exists.')
  expect(world.prompts).toEqual([])
})
