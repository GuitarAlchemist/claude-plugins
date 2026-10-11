import { expect, test } from 'claude-code/testing'
import type { CommandRunInput, On } from 'claude-code'

import { II_V_I_IN_BB } from './chat-samples'
import { AM7, BB7_OVER_D, C13, G7_SHELLS, SEARCH, SET } from './ga-samples'

// The test's own hooks stand for the GA MCP server (its real answers for Cmaj7) and for the engine.

type World = { searches: string[]; sets: string[]; consents: string[]; opened: string[]; shown: string[]; rules: boolean }

// Auto mode as measured on 2026-10-04, word for word: it refused the mod's own GA calls, on /ga chord with
// a `consent` naming the command as much as without one. `rules` stands for the user's allow rules for
// the two GA tools in /permissions: once the user added them, the mod's own calls ran (measured the same
// day, chord_diagram Am7 with no GA answers given).
const NO_VERDICT = (tool: string) =>
  `The server-side auto mode classifier gave no verdict for ${tool}: the request that produced this action did not ask for one. Issue the action again once, as-is; if it is denied again, continue with other tasks that don't require it and tell the user that auto mode could not evaluate it. Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used.`

// What the user reads instead of the classifier's words, which are written for the model.
const ADVICE = "GA's voicing index: the permission check refused the mod's call to mcp__ga__ga_search_voicings. To let /ga ask GA, allow mcp__ga__ga_search_voicings and mcp__ga__ga_chord_to_set in /permissions. A fingering such as x32010 is drawn without GA."

function engine(
  on: On,
  { rules = true, placed = true, gaError = '', answer = SEARCH, setRefused = false, answers = {} as Record<string, string>, gate = (_query: string) => Promise.resolve() } = {},
): World {
  const world: World = { searches: [], sets: [], consents: [], opened: [], shown: [], rules }
  let now = Date.UTC(2026, 9, 4, 20, 0)
  on('clock.now', () => ({ value: (now += 1000) }))
  on('ui.open', (_$, e) => {
    world.opened.push(e.id)
    return { value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'the test draws no pane' } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    world.shown.push(e.text)
    return { value: undefined }
  })
  const judged = (tool: string, args: Record<string, unknown>) => {
    world.consents.push(typeof args['consent'] === 'string' ? args['consent'] : '')
    return world.rules ? '' : NO_VERDICT(tool)
  }
  on('tool.call', { tool: /^mcp__ga__ga_search_voicings$/ }, async (_$, e) => {
    const args: Record<string, unknown> = { ...e }
    const query = String(args['query'])
    world.searches.push(query)
    const refusal = judged('mcp__ga__ga_search_voicings', args)
    // `gate`: GA's answer waits until the test opens it, so the test decides which of two lookups lands first.
    await gate(query)
    return refusal ? { deny: refusal } : { result: gaError ? JSON.stringify({ error: gaError }) : (answers[query] ?? answer) }
  })
  on('tool.call', { tool: /^mcp__ga__ga_chord_to_set$/ }, (_$, e) => {
    const args: Record<string, unknown> = { ...e }
    world.sets.push(String(args['symbol']))
    // `setRefused`: the set call refused while the search runs (the classifier judges each call apart).
    const refusal = judged('mcp__ga__ga_chord_to_set', args) || (setRefused ? NO_VERDICT('mcp__ga__ga_chord_to_set') : '')
    return refusal ? { deny: refusal } : { result: SET }
  })
  return world
}

const ga = (args: string): CommandRunInput => ({
  command: 'ga',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
})

const PROPS = { isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} }

test('/ga chord Cmaj7 asks GA\'s offline index once and opens the chord pane', async ($, on) => {
  const world = engine(on)

  const r = await $.command.run(ga('chord Cmaj7'))

  expect(world.searches).toEqual(['Cmaj7'])
  expect(world.consents).toEqual(['The user typed "/ga chord Cmaj7", which draws guitar voicings of Cmaj7 from GA\'s voicing index.'])
  expect(world.opened).toEqual(['ga-chords'])
  expect(r.text).toBe('GA chords open: 3 voicing(s) for Cmaj7.')
})

