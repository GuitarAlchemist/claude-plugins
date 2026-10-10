// What the /ga panes keep between draws: the conversation with the Guitar Alchemist chatbot, its
// health, and the chord pane's voicings and OPTIC-K ladders.

export type GaTurn = {
  id: string
  at: number
  question: string
  status: 'pending' | 'done' | 'error'
  answer: string
  agentId: string
  confidence: number
  routing: string
  elapsedMs: number
  // The trace's debug.mode: "Agent" for an LLM agent's answer, "DeterministicAgent" for GA's own; absent before 0.2.15.
  mode?: string
  // "source @ revision (query type)" when the answer is grounded in GA's own data, else ''.
  grounding: string
  error: string
}

export type GaHealth = {
  checkedAt: number
  ok: boolean
  provider: string
  model: string
  message: string
  // Ollama was idle and the server's embedding check cut its first load short; absent before 0.2.4.
  warming?: boolean
  // The embedding model the status names (not the routing model the check embeds with, which W loads since
  // 0.2.12); absent before 0.2.4.
  embeddingModel?: string
}

// One fingering in chart order (index 0 is the low E string, null a muted one).
// `missing`: the pitch classes of the chord GA read that this voicing does not hold; absent on voicings
// 0.2.2 left in state, which survives a reload.
export type ChordVoicing = { id: string; name: string; frets: (number | null)[]; score: number; missing?: number[] }

// The chord pane's last look-up: from GA's offline voicing index, or a fingering typed in.
export type ChordView = {
  query: string
  status: 'idle' | 'pending' | 'done' | 'error'
  source: 'ga' | 'fingering' | ''
  // GA's reading of the query (Cmaj7), '' for a fingering.
  chord: string
  voicings: ChordVoicing[]
  error: string
  // The pitch classes and root GA read the query as; absent before 0.2.3 and for a fingering.
  wanted?: number[]
  root?: number
}

// What ga_chord_to_set said of a chord symbol; `error` when it could not be asked.
// `refused`: the permission check refused the call to GA, as against an error of GA's own.
export type ChordSet = { forte: string; icv: string; prime: string; modal: string; error: string; refused: boolean }

declare module 'claude-code' {
  interface PluginState {
    'ga-chatbot': {
      turns: GaTurn[]
      health: GaHealth
      // The turn shown in full; '' shows the latest.
      focus: string
      chords: ChordView
      // Voicing ids whose diagram is unfolded, and those whose OPTIC-K ladder is.
      unfolded: string[]
      ladders: string[]
      // ga_chord_to_set's answers, by chord symbol.
      sets: Record<string, ChordSet>
    }
  }
}
