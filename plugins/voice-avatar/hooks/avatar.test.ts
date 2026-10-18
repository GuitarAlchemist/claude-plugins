import { expect, test } from 'claude-code/testing'

import type { Voices } from '../types'
import {
  asksQuestion, asksYesNo, bar, faceOf, bigFace, callWarning, costLine, cursor, ear, earColor, elapsed, face, gaiaMark, hears, heardLine,
  labels, listenState, meter, moveLine, offersAnswers, outcome, paneWidth, pausedMark, places, questionMark, same, stepLine, tint, tokens,
  turnTokens, voiceRuns,
} from './register'

test('the voices line shows who spoke, one run per speaker, as wide as asked', () => {
  expect(voiceRuns([], 4)).toEqual([{ who: null, text: '▁▁▁▁' }])
  expect(voiceRuns(['claude', 'claude', null, 'gaia'], 6)).toEqual([
    { who: null, text: '▁▁' }, { who: 'claude', text: '▆▆' }, { who: null, text: '▁' }, { who: 'gaia', text: '▆' },
  ])
  expect(voiceRuns(Array(9).fill('observatory'), 3)).toEqual([{ who: 'observatory', text: '▆▆▆' }])
})

test('the pane widens the micro and voices lines to its width, within the 20 s kept', () => {
  expect(paneWidth(40)).toBe(33)
  expect(paneWidth(undefined)).toBe(33)
  expect(paneWidth(12)).toBe(10)
  expect(paneWidth(300)).toBe(100)
})

test('the band adds the voices beside the mic, as narrow as it', async ($, on) => {
  on('clock.now', async () => ({ value: 1000 }))
  const shown: Voices = { ...quiet, listen: 'on', levels: [0.2], spoke: ['gaia', 'claude', 'claude'], target: 'claude' }
  on('state.get', async (_, e, next) => (e.key === 'voices' ? { value: { value: shown, version: 1 } } : next(e)))
  const band = await $.ui.mount({
    plugin: 'voice-avatar', surface: 'terminal', component: 'AbovePrompt',
    props: { isWorking: false } as never,
    viewport: { columns: 120, rows: 30 },
  })
  expect((await band.find({ type: 'Text', text: '▁▁▁▁▁▁▁▁▁▆' }))?.text).toBe(' ▁▁▁▁▁▁▁▁▁▆ ') // the mic, unchanged
  expect((await band.find({ type: 'Text', text: '▆▆' }))?.text).toBe('▆▆') // after 7 silent polls and Gaïa's one, Claude's two
})

test('the pane draws both lines across its body, each on one line, however wide the terminal', async ($, on) => {
  on('clock.now', async () => ({ value: 1000 }))
  const shown: Voices = { ...quiet, listen: 'on', levels: [0.2], spoke: ['gaia', 'claude'], target: 'claude' }
  on('state.get', async (_, e, next) => (e.key === 'voices' ? { value: { value: shown, version: 1 } } : next(e)))
  const pane = await $.ui.mount({
    plugin: 'voice-avatar', surface: 'terminal', component: 'Pane', requestId: 'voice-avatar',
    props: { title: 'Claude', isFocused: false, bodyColumns: 60, placement: 'inline' } as never,
    viewport: { columns: 200, rows: 12 }, // sized to this, each line took three rows
  })
  expect((await pane.find({ type: 'Text', text: 'micro' }))?.text).toBe(`micro ${'▁'.repeat(52)}▆`)
  expect((await pane.find({ type: 'Text', text: 'voix' }))?.text).toBe('voix  ') // its runs: voiceRuns(spoke, 53)
})

const quiet: Voices = { piper: false, gaia: false, observatory: false, listen: 'off', levels: [], spoke: [], target: 'ambient', blink: false, wink: false, last: null, frame: 0, mood: null, yesNo: false, spin: 0, asks: false, moved: false, pulse: false, callOpen: false }
const listening: Voices = { ...quiet, listen: 'on', levels: [0.001, 0.002, 0.001], target: 'claude' }

test('at rest the avatar smiles and says nothing is going on', () => {
  expect(face(null, false)).toEqual(['◕   ◕', '  ‿  '])
  expect(labels(null, null)).toEqual([])
  expect(places(null)).toBeNull()
  expect(outcome(null)).toBeNull()
  expect(tint(quiet, false)).toBeUndefined()
})