test('a refusal with the pane open says what to allow, not "0 voicing(s)" nor the words meant for the model', async ($, on) => {
  engine(on, { rules: false })

  const r = await $.command.run(ga('chord Cmaj7'))

  expect(r.text).toBe(ADVICE)
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`each voicing is a section that folds, with its chart and an OPTIC-K ladder checked against GA (${surface})`, async ($, on) => {
    const world = engine(on)
    await $.command.run(ga('chord Cmaj7'))

    const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface, component: 'Pane', props: { title: 'GA chords', ...PROPS }, requestId: 'ga-chords' })
    // The first voicing starts unfolded, the others folded.
    expect(await ui.find({ type: 'Code', text: / 8fr {2}● \| \| \| ● ●/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: '▸ 2. Cmaj7/B' })).toBeDefined()
    expect(world.sets).toEqual([])

    const climb = await ui.find({ type: 'Button', text: '▸ OPTIC-K ladder' })
    await ui.press({ key: climb?.key ?? 'missing' })
    expect(world.sets).toEqual(['Cmaj7'])
    expect(world.consents[1]).toBe('The user pressed "OPTIC-K ladder" under Cmaj7 in the GA chords pane, which asks GA for that chord\'s set class.')
    expect(await ui.find({ type: 'Code', text: /- I, inversion\s+\(0158\) · Forte 4-20/ })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: /- K, complement\s+\(01245789\) · Forte 8-20/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ICV <1 0 1 2 2 0> \(ok\) · prime form 0 1 5 8 \(ok\)/ })).toBeDefined()

    const second = await ui.find({ type: 'Button', text: '▸ 2. Cmaj7/B' })
    await ui.press({ key: second?.key ?? 'missing' })
    expect(await ui.find({ type: 'Code', text: / 7fr {2}● ● \| \| \| \|/ })).toBeDefined()
    const climbAgain = (await ui.findAll({ type: 'Button', text: '▸ OPTIC-K ladder' }))[0]
    await ui.press({ key: climbAgain?.key ?? 'missing' })
    expect(world.sets).toEqual(['Cmaj7']) // Cmaj7/B is asked as Cmaj7, once
  })
}

test('/ga optic x32010 climbs a typed fingering without asking GA', async ($, on) => {
  const world = engine(on, { placed: false })

  const r = await $.command.run(ga('optic x32010'))

  expect(world.searches).toEqual([])
  expect(world.sets).toEqual([])
  expect(r.text).toContain('1. x32010   GA 0-1-0-2-3-x')
  expect(r.text).toContain('OPTIC-K ladder of x32010')
  expect(r.text).toMatch(/- P, permutation\s+0 0 4 4 7/)
  expect(r.text).toMatch(/- I, inversion\s+\(037\)/)
})

test('a refused GA call says why and points to fingerings', async ($, on) => {
  engine(on, { rules: false, placed: false })

  const r = await $.command.run(ga('chord Cmaj7'))

  expect(r.text).toBe(ADVICE)
})

test('GA\'s own error is shown as GA wrote it, even when it says "denied"', async ($, on) => {
  engine(on, { gaError: 'Access to the path C:/ga/state/voicings/optick.index is denied.' })

  const r = await $.command.run(ga('chord Cmaj7'))

  expect(r.text).toBe("GA's voicing index: Access to the path C:/ga/state/voicings/optick.index is denied. A fingering such as x32010 is drawn without GA.")
})

