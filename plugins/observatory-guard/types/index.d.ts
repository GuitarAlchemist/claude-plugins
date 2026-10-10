// What the /godot pane keeps between draws: the Godot processes read on demand, the last script checks.

export type ObservatoryGuardProc = {
  pid: number
  kind: 'demo' | 'editor' | 'probe' | 'headless' | 'other'
  title: string
  started: string
  cmd: string
}

export type ObservatoryGuardCheck = {
  at: string
  root: string
  file: string
  ok: boolean
  error: string
}

export type ObservatoryGuardMeta = { isLoading: boolean; readAt: string; errors: string[]; outOfSync: string[] }

// A ComfyUI server: the author's on 8188, or a session's task-local one (mine).
export type ObservatoryGuardComfy = { pid: number; port: number; mine: boolean; base: string; started: string }

declare module 'claude-code' {
  interface PluginState {
    'observatory-guard': {
      procs: ObservatoryGuardProc[]
      comfy: ObservatoryGuardComfy[]
      meta: ObservatoryGuardMeta
      checks: ObservatoryGuardCheck[]
    }
  }
}
