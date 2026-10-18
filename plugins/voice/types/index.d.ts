/** The listener's state: the plugin's own "starting", then what its state file says. */
export type Listen = 'starting' | 'loading' | 'on' | 'paused'

declare module 'claude-code' {
  interface PluginState {
    /** The listener this session started, while it runs: its state and when it started (epoch ms). */
    voice: { listening: { state: Listen; since: number } | null }
  }
}