test('the mouth moves while Piper speaks, frame after frame', () => {
  const speaking = { ...quiet, piper: true }
  expect(face({ ...speaking, frame: 1 }, false)[1]).toBe('  o  ')
  expect(face({ ...speaking, frame: 2 }, false)[1]).toBe('  ‿  ')
  expect(labels(speaking, null)).toEqual(['🔊 Piper parle'])
})

test('it says who has the floor and the mic', () => {
  expect(labels({ ...quiet, gaia: true, listen: 'gaia' }, null)).toEqual([])
  expect(gaiaMark({ ...quiet, gaia: true, listen: 'gaia' })).toBe('♁ parle') // a blue earth
  expect(gaiaMark({ ...listening, callOpen: true })).toBe('♁') // her call's mic is open
  expect(gaiaMark(listening)).toBeNull()
  expect(labels(listening, null)).toEqual(["j'écoute"])
  expect(face(listening, false)[1]).toBe('  ᴗ  ')
})

test('it shows the three places speech goes, the one set by Top lit, while the listener runs', () => {
  const lit = (v: Voices) => places(v)?.filter(p => p.on).map(p => p.icon)
  expect(places(listening)?.map(p => `${p.icon} ${p.name}`)).toEqual(['∿ ambiant', '♁ Gaïa', '✻ Claude'])
  expect(lit(listening)).toEqual(['✻'])
  expect(lit({ ...listening, target: 'gaia' })).toEqual(['♁'])
  expect(lit({ ...listening, target: 'ambient' })).toEqual(['∿'])
  expect(lit({ ...quiet, listen: 'gaia', target: 'claude' })).toEqual(['♁']) // her call has the mic: nothing reaches Claude
  expect(lit({ ...listening, listen: 'paused' })).toEqual([]) // paused: it goes nowhere
  expect(places({ ...listening, listen: 'unknown' })).toBeNull() // unsure: no claim
})

test('a listener that stopped writing its state is shown as unknown, never as listening', () => {
  expect(listenState(undefined, 0, 'on')).toBe('off') // a clean stop removes the file
  expect(listenState('on', 500, 'off')).toBe('on')
  expect(listenState('on', 3000, 'on')).toBe('unknown') // died without cleaning up
  expect(listenState('garbled', 500, 'on')).toBe('unknown')
  expect(listenState('', 500, 'gaia')).toBe('gaia') // read while it was rewritten
  const unknown = { ...quiet, listen: 'unknown' as const }
  expect(labels(unknown, null)).toEqual(['❓ écoute : état inconnu'])
  expect(tint(unknown, false)).toBe('#ff8700')
  expect(hears({ ...unknown, levels: [0.5] })).toBe(false)
})

test('while whisper loads its model it does not claim to listen', () => {
  expect(labels({ ...quiet, listen: 'loading' }, null)).toEqual(['⏳ je me prépare à écouter'])
  expect(places({ ...quiet, listen: 'loading' })).toBeNull()
})

test('the meter draws the mic on a dB scale, oldest on the left', () => {
  expect(bar(0)).toBe('▁')
  expect(bar(0.003)).toBe('▁') // -50 dB: the room
  expect(bar(1)).toBe('█')
  expect(bar(0.1)).toBe('▅') // -20 dB: a voice
  expect(meter([])).toBe('▁▁▁▁▁▁▁▁▁▁')
  expect(meter([1, 0])).toBe('▁▁▁▁▁▁▁▁█▁')
  expect(meter(Array(12).fill(1))).toBe('██████████')
})

test('a voice in the last second shows that Claude hears it, room noise does not', () => {
  expect(hears(listening)).toBe(false)
  const voice = { ...listening, levels: [...listening.levels, 0.2] }
  expect(hears(voice)).toBe(true)
  expect(labels(voice, null)).toEqual(["je t'entends"])
  expect(tint(voice, false)).toBe('#5fff5f')
  expect(hears({ ...voice, levels: [0.2, 0, 0, 0, 0, 0] })).toBe(false) // more than a second ago
  expect(hears({ ...voice, listen: 'gaia' })).toBe(false)
})

test('it winks in pink when what was said reached Claude, and Piper speaking comes first', () => {
  const sent = { ...listening, wink: true, last: 'sent' as const }
  expect(face(sent, false)[0]).toBe('◕   -')
  expect(tint(sent, false)).toBe('#ff5fd7')
  expect(face({ ...sent, wink: false }, false)[0]).toBe('◕   ◕')
  expect(face({ ...sent, piper: true, frame: 1 }, false)).toEqual(['◕   ◕', '  o  '])
})

