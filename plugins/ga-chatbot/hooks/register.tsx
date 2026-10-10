import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChordSet, ChordView, ChordVoicing, GaTurn } from '../types'
import {
  BASE,
  CHAT_URL,
  clock,
  EMBED_URL,
  forwardText,
  isCloudModel,
  isUnaided,
  meta,
  oneLine,
  parseAnswer,
  parseHealth,
  quoteText,
  requestBody,
  STATUS_URL,
  unaidedText,
} from './chat'
import {
  chartText,
  chordSymbols,
  diagram,
  gaCheck,
  bassOf,
  lacks,
  ladder,
  ladderText,
  lowestOf,
  omittableFifth,
  parseFingering,
  parseSearch,
  parseSetInfo,
  rootOf,
  rootSpelling,
  setChordOf,
  spelt,
  toGaDiagram,
} from './fretboard'

// Everything that reaches the engine is in this file: the engine follows `$` only into functions
// declared here, which is how `claude plugin validate` can list all the module does.

const PANE = 'ga'
const CHORDS = 'ga-chords'
const VOICINGS = 6
const turns = atom({ plugin: 'ga-chatbot', key: 'turns' } as const, [])
const health = atom({ plugin: 'ga-chatbot', key: 'health' } as const, { checkedAt: 0, ok: false, provider: '', model: '', message: '' })
const focus = atom({ plugin: 'ga-chatbot', key: 'focus' } as const, '')
const chords = atom({ plugin: 'ga-chatbot', key: 'chords' } as const, { query: '', status: 'idle', source: '', chord: '', voicings: [], error: '' })
const unfolded = atom({ plugin: 'ga-chatbot', key: 'unfolded' } as const, [])
const ladders = atom({ plugin: 'ga-chatbot', key: 'ladders' } as const, [])
const sets = atom({ plugin: 'ga-chatbot', key: 'sets' } as const, {})

const WARMING =
  "The server's 10 s embedding check timed out. It embeds with its routing model, bge-large by default, not the nomic-embed-text its status names, and a load cut at 10 s is aborted (GA #822): on 2026-10-04 three cut loads in a row left it warming. The server repeats an answer for 30 s. W loads bge-large with no time limit, then asks the server: that night it loaded in 6.4 s and the server read ready."
// The load W started, when, and whether it has moved on to asking the server, so that a second W meanwhile is
// refused. `$.http.fetch` documents no time limit, so a load still running after STUCK_MS, twice the slowest
// measured (32.8 s, nomic-embed-text after idling; bge-large took 6.4 s), no longer blocks W.
let loading = { model: '', since: 0, asking: false }
const STUCK_MS = 66_000

const why = (err: unknown) => String(err instanceof Error ? err.message : err).slice(0, 200)

// One GET, on opening the pane or on R: the status route runs no chat model, only a catalog skill and a
// local embedding (bge-large, through Ollama).
async function checkHealth($: EngineInterface): Promise<void> {
  try {
    const r = await $.http.fetch(STATUS_URL)
    const at = await $.clock.now()
    await update($, health, () => parseHealth(r.status, r.text, at))
  } catch (err) {
    const at = await $.clock.now()
    await update($, health, () => ({ checkedAt: at, ok: false, provider: '', model: '', message: `not reachable at ${BASE}: ${why(err)}` }))
  }
}

// The model the server's check embeds with: its "routing" generator (ChatProviderReadinessProbe.cs L129 at GA
// 7595983), bge-large in appsettings.json L14, and bge-large in Ollama's log of the running server. The status
// names another, Ollama:EmbeddingModel (L274, L315), and exposes no routing model: a server configured with
// another routing model, or none (then the check embeds with the status's model), makes this constant wrong.
const CHECK_MODEL = 'bge-large'

