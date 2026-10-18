// What of Claude's reply is said aloud, where it may be sent, and how the listener is started:
// plain functions, so the tests need no service, no microphone and no Windows.

import type { Listen } from '../types'

export const MAX_CHARS = 450
export const PIPER_URL = 'http://127.0.0.1:59126'

// Names the French voice misreads, spelt the way it should say them.
const SAY_AS_FR: [RegExp, string][] = [[/\bPiper\b/g, 'Paillepeur']] // paɪpɚ, read as pajpœʁ

/** The reply's first prose paragraph, without markdown, links or paths, cut at a sentence. */
export function speakable(md: string, language = 'fr'): string {
  const text = md.replace(/```[\s\S]*?```/g, ' ')
  let para = text.split(/\n\s*\n/).map(p => p.trim()).find(p => p !== '' && !/^[#|>]/.test(p)) ?? ''
  para = para
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/`([^`]*[\\/][^`]*)`/g, '') // inline code that is a path
    .replace(/\b[A-Za-z]:\\\S+/g, '') // bare Windows paths
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '') // list markers
    .replace(/\s+/g, ' ')
    .trim()
  if (language.startsWith('fr')) for (const [word, spoken] of SAY_AS_FR) para = para.replace(word, spoken)
  if (para.length > MAX_CHARS) {
    const cut = Math.max(...['.', '!', '?', ':'].map(c => para.lastIndexOf(c, MAX_CHARS - 1)))
    para = cut > 0 ? para.slice(0, cut + 1) : para.slice(0, MAX_CHARS)
  }
  return para
}

/** A short fingerprint (FNV-1a) of what was said, so the same reply is not said twice. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

/** piper-voice's address: PIPER_VOICE_URL only when it is on this machine, else the default. */
export function loopback(url: string | undefined): string {
  const given = (url ?? '').trim().replace(/\/+$/, '')
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i.test(given) ? given : PIPER_URL
}

export type ListenOptions = {
  language: string
  autoSend: boolean
  whisperStream: string
  whisperModel: string
  callApp: string
  scene: boolean
}

/** The listener's command line: PowerShell running the plugin's script, with the options. */
export function listenArgv(shell: string, script: string, o: ListenOptions): string[] {
  const argv = [shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Language', o.language || 'fr', '-CallApp', o.callApp.trim() || 'none']
  if (o.autoSend) argv.push('-AutoSend')
  if (o.whisperStream) argv.push('-Whisper', o.whisperStream)
  if (o.whisperModel) argv.push('-Model', o.whisperModel)
  if (o.scene) argv.push('-Scene')
  return argv
}

export type Heard = { said: string; send: boolean } | { error: string }

/** One line of the listener's output: a sentence for Claude, why it could not start, or nothing. */
export function parseLine(line: string): Heard | null {
  try {
    const v: unknown = JSON.parse(line)
    if (typeof v !== 'object' || v === null) return null
    const o = v as Record<string, unknown>
    if (typeof o['said'] === 'string' && o['said'].trim()) return { said: o['said'].trim(), send: o['send'] === true }
    if (typeof o['error'] === 'string') return { error: o['error'] }
  } catch {
    // not one of its lines
  }
  return null
}

/** What the listener's state file says, the plugin's own "starting" until it says more. */
export function listenState(text: string | undefined): Listen {
  const t = (text ?? '').trim()
  return t === 'loading' || t === 'on' || t === 'paused' ? t : 'starting'
}

const SHOWN: Record<Listen, [string, string]> = {
  starting: ['⏳ écoute : démarrage', '⏳ listening: starting'],
  loading: ['⏳ écoute : chargement du modèle, le micro va s\'ouvrir', '⏳ listening: loading the model, the mic is about to open'],
  on: ['🎙 écoute active : le micro est ouvert, transcrit sur cette machine', '🎙 listening: the mic is open, transcribed on this machine'],
  paused: ['⏸ écoute en pause : micro fermé', '⏸ listening paused: mic closed'],
}

/** The line shown above the prompt for as long as the listener runs. */
export function listenBand(state: Listen, language: string): string {
  const [fr, en] = SHOWN[state]
  return `${language.startsWith('fr') ? fr : en} · /listen stop`
}
