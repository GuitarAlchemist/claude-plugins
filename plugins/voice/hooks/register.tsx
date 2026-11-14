import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Heard, Lang, ListenOptions } from './speak'
import { TEXT, errorText, fingerprint, lang, listenArgv, listenBand, listenState, loopback, parseLine, speakable, voiceFor } from './speak'

// Two halves around the piper-voice service, both local:
//   - /speak on: Claude's replies are said aloud (their first paragraph), through piper-voice on
//     127.0.0.1, or queued for voice_courtesy.ps1 while another voice agent speaks;
//   - /listen: the microphone, transcribed by whisper.cpp on this machine (listen/voice_listen.ps1,
//     Windows only). Off until that command; shown above the prompt while it runs.
// The state files under the data folders are the ones the voice-avatar plugin reads. What the
// user reads and hears follows the language option: French for fr, English otherwise.

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

/** The Piper voice for the options: the voice option, else the language's unless the service picks. */
async function voiceOf($: EngineInterface, o: PluginOptions): Promise<string> {
  return voiceFor(str(o, 'language', 'fr'), str(o, 'voice', ''), await $.env.get('PIPER_VOICE_VOICE'))
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
    await writeWhole($, h, scene, `${lang(language)}: ${said}`)
    return 'scene'
  }
  const voice = await voiceOf($, o)
  if (await fresh($, `${h.voice}/courtesy/alive`)) {
    // the voice rides in the name, <time>.<voice>.txt: the watcher reads the text as it is
    const id = `${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`
    await writeWhole($, h, `${h.voice}/courtesy/pending/${id}${voice ? `.${voice}` : ''}.txt`, said)
    return 'queued'
  }
  const r = await piper($, '/v1/say', voice ? { text: said, voice } : { text: said })
  // a voice that is not installed: said in the service's own default rather than not at all
  if (voice && r.status === 400) await piper($, '/v1/say', { text: said })
  return 'said'
}

/** A sentence the listener heard for Claude: sent as the user's prompt, or left in the prompt box. */
export async function deliver($: EngineInterface, heard: Heard | null, listenHome: string, l: Lang): Promise<string | null> {
  if (!heard) return null
  if ('error' in heard) {
    await $.ui.toast(`/listen: ${errorText(heard.error, heard.where, l)}`)
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
  const l = lang(str(o, 'language', 'fr'))
  if (!h.windows) return TEXT[l].notWindows
  if (child) return TEXT[l].already
  const options: ListenOptions = {
    language: str(o, 'language', 'fr'),
    autoSend: flag(o, 'autoSend'),
    whisperStream: str(o, 'whisperStream', ''),
    whisperModel: str(o, 'whisperModel', ''),
    callApp: str(o, 'callApp', 'ChatGPT'),
    scene: str(o, 'sceneSayFile', '') !== '',
    voice: await voiceOf($, o),
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
          await deliver($, parseLine(line), h.listen, l).catch(() => undefined)
        }
      }
      await deliver($, parseLine(rest.trim()), h.listen, l).catch(() => undefined)
    } catch {
      // it could not start, or it was stopped: the band goes either way
    } finally {
      if (child === mine) child = null
      await update($, listening, () => null).catch(() => undefined) // the session may be gone
    }
  })()
  return TEXT[l].starts(options.autoSend)
}

/** Asks the listener to stop (it releases the mic at once); one that does not is killed. */
export async function stopListening($: EngineInterface, l: Lang): Promise<string> {
  const h = await homes($)
  if (!child && !(await exists($, `${h.listen}/listen.pid`))) return TEXT[l].notListening
  await $.fs.write(`${h.listen}/stop`, '')
  if (child) child.stopAt = await $.clock.now()
  return TEXT[l].stops
}

export const register: Register = (on, options) => {
  const language = str(options, 'language', 'fr')
  const t = TEXT[lang(language)]

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'listen', description: t.usageListen })
    await $.command.register({ name: 'speak', description: t.usageSpeak })
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
    if (child) await stopListening($, lang(language)).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'listen' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    const h = await homes($)
    if (arg === '' || arg === 'start') return { text: await startListening($, options) }
    if (arg === 'stop') return { text: await stopListening($, lang(language)) }
    if (arg === 'pause' || arg === 'resume') {
      if (!child) return { text: t.notListening }
      await $.fs.write(`${h.listen}/pause`, arg === 'pause' ? 'paused' : 'resumed')
      return { text: arg === 'pause' ? t.paused : t.resumed }
    }
    if (arg === 'status') {
      const v = await read($, listening)
      return { text: v ? listenBand(v.state, language) : t.notListening }
    }
    return { text: t.usageListen }
  })

  on('command.run', { command: 'speak' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    const h = await homes($)
    const session = `${h.voice}/sessions/${await $.session.id()}`
    if (arg === 'on') {
      await $.fs.write(session, '')
      return { text: t.speakOn }
    }
    if (arg === 'off') {
      await remove($, h, session)
      return { text: t.speakOff }
    }
    if (arg === 'stop') {
      const r = await piper($, '/v1/stop').catch(() => undefined)
      return { text: r?.status === 200 ? t.cut : t.noPiper }
    }
    if (arg !== '') return { text: t.usageSpeak }
    return { text: `${t.speakState(await exists($, session), await exists($, `${h.voice}/muted`))} ${t.usageSpeak}` }
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
        <Text color={v.state === 'on' ? '#ff5f5f' : '#ffaf00'} weight="bold">{listenBand(v.state, language)}</Text>
        {await next(e).catch(() => null)}
      </Box>
    )
  })
}