// W, while warming: one embedding of CHECK_MODEL through the local Ollama with no time limit. Ollama's log of
// 2026-10-04: the check cuts a cold bge-large's load at 10 s and the cut aborts it (GA #822). That afternoon,
// after uncut loads of the status's model (nomic-embed-text, 24.0 s and 32.8 s), the next check loaded bge-large
// in 5.3-5.7 s and passed; that night, with nomic-embed-text loaded, three cut loads of bge-large in a row (11.3
// to 12.4 s) left it warming for over 90 s. An uncut bge-large load took 6.4 s, and the next check passed in
// 29 ms. The load runs the embedding model only, not the chat model.
async function warmUp($: EngineInterface, model: string): Promise<void> {
  const start = await $.clock.now()
  if (loading.model && start - loading.since < STUCK_MS) {
    $.ui.toast(
      loading.asking
        ? `GA chatbot: ${loading.model} loaded; asking the server`
        : `GA chatbot: still loading ${loading.model}, for ${Math.round((start - loading.since) / 1000)} s so far`,
    )
    return
  }
  loading = { model, since: start, asking: false }
  try {
    $.ui.status(`GA chatbot: loading ${model}…`)
    const r = await $.http.fetch(EMBED_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: 'warm-up' }),
    })
    // Replaced after STUCK_MS: the load that replaced it reports.
    if (loading.since !== start) return
    const took = (((await $.clock.now()) - start) / 1000).toFixed(1)
    if (r.status < 200 || r.status > 299) {
      $.ui.toast(`Ollama did not load ${model}: HTTP ${r.status} ${r.text.trim().slice(0, 120)}`)
      return
    }
    // Ask rather than guess: the server repeats a check's answer for 30 s after it ends, and the check may be
    // another caller's, started before the load ended (ChatProviderReadinessProbe.cs L136-L145 at GA 7595983).
    loading = { ...loading, asking: true }
    $.ui.status('GA chatbot: asking the server…')
    await checkHealth($)
    const now = await read($, health)
    $.ui.toast(
      now.ok
        ? `${model} loaded in ${took} s; the server reads ready.`
        : now.warming
          ? `${model} loaded in ${took} s, but the server still reads warming up; it repeats an answer for 30 s after its check: press R again after that.`
          : `${model} loaded in ${took} s.`,
    )
  } catch (err) {
    $.ui.toast(`Loading ${model} failed: ${why(err)}`)
  } finally {
    // A load W gave up on after STUCK_MS leaves the guard and the status line to the one that replaced it.
    if (loading.since === start) {
      loading = { model: '', since: 0, asking: false }
      $.ui.status(undefined)
    }
  }
}

// One question, one POST. The answer replaces the pending turn; nothing retries on its own.
async function ask($: EngineInterface, question: string): Promise<GaTurn | undefined> {
  const q = question.trim()
  if (!q) return undefined
  const list = await read($, turns)
  if (list.some(t => t.status === 'pending')) {
    $.ui.toast('GA chatbot: still answering the previous question')
    return undefined
  }
  const at = await $.clock.now()
  const id = `${at.toString(36)}-${list.length}`
  const pending: GaTurn = { id, at, question: q, status: 'pending', answer: '', agentId: '', confidence: 0, routing: '', elapsedMs: 0, grounding: '', error: '' }
  await update($, turns, all => [...all, pending].slice(-30))
  await update($, focus, () => '')
  $.ui.status('GA chatbot: thinking…')
  let patch: Partial<GaTurn>
  try {
    const r = await $.http.fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: requestBody(q, list),
    })
    patch = parseAnswer(r.status, r.text)
  } catch (err) {
    patch = { status: 'error', error: `not reachable at ${BASE}: ${why(err)}` }
  } finally {
    $.ui.status(undefined)
  }
  await update($, turns, all => all.map(t => (t.id === id ? { ...t, ...patch } : t)))
  return (await read($, turns)).find(t => t.id === id)
}

async function forward($: EngineInterface, id: string): Promise<void> {
  const t = (await read($, turns)).find(x => x.id === id)
  if (!t || t.status !== 'done') return
  const r = await $.prompt.submit({ text: forwardText(t) })
  $.ui.toast(r.drop !== undefined ? `Not forwarded: ${r.drop.slice(0, 120)}` : 'Forwarded to the model')
}

async function quote($: EngineInterface, id: string): Promise<void> {
  const t = (await read($, turns)).find(x => x.id === id)
  if (!t || t.status !== 'done') return
  const r = await $.prompt.fill({ text: quoteText(t), mode: 'append' })
  $.ui.toast(r.isFilled ? 'Copied into the prompt' : `Prompt unavailable${r.refusal ? ` (${r.refusal})` : ''}`)
}

// --- Chords: GA's offline voicing index and its set theory ----------------------------------------

// A tool's answer as text: what the model would read. A failure comes back as `error`; `refused` says it
// came as a deny, the permission check's channel (or a hook's), and not from GA, whatever its words.
type Answer = { text: string; error: string; refused: boolean }

function answerOf(r: { deny?: string | undefined; text?: string | undefined; result?: unknown; isError?: boolean | undefined }): Answer {
  if (r.deny !== undefined) return { text: '', error: r.deny, refused: true }
  const text = typeof r.text === 'string' ? r.text : typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? '')
  return r.isError ? { text: '', error: text.slice(0, 200), refused: false } : { text, error: '', refused: false }
}

// What the user did that raised a GA call, in their own words, which the engine carries as a human turn.
// Measured 2026-10-04 in auto mode: the classifier refused the mod's own calls ("gave no verdict"), on
// /ga chord with this consent too; once the user allowed the two tools in /permissions, they ran. The
// presses with consent alone are unmeasured. The model's own tool passes no consent, and is handed GA's
// answers in its arguments instead.
type Consent = string | undefined
const consentOf = (consent: Consent) => (consent ? { consent } : {})