test('while the model asks GA itself, the open pane says it is looking, not what to allow', async ($, on) => {
  engine(on, { rules: false })
  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chords', ...PROPS }, requestId: 'ga-chords' })

  await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Cmaj7' } as never)

  expect(await ui.find({ type: 'Text', text: /Looking up Cmaj7 in GA's voicing index/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\/permissions/ })).toBeUndefined()
})

test('a refused set class shows what to allow, and is asked again once the rules allow it', async ($, on) => {
  const world = engine(on, { rules: false })
  // The model brings GA's voicings itself; the mod's own ga_chord_to_set call is refused.
  await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Cmaj7', ladder: true, ga_voicings: SEARCH } as never)
  expect(world.sets).toEqual(['Cmaj7'])
  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chords', ...PROPS }, requestId: 'ga-chords' })

  const climb = await ui.find({ type: 'Button', text: '▸ OPTIC-K ladder' })
  await ui.press({ key: climb?.key ?? 'missing' })
  expect(world.sets).toEqual(['Cmaj7', 'Cmaj7']) // a failure is not served from the cache
  expect(await ui.find({ type: 'Text', text: /^GA's ga_chord_to_set: the permission check refused the mod's call to mcp__ga__ga_chord_to_set\. To let \/ga ask GA, allow mcp__ga__ga_search_voicings and mcp__ga__ga_chord_to_set in \/permissions\.$/ })).toBeDefined()

  world.rules = true
  const fold = await ui.find({ type: 'Button', text: '▾ OPTIC-K ladder' })
  await ui.press({ key: fold?.key ?? 'missing' })
  const again = await ui.find({ type: 'Button', text: '▸ OPTIC-K ladder' })
  await ui.press({ key: again?.key ?? 'missing' })
  expect(world.sets).toEqual(['Cmaj7', 'Cmaj7', 'Cmaj7'])
  expect(await ui.find({ type: 'Text', text: /ICV <1 0 1 2 2 0> \(ok\)/ })).toBeDefined()
})

test('the chords a chatbot answer names become buttons that open the chord pane', async ($, on) => {
  const world = engine(on)
  on('http.fetch', () => ({
    value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ naturalLanguageAnswer: 'Play Dm7, G7, then Cmaj7.', agentId: 'theory', confidence: 0.9, routingMethod: 'semantic', elapsedMs: 900 }) },
  }))

  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chatbot', ...PROPS }, requestId: 'ga' })
  await ui.input({ key: 'question', text: 'a ii-V-I in C' })
  expect(await ui.find({ type: 'Button', text: '♪ Dm7' })).toBeDefined()
  const cmaj7 = await ui.find({ type: 'Button', text: '♪ Cmaj7' })
  await ui.press({ key: cmaj7?.key ?? 'missing' })

  expect(world.opened).toEqual(['ga-chords'])
  expect(world.searches).toEqual(['Cmaj7'])
  expect(world.consents).toEqual(['The user pressed "♪ Cmaj7" under a GA chatbot answer, which draws guitar voicings of Cmaj7 from GA\'s voicing index.'])
})

test('the model\'s chord_diagram draws the charts it asks for, and the ladder', async ($, on) => {
  engine(on)

  const r = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Cmaj7', ladder: true, limit: 2 } as never))

  expect(r).toContain('1. Cmaj7   GA 8-8-9-9-x-8')
  expect(r).toContain('2. Cmaj7/B   GA 8-8-x-9-7-7')
  expect(r).not.toContain('3. Cmaj7/E')
  expect(r).toContain('OPTIC-K ladder of Cmaj7')
  expect(r).toContain('GA: Forte 4-20')
})

test('refused, the model\'s chord_diagram names the GA calls to make, then draws from their answers', async ($, on) => {
  const world = engine(on, { rules: false })

  const first = await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Cmaj7', ladder: true } as never)
  expect(world.consents).toEqual(['']) // the model's request is not the user's
  const refusal = JSON.stringify(first)
  expect(refusal).toContain('Call mcp__ga__ga_search_voicings with {\\"query\\":\\"Cmaj7\\",\\"limit\\":6,\\"instrument\\":\\"guitar\\",\\"allowSampling\\":false}')
  // The ladder's set is asked for once the voicings are known: the first voicing's name decides it.
  expect(refusal).not.toContain('mcp__ga__ga_chord_to_set with')
  expect(refusal).toContain('chord_diagram will then name the ga_chord_to_set call its ladder needs')

  // Given only the voicings, it draws them and names the call the ladder still needs.
  const half = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Cmaj7', ladder: true, ga_voicings: SEARCH } as never))
  expect(half).toContain('call mcp__ga__ga_chord_to_set with {\\"symbol\\":\\"Cmaj7\\"} and pass its answer as ga_set')

  const r = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Cmaj7', ladder: true, ga_voicings: SEARCH, ga_set: SET } as never))
  expect(world.searches).toEqual(['Cmaj7']) // the first try only
  expect(world.sets).toEqual(['Cmaj7']) // asked once, by the half-answered call
  expect(r).toContain('1. Cmaj7   GA 8-8-9-9-x-8')
  expect(r).toContain('GA: Forte 4-20 · ICV <1 0 1 2 2 0> (ok)')
})

