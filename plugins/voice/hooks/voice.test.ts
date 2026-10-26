import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { TEXT, errorText, fingerprint, lang, listenArgv, listenBand, listenState, loopback, parseLine, speakable, voiceFor } from './speak'

// No test opens a microphone, starts PowerShell or reaches piper-voice: the disk, the
// environment, the processes and HTTP are all fakes below. The spoken commands themselves are
// tested in listen/Commands.Tests.ps1.

test('a reply is said from its first prose paragraph, without markdown, links or paths', () => {
  expect(speakable('# Title\n\nC\'est **fait** : voir [la PR](https://x.y/1) et `C:\\a\\b.txt`.\n\nSuite.')).toBe('C\'est fait : voir la PR et .')
  expect(speakable('```\ncode\n```\n\n- un\n- deux')).toBe('un deux')
  expect(speakable('| a | b |\n\n> cité\n\nPiper parle.')).toBe('Paillepeur parle.') // the French voice's spelling
  expect(speakable('Piper speaks.', 'en')).toBe('Piper speaks.') // the English voice says it right
  expect(speakable('## Done\n\nThe **tests** pass, see [the PR](https://x.y/2).', 'en')).toBe('The tests pass, see the PR.')
  expect(speakable('')).toBe('')
})

test('a long reply is cut at the last sentence that fits', () => {
  const said = speakable(`${'a'.repeat(300)}. ${'b'.repeat(300)}.`)
  expect(said).toBe(`${'a'.repeat(300)}.`)
  expect(speakable('c'.repeat(600)).length).toBe(450)
})

test('the same reply has the same fingerprint, another a different one', () => {
  expect(fingerprint('Bonjour.')).toBe(fingerprint('Bonjour.'))
  expect(fingerprint('Bonjour.')).not.toBe(fingerprint('Bonsoir.'))
  expect(fingerprint('')).toMatch(/^[0-9a-f]{8}$/)
})

test('piper-voice is only ever reached on this machine', () => {
  expect(loopback(undefined)).toBe('http://127.0.0.1:59126')
  expect(loopback('http://localhost:6000/')).toBe('http://localhost:6000')
  expect(loopback('http://[::1]:59126')).toBe('http://[::1]:59126')
  expect(loopback('http://192.168.1.4:59126')).toBe('http://127.0.0.1:59126')
  expect(loopback('https://example.com')).toBe('http://127.0.0.1:59126')
  expect(loopback('http://127.0.0.1.evil.com')).toBe('http://127.0.0.1:59126')
})

test('the language is French for fr, English for anything else', () => {
  expect(lang('fr')).toBe('fr')
  expect(lang('FR-ca')).toBe('fr')
  expect(lang('en')).toBe('en')
  expect(lang('de')).toBe('en')
})

test('the Piper voice follows the language unless the user picked one', () => {
  expect(voiceFor('fr', '', undefined)).toBe('fr_FR-siwis-medium')
  expect(voiceFor('en', '', undefined)).toBe('en_US-ljspeech-medium')
  expect(voiceFor('en', 'en_GB-alan-medium', undefined)).toBe('en_GB-alan-medium') // the voice option
  expect(voiceFor('en', '', 'fr_FR-siwis-medium')).toBe('') // PIPER_VOICE_VOICE: the service's default
})

