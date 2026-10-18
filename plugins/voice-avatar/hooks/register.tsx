import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Heard, Outcome, Running, Speaker, Step, Usage, Voices } from '../types'

// The voice plugin's tools (piper-voice, voice_courtesy.ps1, voice_listen.ps1) leave their state
// in small files under their data folders; a file not rewritten for FRESH_MS belongs to a tool
// that stopped. This plugin only reads them, and writes the listener's pause and stop files.
const FRESH_MS = 3000
const POLL_MS = 200
const LEVEL_FRESH_MS = 1000 // the mic level is rewritten every 200 ms while listening
const LAST_SHOWN_MS = 5000
const WINK_MS = 1500
const LEVELS = 10 // the band's 2 s of meter
const KEPT_LEVELS = 100 // the pane's 20 s, shown as wide as the pane is
const KEPT = 8 // utterances and steps the pane lists
const USAGE_POLLS = 10 // the cost is read every 10th poll, 2 s

// A peak this loud is a voice, not the room (-26 dB).
export const HEARD = 0.05
const BARS = '▁▂▃▄▅▆▇█'
const OUTCOMES: readonly Outcome[] = ['sent', 'typed', 'ignored', 'piper', 'dropped', 'held']
const WINK_COLOR = '#ff5fd7'
const PAUSE_COLOR = '#ffaf00'
const QUESTION_COLOR = '#ff5f5f'
const LIT = '#5fff5f' // the place what is said goes
const MOVED_MS = 3000
// While Claude works: a braille spinner whose color walks a warm-to-cool ring.
export const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const SPIN_COLORS = ['#ffd75f', '#ffaf5f', '#ff875f', '#ff5f87', '#d75fd7', '#875fff', '#5f87ff', '#5fafff', '#5fd7d7', '#87d787']
const PANE = 'voice-avatar'

const voices = atom({ plugin: 'voice-avatar', key: 'voices' } as const, null)
const tool = atom({ plugin: 'voice-avatar', key: 'tool' } as const, null)
const history = atom({ plugin: 'voice-avatar', key: 'history' } as const, [])
const steps = atom({ plugin: 'voice-avatar', key: 'steps' } as const, [])
const usage = atom({ plugin: 'voice-avatar', key: 'usage' } as const, null)
const NO_USAGE: Usage = { context: null, fiveHour: null, sevenDay: null, usd: null, turnIn: 0, turnOut: 0 }
let voiceHome = '' // piper-voice's data folder, with forward slashes, once session.start found it
let listenHome = '' // the listener's
let windows = false
let workingSince: number | null = null // when the main loop's running turn began
let mood: Voices['mood'] = null // set when the main loop's turn ends, cleared when one starts
let yesNo = false // that question is answered by yes or no
let asking = false // its AskUserQuestion dialog is open
let mainTool: string | null = null // the tool the main loop runs

// A 3D bot can mirror this one from a file it polls (the faceFile option, off when empty); a "t"
// over 10 s old reads there as offline, so it is rewritten on each change and at least every
// FACE_BEAT_MS.
const FACE_BEAT_MS = 3000
let faceSaid = ''
let faceAt = 0
let faceWriting = false

export type Face = { state: 'idle' | 'working' | 'waiting' | 'done' | 'failed'; tool: string | null }

/** What the 3D bot is shown of Claude: a state and a tool's name, never a prompt, an argument or a path. */
export function faceOf(working: boolean, tool: string | null, mood: Voices['mood'], asks: boolean): Face {
  const state = asks ? 'waiting' : working ? 'working' : mood === 'oops' ? 'failed' : mood === null ? 'idle' : 'done'
  return { state, tool: state === 'working' ? tool : null }
}