test('voicings that lack a note of the chord asked say which, in the model\'s charts and in the pane', async ($, on) => {
  engine(on)

  const r = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Am7', ga_voicings: AM7 } as never))
  expect(r).toContain("GA's index returned no voicing that holds every note of Am7.")
  expect(r).toContain('1. Am   GA 5-5-5-7-x-5   lacks the b7 (G) of Am7')

  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chords', ...PROPS }, requestId: 'ga-chords' })
  expect(await ui.find({ type: 'Text', text: /none holds every note of Am7/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /lacks the b7 \(G\)/ })).length).toBe(3)
  expect(await ui.find({ type: 'Code', text: /Am   GA 5-5-5-7-x-5   lacks the b7 \(G\) of Am7/ })).toBeDefined()
})

test('the ladder of a voicing that lacks notes says it is the voicing\'s, not the chord asked', async ($, on) => {
  engine(on)

  const r = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Am7', ladder: true, ga_voicings: AM7 } as never))
  expect(r).toContain('OPTIC-K ladder of Am (the voicing drawn, which lacks the b7 (G) of Am7)')

  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chords', ...PROPS }, requestId: 'ga-chords' })
  const climb = await ui.find({ type: 'Button', text: '▸ OPTIC-K ladder' })
  await ui.press({ key: climb?.key ?? 'missing' })
  expect(await ui.find({ type: 'Text', text: /^This ladder is of the voicing drawn, Am, which lacks the b7 \(G\) of Am7\.$/ })).toBeDefined()
})

test('/ga chord says when no voicing holds every note, and when GA named none to check', async ($, on) => {
  engine(on, { answer: AM7 })
  expect((await $.command.run(ga('chord Am7'))).text).toBe('GA chords open: 3 voicing(s) for Am7; none holds every note of Am7.')

  const bare = JSON.stringify({ ...JSON.parse(AM7), interpreted: { chord: 'Am7' } })
  const r = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Am7', ga_voicings: bare } as never))
  expect(r).toContain('GA did not say which notes Am7 holds, so these voicings were not checked against it.')
})

test('voicings left in state by 0.2.2, without missing notes recorded, still draw after a reload', async ($, on) => {
  engine(on)
  const before = { query: 'Am7', status: 'done', source: 'ga', chord: 'Am7', voicings: [{ id: 'old-0', name: 'Am', frets: [5, null, 7, 5, 5, 5], score: 0.5066 }], error: '' }
  // The host hands back what 0.2.2 wrote: the test answers the mod's reads of those two values.
  on('state.get', (_$, e, next) => {
    const key: unknown = { ...e }['key' as never]
    if (key === 'chords') return { value: { value: before, version: 1 } } as never
    if (key === 'unfolded') return { value: { value: ['old-0'], version: 1 } } as never
    return next(e)
  })

  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chords', ...PROPS }, requestId: 'ga-chords' })
  expect(await ui.find({ type: 'Button', text: '▾ 1. Am' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /notes not checked/ })).toBeDefined()
})

test('a ga_set for another chord than the ladder\'s is not taken, and the right call is named', async ($, on) => {
  engine(on, { rules: false })

  const half = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Am7', ladder: true, ga_voicings: AM7 } as never))
  expect(half).toContain('call mcp__ga__ga_chord_to_set with {\\"symbol\\":\\"Am\\"} and pass its answer as ga_set')

  const wrong = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Am7', ladder: true, ga_voicings: AM7, ga_set: SET } as never))
  expect(wrong).toContain("The ga_set given is GA's answer for Cmaj7, but the ladder is of Am.")
  expect(wrong).toContain('call mcp__ga__ga_chord_to_set with {\\"symbol\\":\\"Am\\"}')
  expect(wrong).not.toContain('Forte 4-20')
})

test('a real answer in B flat gives ♪ buttons for C m7 and B♭, the chords it is about', async ($, on) => {
  const world = engine(on)
  on('http.fetch', () => ({
    value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ naturalLanguageAnswer: II_V_I_IN_BB, agentId: 'fallback-direct', confidence: 0, routingMethod: 'low-confidence-fallback', elapsedMs: 11003 }) },
  }))

  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chatbot', ...PROPS }, requestId: 'ga' })
  await ui.input({ key: 'question', text: 'Transpose the ii-V-I progression in C major to Bb major.' })
  expect(await ui.find({ type: 'Button', text: '♪ Cm7' })).toBeDefined()
  const bb = await ui.find({ type: 'Button', text: '♪ Bb' })
  await ui.press({ key: bb?.key ?? 'missing' })
  expect(world.searches).toEqual(['Bb'])
})

