/** What the voice plugin's tools say, read from their state files every 200 ms. */
export type Voices = {
  /** Piper is playing (voice_courtesy.ps1 writes courtesy/piper-speaking). */
  piper: boolean
  /** Gaïa, the ChatGPT app, is making sound (courtesy/other-speaking). */
  gaia: boolean
  /** The Observatory scene speaks: courtesy/speaking/observatory, refreshed every 0.5 s, is under 3 s old. */
  observatory: boolean
  /**
   * The voice plugin's listener (voice_listen.ps1): "loading" while whisper loads its model, "on" listens, "gaia" leaves the
   * mic to the call, "paused" the user paused it, "off" stopped (its state file is gone),
   * "unknown" its state file is stale or unreadable: it may have died without cleaning up, so
   * nothing says it still listens.
   */
  listen: 'loading' | 'on' | 'gaia' | 'paused' | 'unknown' | 'off'
  /** The microphone's peaks (0..1) over the last 20 s, oldest first; empty unless listening. */
  levels: number[]
  /** Who spoke on the speakers at each poll of the last 20 s, oldest first: the voices' line. */
  spoke: Speaker[]
  /** Who the user speaks to, set by "Top Claude", "Top Gaia" or "Top" (voice-listen/target). */
  target: 'claude' | 'gaia' | 'ambient'
  /** The cursor's phase, every 500 ms, while what the user says is for Claude. */
  blink: boolean
  /** An utterance reached the prompt in the last 1.5 s: the avatar winks. */
  wink: boolean
  /** What became of the utterance heard in the last 5 s, if any (voice-listen/last). */
  last: Outcome | null
  /** Counts the polls while Piper plays, so the mouth moves. */
  frame: number
  /**
   * How Claude's last turn ended: "happy" answered, "question" its answer ends on a question
   * for the user, "oops" it failed or was cut; null while a turn runs or before the first.
   */
  mood: 'happy' | 'question' | 'oops' | null
  /** That question is answered by yes or no ("Tu veux que je continue ?", not "Lequel ?"): the band offers 👍 oui / 👎 non. */
  yesNo: boolean
  /** The spinner's frame while Claude works, every 200 ms, so it turns and the times tick; 0 otherwise. */
  spin: number
  /** A question waits on the user: Claude's last turn ended on one, or its AskUserQuestion dialog is open. */
  asks: boolean
  /** The target changed in the last 3 s ("Top …", or the call's mic): the new one flashes. */
  moved: boolean
  /** The blinking phase, every 500 ms, while a question waits or the target just changed. */
  pulse: boolean
  /** The call with Gaïa has its microphone open (voice-listen/call): she hears what is said too. */
  callOpen: boolean
}

/** What became of an utterance (voice-listen/last). */
/** Piper speaking for Claude, Gaïa, the Observatory scene, or nobody. */
export type Speaker = 'claude' | 'gaia' | 'observatory' | null

export type Outcome ='sent' | 'typed' | 'ignored' | 'piper' | 'dropped' | 'held'

/** The tool Claude runs, and since when (epoch ms). */
export type Running = { name: string; since: number }

/** One utterance's fate, for the detailed pane's history (never its text). */
export type Heard = { at: number; what: Outcome }

/** One tool call of the main loop's current turn: `ms` once it is done. */
export type Step = { id: string; name: string; since: number; ms: number | null }

/**
 * What the session consumes, each figure measured or null when its source has none:
 * `context` the window's fill and `fiveHour` the five-hour quota used, in percent, and `usd`
 * the API price /cost totals (not what a subscription bills), from $.session.usage() every 2 s;
 * `turnIn` and `turnOut` the tokens the main loop's running or last turn read and generated,
 * summed over its steps.
 */
export type Usage = {
  context: number | null
  fiveHour: number | null
  /** The seven-day quota window used, in percent; it and `fiveHour` exist only for a subscription. */
  sevenDay: number | null
  usd: number | null
  turnIn: number
  turnOut: number
}

declare module 'claude-code' {
  interface PluginState {
    'voice-avatar': { voices: Voices | null; tool: Running | null; history: Heard[]; steps: Step[]; usage: Usage | null }
  }
}
