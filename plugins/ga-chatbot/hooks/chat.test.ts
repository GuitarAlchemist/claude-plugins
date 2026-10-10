import { expect, test } from 'claude-code/testing'
import type { CommandRunInput, On } from 'claude-code'

import { forwardText, isUnaided, parseAnswer, parseHealth } from './chat'
import { NOTES_OF_CMAJ7, PRIME_FORM_OF_AM7, STATUS_COLD, STATUS_WARM } from './chat-samples'

// The test's own hooks stand for the engine: `http.fetch` answers as GaChatbot.Api would, so no model runs.

// The rest of the engine the command touches: a clock, the pane, the status line and toasts.
function engine(on: On, tick: () => number = () => 1000): string[] {
  const shown: string[] = []
  let now = Date.UTC(2026, 9, 4, 18, 0)
  on('clock.now', () => ({ value: (now += tick()) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_$, e) => {
    shown.push(`status: ${e.text ?? '(cleared)'}`)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    shown.push(`toast: ${e.text}`)
    return { value: undefined }
  })
  return shown
}

const reply = (status: number, body: unknown) => ({
  value: {
    status,
    ok: status >= 200 && status < 300,
    headers: {},
    text: typeof body === 'string' ? body : JSON.stringify(body),
  },
})

const ga = (args = ''): CommandRunInput => ({
  command: 'ga',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
})

const ANSWER = {
  naturalLanguageAnswer: 'C, E and G.',
  agentId: 'theory',
  confidence: 0.92,
  routingMethod: 'semantic',
  elapsedMs: 1500,
  grounding: { source: 'ga-domain', revision: 'abc1234', queryType: 'chord' },
}

test('/ga <question> posts the question to GaChatbot.Api and shows the answer', async ($, on) => {
  const sent: { url: string; method: string; body: string }[] = []
  const shown = engine(on)
  on('http.fetch', (_$, e) => {
    sent.push({ url: e.url, method: e.init?.method ?? 'GET', body: e.init?.body ?? '' })
    return reply(200, ANSWER)
  })

  const r = await $.command.run(ga('notes of a C major triad'))

  expect(sent.length).toBe(1)
  expect(sent[0]?.url).toBe('http://localhost:5252/api/chatbot/chat')
  expect(sent[0]?.method).toBe('POST')
  const body = JSON.parse(sent[0]?.body ?? '{}') as { message: string; conversationHistory: unknown[] }
  expect(body.message).toBe('notes of a C major triad')
  expect(body.conversationHistory).toEqual([])
  expect(r.text).toContain('C, E and G.')
  expect(r.text).toContain('agent theory')
  expect(r.text).toContain('grounded in ga-domain @ abc1234 (chord)')
  // The status line says the chatbot is thinking only while it is.
  expect(shown).toEqual(['status: GA chatbot: thinking…', 'status: (cleared)'])
})

test('a follow-up question carries the earlier exchange as history', async ($, on) => {
  const bodies: string[] = []
  engine(on)
  on('http.fetch', (_$, e) => {
    bodies.push(e.init?.body ?? '')
    return reply(200, ANSWER)
  })

  await $.command.run(ga('notes of a C major triad'))
  await $.command.run(ga('and in first inversion?'))

  const second = JSON.parse(bodies[1] ?? '{}') as { message: string; conversationHistory: { role: string; content: string }[] }
  expect(second.message).toBe('and in first inversion?')
  expect(second.conversationHistory).toEqual([
    { role: 'user', content: 'notes of a C major triad' },
    { role: 'assistant', content: 'C, E and G.' },
  ])
})

test('a busy server and an unreachable one read as errors, not answers', async ($, on) => {
  let calls = 0
  engine(on)
  on('http.fetch', () => {
    calls += 1
    if (calls === 1) return reply(503, { error: 'Service is busy. Please try again in a few seconds.' })
    return { deny: 'connect ECONNREFUSED 127.0.0.1:5252' }
  })

  const busy = await $.command.run(ga('what is a tritone?'))
  expect(busy.text).toBe('GA chatbot: busy: Service is busy. Please try again in a few seconds.')

  const down = await $.command.run(ga('what is a tritone?'))
  expect(down.text).toContain('GA chatbot: not reachable at http://localhost:5252')
  expect(down.text).toContain('ECONNREFUSED')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the pane asks from its field, draws the answer and forwards it framed (${surface})`, async ($, on) => {
    engine(on)
    on('http.fetch', () => reply(200, ANSWER))
    const submitted: string[] = []
    on('prompt.submit', (_$, e) => {
      submitted.push(e.text)
      return { text: e.text }
    })

    const ui = await $.ui.mount({
      plugin: 'ga-chatbot',
      surface,
      component: 'Pane',
      props: { title: 'GA chatbot', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
      requestId: 'ga',
    })
    expect(await ui.find({ type: 'Text', text: /No question yet/ })).toBeDefined()

    await ui.input({ key: 'question', text: 'notes of a C major triad' })
    expect(await ui.find({ type: 'Markdown', text: 'C, E and G.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /agent theory · confidence 0\.92 · semantic · 1\.5 s/ })).toBeDefined()

    const forward = await ui.find({ type: 'Button', text: 'Forward to model' })
    await ui.press({ key: forward?.key ?? 'missing' })
    expect(submitted.length).toBe(1)
    expect(submitted[0]).toContain('not the user\'s instruction')
    expect(submitted[0]).toContain('Question: notes of a C major triad')
    expect(submitted[0]).toContain('C, E and G.')
  })
}

test('/ga alone opens the pane and reads the status route, not the chat route', async ($, on) => {
  const urls: string[] = []
  engine(on)
  on('http.fetch', (_$, e) => {
    urls.push(e.url)
    return reply(200, { isAvailable: true, provider: 'ollama', chatModel: 'gpt-oss:120b-cloud', message: 'ready' })
  })

  const r = await $.command.run(ga())

  expect(urls).toEqual(['http://localhost:5252/api/chatbot/status'])
  expect(r.text).toContain('GA chatbot open')
})

const UNAIDED = /answered alone \(the chatbot's fallback\), with no GA skill or tool behind it/

test('an answer from the fallback, the model alone, says so; one from a GA skill does not', async ($, on) => {
  engine(on)
  let body: unknown = PRIME_FORM_OF_AM7
  on('http.fetch', () => reply(200, body))

  const r = await $.command.run(ga('What is the prime form and Forte number of Am7?'))
  expect(r.text).toMatch(UNAIDED)
  expect(r.text).toContain('4‑23')

  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chatbot', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }, requestId: 'ga' })
  expect(await ui.find({ type: 'Text', text: UNAIDED })).toBeDefined()

  body = NOTES_OF_CMAJ7
  await ui.input({ key: 'question', text: 'What notes are in Cmaj7?' })
  expect(await ui.find({ type: 'Text', text: UNAIDED })).toBeUndefined()
})

test('forwarded to the model, a fallback answer comes with what to check it against', () => {
  const turn = { id: 't', at: 0, question: 'What is the prime form and Forte number of Am7?', status: 'done' as const, answer: '**Forte number:** 4‑23', agentId: 'fallback-direct', confidence: 0, routing: 'low-confidence-fallback', elapsedMs: 7075, grounding: '', error: '' }
  expect(forwardText(turn)).toContain("the chatbot's fallback, its model alone without GA's tools: check its chords and numbers with GA's tools (mcp__ga__*) before relying on them")
  expect(forwardText({ ...turn, agentId: 'skill.chordinfo', routing: 'orchestrator-skill-semantic' })).not.toContain('fallback')
})

const WARMING = /^The server's 10 s embedding check timed out\. It embeds with its routing model, bge-large by default, not the nomic-embed-text its status names, and a load cut at 10 s is aborted \(GA #822\): on 2026-10-04 three cut loads in a row left it warming\. The server repeats an answer for 30 s\. W loads bge-large with no time limit, then asks the server: that night it loaded in 6\.4 s and the server read ready\.$/

test('a cold embedding model reads as warming up, not as a chatbot that is down', async ($, on) => {
  expect(parseHealth(200, STATUS_COLD, 1)).toMatchObject({ ok: false, warming: true })
  expect(parseHealth(200, STATUS_WARM, 1)).toMatchObject({ ok: true, warming: false })

  engine(on)
  on('http.fetch', () => reply(200, STATUS_COLD))
  await $.command.run(ga(''))
  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chatbot', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }, requestId: 'ga' })
  expect(await ui.find({ type: 'Text', text: /^ ◌ warming up · ollama · gpt-oss:120b-cloud/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: WARMING })).toBeDefined()
})

test('a fallback the model answered is unaided; a fallback notice, where no model answered, is not', () => {
  const t = (agentId: string, routing: string) => ({ agentId, routing })
  expect(isUnaided(t('fallback-direct', 'low-confidence-fallback'))).toBe(true)
  expect(isUnaided(t('fallback-direct', 'timeout-fallback'))).toBe(true)
  expect(isUnaided(t('fallback-direct', 'error-fallback'))).toBe(true)
  expect(isUnaided(t('fallback-direct', 'fallback'))).toBe(true)
  // OrchestratedChatApplicationService.cs L234-L277 at GA 7595983: canned notices when the fallback's model failed.
  expect(isUnaided(t('fallback-direct', 'low-confidence-fallback-timeout'))).toBe(false)
  expect(isUnaided(t('fallback-direct', 'error-fallback-unavailable'))).toBe(false)
  expect(isUnaided(t('skill.chordinfo', 'orchestrator-skill-semantic'))).toBe(false)
})

test('only an embedding cut short, with both models installed and the pipeline up, reads as warming up', () => {
  const cold = JSON.parse(STATUS_COLD) as Record<string, unknown>
  const warming = (patch: Record<string, unknown>) => parseHealth(200, JSON.stringify({ ...cold, ...patch }), 1).warming
  expect(warming({})).toBe(true)
  // ChatProviderReadinessProbe.cs at GA 7595983: a missing model (L317-L323), a wedged orchestrator (L94-L100),
  // an embedding that failed rather than one the probe cut short (L178-L182).
  expect(warming({ chatModelInstalled: false, message: "Ollama reachable but required model(s) missing: chat='gpt-oss:120b-cloud'. Pull with `ollama pull <model>`. Installed: [nomic-embed-text:latest]. | Embedding: embedding timed out after 10s" })).toBe(false)
  expect(warming({ orchestratorRoundTripOk: false, message: "Ollama ready: chat='gpt-oss:120b-cloud', embedding='nomic-embed-text'. | Round-trip: timed out after 3s — orchestrator likely wedged | Embedding: embedding timed out after 10s" })).toBe(false)
  expect(warming({ message: "Ollama ready: chat='gpt-oss:120b-cloud', embedding='nomic-embed-text'. | Embedding: embedding threw HttpRequestException: Connection timed out" })).toBe(false)
})

const PANE = { plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chatbot', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }, requestId: 'ga' } as const
const EMBEDDED = { model: 'bge-large', embeddings: [[0.1, 0.2]] }
const STILL_WARMING = (took: string) => `toast: bge-large loaded in ${took} s, but the server still reads warming up; it repeats an answer for 30 s after its check: press R again after that.`

test('warming up, W loads an embedding model with no time limit, then asks the server rather than guessing its cache', async ($, on) => {
  const shown = engine(on)
  const sent: { url: string; body: string }[] = []
  on('http.fetch', (_$, e) => {
    sent.push({ url: e.url, body: e.init?.body ?? '' })
    return e.url.endsWith('/api/embed') ? reply(200, EMBEDDED) : reply(200, STATUS_COLD)
  })
  await $.command.run(ga(''))
  const ui = await $.ui.mount(PANE)
  const warm = await ui.find({ type: 'Button', text: 'Load an embedding model' })
  await ui.press({ key: warm?.key ?? 'missing' })
  expect(sent.map(s => s.url)).toEqual(['http://localhost:5252/api/chatbot/status', 'http://localhost:11434/api/embed', 'http://localhost:5252/api/chatbot/status'])
  expect(JSON.parse(sent[1]?.body ?? '{}')).toEqual({ model: 'bge-large', input: 'warm-up' })
  // The server answered with a check it still repeats (its own, or another caller's): the toast says what it read.
  expect(shown).toContain(STILL_WARMING('1.0'))
  expect(shown.some(s => /more s|up to \d+/.test(s))).toBe(false)
})

test('after a 33 s load, a server that reads ready turns the pane green and W goes', async ($, on) => {
  // Measured on 2026-10-04: an uncut load after idling took up to 32.8 s (nomic-embed-text, before W loaded bge-large).
  let loading = false
  const shown = engine(on, () => (loading ? 33_000 : 1000))
  const sent: string[] = []
  on('http.fetch', (_$, e) => {
    sent.push(e.url)
    if (e.url.endsWith('/api/embed')) {
      loading = true
      return reply(200, EMBEDDED)
    }
    return reply(200, loading ? STATUS_WARM : STATUS_COLD)
  })
  await $.command.run(ga(''))
  const ui = await $.ui.mount(PANE)
  const warm = await ui.find({ type: 'Button', text: 'Load an embedding model' })
  await ui.press({ key: warm?.key ?? 'missing' })
  expect(sent).toEqual(['http://localhost:5252/api/chatbot/status', 'http://localhost:11434/api/embed', 'http://localhost:5252/api/chatbot/status'])
  expect(shown).toContain('toast: bge-large loaded in 33.0 s; the server reads ready.')
  expect(await ui.find({ type: 'Text', text: /^ ● ollama · gpt-oss:120b-cloud/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Load an embedding model' })).toBeUndefined()
})

test('after a 24 s load, a server that still answers warming is reported as it answered, whatever the pane read before', async ($, on) => {
  let loading = false
  const shown = engine(on, () => (loading ? 24_000 : 1000))
  on('http.fetch', (_$, e) => {
    if (e.url.endsWith('/api/embed')) {
      loading = true
      return reply(200, EMBEDDED)
    }
    return reply(200, STATUS_COLD)
  })
  await $.command.run(ga(''))
  const ui = await $.ui.mount(PANE)
  const warm = await ui.find({ type: 'Button', text: 'Load an embedding model' })
  await ui.press({ key: warm?.key ?? 'missing' })
  expect(shown).toContain(STILL_WARMING('24.0'))
  expect(await ui.find({ type: 'Text', text: /^ ◌ warming up · ollama/ })).toBeDefined()
})

test('if presses run side by side (unmeasured live), a second W during a load is refused, and an R that turns green ends it', async ($, on) => {
  const shown = engine(on)
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  let warm = false
  const sent: string[] = []
  on('http.fetch', async (_$, e) => {
    sent.push(e.url)
    if (e.url.endsWith('/api/embed')) {
      await gate
      return reply(200, EMBEDDED)
    }
    return reply(200, warm ? STATUS_WARM : STATUS_COLD)
  })
  await $.command.run(ga(''))
  const ui = await $.ui.mount(PANE)
  const w = await ui.find({ type: 'Button', text: 'Load an embedding model' })
  const first = ui.press({ key: w?.key ?? 'missing' })
  await ui.press({ key: w?.key ?? 'missing' })
  expect(shown).toContain('toast: GA chatbot: still loading bge-large, for 1 s so far')
  warm = true
  const recheck = await ui.find({ type: 'Button', text: 'Recheck' })
  await ui.press({ key: recheck?.key ?? 'missing' })
  // R alone, with the load still running: green, and no W left to press.
  expect(await ui.find({ type: 'Text', text: /^ ● ollama · gpt-oss:120b-cloud/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Load an embedding model' })).toBeUndefined()
  release()
  await first
  expect(sent.filter(u => u.endsWith('/api/embed'))).toHaveLength(1)
  expect(shown).toContain('toast: bge-large loaded in 3.0 s; the server reads ready.')
})

test('a load still running at 60 s keeps W refused; at 67 s, past twice the slowest load measured, W starts another', async ($, on) => {
  let step = 1000
  const shown = engine(on, () => step)
  let release: () => void = () => {}
  const stuck = new Promise<void>(resolve => {
    release = resolve
  })
  let loads = 0
  on('http.fetch', async (_$, e) => {
    if (!e.url.endsWith('/api/embed')) return reply(200, STATUS_COLD)
    loads += 1
    if (loads === 1) await stuck
    return reply(200, EMBEDDED)
  })
  await $.command.run(ga(''))
  const ui = await $.ui.mount(PANE)
  const w = await ui.find({ type: 'Button', text: 'Load an embedding model' })
  const first = ui.press({ key: w?.key ?? 'missing' })
  step = 60_000
  await ui.press({ key: w?.key ?? 'missing' })
  expect(shown).toContain('toast: GA chatbot: still loading bge-large, for 60 s so far')
  expect(loads).toBe(1)
  step = 7000
  await ui.press({ key: w?.key ?? 'missing' })
  expect(loads).toBe(2)
  const before = shown.length
  // The first load ends after the one that replaced it: it adds no toast and leaves the status line cleared.
  release()
  await first
  expect(shown.slice(before)).toEqual([])
  expect(shown.filter(s => s.startsWith('status:')).at(-1)).toBe('status: (cleared)')
})

test('a W while the server is being asked after a load says so, not that the model is still loading', async ($, on) => {
  const shown = engine(on)
  let statusCalls = 0
  let entered: () => void = () => {}
  const asking = new Promise<void>(resolve => {
    entered = resolve
  })
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  on('http.fetch', async (_$, e) => {
    if (e.url.endsWith('/api/embed')) return reply(200, EMBEDDED)
    statusCalls += 1
    if (statusCalls === 2) {
      entered()
      await gate
      return reply(200, STATUS_WARM)
    }
    return reply(200, STATUS_COLD)
  })
  await $.command.run(ga(''))
  const ui = await $.ui.mount(PANE)
  const w = await ui.find({ type: 'Button', text: 'Load an embedding model' })
  const first = ui.press({ key: w?.key ?? 'missing' })
  await asking
  await ui.press({ key: w?.key ?? 'missing' })
  expect(shown).toContain('toast: GA chatbot: bge-large loaded; asking the server')
  expect(shown.some(s => s.includes('still loading'))).toBe(false)
  release()
  await first
  expect(shown).toContain('toast: bge-large loaded in 1.0 s; the server reads ready.')
})

test('a model Ollama lacks, or a load that fails, says which and leaves W there', async ($, on) => {
  const shown = engine(on)
  let loads = 0
  on('http.fetch', (_$, e) => {
    if (!e.url.endsWith('/api/embed')) return reply(200, STATUS_COLD)
    loads += 1
    // The body is the test's own; the mod quotes whatever Ollama answers.
    return loads === 1 ? reply(404, { error: 'model not found' }) : { deny: 'socket hang up' }
  })
  await $.command.run(ga(''))
  const ui = await $.ui.mount(PANE)
  const w = await ui.find({ type: 'Button', text: 'Load an embedding model' })
  await ui.press({ key: w?.key ?? 'missing' })
  await ui.press({ key: w?.key ?? 'missing' })
  expect(shown).toContain('toast: Ollama did not load bge-large: HTTP 404 {"error":"model not found"}')
  expect(shown.some(s => s.startsWith('toast: Loading bge-large failed:') && s.includes('socket hang up'))).toBe(true)
  expect(await ui.find({ type: 'Button', text: 'Load an embedding model' })).toBeDefined()
})

test('W loads the model the server\'s check embeds with, bge-large, not the nomic-embed-text its status names', async ($, on) => {
  // Measured on 2026-10-04 in Ollama's log: with nomic-embed-text loaded, three checks in a row cut bge-large's load at
  // 10 s (11.3, 12.1, 12.4 s) and the server read warming for over 90 s; an uncut bge-large load took 6.4 s, and the next
  // check passed in 29 ms. ChatProviderReadinessProbe.cs L129 at GA 7595983 embeds with the "routing" generator, which
  // appsettings.json L14 sets to bge-large; its status names Ollama:EmbeddingModel (L274, L315).
  let routing = false
  const shown = engine(on, () => (routing ? 6400 : 1000))
  const loaded: string[] = []
  on('http.fetch', (_$, e) => {
    if (e.url.endsWith('/api/embed')) {
      const model = (JSON.parse(e.init?.body ?? '{}') as { model?: string }).model ?? ''
      loaded.push(model)
      if (model === 'bge-large') routing = true
      return reply(200, { model, embeddings: [[0.1, 0.2]] })
    }
    return reply(200, routing ? STATUS_WARM : STATUS_COLD)
  })
  await $.command.run(ga(''))
  const ui = await $.ui.mount(PANE)
  const warm = await ui.find({ type: 'Button', text: 'Load an embedding model' })
  await ui.press({ key: warm?.key ?? 'missing' })
  expect(loaded).toEqual(['bge-large'])
  expect(shown).toContain('toast: bge-large loaded in 6.4 s; the server reads ready.')
  expect(await ui.find({ type: 'Text', text: /^ ● ollama · gpt-oss:120b-cloud/ })).toBeDefined()
})

// An answer from one of GaChatbot.Api's LLM agents (theory, tab, technique, composer, critic). The trace's shape is
// a real answer's (q3, 2026-10-04: its agent.semantic_result step carries debug.mode); the value "Agent" is GA's
// code (ProductionOrchestrator.cs L644 at 7595983), unseen live: none of 8 captured answers came from such an agent.
const step = (mode: string | null, agent: string) => ({ name: 'agent.semantic_result', status: 'completed', elapsedMs: 0, attributes: { 'agent.id': agent, 'grounding.source': null, 'candidate.count': 0, 'debug.mode': mode, 'debug.agent': mode ? agent : null } })
const BY_AGENT = { naturalLanguageAnswer: 'D Dorian is the second mode of C major.', agentId: 'theory', confidence: 0.9, routingMethod: 'semantic', elapsedMs: 4200, trace: { steps: [step('Agent', 'theory')] } }

test('an answer one of the chatbot\'s LLM agents wrote (mode "Agent" from GA\'s code, unmeasured live) says it had no GA tool', async ($, on) => {
  expect(isUnaided(parseAnswer(200, JSON.stringify(BY_AGENT)))).toBe(true)
  // A deterministic agent's answer (q3's mode) and a GA skill's (no mode) are GA's own work.
  expect(isUnaided(parseAnswer(200, JSON.stringify({ ...BY_AGENT, agentId: 'voicing', routingMethod: 'deterministic-voicing', trace: { steps: [step('DeterministicAgent', 'voicing')] } })))).toBe(false)
  expect(isUnaided(parseAnswer(200, JSON.stringify({ ...BY_AGENT, agentId: 'skill.chordinfo', routingMethod: 'orchestrator-skill-semantic', trace: { steps: [step(null, 'skill.chordinfo')] } })))).toBe(false)
  // No trace at all (an older server): nothing is claimed.
  expect(isUnaided(parseAnswer(200, JSON.stringify(ANSWER)))).toBe(false)
  // The voicing agent reaches the same branch, with the same mode, but searches GA's voicing index
  // (VoicingAgent.cs L101 at 7595983): GA's tool is behind it.
  expect(isUnaided(parseAnswer(200, JSON.stringify({ ...BY_AGENT, agentId: 'voicing', trace: { steps: [step('Agent', 'voicing')] } })))).toBe(false)

  engine(on)
  on('http.fetch', () => reply(200, BY_AGENT))
  const said = "The chatbot's theory agent answered from its model alone, with no GA skill or tool behind it: check chords with ♪ and set classes with /ga optic."
  const r = await $.command.run(ga('What is D Dorian?'))
  expect(r.text).toContain(said)
  const ui = await $.ui.mount({ plugin: 'ga-chatbot', surface: 'terminal', component: 'Pane', props: { title: 'GA chatbot', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }, requestId: 'ga' })
  expect(await ui.find({ type: 'Text', text: said })).toBeDefined()
  const turn = { id: 't', at: 0, question: 'What is D Dorian?', ...parseAnswer(200, JSON.stringify(BY_AGENT)) }
  expect(forwardText(turn)).toContain("It came from the chatbot's theory agent, its model alone without GA's tools: check its chords and numbers with GA's tools (mcp__ga__*) before relying on them.")
})
