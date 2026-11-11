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
  voice: string
}

/** The listener's command line: PowerShell running the plugin's script, with the options. */
export function listenArgv(shell: string, script: string, o: ListenOptions): string[] {
  const argv = [shell, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Language', o.language || 'fr', '-CallApp', o.callApp.trim() || 'none']
  if (o.autoSend) argv.push('-AutoSend')
  if (o.whisperStream) argv.push('-Whisper', o.whisperStream)
  if (o.whisperModel) argv.push('-Model', o.whisperModel)
  if (o.scene) argv.push('-Scene')
  if (o.voice) argv.push('-Voice', o.voice)
  return argv
}

export type Heard = { said: string; send: boolean } | { error: string; where: string }

/** One line of the listener's output: a sentence for Claude, why it could not start, or nothing. */
export function parseLine(line: string): Heard | null {
  try {
    const v: unknown = JSON.parse(line)
    if (typeof v !== 'object' || v === null) return null
    const o = v as Record<string, unknown>
    if (typeof o['said'] === 'string' && o['said'].trim()) return { said: o['said'].trim(), send: o['send'] === true }
    if (typeof o['error'] === 'string') return { error: o['error'], where: typeof o['where'] === 'string' ? o['where'] : '' }
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
  return `${lang(language) === 'fr' ? fr : en} · /listen stop`
}

/** The language the plugin talks and writes in: French for fr*, English for anything else. */
export type Lang = 'fr' | 'en'
export const lang = (language: string): Lang => (language.trim().toLowerCase().startsWith('fr') ? 'fr' : 'en')

// The two voices piper-voice's setup installs.
const VOICES: Record<Lang, string> = { fr: 'fr_FR-siwis-medium', en: 'en_US-ljspeech-medium' }

/**
 * The Piper voice to ask for: the voice option when set; none when PIPER_VOICE_VOICE already
 * picks the service's default (the user's choice); else the one of the language.
 */
export function voiceFor(language: string, chosen: string, serviceDefault: string | undefined): string {
  if (chosen.trim()) return chosen.trim()
  if ((serviceDefault ?? '').trim()) return ''
  return VOICES[lang(language)]
}

/** What /listen, /speak and the listener's errors say, in each language. */
export const TEXT = {
  fr: {
    usageListen: '/listen écoute (Windows), /listen stop, /listen pause, /listen resume, /listen status',
    usageSpeak: '/speak on dit les réponses de cette session à voix haute, /speak off, /speak stop coupe la voix, /speak montre l\'état',
    notWindows: 'L\'écoute ne marche que sous Windows (whisper.cpp, Core Audio) : rien n\'a été lancé.',
    already: 'L\'écoute tourne déjà. /listen stop libère le micro.',
    starts: (send: boolean) => `L'écoute démarre (${send ? 'chaque phrase est envoyée' : 'chaque phrase attend Entrée dans le prompt'}). La parole est transcrite sur cette machine. /listen stop libère le micro.`,
    notListening: 'Pas d\'écoute en cours : le micro n\'est pas ouvert.',
    stops: 'L\'écoute s\'arrête ; le micro est libéré.',
    paused: 'En pause : le micro est libéré.',
    resumed: 'L\'écoute reprend.',
    speakOn: 'Les réponses de cette session sont dites à voix haute par piper-voice (127.0.0.1). /speak off l\'arrête.',
    speakOff: 'Les réponses de cette session ne sont plus dites à voix haute.',
    cut: 'Voix coupée.',
    noPiper: 'piper-voice n\'a pas répondu sur 127.0.0.1.',
    speakState: (on: boolean, muted: boolean) => `${on ? 'Les réponses sont dites à voix haute' : 'Les réponses sont muettes'} dans cette session${muted ? ', mais toutes les sessions sont coupées (le fichier muted)' : ''}.`,
    noWhisper: (where: string) => `whisper-stream.exe introuvable : placez la version Windows de whisper.cpp sous ${where}, ou réglez l'option whisperStream`,
    noModel: (where: string) => `aucun modèle whisper pour cette langue : placez un ggml-*.bin sous ${where}, ou réglez l'option whisperModel`,
    running: (pid: string) => `une écoute tourne déjà (pid ${pid}) : arrêtez-la d'abord`,
  },
  en: {
    usageListen: '/listen starts listening (Windows), /listen stop, /listen pause, /listen resume, /listen status',
    usageSpeak: '/speak on says this session\'s replies aloud, /speak off, /speak stop cuts the voice, /speak shows the state',
    notWindows: 'Listening is Windows only (whisper.cpp, Windows Core Audio): nothing was started.',
    already: 'Already listening. /listen stop releases the microphone.',
    starts: (send: boolean) => `Listening starts (${send ? 'each sentence is sent' : 'each sentence waits in the prompt box for Enter'}). Speech is transcribed on this machine. /listen stop releases the microphone.`,
    notListening: 'Not listening: the microphone is not open.',
    stops: 'Listening stops; the microphone is released.',
    paused: 'Paused: the microphone is released.',
    resumed: 'Listening again.',
    speakOn: 'This session\'s replies are said aloud through piper-voice (127.0.0.1). /speak off stops it.',
    speakOff: 'This session\'s replies are no longer said aloud.',
    cut: 'Voice cut.',
    noPiper: 'piper-voice did not answer on 127.0.0.1.',
    speakState: (on: boolean, muted: boolean) => `${on ? 'Replies are said aloud' : 'Replies are silent'} in this session${muted ? ', but every session is muted (the muted file)' : ''}.`,
    noWhisper: (where: string) => `whisper-stream.exe not found: put whisper.cpp's Windows build under ${where}, or set the whisperStream option`,
    noModel: (where: string) => `no whisper model for this language: put a ggml-*.bin under ${where}, or set the whisperModel option`,
    running: (pid: string) => `already listening (pid ${pid}): stop it first`,
  },
} as const

/** A listener's error line, {"error": code, "where": ...}, as the user reads it. */
export function errorText(code: string, where: string, l: Lang): string {
  const t = TEXT[l]
  if (code === 'no-whisper') return t.noWhisper(where)
  if (code === 'no-model') return t.noModel(where)
  if (code === 'already') return t.running(where)
  return code
}