test('a slash chord\'s voicings say when their bass is not the one asked; the shells over D hold it', async ($, on) => {
  engine(on, { answer: BB7_OVER_D })

  const r = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Bb7/D', limit: 6, ga_voicings: BB7_OVER_D } as never))
  expect(r).not.toContain("GA's index returned no voicing")
  expect(r).toContain('1. Bb7(shell)   GA 6-9-7-6-x-6   has Bb in the bass, not the D of Bb7/D, and omits the 5 (F)')
  // The three GA names "/D" have D3 lowest and leave out only the 5: they hold Bb7/D.
  expect(r).toContain('4. Bb7(shell)/D   GA 6-9-x-x-5-x   omits the 5 (F) of Bb7/D')
  expect(r).not.toContain('6-9-x-x-5-x   omits the 5 (F) of Bb7/D, and')

  expect((await $.command.run(ga('chord Bb7/D'))).text).toBe('GA chords open: 6 voicing(s) for Bb7/D.')
})

test('a voicing with every note of a slash chord but another bass does not hold it (GA\'s Bb7/D answer, one result swapped for a full Bb7)', async ($, on) => {
  engine(on)
  // x13131, low E first: Bb2 F3 Ab3 D4 F4, all four notes of Bb7, with Bb lowest.
  const full = JSON.stringify({ ...JSON.parse(BB7_OVER_D), results: [{ score: 0.5, diagram: '1-3-1-3-1-x', chordName: 'Bb7', instrument: 'guitar' }] })
  const r = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Bb7/D', ga_voicings: full } as never))
  expect(r).toContain("GA's index returned no voicing that holds every note of Bb7/D with D in the bass.")
  expect(r).toContain('1. Bb7   GA 1-3-1-3-1-x   has Bb in the bass, not the D of Bb7/D')
})

test('the pane\'s folded rows say the bass too, not only the missing notes', async ($, on) => {
  engine(on, { answer: BB7_OVER_D })
  await $.command.run(ga('chord Bb7/D'))
  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chords', ...PROPS }, requestId: 'ga-chords' })
  // Rows 1-3 have Bb2 lowest; rows 4-6 have D3 lowest and only leave out the 5.
  expect((await ui.findAll({ type: 'Text', text: /^ {2}has Bb in the bass, not D, and omits the 5 \(F\)$/ })).length).toBe(3)
  expect((await ui.findAll({ type: 'Text', text: /^ {2}omits the 5 \(F\)$/ })).length).toBe(3)
})

test('the bass typed is kept when GA\'s reading drops the slash (its Bb7/D answer with an empty chord and one full Bb7: a variant)', async ($, on) => {
  const sample = JSON.parse(BB7_OVER_D)
  engine(on, { answer: JSON.stringify({ ...sample, interpreted: { ...sample.interpreted, chord: '' }, results: [{ score: 0.5, diagram: '1-3-1-3-1-x', chordName: 'Bb7', instrument: 'guitar' }] }) })
  expect((await $.command.run(ga('chord Bb7 / D'))).text).toBe('GA chords open: 1 voicing(s) for Bb7 / D; none holds every note of Bb7 / D with D in the bass.')
})

test('a chord of seven notes says why no voicing holds it: six strings', async ($, on) => {
  engine(on, { answer: C13 })
  const r = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'C13', ga_voicings: C13 } as never))
  expect(r).toContain("GA's index returned no voicing that holds every note of C13: it has 7 notes, more than a guitar's 6 strings.")
  expect((await $.command.run(ga('chord C13'))).text).toBe('GA chords open: 6 voicing(s) for C13; none holds every note of C13 (7 notes, 6 strings).')
  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chords', ...PROPS }, requestId: 'ga-chords' })
  expect(await ui.find({ type: 'Text', text: /none holds every note of C13 \(7 notes, 6 strings\)/ })).toBeDefined()
})

