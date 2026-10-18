import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { fingerprint, listenArgv, listenBand, listenState, loopback, parseLine, speakable } from './speak'

// No test opens a microphone, starts PowerShell or reaches piper-voice: the disk, the
// environment, the processes and HTTP are all fakes below.

test('a reply is said from its first prose paragraph, without markdown, links or paths', () => {
  expect(speakable('# Title\n\nC\'est **fait** : voir [la PR](https://x.y/1) et `C:\\a\\b.txt`.\n\nSuite.')).toBe('C\'est fait : voir la PR et .')
  expect(speakable('```\ncode\n```\n\n- un\n- deux')).toBe('un deux')
  expect(speakable('| a | b |\n\n> cité\n\nPiper parle.')).toBe('Paillepeur parle.') // the French voice's spelling
  expect(speakable('Piper speaks.', 'en')).toBe('Piper speaks.')
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

test('the listener is started with the options, preview and no call app unless asked', () => {
  const base = { language: 'fr', autoSend: false, whisperStream: '', whisperModel: '', callApp: '', scene: false }
  const argv = listenArgv('pwsh', '/p/listen/voice_listen.ps1', base)
  expect(argv).toEqual(['pwsh', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', '/p/listen/voice_listen.ps1', '-Language', 'fr', '-CallApp', 'none'])
  const all = listenArgv('pwsh', 's', { ...base, autoSend: true, whisperStream: 'w.exe', whisperModel: 'm.bin', callApp: 'ChatGPT', scene: true })
  expect(all.slice(7)).toEqual(['-Language', 'fr', '-CallApp', 'ChatGPT', '-AutoSend', '-Whisper', 'w.exe', '-Model', 'm.bin', '-Scene'])
})

test("the listener's lines are read as sentences or errors, anything else ignored", () => {
  expect(parseLine('{"said":" bonjour ","send":true}')).toEqual({ said: 'bonjour', send: true })
  expect(parseLine('{"said":"bonjour"}')).toEqual({ said: 'bonjour', send: false })
  expect(parseLine('{"error":"no model"}')).toEqual({ error: 'no model' })
  expect(parseLine('{"said":"  "}')).toBeNull()
  expect(parseLine('WARNING: something')).toBeNull()
  expect(parseLine('')).toBeNull()
})

test('the band says the mic is open while the listener runs, and how to stop it', () => {
  expect(listenState(undefined)).toBe('starting')
  expect(listenState('on\n')).toBe('on')
  expect(listenState('garbled')).toBe('starting')
  expect(listenBand('on', 'fr')).toBe('🎙 écoute active : le micro est ouvert, transcrit sur cette machine · /listen stop')
  expect(listenBand('paused', 'en')).toBe('⏸ listening paused: mic closed · /listen stop')
})

/** An in-memory disk and environment, a recorded HTTP and process log: nothing real is touched. */
function fakes(on: On, env: Record<string, string>, files: Record<string, string>) {
  const fetched: string[] = []
  const ran: string[][] = []
  const spawned: string[][] = []
  const filled: string[] = []
  const submitted: string[] = []
  const missing = { deny: 'ENOENT' } as never
  const k = (path: string) => path.replace(/\\/g, '/') // the engine hands hooks the native path
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
    fetched.push(`${e.init?.method} ${e.url} ${e.init?.body ?? ''}`)
    return { value: { status: 200, ok: true, headers: {}, body: '{}' } } as never
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
  return { fetched, ran, spawned, filled, submitted, files }
}

const WIN = { OS: 'Windows_NT', LOCALAPPDATA: 'C:\\LA' }
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
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  await reply($, 'Bonjour.')
  expect(f.fetched).toEqual([])
})

test('/speak on says each reply once, through the loopback service; /speak off stops it', async ($, on) => {
  const f = fakes(on, WIN, {})
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  expect((await $.command.run(command('speak', 'on'))).text).toBe("This session's replies are said aloud through piper-voice (127.0.0.1). /speak off stops it.")
  expect(f.files['C:/LA/piper-voice/sessions/S1']).toBe('')
  await reply($, 'Bonjour.\n\nDétails.')
  expect(f.fetched).toEqual(['POST http://127.0.0.1:59126/v1/say {"text":"Bonjour."}'])
  await reply($, 'Bonjour.') // the same reply twice: said once
  expect(f.fetched.length).toBe(1)
  await $.command.run(command('speak', 'off'))
  expect(f.ran[f.ran.length - 1]).toEqual(['cmd', '/c', 'del', '/f', '/q', 'C:\\LA\\piper-voice\\sessions\\S1'])
})

test('the muted file silences every session', async ($, on) => {
  const f = fakes(on, WIN, { 'C:/LA/piper-voice/sessions/S1': '', 'C:/LA/piper-voice/muted': '' })
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  await reply($, 'Bonjour.')
  expect(f.fetched).toEqual([])
})

test('while the courtesy watcher runs, a reply is queued for it, whole', async ($, on) => {
  const f = fakes(on, WIN, { 'C:/LA/piper-voice/sessions/S1': '', 'C:/LA/piper-voice/courtesy/alive': '1' })
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  await reply($, 'Bonjour.')
  expect(f.fetched).toEqual([])
  const part = Object.keys(f.files).find(p => p.startsWith('C:/LA/piper-voice/courtesy/pending/'))
  expect(part?.endsWith('.part')).toBe(true)
  expect(f.ran[0]?.slice(0, 4)).toEqual(['cmd', '/c', 'move', '/y'])
  expect(f.ran[0]?.[5]?.endsWith('.txt')).toBe(true)
})

test('the 3D scene is off by default: the reply goes to piper-voice even when the scene has the focus', async ($, on) => {
  const f = fakes(on, WIN, { 'C:/LA/piper-voice/sessions/S1': '', 'C:/LA/voice-listen/focus': 'observatory' })
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  await reply($, 'Bonjour.')
  expect(f.fetched.length).toBe(1)
})

test('with its option set, the 3D scene gets the reply while its window has the focus', { options: { sceneSayFile: 'D:\\scene\\say.txt' } }, async ($, on) => {
  const f = fakes(on, WIN, { 'C:/LA/piper-voice/sessions/S1': '', 'C:/LA/voice-listen/focus': 'observatory' })
  on('turn.complete', async (_, e) => ({ text: e.answer }))
  await reply($, 'Bonjour.')
  expect(f.fetched).toEqual([])
  expect(f.files['D:/scene/say.part']).toBe('fr: Bonjour.')
})

test('/listen is refused off Windows, and nothing is started', async ($, on) => {
  const f = fakes(on, { OS: '', HOME: '/home/u' }, {})
  expect((await $.command.run(command('listen'))).text).toBe('Listening is Windows only (whisper.cpp, Windows Core Audio): nothing was started.')
  expect(f.spawned).toEqual([])
})

test("/listen starts the plugin's script, in preview: a sentence it hears waits in the prompt box", async ($, on) => {
  const f = fakes(on, WIN, {})
  const said = (await $.command.run(command('listen'))).text ?? ''
  expect(said.startsWith('Listening starts (each sentence waits in the prompt box for Enter)')).toBe(true)
  await settle()
  expect(f.spawned.length).toBe(1)
  expect(f.spawned[0]?.[6]?.endsWith('/listen/voice_listen.ps1')).toBe(true)
  expect(f.spawned[0]?.includes('-AutoSend')).toBe(false)
  expect(f.filled).toEqual(['bonjour Claude'])
  expect(f.submitted).toEqual([])
})

// The kit holds a plugin's prompt.submit until the session is idle, which a test never is, so
// what is seen here is the other half: the flag reaches the script and nothing is left in the box.
test('with autoSend, the script is told to send and nothing waits in the prompt box', { options: { autoSend: true } }, async ($, on) => {
  const f = fakes(on, WIN, {})
  expect((await $.command.run(command('listen'))).text?.startsWith('Listening starts (each sentence is sent)')).toBe(true)
  await settle()
  expect(f.spawned[0]?.includes('-AutoSend')).toBe(true)
  expect(f.filled).toEqual([])
})

test('/listen stop with nothing listening says so and writes nothing', async ($, on) => {
  const f = fakes(on, WIN, {})
  expect((await $.command.run(command('listen', 'stop'))).text).toBe('Not listening.')
  expect(Object.keys(f.files)).toEqual([])
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