// Written whole beside it, then moved over it: the 3D view never reads half a file.
async function writeFace($: EngineInterface, now: number, face: Face, file: string, session: string) {
  const said = JSON.stringify(face)
  if (faceWriting || (said === faceSaid && now - faceAt < FACE_BEAT_MS)) return
  faceWriting = true
  try {
    await $.fs.write(`${file}.tmp`, JSON.stringify({ v: 1, t: now, ...face, session }))
    await $.process.run(windows
      ? ['cmd', '/c', 'move', '/y', `${file}.tmp`.replace(/\//g, '\\'), file.replace(/\//g, '\\')]
      : ['mv', '-f', `${file}.tmp`, file])
    faceSaid = said
    faceAt = now
  } finally {
    faceWriting = false
  }
}

/** Whether an answer ends on a question for the user: its last line ends with "?". */
export function asksQuestion(text: string): boolean {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  return /\?[\s*_`»"')\]]*$/.test(lines[lines.length - 1] ?? '')
}

// What opens a question no yes or no answers: which, how, why, where, when, who, what, or a choice.
const LEADING = /^(?:(?:et|alors|donc|mais|bon|sinon|ok|d['’]accord|bref|ensuite|puis|enfin)\b[\s,]*)+/iu
const OPENS = /^(?:(?:à|de|d['’]|avec|pour|par|dans|sur|en|chez|depuis)\s*)?(?:qu['’]|(?:quel(?:le)?s?|lequel|laquelle|lesquel(?:le)?s|comment|pourquoi|combien|où|quand|qui|que|quoi)(?![\p{L}-]))/iu
const ENDS_OPEN = /(?:^|[\s'’-])(?:quoi|où|quand|comment|combien|pourquoi|qui|lequel|laquelle|lesquel(?:le)?s)\s*\?$/iu
const WHICH = /(?:^|[\s'’-])(?:quel(?:le)?s?|lequel|laquelle|lesquel(?:le)?s)(?![\p{L}-])/iu
const CHOICE = /\sou\s(?!pas\b|non\b)/iu

/** Whether an answer ends on a question its reader answers by yes or no ("Tu veux que je continue ?"). */
export function asksYesNo(text: string): boolean {
  if (!asksQuestion(text)) return false
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const line = (lines[lines.length - 1] ?? '').replace(/^[\s>*_`«"'\-]+|[\s*_`»"')\]]+$/g, '')
  const sentence = (line.split(/(?<=[.!?…:;])\s+/).pop() ?? '').replace(LEADING, '')
  return !OPENS.test(sentence) && !ENDS_OPEN.test(sentence) && !WHICH.test(sentence) && !CHOICE.test(sentence)
}

/**
 * The listener's state from its file: none is "off" (a clean stop removes it), a stale or
 * unreadable one is "unknown". An empty read (caught mid-rewrite) keeps the previous state.
 */
export function listenState(text: string | undefined, ageMs: number, previous: Voices['listen']): Voices['listen'] {
  if (text === undefined) return 'off'
  if (ageMs >= FRESH_MS) return 'unknown'
  if (text === '') return previous
  return text === 'loading' || text === 'on' || text === 'gaia' || text === 'paused' ? text : 'unknown'
}

/** One peak (0..1) as a bar, on a dB scale: -50 dB and below is the floor, 0 dB full. */
export function bar(peak: number): string {
  const db = peak > 0 ? 20 * Math.log10(peak) : -100
  const i = Math.round(((db + 50) / 50) * (BARS.length - 1))
  return BARS[Math.max(0, Math.min(BARS.length - 1, i))]!
}

/** The meter: the last `width` polls of the mic, oldest on the left, padded to that width. */
export function meter(levels: number[], width = LEVELS): string {
  const shown = levels.slice(-width)
  return BARS[0]!.repeat(width - shown.length) + shown.map(bar).join('')
}

/** The pane's lines run its width, past the "micro " label, within the polls kept. */
export function paneWidth(columns: number | undefined): number {
  return Math.max(LEVELS, Math.min(KEPT_LEVELS, (columns ?? 40) - 7))
}

export const VOICE_COLORS = { claude: '#ff8700', gaia: '#5fafff', observatory: '#af87ff' } as const

/**
 * The voices' line: who spoke at each of the last `width` polls, oldest on the left, as runs of
 * one speaker each. Piper writes no level, so a voice is a full block, not its loudness.
 */
export function voiceRuns(spoke: Speaker[], width: number): { who: Speaker; text: string }[] {
  const shown: Speaker[] = [...Array<Speaker>(Math.max(0, width - spoke.length)).fill(null), ...spoke.slice(-width)]
  const runs: { who: Speaker; text: string }[] = []
  for (const who of shown) {
    const glyph = who ? '▆' : BARS[0]!
    const tail = runs[runs.length - 1]
    if (tail && tail.who === who) tail.text += glyph
    else runs.push({ who, text: glyph })
  }
  return runs
}

/** A voice in the last second (5 polls). */
export function hears(v: Voices | null): boolean {
  return v?.listen === 'on' && v.levels.slice(-5).some(p => p >= HEARD)
}

/** A duration as the band says it: "12 s", "3 min 05". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`
}

/** What the face shows, from the most pressing: one name per expression. */
export type Expression =
  | 'speak-open' | 'speak-shut' | 'gaia' | 'wink' | 'hear-open' | 'hear-shut' | 'work' | 'loading'
  | 'question' | 'oops' | 'happy' | 'listen' | 'rest'

export function expression(v: Voices | null, isWorking: boolean): Expression {
  if (v?.piper) return v.frame % 2 ? 'speak-open' : 'speak-shut'
  if (v?.gaia) return 'gaia'
  if (v?.wink) return 'wink'
  if (hears(v) && v?.target === 'claude') return v.blink ? 'hear-shut' : 'hear-open'
  if (isWorking) return 'work'
  if (v?.listen === 'loading') return 'loading'
  if (v?.mood === 'question') return 'question'
  if (v?.mood === 'oops') return 'oops'
  if (v?.mood === 'happy') return 'happy'
  return v?.listen === 'on' ? 'listen' : 'rest'
}

/** Its eyes are closed while what is said is not for it. */
export function asleep(v: Voices | null): boolean {
  return v?.listen === 'on' && v.target !== 'claude'
}

const SMALL: Record<Expression, [string, string]> = {
  'speak-open': ['◕   ◕', '  o  '], 'speak-shut': ['◕   ◕', '  ‿  '], gaia: ['◕   ◕', '  _  '],
  wink: ['◕   -', '  ‿  '], work: ['◔   ◔', '  _  '], loading: ['◔   ◔', '  ‿  '],
  'hear-open': ['◕   ◕', '  ᴗ  '], 'hear-shut': ['◕   -', '  ᴗ  '],
  question: ['◕   ◔', '  ~  '], oops: ['×   ×', '  ~  '], happy: ['◕   ◕', ' ╰─╯ '],
  listen: ['◕   ◕', '  ᴗ  '], rest: ['◕   ◕', '  ‿  '],
}

/**
 * The band's face on two rows, eyes then mouth: the mouth moves while Piper speaks; one eye
 * blinks while it hears a voice meant for it; it winks, in pink, when it got what was said;
 * its eyes close while what is said is not for it; it smiles when
 * its turn went well, and looks puzzled when it asked a question or failed.
 */
export function face(v: Voices | null, isWorking: boolean): [string, string] {
  const x = expression(v, isWorking)
  const [eyes, mouth] = SMALL[x]
  const keepsEyes = x === 'speak-open' || x === 'speak-shut' || x === 'gaia' || x === 'wink' || x === 'work' || x === 'loading'
  return [asleep(v) && !keepsEyes ? '─   ─' : eyes, mouth]
}

const BIG: Record<Expression, [string, string, string]> = {
  'speak-open': ['  ◕     ◕  ', '           ', '   ( O )   '],
  'speak-shut': ['  ◕     ◕  ', '           ', '    ───    '],
  gaia: ['  ◕     ◕  ', '           ', '    ───    '],
  wink: ['  ◕     ─  ', '           ', '  ╰─────╯  '],
  'hear-open': ['  ◕     ◕  ', '           ', '   ╰───╯   '],
  'hear-shut': ['  ◕     ─  ', '           ', '   ╰───╯   '],
  work: ['  ◔     ◔  ', '           ', '    ───    '],
  loading: ['  ◔     ◔  ', '           ', '   ╰───╯   '],
  question: ['  ◕     ◔ ?', '           ', '    ~~~    '],
  oops: ['  ×     ×  ', '           ', '    ~~~    '],
  happy: ['  ◕     ◕  ', '           ', '  ╰─────╯  '],
  listen: ['  ◕     ◕  ', '           ', '   ╰───╯   '],
  rest: ['  ◕     ◕  ', '           ', '    ───    '],
}

/** The pane's face, the band's in three wider rows. */
export function bigFace(v: Voices | null, isWorking: boolean): [string, string, string] {
  const x = expression(v, isWorking)
  const [eyes, nose, mouth] = BIG[x]
  const keepsEyes = x === 'speak-open' || x === 'speak-shut' || x === 'gaia' || x === 'wink' || x === 'work' || x === 'loading'
  return [asleep(v) && !keepsEyes ? '  ─     ─  ' : eyes, nose, mouth]
}

/** What Claude does and for how long: there is no ETA to know, so the time spent so far. */
export type Work = { tool: string | null; toolMs: number; turnMs: number }

/** The first row: who has the floor and what Claude does, in the order they matter. */
export function labels(v: Voices | null, work: Work | null): string[] {
  const out: string[] = []
  if (v?.piper) out.push('🔊 Piper parle')
  if (v?.observatory) out.push('🔭 Observatoire parle')
  if (v?.listen === 'loading') out.push('⏳ je me prépare à écouter')
  if (v?.listen === 'on') out.push(hears(v) ? "je t'entends" : "j'écoute")
  if (v?.listen === 'unknown') out.push('❓ écoute : état inconnu')
  if (v?.asks) out.push("j'ai une question pour toi")
  if (!work && v?.mood === 'oops') out.push("😕 ça n'a pas marché")
  if (work) {
    const doing = work.tool ? `${work.tool} ${elapsed(work.toolMs)}` : 'je réfléchis'
    out.push(`${doing} · tour ${elapsed(work.turnMs)}`)
  }
  return out
}

/**
 * A pink ring while what the user says comes to Claude, an empty one when it does not: a text
 * symbol, since an emoji ear keeps the font's yellow whatever its color or ground.
 */
export function ear(v: Voices | null): string | null {
  if (v?.listen !== 'on') return null
  return v.target === 'claude' ? '◉' : '◌'
}

/** The ring's color: fuchsia, brighter while a voice is heard; none when it is not for Claude. */
export function earColor(v: Voices | null): string | undefined {
  if (v?.listen !== 'on' || v.target !== 'claude') return undefined
  return hears(v) ? '#ff00af' : '#d75faf'
}
export const EAR_COLOR = '#ff5fd7'

/**
 * Whether the band offers 👍 oui / 👎 non: Claude's turn ended on a question answered by yes or
 * no (not while it works, nor while its AskUserQuestion dialog, which has its own choices, is open).
 */
export function offersAnswers(v: Voices | null, isWorking: boolean): boolean {
  return v?.mood === 'question' && v.yesNo && !isWorking
}

/** A question mark while a question waits on the user, blinking: white on red, then red. */
export function questionMark(v: Voices | null): { ground: string | undefined; color: string } | null {
  if (!v?.asks) return null
  return v.pulse ? { ground: QUESTION_COLOR, color: '#ffffff' } : { ground: undefined, color: QUESTION_COLOR }
}

const TO: Record<Voices['target'], string> = {
  claude: '→ maintenant pour Claude',
  gaia: '→ maintenant pour Gaïa',
  ambient: "→ maintenant ambiant : rien n'est envoyé",
}

/** For 3 s after the target changed, where what is said goes now. */
export function moveLine(v: Voices | null): string | null {
  return v?.moved && v.listen === 'on' ? TO[v.target] : null
}

/**
 * The call's own microphone is open while the listener runs: what is said for Claude, or to
 * the room, reaches Gaïa's call too (and leaves the machine with it).
 */
export function callWarning(v: Voices | null): string | null {
  return v?.listen === 'on' && v.callOpen && v.target !== 'gaia' ? "⚠ micro de l'appel ouvert : Gaïa entend aussi" : null
}

/** A small block after the ear: it blinks while Claude listens to the user, else none. */
export function cursor(v: Voices | null): string | null {
  if (v?.listen !== 'on' || v.target !== 'claude') return null
  return v.blink ? '▌' : ' '
}

/** The pause, where the ear stands while listening: nothing is heard until it is lifted. */
export function pausedMark(v: Voices | null): string | null {
  return v?.listen === 'paused' ? '❚❚ en pause' : null
}

/** A price in dollars the French way: "1,23 $". */
export function dollars(usd: number): string {
  return `${usd.toFixed(2).replace('.', ',')} $`
}

/** A token count the French way: "850", "12 k", "1,4 M". */
export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1e6) return `${Math.round(n / 1000)} k`
  return `${(n / 1e6).toFixed(1).replace('.', ',')} M`
}

/**
 * What the session consumes, each figure apart and only when measured: the context's fill,
 * the quota windows, and the API price. Quota windows are reported to a subscription only, and
 * a subscription is not billed by the token: then the price is marked as not billed.
 */
export function costLine(u: Usage | null): string {
  const parts: string[] = []
  if (u?.context != null) parts.push(`contexte ${Math.round(u.context)} %`)
  if (u?.fiveHour != null) parts.push(`quota 5 h ${Math.round(u.fiveHour)} %`)
  if (u?.sevenDay != null) parts.push(`semaine ${Math.round(u.sevenDay)} %`)
  const subscribed = u?.fiveHour != null || u?.sevenDay != null
  if (u?.usd != null) parts.push(subscribed ? `équiv. API ${dollars(u.usd)}, non facturé` : `prix API ≈ ${dollars(u.usd)}`)
  return parts.length ? parts.join(' · ') : 'consommation : indisponible'
}

/** The tokens of the main loop's turn: what its requests read, and what they generated. */
export function turnTokens(u: Usage | null): string | null {
  return u && u.turnIn + u.turnOut > 0 ? `${tokens(u.turnIn)} lus · ${tokens(u.turnOut)} générés` : null
}

/** Gaïa as a blue earth: "♁ parle" while she speaks, "♁" alone while her call's mic is open. */
export function gaiaMark(v: Voices | null): string | null {
  if (v?.gaia) return '♁ parle'
  return v?.callOpen ? '♁' : null
}
export const GAIA_COLOR = '#5fafff'

/** One of the three places what the user says goes, set by "Top", "Top Gaïa", "Top Claude". */
export type Place = { icon: string; name: string; on: boolean }

/**
 * The three, lit where what the user says actually goes: Gaïa while her call has the mic (the
 * listener is off then, whatever its target), none while paused; null when it is off or unsure.
 */
export function places(v: Voices | null): Place[] | null {
  if (v?.listen !== 'on' && v?.listen !== 'gaia' && v?.listen !== 'paused') return null
  const goes = v.listen === 'gaia' ? 'gaia' : v.listen === 'paused' ? null : v.target
  return [
    { icon: '∿', name: 'ambiant', on: goes === 'ambient' },
    { icon: '♁', name: 'Gaïa', on: goes === 'gaia' },
    { icon: '✻', name: 'Claude', on: goes === 'claude' },
  ]
}

const SAID: Record<Outcome, string> = {
  sent: '✓ reçu',
  typed: '✓ tapé : Entrée pour envoyer',
  ignored: '· pas pour moi',
  piper: "· c'était ma voix",
  dropped: '· ignoré : la voix de Gaïa',
  held: "· pas envoyé : une question est ouverte à l'écran",
}

/** What became of the last utterance, for 5 s. */
export function outcome(v: Voices | null): string | null {
  return v?.last ? SAID[v.last] : null
}

/** One line of the pane's history: what became of an utterance, and how long ago. */
export function heardLine(h: Heard, now: number): string {
  return `${SAID[h.what]} · il y a ${elapsed(now - h.at)}`
}

/** One line of the pane's steps: done or running, the tool, its time. */
export function stepLine(s: Step, now: number, spin: number): string {
  return s.ms === null ? `${SPIN[spin % SPIN.length]} ${s.name} ${elapsed(now - s.since)}` : `✓ ${s.name} ${elapsed(s.ms)}`
}

/** The face's color: who has the floor; pink when it winks. */
export function tint(v: Voices | null, isWorking: boolean): string | undefined {
  if (v?.piper) return '#5fd7ff'
  if (v?.gaia) return '#d7afff'
  if (v?.wink) return WINK_COLOR
  if (isWorking) return '#ffd75f'
  if (hears(v)) return '#5fff5f'
  if (v?.listen === 'on') return '#87d787'
  if (v?.listen === 'unknown') return '#ff8700'
  return undefined
}

export function same(a: Voices | null, b: Voices): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b)
}