test('a chord of four notes that no voicing holds keeps the plain sentence', async ($, on) => {
  engine(on, { answer: AM7 })
  expect((await $.command.run(ga('chord Am7'))).text).toBe('GA chords open: 3 voicing(s) for Am7; none holds every note of Am7.')
})

test('shell voicings without the perfect 5th hold a four-note chord, and say they omit it', async ($, on) => {
  engine(on, { answer: G7_SHELLS })
  const r = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'G7', ga_voicings: G7_SHELLS } as never))
  expect(r).not.toContain("GA's index returned no voicing")
  expect(r).toContain('1. G7(shell)/B   GA x-x-x-5-8-7   omits the 5 (D) of G7')
  expect((await $.command.run(ga('chord G7'))).text).toBe('GA chords open: 6 voicing(s) for G7.')
  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chords', ...PROPS }, requestId: 'ga-chords' })
  // Said, but not as a warning: the voicing holds the chord.
  const row = await ui.find({ type: 'Text', text: /^ {2}omits the 5 \(D\)$/ })
  expect(row?.props).toMatchObject({ dimColor: true })
  expect(row?.props).not.toMatchObject({ color: 'yellow' })
  // Its ladder is of the three notes drawn, not of G7's four: said, dim too.
  const climb = await ui.find({ type: 'Button', text: '▸ OPTIC-K ladder' })
  await ui.press({ key: climb?.key ?? 'missing' })
  const whose = await ui.find({ type: 'Text', text: /^This ladder is of the voicing drawn, G7\(shell\)\/B, which omits the 5 \(D\) of G7\.$/ })
  expect(whose?.props).toMatchObject({ dimColor: true })
  expect(whose?.props).not.toMatchObject({ color: 'yellow' })
})

test('a 7th stays required, and so does every note of a seven-note chord: Am7 triads still lack the b7, C13 its 5', async ($, on) => {
  engine(on, { answer: AM7 })
  expect((await $.command.run(ga('chord Am7'))).text).toBe('GA chords open: 3 voicing(s) for Am7; none holds every note of Am7.')
  const r = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'C13', ga_voicings: C13 } as never))
  expect(r).toContain("GA's index returned no voicing that holds every note of C13: it has 7 notes, more than a guitar's 6 strings.")
  expect(r).toContain('lacks the 9 (D) and the 5 (G) and the 6 (A) of C13')
})