const RULES = 'mcp__ga__ga_search_voicings and mcp__ga__ga_chord_to_set'

// What the user reads when GA could not be asked: the classifier's own text is written for the model.
const refusalText = (tool: string) => `the permission check refused the mod's call to ${tool}. To let /ga ask GA, allow ${RULES} in /permissions.`

// ga_search_voicings reads GA's mmap index offline; it calls no model unless asked to (allowSampling).
async function searchVoicings($: EngineInterface, query: string, consent: Consent): Promise<Answer> {
  try {
    return answerOf(await $.tool.call({ tool: 'mcp__ga__ga_search_voicings', query, limit: VOICINGS, instrument: 'guitar', allowSampling: false, ...consentOf(consent) }))
  } catch (err) {
    return { text: '', error: why(err), refused: false }
  }
}

async function chordToSet($: EngineInterface, symbol: string, consent: Consent): Promise<Answer> {
  try {
    return answerOf(await $.tool.call({ tool: 'mcp__ga__ga_chord_to_set', symbol, ...consentOf(consent) }))
  } catch (err) {
    return { text: '', error: why(err), refused: false }
  }
}

// How many lookups have started. One that started earlier can land later (the command or the model's tool
// waiting on GA while the user draws another chord in the pane): it leaves the pane to the newer one. The
// module's own variable: a reload starts it over, so a lookup running across a reload is not ordered.
let lookups = 0

type Lookup = { view: ChordView; current: () => boolean; refused: boolean }

// A chord symbol goes to GA's index, unless GA's answer is given (the model asked GA itself); a
// fingering typed in (x32010) is drawn without asking anyone. Resolves to what it found, whether it is still
// the newest lookup (the pane shows the newest), and whether the permission check refused the call to GA.
async function lookUp($: EngineInterface, query: string, consent: Consent, given?: string): Promise<Lookup> {
  const q = query.trim()
  if (!q) return { view: { query: '', status: 'idle', source: '', chord: '', voicings: [], error: '' }, current: () => false, refused: false }
  const mine = ++lookups
  const current = () => mine === lookups
  // Each write checks as it runs that no newer lookup has started.
  const show = async (view: ChordView, open?: string[]) => {
    await update($, chords, cur => (current() ? view : cur))
    if (open) await update($, unfolded, cur => (current() ? open : cur))
  }
  const stamp = (await $.clock.now()).toString(36)
  const typed = parseFingering(q)
  if (typed) {
    const id = `${stamp}-0`
    const view: ChordView = { query: q, status: 'done', source: 'fingering', chord: '', voicings: [{ id, name: chartText(typed), frets: typed, score: 0, missing: [] }], error: '' }
    await show(view, [id])
    return { view, current, refused: false }
  }
  await show({ query: q, status: 'pending', source: '', chord: '', voicings: [], error: '' })
  const r = given !== undefined ? { text: given, error: '', refused: false } : await searchVoicings($, q, consent)
  const parsed = r.error ? { chord: '', wanted: [], root: undefined, voicings: [], error: r.error } : parseSearch(r.text)
  if (parsed.error) {
    const view: ChordView = {
      query: q,
      status: 'error',
      source: 'ga',
      chord: '',
      voicings: [],
      error: `GA's voicing index: ${r.refused ? refusalText('mcp__ga__ga_search_voicings') : parsed.error} A fingering such as x32010 is drawn without GA.`,
    }
    await show(view)
    return { view, current, refused: r.refused }
  }
  const voicings: ChordVoicing[] = parsed.voicings.map((v, i) => ({ id: `${stamp}-${i}`, name: v.name, frets: v.frets, score: v.score, missing: v.missing }))
  const root = parsed.root
  const view: ChordView = { query: q, status: 'done', source: 'ga', chord: parsed.chord, voicings, error: '', wanted: parsed.wanted, ...(root === undefined ? {} : { root }) }
  await show(view, voicings.slice(0, 1).map(v => v.id))
  return { view, current, refused: false }
}

// The model may call GA's tools where the mod may not: the mod's own call carries no request of the
// user's. So it is told the exact calls to make and how to bring their answers back.
// The ladder's set is asked for once the voicings are known: it is the first voicing's chord, which need not
// be the one asked (GA answered Am7 with Am triads).
function handOver(chord: string, withLadder: boolean): string {
  const search = JSON.stringify({ query: chord.trim(), limit: VOICINGS, instrument: 'guitar', allowSampling: false })
  return [
    'chord_diagram could not ask GA itself: the permission check refused its call.',
    `Call mcp__ga__ga_search_voicings with ${search}, then call chord_diagram again with the same arguments plus ga_voicings, its answer, verbatim.`,
    withLadder ? 'chord_diagram will then name the ga_chord_to_set call its ladder needs.' : '',
  ].filter(Boolean).join(' ')
}