test('the listener is started with the options, preview and no call app unless asked', () => {
  const base = { language: 'fr', autoSend: false, whisperStream: '', whisperModel: '', callApp: '', scene: false, voice: '' }
  const argv = listenArgv('pwsh', '/p/listen/voice_listen.ps1', base)
  expect(argv).toEqual(['pwsh', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', '/p/listen/voice_listen.ps1', '-Language', 'fr', '-CallApp', 'none'])
  const all = listenArgv('pwsh', 's', { ...base, language: 'en', autoSend: true, whisperStream: 'w.exe', whisperModel: 'm.bin', callApp: 'ChatGPT', scene: true, voice: 'en_US-ljspeech-medium' })
  expect(all.slice(7)).toEqual(['-Language', 'en', '-CallApp', 'ChatGPT', '-AutoSend', '-Whisper', 'w.exe', '-Model', 'm.bin', '-Scene', '-Voice', 'en_US-ljspeech-medium'])
})

test("the listener's lines are read as sentences or errors, anything else ignored", () => {
  expect(parseLine('{"said":" bonjour ","send":true}')).toEqual({ said: 'bonjour', send: true })
  expect(parseLine('{"said":"hello"}')).toEqual({ said: 'hello', send: false })
  expect(parseLine('{"error":"no-model","where":"C:\\\\LA\\\\voice-listen\\\\models"}')).toEqual({ error: 'no-model', where: 'C:\\LA\\voice-listen\\models' })
  expect(parseLine('{"said":"  "}')).toBeNull()
  expect(parseLine('WARNING: something')).toBeNull()
  expect(parseLine('')).toBeNull()
})

test("the listener's errors read in the user's language", () => {
  expect(errorText('no-model', 'M', 'en')).toBe('no whisper model for this language: put a ggml-*.bin under M, or set the whisperModel option')
  expect(errorText('no-model', 'M', 'fr')).toBe('aucun modèle whisper pour cette langue : placez un ggml-*.bin sous M, ou réglez l\'option whisperModel')
  expect(errorText('no-whisper', 'W', 'en').startsWith('whisper-stream.exe not found: ')).toBe(true)
  expect(errorText('already', '42', 'en')).toBe('already listening (pid 42): stop it first')
  expect(errorText('already', '42', 'fr')).toBe('une écoute tourne déjà (pid 42) : arrêtez-la d\'abord')
  expect(errorText('something else', '', 'en')).toBe('something else')
})

test('the band says the mic is open while the listener runs, and how to stop it, in each language', () => {
  expect(listenState(undefined)).toBe('starting')
  expect(listenState('on\n')).toBe('on')
  expect(listenState('garbled')).toBe('starting')
  expect(listenBand('on', 'fr')).toBe('🎙 écoute active : le micro est ouvert, transcrit sur cette machine · /listen stop')
  expect(listenBand('on', 'en')).toBe('🎙 listening: the mic is open, transcribed on this machine · /listen stop')
  expect(listenBand('paused', 'en')).toBe('⏸ listening paused: mic closed · /listen stop')
  expect(listenBand('loading', 'en')).toBe('⏳ listening: loading the model, the mic is about to open · /listen stop')
})

test('every message has its English and its French', () => {
  const keys = (o: object) => Object.keys(o).sort()
  expect(keys(TEXT.en)).toEqual(keys(TEXT.fr))
  for (const k of keys(TEXT.en)) expect(String((TEXT.en as Record<string, unknown>)[k])).not.toBe(String((TEXT.fr as Record<string, unknown>)[k]))
})

// The kit resolves fs paths on its host before passing them to stubs. Linux
// therefore prefixes our simulated Windows paths with the plugin directory.
function fixturePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^.*\/(?=(?:C:\/LA|D:\/scene)\/)/, '')
}

test('the fake Windows disk recognizes paths resolved by either test host', () => {
  expect(fixturePath('C:\\LA\\piper-voice\\sessions\\S1')).toBe('C:/LA/piper-voice/sessions/S1')
  expect(fixturePath('/work/plugin/C:/LA/piper-voice/sessions/S1')).toBe('C:/LA/piper-voice/sessions/S1')
  expect(fixturePath('/work/plugin/D:/scene/say.part')).toBe('D:/scene/say.part')
  expect(fixturePath('/work/plugin/other/file.txt')).toBe('/work/plugin/other/file.txt')
  expect(fixturePath('/work/plugin/C:/elsewhere/file.txt')).toBe('/work/plugin/C:/elsewhere/file.txt')
})