test('Bb7\'s charts spell their notes in flats, as the chord symbol does (GA\'s Bb7/D answer)', async ($, on) => {
  engine(on, { answer: BB7_OVER_D })
  const r = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Bb7/D', limit: 6, ga_voicings: BB7_OVER_D, ladder: true } as never))
  expect(r).toContain('      Bb2 Ab3 D4 Ab4 Bb4')
  expect(r).not.toMatch(/A#|G#/)
})

test('the symbol typed decides the spelling when GA reads the same root another way (its Bb7/D answer, read as A#7/D: a variant)', async ($, on) => {
  const sample = JSON.parse(BB7_OVER_D)
  const asSharp = JSON.stringify({ ...sample, interpreted: { ...sample.interpreted, chord: 'A#7/D' } })
  engine(on, { answer: asSharp })
  const r = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Bb7/D', limit: 1, ga_voicings: asSharp } as never))
  expect(r).toContain('      Bb2 Ab3 D4 Ab4 Bb4')
})

test('/ga optic in a terminal too narrow for the pane asks GA for the set once, even when that call fails', async ($, on) => {
  const world = engine(on, { placed: false, setRefused: true })
  const r = await $.command.run(ga('optic Cmaj7'))
  expect(world.sets).toEqual(['Cmaj7'])
  expect(r.text).toContain("GA's ga_chord_to_set: the permission check refused the mod's call to mcp__ga__ga_chord_to_set.")
})

test('/ga optic in a terminal too narrow for the pane asks GA for the set once when it answers, and draws its numbers', async ($, on) => {
  const ok = engine(on, { placed: false })
  const drawn = await $.command.run(ga('optic Cmaj7'))
  expect(ok.sets).toEqual(['Cmaj7'])
  expect(drawn.text).toContain('Forte 4-20')
})

// A promise and the call that settles it.
function deferred(): { promise: Promise<void>; open: () => void } {
  let open = () => {}
  const promise = new Promise<void>(resolve => {
    open = () => resolve()
  })
  return { promise, open }
}

// GA's answer for Cmaj7 held until the test opens it; `called` settles once the mod has asked for it.
function slowCmaj7(on: On, answers: Record<string, string> = { Am7: AM7 }) {
  const called = deferred()
  const slow = deferred()
  const world = engine(on, { answers, gate: query => (query === 'Cmaj7' ? (called.open(), slow.promise) : Promise.resolve()) })
  return { world, called, slow }
}

// Whether the engine runs a press in the pane while a command or the model's tool waits on GA is unmeasured
// live: these tests assume it can, and hold GA's answer for Cmaj7 so that Am7, asked after it, lands first.
test('a lookup that lands after a newer one leaves the pane to the newer one, and /ga chord still reports its own (interleaving assumed)', async ($, on) => {
  const { called, slow } = slowCmaj7(on)
  const command = $.command.run(ga('chord Cmaj7'))
  await called.promise
  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chords', ...PROPS }, requestId: 'ga-chords' })
  await ui.input({ key: 'chord-query', text: 'Am7' })
  expect(await ui.find({ type: 'Button', text: /^▸ 2\. Am\b/ })).toBeDefined()

  slow.open()
  const r = await command

  expect(r.text).toBe('GA chords open: 3 voicing(s) for Cmaj7; the pane shows a chord drawn since.')
  expect(await ui.find({ type: 'Button', text: /^▸ 2\. Am\b/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button', text: /Cmaj7/ })).toHaveLength(0)
})

test('the model\'s chord_diagram landing after a newer lookup draws its own chord and leaves the pane to the newer one (interleaving assumed)', async ($, on) => {
  const { called, slow } = slowCmaj7(on)
  const call = $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Cmaj7', ladder: true } as never)
  await called.promise
  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chords', ...PROPS }, requestId: 'ga-chords' })
  await ui.input({ key: 'chord-query', text: 'Am7' })

  slow.open()
  const r = JSON.stringify(await call)

  expect(r).toContain('1. Cmaj7   GA 8-8-9-9-x-8')
  expect(r).toContain('OPTIC-K ladder of Cmaj7')
  expect(r).not.toContain('Am7')
  expect(await ui.find({ type: 'Button', text: /^▸ 2\. Am\b/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button', text: /Cmaj7/ })).toHaveLength(0)
})

test('a lookup that fails after a newer one landed leaves the pane to the newer one, and /ga chord says its own error (interleaving assumed)', async ($, on) => {
  const denied = 'Access to the path C:/ga/state/voicings/optick.index is denied.'
  const { called, slow } = slowCmaj7(on, { Am7: AM7, Cmaj7: JSON.stringify({ error: denied }) })
  const command = $.command.run(ga('chord Cmaj7'))
  await called.promise
  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chords', ...PROPS }, requestId: 'ga-chords' })
  await ui.input({ key: 'chord-query', text: 'Am7' })

  slow.open()
  const r = await command

  expect(r.text).toBe(`GA's voicing index: ${denied} A fingering such as x32010 is drawn without GA.`)
  expect(await ui.find({ type: 'Button', text: /^▸ 2\. Am\b/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: /denied/ })).toHaveLength(0)
})

// Contract derived from GA 879f148e3f2b7d55d9f465d74803e8c10647fb3e:
// ChordParser requires EOF; GaChordToSet returns parse failures as ordinary strings.
const G7_PINNED_SET = [
  'Chord: G7', 'Pitch set:  {D, F, G, B} (4 tones)',
  '  ICV:        <0 1 2 1 1 1>', '  Forte:      4-27', '  Prime form: 0 2 5 8',
  'OPTIC-K layer: STRUCTURE (dims 6–29, w=0.45) — ICV drives structural similarity',
].join('\n')

test('known shell labels normalize to GA symbols while their displayed names are preserved', async ($, on) => {
  const world = engine(on)
  on('tool.call', { tool: /^mcp__ga__ga_chord_to_set$/ }, (_$, e) => {
    const symbol = String({ ...e }['symbol'])
    world.sets.push(symbol)
    const result = symbol === 'G7' ? G7_PINNED_SET :
      symbol === 'Bb7' ? G7_PINNED_SET.replace('Chord: G7', 'Chord: Bb7').replace('{D, F, G, B}', '{D, F, Ab, Bb}') :
      "Error: could not parse chord '" + symbol + "'"
    return { result }
  })
  const g7 = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'G7', ladder: true, ga_voicings: G7_SHELLS } as never))
  expect(world.sets).toEqual(['G7'])
  expect(g7).toContain('G7(shell)/B')
  expect(g7).toContain('Forte 4-27')
  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chords', ...PROPS }, requestId: 'ga-chords' })
  const climb = await ui.find({ type: 'Button', text: '▸ OPTIC-K ladder' })
  await ui.press({ key: climb?.key ?? 'missing' })
  expect(await ui.find({ type: 'Text', text: /ICV <0 1 2 1 1 1>/ })).toBeDefined()
  expect(world.sets).toEqual(['G7'])
  // Supply the exact voicing result so the fixture cannot substitute Cmaj7.
  const bb = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'Bb7/D', ladder: true, ga_voicings: BB7_OVER_D } as never))
  expect(world.sets).toContain('Bb7')
  expect(bb).toContain('Bb7(shell)')
})

test('text errors, empty replies and missing set data are shown and never cached as successes', async ($, on) => {
  const world = engine(on)
  const answers = ["Error: could not parse chord 'G7(shell)'", '', 'Chord: G7\nPitch set: {}', G7_PINNED_SET]
  on('tool.call', { tool: /^mcp__ga__ga_chord_to_set$/ }, (_$, e) => {
    world.sets.push(String({ ...e }['symbol']))
    return { result: answers.shift() ?? G7_PINNED_SET }
  })
  for (const expected of ['Error: could not parse', 'unknown or different chord', 'no usable chord-set data', 'Forte 4-27']) {
    const output = JSON.stringify(await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'G7', ladder: true, ga_voicings: G7_SHELLS } as never))
    expect(output).toContain(expected)
  }
  expect(world.sets).toEqual(['G7', 'G7', 'G7', 'G7'])
})

