import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Heard, ListenOptions } from './speak'
import { fingerprint, listenArgv, listenBand, listenState, loopback, parseLine, speakable } from './speak'

// Two halves around the piper-voice service, both local:
//   - /speak on: Claude's replies are said aloud (their first paragraph), through piper-voice on
//     127.0.0.1, or queued for voice_courtesy.ps1 while another voice agent speaks;
//   - /listen: the microphone, transcribed by whisper.cpp on this machine (listen/voice_listen.ps1,
//     Windows only). Off until that command; shown above the prompt while it runs.
// The state files under the data folders are the ones the voice-avatar plugin reads.

const FRESH_MS = 3000
const VOICE_PROMPT_MS = 5000 // a prompt the listener sent this recently does not cut Piper
const STOP_GRACE_MS = 5000 // after /listen stop, the listener has this long to end on its own

const listening = atom({ plugin: 'voice', key: 'listening' } as const, null)

type Homes = { windows: boolean; voice: string; listen: string }
type Child = { stream: AsyncGenerator<unknown, unknown> & { return: (v?: never) => Promise<unknown> }; stopAt: number | null }

let child: Child | null = null
let lastVoicePrompt = -Infinity

const str = (o: PluginOptions, key: string, fallback: string) => (typeof o[key] === 'string' ? (o[key] as string) : fallback)
const flag = (o: PluginOptions, key: string) => o[key] === true

/** The data folders: piper-voice's and the listener's, as their own programs find them. */
export async function homes($: EngineInterface): Promise<Homes> {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const base = ((await $.env.get('LOCALAPPDATA')) || (await $.env.get('XDG_CACHE_HOME')) || `${(await $.env.get('HOME')) ?? '.'}/.cache`).replace(/\\/g, '/')
  const voice = ((await $.env.get('PIPER_VOICE_HOME')) || `${base}/piper-voice`).replace(/\\/g, '/')
  const listen = ((await $.env.get('VOICE_LISTEN_HOME')) || `${base}/voice-listen`).replace(/\\/g, '/')
  return { windows, voice, listen }
}

const exists = ($: EngineInterface, path: string) => $.fs.exists(path).catch(() => false)

async function fresh($: EngineInterface, path: string): Promise<boolean> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  return stat !== undefined && (await $.clock.now()) - stat.mtimeMs < FRESH_MS
}