/** An in-memory disk and environment, a recorded HTTP and process log: nothing real is touched. */
function fakes(on: On, env: Record<string, string>, files: Record<string, string>, opts: { voiceMissing?: boolean } = {}) {
  const fetched: string[] = []
  const ran: string[][] = []
  const spawned: string[][] = []
  const filled: string[] = []
  const submitted: string[] = []
  const missing = { deny: 'ENOENT' } as never
  const k = fixturePath
  on('env.get', async (_, e) => ({ value: env[e.name] }))
  on('fs.exists', async (_, e) => ({ value: k(e.path) in files }))
  on('fs.read', async (_, e) => (k(e.path) in files ? { value: files[k(e.path)]! } : missing))
  on('fs.write', async (_, e) => {
    files[k(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.stat', async (_, e) => (k(e.path) in files ? ({ value: { mtimeMs: 1000 } } as never) : missing))
  on('clock.now', async () => ({ value: 1500 }))
  on('session.id', async () => ({ value: 'S1' }))
  on('http.fetch', async (_, e) => {
    const body = e.init?.body ?? ''
    fetched.push(`${e.init?.method} ${e.url} ${body}`)
    const status = opts.voiceMissing && body.includes('"voice"') ? 400 : 200
    return { value: { status, ok: status === 200, headers: {}, body: '{}' } } as never
  })
  on('process.run', async (_, e) => {
    ran.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('process.spawn', async function* (_, e) {
    spawned.push([...e.argv])
    yield { stream: 'stdout', text: '{"said":"bonjour ' } as never
    yield { stream: 'stdout', text: `Claude","send":${e.argv.includes('-AutoSend')}}\nnot json\n` } as never // as the script prints it
    return { value: { code: 0, signal: null } } as never
  })
  on('prompt.read', async () => ({ value: { text: '', cursor: 0 } }) as never)
  on('prompt.fill', async (_, e) => {
    filled.push(e.text)
    return { isFilled: true } as never
  })
  on('prompt.submit', async (_, e) => {
    submitted.push(e.text)
    return { text: e.text } as never
  })
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  return { fetched, ran, spawned, filled, submitted, files }
}

const WIN = { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\LA' }
const ON = { 'C:/LA/piper-voice/sessions/S1': '' }
const EN = { options: { language: 'en' } }
const command = (name: string, args = '') => ({ command: name, args, origin: { kind: 'composer' }, presentation: 'inline' }) as never
const answer = (text: string) => ({ answer: text, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' }) as never
declare const setTimeout: (run: () => void, ms: number) => unknown // the runner's own timer: the test $ has no clock
// The listener's output and a spoken reply are handled after the call returns: let them run.
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 50))

async function reply($: Engine, text: string) {
  await $.turn.complete(answer(text))
  await settle()
}

test('a session that did not ask for voice stays silent', async ($, on) => {
  const f = fakes(on, WIN, {})
  await reply($, 'Bonjour.')
  expect(f.fetched).toEqual([])
})

test('/speak on says each reply once, in the French voice, through the loopback service; /speak off stops it', async ($, on) => {
  const f = fakes(on, WIN, {})
  expect((await $.command.run(command('speak', 'on'))).text).toBe(TEXT.fr.speakOn)
  expect(f.files).toEqual({ 'C:/LA/piper-voice/sessions/S1': '' })
  await reply($, 'Bonjour.\n\nDétails.')
  expect(f.fetched).toEqual(['POST http://127.0.0.1:59126/v1/say {"text":"Bonjour.","voice":"fr_FR-siwis-medium"}'])
  await reply($, 'Bonjour.') // the same reply twice: said once
  expect(f.fetched.length).toBe(1)
  expect((await $.command.run(command('speak', 'off'))).text).toBe(TEXT.fr.speakOff)
  expect(f.ran[f.ran.length - 1]).toEqual(['cmd', '/c', 'del', '/f', '/q', 'C:\\LA\\piper-voice\\sessions\\S1'])
})

test('in English, /speak answers in English and replies are said in the English voice', EN, async ($, on) => {
  const f = fakes(on, WIN, {})
  expect((await $.command.run(command('speak', 'on'))).text).toBe("This session's replies are said aloud through piper-voice (127.0.0.1). /speak off stops it.")
  await reply($, 'Done.\n\nDetails.')
  expect(f.fetched).toEqual(['POST http://127.0.0.1:59126/v1/say {"text":"Done.","voice":"en_US-ljspeech-medium"}'])
  expect((await $.command.run(command('speak'))).text).toBe(`Replies are said aloud in this session. ${TEXT.en.usageSpeak}`)
  expect((await $.command.run(command('speak', 'stop'))).text).toBe('Voice cut.')
  expect((await $.command.run(command('speak', 'what'))).text).toBe(TEXT.en.usageSpeak)
})

test('a voice the user picked wins, and PIPER_VOICE_VOICE leaves the choice to the service', { options: { language: 'en', voice: 'en_GB-alan-medium' } }, async ($, on) => {
  const f = fakes(on, { ...WIN, PIPER_VOICE_VOICE: 'fr_FR-siwis-medium' }, { ...ON })
  await reply($, 'Done.')
  expect(f.fetched).toEqual(['POST http://127.0.0.1:59126/v1/say {"text":"Done.","voice":"en_GB-alan-medium"}'])
})

test('with PIPER_VOICE_VOICE set and no voice option, no voice is asked for', EN, async ($, on) => {
  const f = fakes(on, { ...WIN, PIPER_VOICE_VOICE: 'en_US-ljspeech-medium' }, { ...ON })
  await reply($, 'Done.')
  expect(f.fetched).toEqual(['POST http://127.0.0.1:59126/v1/say {"text":"Done."}'])
})

test('a voice that is not installed: the reply is said in the service default instead', EN, async ($, on) => {
  const f = fakes(on, WIN, { ...ON }, { voiceMissing: true })
  await reply($, 'Done.')
  expect(f.fetched).toEqual([
    'POST http://127.0.0.1:59126/v1/say {"text":"Done.","voice":"en_US-ljspeech-medium"}',
    'POST http://127.0.0.1:59126/v1/say {"text":"Done."}',
  ])
})

test('the muted file silences every session', async ($, on) => {
  const f = fakes(on, WIN, { ...ON, 'C:/LA/piper-voice/muted': '' })
  await reply($, 'Bonjour.')
  expect(f.fetched).toEqual([])
})

test('while the courtesy watcher runs, a reply is queued for it, whole, its voice in its name', async ($, on) => {
  const f = fakes(on, WIN, { ...ON, 'C:/LA/piper-voice/courtesy/alive': '1' })
  await reply($, 'Bonjour.')
  expect(f.fetched).toEqual([])
  const part = Object.keys(f.files).find(p => p.startsWith('C:/LA/piper-voice/courtesy/pending/'))
  expect(part?.endsWith('.fr_FR-siwis-medium.part')).toBe(true)
  expect(f.ran[0]?.slice(0, 4)).toEqual(['cmd', '/c', 'move', '/y'])
  expect(f.ran[0]?.[5]?.endsWith('.fr_FR-siwis-medium.txt')).toBe(true)
})

test('in English, a queued reply carries the English voice', EN, async ($, on) => {
  const f = fakes(on, WIN, { ...ON, 'C:/LA/piper-voice/courtesy/alive': '1' })
  await reply($, 'Done.')
  expect(f.ran[0]?.[5]?.endsWith('.en_US-ljspeech-medium.txt')).toBe(true)
})

test('the 3D scene is off by default: the reply goes to piper-voice even when the scene has the focus', async ($, on) => {
  const f = fakes(on, WIN, { ...ON, 'C:/LA/voice-listen/focus': 'observatory' })
  await reply($, 'Bonjour.')
  expect(f.fetched.length).toBe(1)
})

test('with its option set, the 3D scene gets the reply, in its language, while its window has the focus', { options: { sceneSayFile: 'D:\\scene\\say.txt' } }, async ($, on) => {
  const f = fakes(on, WIN, { ...ON, 'C:/LA/voice-listen/focus': 'observatory' })
  await reply($, 'Bonjour.')
  expect(f.fetched).toEqual([])
  expect(f.files['D:/scene/say.part']).toBe('fr: Bonjour.')
})

test('in English, the 3D scene is told the reply is English', { options: { language: 'en', sceneSayFile: 'D:\\scene\\say.txt' } }, async ($, on) => {
  const f = fakes(on, WIN, { ...ON, 'C:/LA/voice-listen/focus': 'observatory' })
  await reply($, 'Done.')
  expect(f.files['D:/scene/say.part']).toBe('en: Done.')
})

test('/listen is refused off Windows, and nothing is started', async ($, on) => {
  const f = fakes(on, { OS: '', HOME: '/home/u' }, {})
  expect((await $.command.run(command('listen'))).text).toBe(TEXT.fr.notWindows)
  expect(f.spawned).toEqual([])
})

test('in English, /listen off Windows says so in English', EN, async ($, on) => {
  fakes(on, { OS: '', HOME: '/home/u' }, {})
  expect((await $.command.run(command('listen'))).text).toBe('Listening is Windows only (whisper.cpp, Windows Core Audio): nothing was started.')
})

test("/listen starts the plugin's script, in preview: a sentence it hears waits in the prompt box", async ($, on) => {
  const f = fakes(on, WIN, {})
  expect((await $.command.run(command('listen'))).text).toBe(TEXT.fr.starts(false))
  await settle()
  expect(f.spawned.length).toBe(1)
  expect(f.spawned[0]?.[6]?.endsWith('/listen/voice_listen.ps1')).toBe(true)
  expect(f.spawned[0]?.includes('-AutoSend')).toBe(false)
  expect(f.spawned[0]?.slice(7, 9)).toEqual(['-Language', 'fr'])
  expect(f.spawned[0]?.slice(-2)).toEqual(['-Voice', 'fr_FR-siwis-medium'])
  expect(f.filled).toEqual(['bonjour Claude'])
  expect(f.submitted).toEqual([])
})

test('in English, /listen starts the script in English, with the English voice', EN, async ($, on) => {
  const f = fakes(on, WIN, {})
  expect((await $.command.run(command('listen'))).text).toBe('Listening starts (each sentence waits in the prompt box for Enter). Speech is transcribed on this machine. /listen stop releases the microphone.')
  await settle()
  expect(f.spawned[0]?.slice(7, 9)).toEqual(['-Language', 'en'])
  expect(f.spawned[0]?.slice(-2)).toEqual(['-Voice', 'en_US-ljspeech-medium'])
})

// The kit holds a plugin's prompt.submit until the session is idle, which a test never is, so
// what is seen here is the other half: the flag reaches the script and nothing is left in the box.
test('with autoSend, the script is told to send and nothing waits in the prompt box', { options: { autoSend: true } }, async ($, on) => {
  const f = fakes(on, WIN, {})
  expect((await $.command.run(command('listen'))).text).toBe(TEXT.fr.starts(true))
  await settle()
  expect(f.spawned[0]?.includes('-AutoSend')).toBe(true)
  expect(f.filled).toEqual([])
})

test('/listen stop with nothing listening says so and writes nothing', async ($, on) => {
  const f = fakes(on, WIN, {})
  expect((await $.command.run(command('listen', 'stop'))).text).toBe(TEXT.fr.notListening)
  expect(Object.keys(f.files)).toEqual([])
})

test('in English, /listen stop, pause, status and help answer in English', EN, async ($, on) => {
  fakes(on, WIN, {})
  expect((await $.command.run(command('listen', 'stop'))).text).toBe('Not listening: the microphone is not open.')
  expect((await $.command.run(command('listen', 'pause'))).text).toBe('Not listening: the microphone is not open.')
  expect((await $.command.run(command('listen', 'status'))).text).toBe('Not listening: the microphone is not open.')
  expect((await $.command.run(command('listen', 'help'))).text).toBe(TEXT.en.usageListen)
})

test('while the listener runs, a line above the prompt says the mic is open and how to stop it', async ($, on) => {
  on('state.get', async (_, e, next) => (e.key === 'listening' ? { value: { value: { state: 'on', since: 0 }, version: 1 } } : next(e)))
  const band = await $.ui.mount({
    plugin: 'voice', surface: 'terminal', component: 'AbovePrompt',
    props: { isWorking: false } as never,
    viewport: { columns: 120, rows: 30 },
  })
  expect((await band.find({ type: 'Text', text: '/listen stop' }))?.text).toBe('🎙 écoute active : le micro est ouvert, transcrit sur cette machine · /listen stop')
})

test('in English, that line is English', EN, async ($, on) => {
  on('state.get', async (_, e, next) => (e.key === 'listening' ? { value: { value: { state: 'on', since: 0 }, version: 1 } } : next(e)))
  const band = await $.ui.mount({
    plugin: 'voice', surface: 'terminal', component: 'AbovePrompt',
    props: { isWorking: false } as never,
    viewport: { columns: 120, rows: 30 },
  })
  expect((await band.find({ type: 'Text', text: '/listen stop' }))?.text).toBe('🎙 listening: the mic is open, transcribed on this machine · /listen stop')
})