test('a provided ga_set text error is reported without becoming a reusable success', async ($, on) => {
  const world = engine(on)
  const output = JSON.stringify(await $.tool.call({
    tool: 'mcp__ga-chatbot__chord_diagram', chord: 'G7', ladder: true, ga_voicings: G7_SHELLS,
    ga_set: "Error: could not parse chord 'G7(shell)'",
  } as never))
  expect(output).toContain("Error: could not parse chord 'G7(shell)'")
  expect(world.sets).toEqual([])
  await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: 'G7', ladder: true, ga_voicings: G7_SHELLS } as never)
  expect(world.sets).toEqual(['G7'])
})

test('normalization keeps legitimate slash qualities and omission notation', async ($, on) => {
  const world = engine(on)
  for (const name of ['C6/9', 'C(no 3)']) {
    const sample = { ...JSON.parse(SEARCH), results: [{ ...JSON.parse(SEARCH).results[0], chordName: name }] }
    await $.tool.call({ tool: 'mcp__ga-chatbot__chord_diagram', chord: name, ladder: true, ga_voicings: JSON.stringify(sample) } as never)
  }
  expect(world.sets).toEqual(['C6/9', 'C(no 3)'])
})

test('the pinned GA pitch-class notation T and E is accepted in a valid prime form', async ($, on) => {
  const world = engine(on)
  const sample = { ...JSON.parse(SEARCH), results: [{ ...JSON.parse(SEARCH).results[0], chordName: '12-1' }] }
  on('tool.call', { tool: /^mcp__ga__ga_chord_to_set$/ }, (_$, e) => {
    world.sets.push(String({ ...e }['symbol']))
    return { result: 'Chord: 12-1\nPitch set: chromatic\nICV: <12 12 12 12 12 6>\nForte: 12-1\nPrime form: 0 1 2 3 4 5 6 7 8 9 T E' }
  })
  const output = JSON.stringify(await $.tool.call({
    tool: 'mcp__ga-chatbot__chord_diagram', chord: '12-1', ladder: true, ga_voicings: JSON.stringify(sample),
  } as never))
  expect(output).toContain('Forte 12-1')
  expect(output).not.toContain('no usable chord-set data')
  expect(world.sets).toEqual(['12-1'])
})