// A slash chord is asked without its bass.
const symbolOf = (name: string) => name.split('/')[0]?.trim() ?? ''

// GA's own reading of a chord symbol, asked once per symbol, or taken from its answer when given. A
// failure is kept to be shown, not to be served: the next press asks again.
async function setOf($: EngineInterface, name: string, consent: Consent, given?: string): Promise<ChordSet | undefined> {
  const symbol = symbolOf(name)
  if (!symbol) return undefined
  const known = (await read($, sets))[symbol]
  if (known && !known.error && given === undefined) return known
  const r = given !== undefined ? { text: given, error: '', refused: false } : await chordToSet($, symbol, consent)
  const info: ChordSet = r.error ? { forte: '', icv: '', prime: '', modal: '', error: r.error, refused: r.refused } : { ...parseSetInfo(r.text), error: '', refused: false }
  await update($, sets, all => ({ ...all, [symbol]: info }))
  return info
}

// Opens or folds a voicing's ladder; opening one of GA's voicings asks GA for its set, and returns what it said.
async function toggleLadder($: EngineInterface, v: ChordVoicing, fromGa: boolean, consent: Consent): Promise<ChordSet | undefined> {
  const open = (await read($, ladders)).includes(v.id)
  await update($, ladders, cur => (open ? cur.filter(x => x !== v.id) : [...cur, v.id]))
  return !open && fromGa ? setOf($, v.name, consent) : undefined
}

// Voicings left by 0.2.2 have no notes recorded as missing.
const missingOf = (v: ChordVoicing) => v.missing ?? []

// The bass a slash chord asks for, read when drawing (so state from 0.2.6 gets it too): from GA's reading
// of the symbol, else from what was typed, which keeps it when GA's reading drops the slash.
const askedBass = (view: ChordView) => (view.source === 'ga' ? (bassOf(view.chord) ?? bassOf(view.query)) : undefined)

// A voicing's lowest note when a slash chord asked for another bass, else undefined.
function offBass(view: ChordView, v: ChordVoicing): number | undefined {
  const bass = askedBass(view)
  const low = bass === undefined ? undefined : lowestOf(v.frets)
  return low === undefined || low === bass?.pc ? undefined : low
}

// The chord's root as the symbol typed writes it, else as GA's reading writes it, when its pitch class agrees
// with GA's root; else GA's pitch class alone.
function rootFor(view: ChordView): ReturnType<typeof rootSpelling> | number | undefined {
  for (const symbol of [view.query, view.chord]) {
    const named = rootSpelling(symbol)
    if (named && (view.root === undefined || named.pc === view.root)) return named
  }
  return view.root
}

// The notes a voicing must hold and does not: GA's notes it lacks, less a four-note chord's perfect 5th.
function requiredOf(view: ChordView, v: ChordVoicing): number[] {
  const fifth = omittableFifth(view.wanted ?? [], view.root)
  return missingOf(v).filter(pc => pc !== fifth)
}

// Whether a voicing holds the chord asked: every required note, over the bass asked.
const holds = (view: ChordView, v: ChordVoicing) => requiredOf(view, v).length === 0 && offBass(view, v) === undefined

// What a voicing lacks of the chord asked, its bass when a slash chord asked for another, and the 5th it leaves
// out; '' when it holds every note GA read, over the bass asked. Charts name the chord (`of`); the rows do not.
function lackOf(view: ChordView, v: ChordVoicing, of = true): string {
  const missing = requiredOf(view, v)
  const low = offBass(view, v)
  const root = rootFor(view)
  const fifth = omittableFifth(view.wanted ?? [], view.root)
  const omits = fifth !== undefined && missingOf(v).includes(fifth) ? `omits the 5 (${spelt(fifth, root)})` : ''
  const bassFirst = !missing.length && of
  const bass = low === undefined ? '' : `has ${spelt(low, root)} in the bass, not ${bassFirst ? 'the ' : ''}${askedBass(view)?.name ?? ''}`
  const [first, ...rest] = [missing.length ? lacks(missing, root) : '', bass, omits].filter(Boolean)
  if (!first) return ''
  return `${first}${of ? ` of ${view.chord || view.query}` : ''}${rest.length ? `, and ${rest.join(', and ')}` : ''}`
}

// More notes than a guitar has strings: no voicing can hold them all, whatever GA returns.
const STRINGS = 6
const notesOf = (view: ChordView) => (view.wanted ?? []).length