test('one eye blinks while it hears a voice meant for it, and not otherwise', () => {
  const voice = { ...listening, levels: [0.2] }
  expect(face({ ...voice, blink: true }, false)[0]).toBe('◕   -')
  expect(face({ ...voice, blink: false }, false)[0]).toBe('◕   ◕')
  expect(face({ ...voice, blink: true }, true)[0]).toBe('◕   -') // hearing shows even while it works
  expect(face({ ...listening, blink: true }, false)[0]).toBe('◕   ◕') // room noise: no blink
  expect(face({ ...voice, target: 'ambient', blink: true }, false)[0]).toBe('─   ─') // not for Claude: asleep
  expect(bigFace({ ...voice, blink: true }, false)[0]).toBe('  ◕     ─  ')
})

test('it says what became of the last utterance', () => {
  expect(outcome({ ...listening, last: 'sent' })).toBe('✓ reçu')
  expect(outcome({ ...listening, last: 'typed' })).toBe('✓ tapé : Entrée pour envoyer')
  expect(outcome({ ...listening, last: 'ignored' })).toBe('· pas pour moi')
  expect(outcome({ ...listening, last: 'piper' })).toBe("· c'était ma voix")
  expect(outcome({ ...listening, last: 'dropped' })).toBe('· ignoré : la voix de Gaïa')
  expect(outcome({ ...listening, last: 'held' })).toBe("· pas envoyé : une question est ouverte à l'écran")
  expect(labels({ ...quiet, observatory: true }, null)).toEqual(['🔭 Observatoire parle'])
})

test('while Claude works it shows the tool running, or that it thinks', () => {
  expect(face(quiet, true)[0]).toBe('◔   ◔')
  expect(labels(quiet, { tool: 'Bash', toolMs: 12000, turnMs: 65000 })).toEqual(['Bash 12 s · tour 1 min 05'])
  expect(labels(quiet, { tool: null, toolMs: 0, turnMs: 5000 })).toEqual(['je réfléchis · tour 5 s'])
})

test('a paused listener says so and shows no meter nor addressee', () => {
  expect(listenState('paused', 500, 'on')).toBe('paused')
  const paused = { ...listening, listen: 'paused' as const }
  expect(labels(paused, null)).toEqual([])
  expect(pausedMark(paused)).toBe('❚❚ en pause') // shown where the ear stands
  expect(pausedMark(listening)).toBeNull()
  expect(ear(paused)).toBeNull()
  expect(hears({ ...paused, levels: [0.5] })).toBe(false)
})

test('elapsed times read as seconds, then minutes', () => {
  expect(elapsed(0)).toBe('0 s')
  expect(elapsed(59999)).toBe('59 s')
  expect(elapsed(125000)).toBe('2 min 05')
})

test('a fuchsia ring and a small blinking block while it listens for Claude, an empty ring otherwise', () => {
  expect(ear(listening)).toBe('◉')
  expect(earColor(listening)).toBe('#d75faf')
  expect(earColor({ ...listening, levels: [0.2] })).toBe('#ff00af') // a voice: brighter
  expect(cursor({ ...listening, blink: true })).toBe('▌')
  expect(cursor({ ...listening, blink: false })).toBe(' ')
  for (const target of ['ambient', 'gaia'] as const) {
    expect(ear({ ...listening, target })).toBe('◌')
    expect(earColor({ ...listening, target })).toBeUndefined()
    expect(cursor({ ...listening, target, blink: true })).toBeNull() // no block when not for Claude
  }
  expect(cursor({ ...listening, listen: 'paused' })).toBeNull()
})

test('its eyes are closed while what is said is not for Claude', () => {
  expect(face({ ...listening, target: 'ambient' }, false)[0]).toBe('─   ─')
  expect(face({ ...listening, target: 'gaia' }, false)[0]).toBe('─   ─')
  expect(face(listening, false)[0]).toBe('◕   ◕')
  expect(face({ ...listening, target: 'ambient', piper: true, frame: 1 }, false)[1]).toBe('  o  ') // Piper first
})