// Written beside it, then moved over it: a reader never sees half a file.
async function writeWhole($: EngineInterface, h: Homes, path: string, text: string) {
  const part = path.replace(/\.txt$/, '') + '.part'
  await $.fs.write(part, text)
  const moved = await $.process.run(h.windows
    ? ['cmd', '/c', 'move', '/y', part.replace(/\//g, '\\'), path.replace(/\//g, '\\')]
    : ['mv', '-f', part, path])
  if (moved.exitCode !== 0) throw new Error(`could not move ${part}`)
}

async function remove($: EngineInterface, h: Homes, path: string) {
  await $.process.run(h.windows ? ['cmd', '/c', 'del', '/f', '/q', path.replace(/\//g, '\\')] : ['rm', '-f', path])
}

async function piper($: EngineInterface, path: string, body?: unknown) {
  const url = loopback(await $.env.get('PIPER_VOICE_URL'))
  return $.http.fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? '' : JSON.stringify(body),
  })
}

/**
 * Says Claude's reply when this session asked for it (/speak on): in the 3D scene while it has
 * the focus (the sceneSayFile option), queued while another voice agent speaks, else at once.
 */
export async function speakReply($: EngineInterface, text: string, o: PluginOptions): Promise<string> {
  const h = await homes($)
  const session = `${h.voice}/sessions/${await $.session.id()}`
  if ((await exists($, `${h.voice}/muted`)) || !(await exists($, session))) return 'off'
  const language = str(o, 'language', 'fr')
  const said = speakable(text, language)
  const print = fingerprint(said)
  if (!said || (await $.fs.read(session).catch(() => '')).trim() === print) return 'same'
  await $.fs.write(session, print)
  const scene = str(o, 'sceneSayFile', '').replace(/\\/g, '/')
  if (scene && (await fresh($, `${h.listen}/focus`)) && (await $.fs.read(`${h.listen}/focus`).catch(() => '')).trim() === 'observatory') {
    await writeWhole($, h, scene, `${language.slice(0, 2)}: ${said}`)
    return 'scene'
  }
  if (await fresh($, `${h.voice}/courtesy/alive`)) {
    await writeWhole($, h, `${h.voice}/courtesy/pending/${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}.txt`, said)
    return 'queued'
  }
  await piper($, '/v1/say', { text: said })
  return 'said'
}

/** A sentence the listener heard for Claude: sent as the user's prompt, or left in the prompt box. */
export async function deliver($: EngineInterface, heard: Heard | null, listenHome: string): Promise<string | null> {
  if (!heard) return null
  if ('error' in heard) {
    await $.ui.toast(`/listen: ${heard.error}`)
    return 'error'
  }
  lastVoicePrompt = await $.clock.now()
  if (heard.send) {
    void $.prompt.submit({ text: heard.said, asUser: true }).catch(() => undefined)
    return 'sent'
  }
  const box = await $.prompt.read()
  const { isFilled } = await $.prompt.fill({ text: (box.text && !/\s$/.test(box.text) ? ' ' : '') + heard.said, mode: 'append' })
  if (isFilled) return 'typed'
  await $.fs.write(`${listenHome}/last`, 'held').catch(() => undefined) // a dialog holds the box
  return 'held'
}

async function shell($: EngineInterface): Promise<string> {
  const pwsh = await $.process.run(['pwsh', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { timeoutMs: 15000 }).catch(() => undefined)
  return pwsh?.exitCode === 0 ? 'pwsh' : 'powershell.exe'
}

/** Starts the listener, which opens the microphone: only ever from /listen. */
export async function startListening($: EngineInterface, o: PluginOptions): Promise<string> {
  const h = await homes($)
  if (!h.windows) return 'Listening is Windows only (whisper.cpp, Windows Core Audio): nothing was started.'
  if (child) return 'Already listening. /listen stop releases the microphone.'
  const options: ListenOptions = {
    language: str(o, 'language', 'fr'),
    autoSend: flag(o, 'autoSend'),
    whisperStream: str(o, 'whisperStream', ''),
    whisperModel: str(o, 'whisperModel', ''),
    callApp: str(o, 'callApp', 'ChatGPT'),
    scene: str(o, 'sceneSayFile', '') !== '',
  }
  const stream = $.process.spawn({ argv: listenArgv(await shell($), `${$.plugin.root}/listen/voice_listen.ps1`, options) })
  const mine: Child = { stream: stream as unknown as Child['stream'], stopAt: null }
  child = mine
  await update($, listening, () => ({ state: 'starting' as const, since: Date.now() }))
  void (async () => {
    let rest = ''
    try {
      for await (const piece of stream) {
        if (piece.stream !== 'stdout') continue
        rest += piece.text
        for (let i = rest.indexOf('\n'); i >= 0; i = rest.indexOf('\n')) {
          const line = rest.slice(0, i).trim()
          rest = rest.slice(i + 1)
          await deliver($, parseLine(line), h.listen).catch(() => undefined)
        }
      }
      await deliver($, parseLine(rest.trim()), h.listen).catch(() => undefined)
    } catch {
      // it could not start, or it was stopped: the band goes either way
    } finally {
      if (child === mine) child = null
      await update($, listening, () => null).catch(() => undefined) // the session may be gone
    }
  })()
  return `Listening starts (${options.autoSend ? 'each sentence is sent' : 'each sentence waits in the prompt box for Enter'}). Speech is transcribed on this machine. /listen stop releases the microphone.`
}

/** Asks the listener to stop (it releases the mic at once); one that does not is killed. */
export async function stopListening($: EngineInterface): Promise<string> {
  const h = await homes($)
  if (!child && !(await exists($, `${h.listen}/listen.pid`))) return 'Not listening.'
  await $.fs.write(`${h.listen}/stop`, '')
  if (child) child.stopAt = await $.clock.now()
  return 'Listening stops; the microphone is released.'
}

const USAGE_LISTEN = '/listen starts listening (Windows), /listen stop, /listen pause, /listen resume, /listen status'
const USAGE_SPEAK = '/speak on says this session\'s replies aloud, /speak off, /speak stop cuts the voice, /speak shows the state'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'listen', description: USAGE_LISTEN })
    await $.command.register({ name: 'speak', description: USAGE_SPEAK })
    // While the listener runs: its state for the band, and a kill if a stop was not obeyed.
    $.clock.every(1000, async () => {
      const running = child
      if (!running) return
      const now = await $.clock.now()
      if (running.stopAt !== null && now - running.stopAt > STOP_GRACE_MS) {
        void running.stream.return().catch(() => undefined)
        return
      }
      const h = await homes($)
      const text = (await fresh($, `${h.listen}/state`)) ? await $.fs.read(`${h.listen}/state`).catch(() => '') : ''
      const state = listenState(text)
      await update($, listening, was => (was && was.state === state ? was : { state, since: was?.since ?? Date.now() }))
    })
    return started
  })

  on('session.end', async ($, e, next) => {
    if (child) await stopListening($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'listen' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    const h = await homes($)
    if (arg === '' || arg === 'start') return { text: await startListening($, options) }
    if (arg === 'stop') return { text: await stopListening($) }
    if (arg === 'pause' || arg === 'resume') {
      if (!child) return { text: 'Not listening.' }
      await $.fs.write(`${h.listen}/pause`, arg === 'pause' ? 'paused' : 'resumed')
      return { text: arg === 'pause' ? 'Paused: the microphone is released.' : 'Listening again.' }
    }
    if (arg === 'status') {
      const v = await read($, listening)
      return { text: v ? listenBand(v.state, 'en') : 'Not listening: the microphone is not open.' }
    }
    return { text: USAGE_LISTEN }
  })

  on('command.run', { command: 'speak' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    const h = await homes($)
    const session = `${h.voice}/sessions/${await $.session.id()}`
    if (arg === 'on') {
      await $.fs.write(session, '')
      return { text: 'This session\'s replies are said aloud through piper-voice (127.0.0.1). /speak off stops it.' }
    }
    if (arg === 'off') {
      await remove($, h, session)
      return { text: 'This session\'s replies are no longer said aloud.' }
    }
    if (arg === 'stop') {
      const r = await piper($, '/v1/stop').catch(() => undefined)
      return { text: r?.status === 200 ? 'Voice cut.' : 'piper-voice did not answer on 127.0.0.1.' }
    }
    if (arg !== '') return { text: USAGE_SPEAK }
    const muted = await exists($, `${h.voice}/muted`)
    const on_ = await exists($, session)
    return { text: `${on_ ? 'Replies are said aloud' : 'Replies are silent'} in this session${muted ? ', but every session is muted (the muted file)' : ''}. ${USAGE_SPEAK}` }
  })

  // The user speaking again (typing, or a prompt of their own) cuts Piper; a sentence the
  // listener just sent does not: it was heard over nothing, since Piper's voice is dropped.
  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    const fromVoice = now - lastVoicePrompt < VOICE_PROMPT_MS
    if (!fromVoice) {
      void (async () => {
        const h = await homes($)
        if ((await exists($, `${h.voice}/muted`)) || !(await exists($, `${h.voice}/sessions/${await $.session.id()}`))) return
        await piper($, '/v1/stop')
      })().catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The main loop's answer, once its turn is over; a failure to speak never reaches the turn.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') void speakReply($, done.text, options).catch(() => undefined)
    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, listening)
    if (!v || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Text color={v.state === 'on' ? '#ff5f5f' : '#ffaf00'} weight="bold">{listenBand(v.state, str(options, 'language', 'fr'))}</Text>
        {await next(e).catch(() => null)}
      </Box>
    )
  })
}