// voice_listen.ps1 reads these files every second (pause) or every 200 ms (stop).
function controls($: EngineInterface) {
  return {
    pause: (word: string, said: string) => () => {
      void $.fs.write(`${listenHome}/pause`, word).then(() => $.ui.toast(said))
    },
    stop: () => {
      void $.fs.write(`${listenHome}/stop`, '').then(() => $.ui.toast('Écoute arrêtée'))
    },
    // the user's own answer, pressed by the user: submitted as their words
    answer: (word: string) => () => {
      void $.prompt.submit({ text: word, asUser: true })
    },
  }
}

const option = (o: PluginOptions, key: string, fallback: string) => (typeof o[key] === 'string' ? (o[key] as string) : fallback)

export const register: Register = (on, options) => {
  const faceFile = option(options, 'faceFile', '').replace(/\\/g, '/')
  const faceSession = option(options, 'faceSession', 'Claude')

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The folders piper-voice and the listener use: their variables, else the user's cache folder.
    windows = (await $.env.get('OS')) === 'Windows_NT'
    const base = ((await $.env.get('LOCALAPPDATA')) || (await $.env.get('XDG_CACHE_HOME')) || ((await $.env.get('HOME')) ? `${await $.env.get('HOME')}/.cache` : '')).replace(/\\/g, '/')
    voiceHome = ((await $.env.get('PIPER_VOICE_HOME')) || (base && `${base}/piper-voice`)).replace(/\\/g, '/')
    listenHome = ((await $.env.get('VOICE_LISTEN_HOME')) || (base && `${base}/voice-listen`)).replace(/\\/g, '/')
    if (!voiceHome || !listenHome) return started

    const isFresh = async (path: string, now: number, ms = FRESH_MS) => {
      const stat = await $.fs.stat(path).catch(() => undefined)
      return stat !== undefined && now - stat.mtimeMs < ms
    }
    const readFresh = async (path: string, now: number, ms: number) =>
      (await isFresh(path, now, ms)) ? (await $.fs.read(path).catch(() => '')).trim() : ''
    const has = (path: string) => $.fs.exists(path).catch(() => false)
    const courtesy = `${voiceHome}/courtesy`
    const listening = listenHome
    let last: Voices | null = null
    let frame = 0
    let levels: number[] = []
    let spoke: Speaker[] = []
    let lastSeenAt = 0 // the mtime of the last outcome the history took
    let polls = 0
    let lastTarget: Voices['target'] | null = null
    let movedAt = -Infinity

    $.clock.every(POLL_MS, async () => {
      const now = await $.clock.now()
      if (polls++ % USAGE_POLLS === 0) {
        const u = await $.session.usage().catch(() => undefined)
        const fiveHour = u?.rateLimits.find(r => r.kind === 'five_hour')?.percentUsed ?? null
        const sevenDay = u?.rateLimits.find(r => r.kind === 'seven_day')?.percentUsed ?? null
        const seen = { context: u?.context.percent ?? null, fiveHour, sevenDay, usd: u?.cost?.usd ?? null }
        await update($, usage, was => ({ ...NO_USAGE, ...was, ...seen }))
      }
      const watching = await isFresh(`${courtesy}/alive`, now)
      const piper = watching && (await has(`${courtesy}/piper-speaking`))
      const gaia = watching && (await has(`${courtesy}/other-speaking`))
      const observatory = await isFresh(`${courtesy}/speaking/observatory`, now)
      const stat = await $.fs.stat(`${listening}/state`).catch(() => undefined)
      const text = stat && (await $.fs.read(`${listening}/state`).catch(() => '')).trim()
      const listen = listenState(text, stat ? now - stat.mtimeMs : 0, last?.listen ?? 'off')
      if (listen === 'on') {
        const level = Number(await readFresh(`${listening}/level`, now, LEVEL_FRESH_MS))
        levels = [...levels, Number.isFinite(level) ? level : 0].slice(-KEPT_LEVELS)
      } else levels = []
      spoke = [...spoke, piper ? 'claude' : gaia ? 'gaia' : observatory ? 'observatory' : null].slice(-KEPT_LEVELS) as Speaker[]
      const lastStat = await $.fs.stat(`${listening}/last`).catch(() => undefined)
      const lastAge = lastStat ? now - lastStat.mtimeMs : Infinity
      const said = lastAge < LAST_SHOWN_MS ? (await $.fs.read(`${listening}/last`).catch(() => '')).trim() : ''
      const what = OUTCOMES.find(s => s === said) ?? null
      if (what && lastStat && lastStat.mtimeMs !== lastSeenAt) {
        lastSeenAt = lastStat.mtimeMs
        await update($, history, list => [...list, { at: lastStat.mtimeMs, what }].slice(-KEPT))
      }
      const to = (await $.fs.read(`${listening}/target`).catch(() => '')).trim()
      const target = to === 'claude' || to === 'gaia' ? to : 'ambient'
      if (lastTarget !== null && target !== lastTarget && listen === 'on') movedAt = now
      lastTarget = target
      const moved = now - movedAt < MOVED_MS
      const asks = mood === 'question' || asking
      const callOpen = (await readFresh(`${listening}/call`, now, FRESH_MS)) === 'live'
      frame = piper ? frame + 1 : 0
      if (faceFile) void writeFace($, now, faceOf(workingSince !== null, mainTool, mood, asks), faceFile, faceSession).catch(() => undefined)
      const seen: Voices = {
        piper,
        gaia,
        observatory,
        listen,
        levels,
        spoke,
        target,
        blink: listen === 'on' && target === 'claude' && Math.floor(now / 500) % 2 === 0,
        wink: (said === 'sent' || said === 'typed') && lastAge < WINK_MS,
        last: what,
        frame,
        mood,
        yesNo,
        spin: workingSince !== null ? Math.floor(now / 200) % SPIN.length : 0,
        asks,
        moved,
        pulse: (asks || moved) && Math.floor(now / 500) % 2 === 0,
        callOpen,
      }
      if (same(last, seen)) return
      last = seen
      await update($, voices, () => seen)
    })
    return started
  })

  // The mood, the turn's time and its steps follow the main loop only, not a subagent's.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      mood = null
      yesNo = false
      workingSince = await $.clock.now()
      await update($, steps, () => [])
      await update($, usage, was => ({ ...NO_USAGE, ...was, turnIn: 0, turnOut: 0 }))
    }
    return next(e)
  })
  // Each request of the main loop's turn: the tokens its usage reports.
  on('turn.step', async function* ($, e, next) {
    const done = yield* next(e)
    const used = done.usage
    if (e.agentId === undefined && used) {
      const read = used.input_tokens + used.cache_read_input_tokens + used.cache_creation_input_tokens
      await update($, usage, was => {
        const u = { ...NO_USAGE, ...was }
        return { ...u, turnIn: u.turnIn + read, turnOut: u.turnOut + used.output_tokens }
      })
    }
    return done
  })
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      mood = e.reason !== 'answer' ? 'oops' : asksQuestion(done.text) ? 'question' : 'happy'
      yesNo = mood === 'question' && asksYesNo(done.text)
      workingSince = null
    }
    return done
  })

  // It only watches: a failure to note the tool never stops the call.
  on('tool.call', async ($, e, next) => {
    const since = await $.clock.now()
    const name = 'tool' in e ? String(e.tool) : null
    const id = 'tool_use_id' in e ? String(e.tool_use_id) : String(since)
    const main = !('agentId' in e) || e.agentId === undefined
    await update($, tool, (): Running | null => (name ? { name, since } : null))
    if (name && main) await update($, steps, list => [...list, { id, name, since, ms: null }].slice(-KEPT))
    if (name && main) mainTool = name
    if (name === 'AskUserQuestion') asking = true
    try {
      return await next(e)
    } finally {
      if (name && main && mainTool === name) mainTool = null
      if (name === 'AskUserQuestion') asking = false
      await update($, tool, () => null)
      if (name && main) {
        const end = await $.clock.now()
        await update($, steps, list => list.map(s => (s.id === id ? { ...s, ms: end - s.since } : s)))
      }
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const v = await read($, voices)
    const t = await read($, tool)
    const now = await $.clock.now()
    const work = workingSince !== null
      ? { tool: t?.name ?? null, toolMs: t ? now - t.since : 0, turnMs: now - workingSince }
      : null
    const { Box, Text, Button } = $.ui.resolve(e)
    const [eyes, mouth] = face(v, e.props.isWorking)
    const color = tint(v, e.props.isWorking)
    const parts = labels(v, work)
    const { pause, stop, answer } = controls($)
    const running = listenHome !== '' && v !== null && v.listen !== 'off'
    const answers = offersAnswers(v, e.props.isWorking)
    const listenEar = ear(v)
    const ringColor = earColor(v)
    const blinkCursor = cursor(v)
    const held = pausedMark(v)
    const gaia = gaiaMark(v)
    const where = places(v)
    const done = outcome(v)
    const spent = costLine(await read($, usage))
    const ask = questionMark(v)
    const moving = moveLine(v)
    const warning = callWarning(v)

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={color} weight="bold">{` ${eyes} `}</Text>
          <Text weight="bold"> Claude</Text>
          {ask ? <Text backgroundColor={ask.ground} color={ask.color} weight="bold"> ? </Text> : null}
          {work ? <Text color={SPIN_COLORS[(v?.spin ?? 0) % SPIN_COLORS.length]} weight="bold"> {SPIN[v?.spin ?? 0]}</Text> : null}
          {gaia ? <Text color={GAIA_COLOR} weight="bold"> {gaia}</Text> : null}
          <Text dimColor> · {parts.length ? parts.join(' · ') : gaia ? '' : 'au repos'}</Text>
        </Box>
        <Box>
          <Text color={color} weight="bold">{` ${mouth} `}</Text>
          {v?.listen === 'on' ? <Text color={hears(v) ? '#5fff5f' : '#5f875f'}> {meter(v.levels)} </Text> : null}
          {/* the voices, as narrow as the mic: who spoke in the same 2 s */}
          {v && (v.listen === 'on' || v.spoke.slice(-LEVELS).some(Boolean))
            ? voiceRuns(v.spoke, LEVELS).map(run => <Text color={run.who ? VOICE_COLORS[run.who] : undefined} dimColor={!run.who}>{run.text}</Text>)
            : null}
          {listenEar ? <Text color={ringColor} dimColor={!ringColor} weight="bold">{` ${listenEar} `}</Text> : null}
          {blinkCursor ? <Text color={EAR_COLOR} weight="bold">{blinkCursor}</Text> : null}
          {held ? <Text color={PAUSE_COLOR} weight="bold"> {held}</Text> : null}
          {where ? where.map(p => <Text color={p.on ? LIT : undefined} backgroundColor={p.on && v?.moved && v.pulse ? '#005f00' : undefined} dimColor={!p.on}>{`  ${p.icon} ${p.name}`}</Text>) : null}
          {warning ? <Text color={PAUSE_COLOR}>  {warning}</Text> : null}
        </Box>
        <Box>
          <Text>{'        '}</Text>
          {answers && ask ? <Text backgroundColor={ask.ground} color={ask.color} weight="bold"> ? </Text> : null}
          {answers ? <Button hotkey="o" dimColor={!v?.pulse} onPress={answer('Oui')}>👍 oui</Button> : null}
          {answers ? <Button hotkey="n" dimColor={!v?.pulse} onPress={answer('Non')}>👎 non</Button> : null}
          {moving ? <Text color={LIT} weight="bold">{moving} </Text> : null}
          {done ? <Text color={v?.wink ? WINK_COLOR : undefined} dimColor={!v?.wink}>{done} </Text> : null}
          {running && v.listen === 'paused' ? <Button hotkey="p" onPress={pause('resumed', "J'écoute à nouveau")}>▶ reprendre</Button> : null}
          {running && v.listen !== 'paused' ? <Button hotkey="p" dimColor onPress={pause('paused', 'Écoute en pause')}>⏸ pause</Button> : null}
          {running ? <Button hotkey="a" dimColor onPress={stop}>⏹ arrêter</Button> : null}
          <Button hotkey="d" dimColor onPress={() => void $.ui.open({ id: PANE, title: 'Claude', columns: 40, rows: 26 })}>⤢ détails</Button>
          <Text dimColor> {spent}</Text>
        </Box>
        {/* what the other plugins show there, the voice plugin's listening line among them */}
        {await next(e).catch(() => null)}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const v = await read($, voices)
    const t = await read($, tool)
    const heard = await read($, history)
    const turn = await read($, steps)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const isWorking = workingSince !== null
    const [eyes, nose, mouth] = bigFace(v, isWorking)
    const color = tint(v, isWorking)
    const work = workingSince !== null
      ? { tool: t?.name ?? null, toolMs: t ? now - t.since : 0, turnMs: now - workingSince }
      : null
    const parts = labels(v, work)
    const { pause, stop, answer } = controls($)
    const running = listenHome !== '' && v !== null && v.listen !== 'off'
    const answers = offersAnswers(v, isWorking)
    const spin = v?.spin ?? 0
    const u = await read($, usage)
    const held = pausedMark(v)
    const gaia = gaiaMark(v)
    const where = places(v)
    const read_ = turnTokens(u)
    const ask = questionMark(v)
    const moving = moveLine(v)
    const warning = callWarning(v)
    // What matters first, so a short inline pane still shows it: who listens, the turn, the cost.
    const rows = e.viewport?.rows ?? 24
    const roomy = e.props.placement === 'dock' && rows >= 24
    const lists = Math.max(2, rows - (roomy ? 16 : 10))
    // the pane's body, inside its frame: the viewport is the whole terminal, and a line that wide wrapped
    const width = paneWidth(e.props.bodyColumns)
    const speaking = v?.spoke[v.spoke.length - 1] ?? null
    const shownSteps = turn.slice(-Math.ceil(lists / 2))
    const shownHeard = [...heard].reverse().slice(0, Math.floor(lists / 2))

    return (
      <Box flexDirection="column">
        {roomy ? <Text color={color} weight="bold">{eyes}</Text> : null}
        {roomy ? <Text color={color} weight="bold">{nose}</Text> : null}
        {roomy ? <Text color={color} weight="bold">{mouth}</Text> : null}
        <Box>
          <Text weight="bold">Claude</Text>
          {ask ? <Text backgroundColor={ask.ground} color={ask.color} weight="bold"> ? </Text> : null}
          {work ? <Text color={SPIN_COLORS[spin % SPIN_COLORS.length]} weight="bold"> {SPIN[spin]}</Text> : null}
          {gaia ? <Text color={GAIA_COLOR} weight="bold"> {gaia}</Text> : null}
          <Text dimColor> · {parts.length ? parts.join(' · ') : 'au repos'}</Text>
        </Box>
        {where ? (
          <Box>
            {ear(v) ? <Text color={earColor(v)} dimColor={!earColor(v)} weight="bold">{` ${ear(v)} `}</Text> : null}
            {cursor(v) ? <Text color={EAR_COLOR} weight="bold">{cursor(v)}</Text> : null}
            {held ? <Text color={PAUSE_COLOR} weight="bold">{held}</Text> : null}
            {where.map(p => <Text color={p.on ? LIT : undefined} backgroundColor={p.on && v?.moved && v.pulse ? '#005f00' : undefined} dimColor={!p.on}>{`  ${p.icon} ${p.name}`}</Text>)}
          </Box>
        ) : <Text dimColor>écoute arrêtée</Text>}
        {moving ? <Text color={LIT} weight="bold">{moving}</Text> : null}
        {warning ? <Text color={PAUSE_COLOR}>{warning}</Text> : null}
        {v?.listen === 'on' ? <Text color={hears(v) ? '#5fff5f' : '#5f875f'}>micro {meter(v.levels, width)}</Text> : null}
        {v && (v.listen === 'on' || v.spoke.some(Boolean)) ? (
          <Box>
            <Text color={speaking ? VOICE_COLORS[speaking] : undefined} dimColor={!speaking}>{'voix  '}</Text>
            {voiceRuns(v.spoke, width).map(run => <Text color={run.who ? VOICE_COLORS[run.who] : undefined} dimColor={!run.who}>{run.text}</Text>)}
          </Box>
        ) : null}
        <Text weight="bold">{work ? `Tour en cours · ${elapsed(work.turnMs)}` : 'Dernier tour'}{read_ ? <Text dimColor> · {read_}</Text> : null}</Text>
        {shownSteps.length ? shownSteps.map(s => <Text dimColor={s.ms !== null}>{stepLine(s, now, spin)}</Text>) : <Text dimColor>aucun outil</Text>}
        <Text dimColor>{costLine(u)}</Text>
        <Text weight="bold">Dernières phrases</Text>
        {shownHeard.length
          ? shownHeard.map(said => <Text dimColor={said.what !== 'sent' && said.what !== 'typed'}>{heardLine(said, now)}</Text>)
          : <Text dimColor>rien encore depuis le chargement</Text>}
        <Box>
          {answers && ask ? <Text backgroundColor={ask.ground} color={ask.color} weight="bold"> ? </Text> : null}
          {answers ? <Button hotkey="o" dimColor={!v?.pulse} onPress={answer('Oui')}>👍 oui</Button> : null}
          {answers ? <Button hotkey="n" dimColor={!v?.pulse} onPress={answer('Non')}>👎 non</Button> : null}
          {running && v.listen === 'paused' ? <Button hotkey="p" onPress={pause('resumed', "J'écoute à nouveau")}>▶ reprendre</Button> : null}
          {running && v.listen !== 'paused' ? <Button hotkey="p" dimColor onPress={pause('paused', 'Écoute en pause')}>⏸ pause</Button> : null}
          {running ? <Button hotkey="a" dimColor onPress={stop}>⏹ arrêter</Button> : null}
          {/* one glyph: with ▶ reprendre and ⏹ arrêter the full word took the 41st column */}
          <Button hotkey="r" dimColor onPress={() => void $.ui.close({ id: PANE })}>⤡</Button>
        </Box>
      </Box>
    )
  })
}