test('it smiles when its turn went well, and looks puzzled when it asks or fails', () => {
  expect(face({ ...listening, mood: 'happy' }, false)).toEqual(['◕   ◕', ' ╰─╯ '])
  expect(face({ ...listening, mood: 'question' }, false)).toEqual(['◕   ◔', '  ~  '])
  expect(face({ ...listening, mood: 'oops' }, false)).toEqual(['×   ×', '  ~  '])
  expect(face({ ...listening, mood: 'happy', target: 'ambient' }, false)).toEqual(['─   ─', ' ╰─╯ ']) // asleep, smiling
  expect(face({ ...listening, mood: 'question' }, true)[0]).toBe('◔   ◔') // working comes first
  expect(labels({ ...listening, mood: 'question', asks: true }, null)).toEqual(["j'écoute", "j'ai une question pour toi"])
})

test('a question mark blinks while a question waits on the user, and is gone otherwise', () => {
  const asks = { ...listening, asks: true }
  expect(questionMark({ ...asks, pulse: true })).toEqual({ ground: '#ff5f5f', color: '#ffffff' })
  expect(questionMark({ ...asks, pulse: false })).toEqual({ ground: undefined, color: '#ff5f5f' })
  expect(questionMark(listening)).toBeNull()
  // its dialog open while the turn runs: the question shows beside the work
  expect(labels(asks, { tool: 'AskUserQuestion', toolMs: 0, turnMs: 0 })).toEqual(["j'écoute", "j'ai une question pour toi", 'AskUserQuestion 0 s · tour 0 s'])
})

test('👍 oui and 👎 non are offered when the turn ended on a yes-or-no question, not while it works', () => {
  expect(offersAnswers({ ...listening, mood: 'question', yesNo: true, asks: true }, false)).toBe(true)
  expect(offersAnswers({ ...listening, mood: 'question', yesNo: true, asks: true }, true)).toBe(false)
  expect(offersAnswers({ ...listening, mood: 'question', asks: true }, false)).toBe(false) // "Lequel ?" has no yes
  expect(offersAnswers({ ...listening, mood: 'happy' }, false)).toBe(false)
  expect(offersAnswers({ ...listening, asks: true }, true)).toBe(false) // its dialog has its own choices
  expect(offersAnswers(null, false)).toBe(false)
})

test('for 3 s after the target changed, it says where speech goes now', () => {
  expect(moveLine({ ...listening, moved: true })).toBe('→ maintenant pour Claude')
  expect(moveLine({ ...listening, moved: true, target: 'gaia' })).toBe('→ maintenant pour Gaïa')
  expect(moveLine({ ...listening, moved: true, target: 'ambient' })).toBe("→ maintenant ambiant : rien n'est envoyé")
  expect(moveLine(listening)).toBeNull()
  expect(moveLine({ ...listening, moved: true, listen: 'paused' })).toBeNull()
})

test("it warns that Gaïa's call hears too while its microphone is open", () => {
  const open = { ...listening, callOpen: true }
  expect(callWarning(open)).toBe("⚠ micro de l'appel ouvert : Gaïa entend aussi")
  expect(callWarning({ ...open, target: 'ambient' })).toBe("⚠ micro de l'appel ouvert : Gaïa entend aussi")
  expect(callWarning({ ...open, target: 'gaia' })).toBeNull() // meant for her
  expect(callWarning(listening)).toBeNull()
})

test('an answer asks a question when its last line ends with one', () => {
  expect(asksQuestion('Fait.\n\nTu veux que je continue ?')).toBe(true)
  expect(asksQuestion('Tu le vois ? Oui.\n**Je fais le bandeau ?**')).toBe(true)
  expect(asksQuestion('Est-ce clair ?\n\nC\'est fait.')).toBe(false)
  expect(asksQuestion('')).toBe(false)
})

test('a question asks for yes or no unless it asks which, how, why, where, when, who, what, or to choose', () => {
  for (const q of ["Est-ce qu'ils te conviennent comme ça ?", 'Fait.\n\nTu veux que je continue ?', '**Je fais le bandeau ?**',
    'Je lance le test. Ça te va ?', 'On le garde ou pas ?', 'Alors, je pousse la branche ?', 'Veux-tu que je relise la PR #388 ?'])
    expect(asksYesNo(q)).toBe(true)
  for (const q of ['Si oui, lesquels te faut-il ? Sinon, quel chemin préfères-tu ?', "Qu'est-ce que tu préfères ?",
    'Comment veux-tu faire ?', "C'est pour qui ?", 'Et lequel tu veux ?', 'Tu préfères Kokoro ou Piper ?', 'Tu veux quoi ?',
    'À quelle heure on reprend ?', 'Fait.'])
    expect(asksYesNo(q)).toBe(false)
})