// What holding the chord asked means: its notes, over its bass for a slash chord.
function heldText(view: ChordView): string {
  const bass = askedBass(view)
  return `every note of ${view.chord || view.query}${bass ? ` with ${bass.name} in the bass` : ''}`
}

// Whether GA's voicings were checked against the notes it read, and whether any holds them all.
function coverage(view: ChordView): 'ok' | 'none' | 'unchecked' {
  if (view.source !== 'ga' || view.voicings.length === 0) return 'ok'
  if (!(view.wanted ?? []).length) return 'unchecked'
  return view.voicings.some(v => holds(view, v)) ? 'ok' : 'none'
}

// GA's set class beside the one computed here, or why GA could not be asked.
function gaLine(v: ChordVoicing, info: ChordSet | undefined): string {
  if (!info) return ''
  if (info.refused) return `GA's ga_chord_to_set: ${refusalText('mcp__ga__ga_chord_to_set')}`
  return info.error ? `GA's ga_chord_to_set: ${info.error}` : gaCheck(v.frets, info)
}

// What the command and the model's tool print, from their own lookup's view (the pane may show a newer one):
// each voicing's chart, then the first one's ladder. `setAsked`: GA's answer for the first voicing's set when
// the caller has just asked, so a failure is not asked again at once.
async function chordReport($: EngineInterface, view: ChordView, withLadder: boolean, max: number, consent: Consent, setAsked?: ChordSet): Promise<string> {
  if (view.status === 'error') return view.error
  if (view.voicings.length === 0) return `Nothing found for ${view.query}.`
  const asked = view.chord || view.query
  const titled = (v: ChordVoicing, i: number) => [`${i + 1}. ${v.name}`, `GA ${toGaDiagram(v.frets)}`, lackOf(view, v)].filter(Boolean).join('   ')
  const parts = view.voicings.slice(0, max).map((v, i) => diagram(v.frets, titled(v, i), rootFor(view)))
  const covered = coverage(view)
  if (covered === 'none') parts.unshift(`GA's index returned no voicing that holds ${heldText(view)}${notesOf(view) > STRINGS ? `: it has ${notesOf(view)} notes, more than a guitar's ${STRINGS} strings` : ''}.`)
  if (covered === 'unchecked') parts.unshift(`GA did not say which notes ${asked} holds, so these voicings were not checked against it.`)
  const first = view.voicings[0]
  if (withLadder && first) {
    const info = view.source === 'ga' ? (setAsked ?? (await setOf($, first.name, consent))) : undefined
    const lack = lackOf(view, first)
    parts.push(`OPTIC-K ladder of ${first.name}${lack ? ` (the voicing drawn, which ${lack})` : ''}\n${ladderText(ladder(first.frets, info && !info.error ? info : undefined, rootFor(view)))}`)
    const line = gaLine(first, info)
    if (line) parts.push(line)
  }
  return parts.join('\n\n')
}

const DIAGRAM_DESCRIPTION = [
  'Draw ASCII chord diagrams for a chord symbol (Cmaj7, F#m7b5, Bb7/D) from GA\'s offline voicing index (ga_search_voicings, no model runs),',
  'or for a fingering in chart order, low E first (x32010, or "x 10 12 12 11 x").',
  'With ladder: true, adds the OPTIC-K ladder of the first voicing: pitches, then octave, permutation, cardinality, transposition, inversion and complement,',
  'with GA\'s Forte number and interval vector checked against the ones computed here.',
  'When it cannot ask GA itself, it names the GA calls to make and takes their answers as ga_voicings and ga_set.',
].join(' ')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ga',
      description: 'Guitar Alchemist: /ga opens the chatbot, /ga <question> asks it, /ga chord <Cmaj7|x32010> draws voicings, /ga optic <…> climbs the OPTIC-K ladder',
    })
    try {
      await $.tool.register({
        name: 'chord_diagram',
        description: DIAGRAM_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            chord: { type: 'string', description: 'A chord symbol (Cmaj7) or a fingering in chart order (x32010)' },
            ladder: { type: 'boolean', description: 'Also climb the OPTIC-K ladder of the first voicing' },
            limit: { type: 'integer', description: 'How many voicings to draw, 1 to 6 (default 3)' },
            ga_voicings: { type: 'string', description: 'mcp__ga__ga_search_voicings\'s answer for this chord, verbatim, when chord_diagram asked for it' },
            ga_set: { type: 'string', description: 'mcp__ga__ga_chord_to_set\'s answer for this chord, verbatim, when chord_diagram asked for it' },
          },
          required: ['chord'],
          additionalProperties: false,
        },
      })
    } catch {
      // The session is not bound yet: the tool comes with the next start.
    }
    return next(e)
  })

  // A RegExp: the tool's literal name joins the engine's types only once the mod has loaded.
  on('tool.call', { tool: /^mcp__ga-chatbot__chord_diagram$/ }, async ($, e) => {
    const args: Record<string, unknown> = { ...e }
    const text = (key: string) => {
      const value = args[key]
      return typeof value === 'string' ? value : undefined
    }
    const chord = text('chord') ?? ''
    if (!chord.trim()) return { deny: 'chord_diagram needs a chord symbol or a fingering.' }
    const limit = typeof args['limit'] === 'number' ? Math.min(VOICINGS, Math.max(1, Math.round(args['limit']))) : 3
    const withLadder = args['ladder'] === true
    // No consent: the request is the model's.
    const { view, current, refused } = await lookUp($, chord, undefined, text('ga_voicings'))
    if (refused) {
      // The model asks GA next: an open pane says it is looking, not what to allow.
      await update($, chords, (cur): ChordView => (current() ? { ...cur, status: 'pending', error: '' } : cur))
      return { deny: handOver(chord, withLadder) }
    }
    if (view.status === 'error') return { deny: view.error }
    const first = view.source === 'ga' ? view.voicings[0] : undefined
    const symbol = first ? symbolOf(first.name) : ''
    // GA's answer is taken only for the chord the ladder climbs: another one would be cached under it.
    const givenSet = text('ga_set')
    const about = givenSet === undefined ? '' : setChordOf(givenSet)
    const wrongSet = about !== '' && about !== symbol
    if (withLadder && first && givenSet !== undefined && !wrongSet) await setOf($, first.name, undefined, givenSet)
    const report = await chordReport($, view, withLadder, limit, undefined)
    const info = withLadder && first ? (await read($, sets))[symbol] : undefined
    const notes = [
      wrongSet ? `The ga_set given is GA's answer for ${about}, but the ladder is of ${symbol}.` : '',
      wrongSet || info?.refused ? `To check the ladder against GA, call mcp__ga__ga_chord_to_set with ${JSON.stringify({ symbol })} and pass its answer as ga_set.` : '',
    ].filter(Boolean)
    return { result: [report, ...notes].join('\n\n') }
  })

  on('command.run', { command: 'ga' }, async ($, e) => {
    const args = e.args.trim()
    const [verb = '', ...rest] = args.split(/\s+/)
    const kind = verb.toLowerCase()
    if (kind === 'chord' || kind === 'chords' || kind === 'optic') {
      const query = rest.join(' ')
      if (!query) return { text: 'Name a chord or a fingering: /ga chord Cmaj7, /ga chord x32010, /ga optic Am7.' }
      const consent = `The user typed "/ga ${args}", which draws guitar voicings of ${query} from GA's voicing index${kind === 'optic' ? ' and asks GA for its set class' : ''}.`
      const { view, current } = await lookUp($, query, consent)
      let setAsked: ChordSet | undefined
      if (kind === 'optic') {
        const first = view.voicings[0]
        if (first) setAsked = await toggleLadder($, first, view.source === 'ga', consent)
      }
      const placed = await $.ui.open({ id: CHORDS, title: 'GA chords', focus: true })
      // Shown to the user only: command output does not reach the model.
      if (!placed.isPlaced) return { text: await chordReport($, view, kind === 'optic', 3, consent, setAsked) }
      if (view.status === 'error') return { text: view.error }
      const covered = coverage(view)
      const asked = view.chord || query
      const notes = covered === 'none' ? `; none holds ${heldText(view)}${notesOf(view) > STRINGS ? ` (${notesOf(view)} notes, ${STRINGS} strings)` : ''}` : covered === 'unchecked' ? '; GA named no notes, so none were checked' : ''
      return { text: `GA chords open: ${view.voicings.length} voicing(s) for ${query}${notes}${current() ? '' : '; the pane shows a chord drawn since'}.` }
    }
    const opened = await $.ui.open({ id: PANE, title: 'GA chatbot', focus: true })
    if (!args) {
      await checkHealth($)
      return { text: opened.isPlaced ? 'GA chatbot open: type a question below, R rechecks the server, N starts over.' : `GA chatbot: widen the terminal to see the pane, or ask with /ga <question>.` }
    }
    const t = await ask($, args)
    if (!t) return { text: 'GA chatbot: nothing asked.' }
    if (t.status === 'error') return { text: `GA chatbot: ${t.error}` }
    return { text: `GA chatbot (${meta(t)}):\n${isUnaided(t) ? `${unaidedText(t)}\n\n` : ''}${t.answer}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = table
    const Input = 'Input' in table ? table.Input : undefined // the mobile app draws no field yet
    const list = await read($, turns)
    const server = await read($, health)
    const wanted = await read($, focus)
    const shown = list.find(t => t.id === wanted) ?? list[list.length - 1]
    const busy = list.some(t => t.status === 'pending')
    const named = shown?.status === 'done' ? chordSymbols(shown.answer) : []

    const status = server.checkedAt
      ? `${server.ok ? '●' : server.warming ? '◌ warming up ·' : '⚠'} ${server.provider || 'server'}${server.model ? ` · ${server.model}${isCloudModel(server.model) ? ' (Ollama Cloud: runs on ollama.com, on your quota)' : ''}` : ''} · checked ${clock(server.checkedAt)}`
      : 'not checked yet'

    // Earlier questions, one line each, newest last, as many as leave room for the open answer.
    const room = Math.max(0, (e.viewport?.rows ?? 30) - 14)
    const earlier = list.filter(t => t !== shown).slice(-room)

    return (
      <Box flexDirection="column">
        <Box>
          <Button key="health" hotkey="r" label="Recheck" onPress={() => checkHealth($)} />
          <Text> </Text>
          {server.warming ? (
            <Box key="warm-box">
              <Button key="warm" hotkey="w" label="Load an embedding model" onPress={() => warmUp($, CHECK_MODEL)} />
              <Text> </Text>
            </Box>
          ) : null}
          <Button
            key="new"
            hotkey="n"
            label="New conversation"
            onPress={async () => {
              await update($, turns, all => all.filter(t => t.status === 'pending'))
              await update($, focus, () => '')
            }}
          />
          <Text {...(server.checkedAt ? { color: server.ok ? 'green' : 'yellow' } : { dimColor: true })} wrap="truncate-end">
            {' '}
            {status}
          </Text>
        </Box>
        {server.checkedAt > 0 && !server.ok && (
          <Text color="yellow" wrap={server.warming ? 'wrap' : 'truncate-end'}>
            {server.warming ? WARMING : server.message}
          </Text>
        )}
        {earlier.map(t => (
          <Box key={`row-${t.id}`}>
            <Button key={`focus-${t.id}`} plain dimColor label="▸" onPress={() => update($, focus, () => t.id)} />
            <Text dimColor wrap="truncate-end">
              {' '}
              {clock(t.at)} {oneLine(t.question, 60)}
              {t.status === 'done' ? ` → ${oneLine(t.answer, 80)}` : t.status === 'error' ? ' → error' : ' → …'}
            </Text>
          </Box>
        ))}
        {shown && (
          <Box key={`turn-${shown.id}`} flexDirection="column">
            <Text bold wrap="truncate-end">
              {clock(shown.at)} You: {shown.question}
            </Text>
            {shown.status === 'pending' && <Text dimColor>The chatbot is thinking…</Text>}
            {shown.status === 'error' && <Text color="red">{shown.error}</Text>}
            {shown.status === 'done' && isUnaided(shown) && (
              <Text key={`unaided-${shown.id}`} color="yellow" wrap="wrap">
                {unaidedText(shown)}
              </Text>
            )}
            {shown.status === 'done' && <Markdown key={`answer-${shown.id}`} text={shown.answer.slice(0, 9000)} />}
            {shown.status === 'done' && (
              <Text dimColor wrap="truncate-end">
                {meta(shown)}
              </Text>
            )}
            {named.length > 0 && (
              <Box key={`named-${shown.id}`}>
                <Text dimColor>Diagrams: </Text>
                {named.map(symbol => (
                  <Box key={`chord-${shown.id}-${symbol}`}>
                    <Button
                      key={`draw-${shown.id}-${symbol}`}
                      plain
                      label={`♪ ${symbol}`}
                      onPress={async () => {
                        await $.ui.open({ id: CHORDS, title: 'GA chords', focus: true })
                        await lookUp($, symbol, `The user pressed "♪ ${symbol}" under a GA chatbot answer, which draws guitar voicings of ${symbol} from GA's voicing index.`)
                      }}
                    />
                    <Text> </Text>
                  </Box>
                ))}
              </Box>
            )}
            {shown.status === 'done' && (
              <Box>
                <Button key={`fwd-${shown.id}`} hotkey="1" variant="primary" label="Forward to model" onPress={() => forward($, shown.id)} />
                <Text> </Text>
                <Button key={`quote-${shown.id}`} hotkey="2" label="Copy to prompt" onPress={() => quote($, shown.id)} />
              </Box>
            )}
          </Box>
        )}
        {!shown && <Text dimColor>No question yet. Answers come from {BASE}; each one runs the chatbot's model.</Text>}
        {Input ? (
          <Input
            key="question"
            label="Ask GA: "
            placeholder={busy ? 'waiting for the answer…' : 'a music theory or guitar question'}
            submitLabel="ask"
            autoFocus
            onSubmit={value => ask($, value)}
          />
        ) : (
          <Text dimColor>Ask with /ga followed by your question.</Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: CHORDS }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Code } = table
    const Input = 'Input' in table ? table.Input : undefined
    const view = await read($, chords)
    const open = await read($, unfolded)
    const climbing = await read($, ladders)
    const known = await read($, sets)
    const fromGa = view.source === 'ga'
    const toggle = (id: string) => update($, unfolded, cur => (cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]))

    const sections: JSX.Element[] = []
    view.voicings.forEach((v, i) => {
      const isOpen = open.includes(v.id)
      const climbed = climbing.includes(v.id)
      const info = fromGa ? known[v.name.split('/')[0]?.trim() ?? ''] : undefined
      sections.push(
        <Box key={`head-${v.id}`}>
          <Button key={`fold-${v.id}`} plain label={`${isOpen ? '▾' : '▸'} ${i + 1}. ${v.name}`} onPress={() => toggle(v.id)} />
          {lackOf(view, v, false) && (
            <Text {...(holds(view, v) ? { dimColor: true } : { color: 'yellow' })}>
              {'  '}
              {lackOf(view, v, false)}
            </Text>
          )}
          <Text dimColor wrap="truncate-end">
            {'  '}
            {chartText(v.frets)}
            {fromGa ? ` · GA ${toGaDiagram(v.frets)} · score ${v.score.toFixed(2)}` : ' · typed fingering'}
          </Text>
        </Box>,
      )
      if (!isOpen) return
      const lack = lackOf(view, v)
      sections.push(<Code key={`chart-${v.id}`} source={diagram(v.frets, [v.name, `GA ${toGaDiagram(v.frets)}`, lack].filter(Boolean).join('   '), rootFor(view))} language="text" />)
      sections.push(
        <Box key={`climb-${v.id}`} paddingLeft={2}>
          <Button
            key={`ladder-${v.id}`}
            plain
            label={`${climbed ? '▾' : '▸'} OPTIC-K ladder`}
            onPress={() => toggleLadder($, v, fromGa, `The user pressed "OPTIC-K ladder" under ${v.name} in the GA chords pane, which asks GA for that chord's set class.`)}
          />
        </Box>,
      )
      if (climbed) {
        if (lack) {
          sections.push(
            <Text key={`whose-${v.id}`} {...(holds(view, v) ? { dimColor: true } : { color: 'yellow' })} wrap="wrap">
              This ladder is of the voicing drawn, {v.name}, which {lack}.
            </Text>,
          )
        }
        sections.push(<Code key={`rungs-${v.id}`} source={ladderText(ladder(v.frets, info && !info.error ? info : undefined, rootFor(view)))} language="text" />)
        const line = gaLine(v, info)
        if (line) {
          sections.push(
            <Text key={`ga-${v.id}`} {...(info?.error ? { color: 'yellow' } : { dimColor: true })} wrap="wrap">
              {line}
            </Text>,
          )
        } else if (fromGa) {
          sections.push(
            <Text key={`ga-${v.id}`} dimColor>
              Asking GA for the set class…
            </Text>,
          )
        }
      }
    })

    return (
      <Box flexDirection="column">
        {Input ? (
          <Input key="chord-query" label="Chord or fingering: " placeholder="Cmaj7, F#m7b5, Bb7/D, or x32010 (low E first)" submitLabel="draw"
            onSubmit={value => lookUp($, value, `The user typed "${value.trim()}" in the GA chords pane and pressed draw, which looks it up in GA's voicing index.`)}
          />
        ) : (
          <Text dimColor>Draw a chord with /ga chord Cmaj7, or a fingering with /ga chord x32010.</Text>
        )}
        {view.status === 'idle' && <Text dimColor>Voicings come from GA's offline index (ga_search_voicings, no model runs); a fingering is drawn here.</Text>}
        {view.status === 'pending' && <Text dimColor>Looking up {view.query} in GA's voicing index…</Text>}
        {view.status === 'error' && <Text color="yellow">{view.error}</Text>}
        {view.status === 'done' && (
          <Text dimColor wrap="truncate-end">
            {fromGa ? `${view.voicings.length} voicing(s) from GA's index for ${view.query}${view.chord && view.chord !== view.query ? ` (read as ${view.chord})` : ''}` : `fingering ${view.query}, low E first`}
            {coverage(view) === 'none' ? ` · none holds ${heldText(view)}${notesOf(view) > STRINGS ? ` (${notesOf(view)} notes, ${STRINGS} strings)` : ''}` : coverage(view) === 'unchecked' ? ` · notes not checked: GA named none for ${view.chord || view.query}` : ''}
          </Text>
        )}
        {sections}
      </Box>
    )
  })
}