test("the 3D bot is shown Claude's state and its tool's name, nothing else", () => {
  expect(faceOf(false, null, null, false)).toEqual({ state: 'idle', tool: null })
  expect(faceOf(true, 'Bash', null, false)).toEqual({ state: 'working', tool: 'Bash' })
  expect(faceOf(true, 'AskUserQuestion', null, true)).toEqual({ state: 'waiting', tool: null }) // its dialog waits on the user
  expect(faceOf(false, null, 'question', true)).toEqual({ state: 'waiting', tool: null })
  expect(faceOf(false, 'Bash', 'happy', false)).toEqual({ state: 'done', tool: null })
  expect(faceOf(false, null, 'oops', false)).toEqual({ state: 'failed', tool: null })
})

test('a poll that saw the same thing is not written again', () => {
  expect(same(null, quiet)).toBe(false)
  expect(same(quiet, { ...quiet })).toBe(true)
  expect(same(quiet, { ...quiet, frame: 1 })).toBe(false)
  expect(same(listening, { ...listening, levels: [0.001, 0.002, 0.3] })).toBe(false)
})

test('consumption shows each measured figure apart, and says when none is', () => {
  expect(costLine(null)).toBe('consommation : indisponible')
  const u = { context: 34.4, fiveHour: 23, sevenDay: 41, usd: 12.345, turnIn: 0, turnOut: 0 }
  expect(costLine(u)).toBe('contexte 34 % · quota 5 h 23 % · semaine 41 % · équiv. API 12,35 $, non facturé')
  expect(costLine({ ...u, fiveHour: null, sevenDay: null })).toBe('contexte 34 % · prix API ≈ 12,35 $') // no quota: may be billed
  expect(costLine({ ...u, fiveHour: null, sevenDay: null, usd: null })).toBe('contexte 34 %')
  expect(turnTokens(u)).toBeNull()
  expect(turnTokens({ ...u, turnIn: 1_400_000, turnOut: 12_300 })).toBe('1,4 M lus · 12 k générés')
  expect(tokens(850)).toBe('850')
})

test('the detailed pane draws on the terminal', async ($, on) => {
  on('clock.now', async () => ({ value: 1000 }))
  const pane = await $.ui.mount({
    plugin: 'voice-avatar', surface: 'terminal', component: 'Pane', requestId: 'voice-avatar',
    props: { title: 'Claude', isFocused: false, bodyColumns: 40, placement: 'inline' } as never,
    viewport: { columns: 40, rows: 8 },
  })
  expect((await pane.find({ type: 'Text', text: 'Dernier tour' }))?.text).toBe('Dernier tour')
  expect((await pane.find({ type: 'Text', text: 'consommation' }))?.text).toBe('consommation : indisponible')
  expect((await pane.find({ type: 'Text', text: 'écoute' }))?.text).toBe('écoute arrêtée')
})

test('the detailed pane still draws once utterances were heard', async ($, on) => {
  // a list item named `h` hid the JSX factory: "h is not a function", and the pane went blank
  on('clock.now', async () => ({ value: 13000 }))
  const heard = [{ at: 1000, what: 'sent' }, { at: 2000, what: 'ignored' }]
  on('state.get', async (_, e, next) => (e.key === 'history' ? { value: { value: heard, version: 1 } } : next(e)))
  const pane = await $.ui.mount({
    plugin: 'voice-avatar', surface: 'terminal', component: 'Pane', requestId: 'voice-avatar',
    props: { title: 'Claude', isFocused: false, bodyColumns: 40, placement: 'dock' } as never,
    viewport: { columns: 40, rows: 26 },
  })
  expect((await pane.find({ type: 'Text', text: '✓ reçu' }))?.text).toBe('✓ reçu · il y a 12 s')
})

test('the pane lists what became of each utterance and each step of the turn, never their text', () => {
  expect(heardLine({ at: 1000, what: 'sent' }, 13000)).toBe('✓ reçu · il y a 12 s')
  expect(stepLine({ id: 'a', name: 'Bash', since: 0, ms: 4200 }, 9000, 0)).toBe('✓ Bash 4 s')
  expect(stepLine({ id: 'b', name: 'Read', since: 1000, ms: null }, 3000, 1)).toBe('⠙ Read 2 s')
  expect(bigFace(listening, false)[0]).toBe('  ◕     ◕  ')
  expect(bigFace({ ...listening, target: 'ambient' }, false)[0]).toBe('  ─     ─  ')
  expect(bigFace({ ...listening, mood: 'happy' }, false)[2]).toBe('  ╰─────╯  ')
})
