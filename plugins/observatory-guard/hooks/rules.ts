// The author runs the Observatory prototype and its native DLSS copy while sessions edit them. A scene
// script that stops parsing shows them a void with only the steel cube, a probe window pops over their
// demo, and a PID typed from memory can stop their window. Each rule below is one those sessions
// already follow by hand (the godot-rtx skill).
// Pure text work only: everything that reaches the engine (`$`) lives in register.tsx.

// The two projects the author runs, and the Godot that checks each one.
export const ROOTS = ['C:/tmp/observatory-prototype-v1', 'C:/tmp/observatory-dlss'] as const
export const STOCK_GODOT =
  'C:/Users/spare/AppData/Local/Microsoft/WinGet/Packages/GodotEngine.GodotEngine_Microsoft.Winget.Source_8wekyb3d8bbwe/Godot_v4.6.1-stable_win64_console.exe'
export const FORK_GODOT = 'C:/tmp/godot-nvidia-dlss/godot/bin/godot.windows.editor.x86_64.console.exe'
// The folders whose scripts the author's runs load: the scene's, and the native demo's.
export const WATCHED = ['scripts', 'artpass/dlss'] as const

export function slash(path: string): string {
  return path.replace(/\\/g, '/')
}

// The live project a path is in, spelled as in `roots`; undefined outside them.
export function rootOf(path: string, roots: readonly string[] = ROOTS): string | undefined {
  const p = slash(path).toLowerCase()
  return roots.find(r => p.startsWith(`${r.toLowerCase()}/`))
}

// OBSERVATORY_GUARD_ROOTS ("<prototype>;<copy>") points the guard at a throwaway pair, to test it
// without touching the projects the author runs.
export function rootsFrom(value: string | undefined): readonly string[] {
  const list = (value ?? '').split(';').map(s => slash(s.trim()).replace(/\/+$/, '')).filter(Boolean)
  return list.length === 2 ? list : ROOTS
}

export function godotFor(root: string): string {
  return root.toLowerCase().endsWith('observatory-dlss') ? FORK_GODOT : STOCK_GODOT
}

export function toRes(root: string, path: string): string {
  return `res://${slash(path).slice(root.length + 1)}`
}

export function isScript(path: string): boolean {
  return /\.gd$/i.test(path)
}

// Godot's lines that say why a script failed: the error, and the `at:` line after it naming file:line.
export function parseErrors(output: string): string[] {
  const lines = output.split('\n').map(l => l.replace(/\r$/, ''))
  const found: string[] = []
  lines.forEach((line, i) => {
    if (!/SCRIPT ERROR|Parse Error|ERROR: Failed to load script|Compile Error/.test(line)) return
    found.push(line.trim())
    const next = lines[i + 1]
    if (next && /^\s+at:/.test(next)) found.push(next.trim())
  })
  return [...new Set(found)].slice(0, 8)
}

// ---- Shell commands ----

// The scripts a command runs (a .ps1, .sh, .py, .cmd or .bat named in it), to read their text too.
export function scriptPaths(command: string): string[] {
  const out = new Set<string>()
  for (const m of command.matchAll(/["']?([A-Za-z]:[\\/][^\s"'|;&<>]+?|[.\w~\-/\\]+?)\.(ps1|sh|py|cmd|bat)\b["']?/g)) {
    out.add(`${m[1]}.${m[2]}`)
  }
  return [...out].slice(0, 6)
}

// A Godot run that opens a window: Godot named, more `--path` than `--headless`, or the demo's launcher.
export function opensGodotWindow(text: string): boolean {
  if (/observatory-dlss\.cmd/i.test(text)) return true
  if (!/godot[^\s"'\\/]*\.exe/i.test(text)) return false
  if (/--check-only|--export-(?:release|debug|pack)|--import\b/.test(text) && !/--resolution|--maximized|--fullscreen/.test(text)) {
    return false
  }
  const paths = text.match(/--path\b/g)?.length ?? 0
  const headless = text.match(/--headless\b/g)?.length ?? 0
  return paths > headless
}

// A run of NVIDIA's DLSS fork with --fixed-fps. On 2026-10-03, under path tracing with Ray
// Reconstruction, it drew haze over black and never changed, with Streamline's `slSetConstants ...
// eErrorDuplicatedConstants` on every frame; the same probe without --fixed-fps was clean
// (artpass/dlss/NOTES.md in the prototype). Judged statement by statement, so that a stock Godot run
// with --fixed-fps beside a fork run is not caught, and through variables that hold the fork's path.
// A command that means it says so with `fixed-fps-ok` (in a comment).
const FORK_EXE = /godot-nvidia-dlss[\\/][^\s'"]*\.exe|godot\.windows\.(?:editor|template)[\w.]*\.exe/i

export function forkWithFixedFps(text: string): boolean {
  if (/fixed-fps-ok/i.test(text)) return false
  const vars = new Set<string>()
  for (const m of text.matchAll(/\$?\{?(\w+)\}?\s*=\s*["']?([^\n;"']+)/g)) {
    if (FORK_EXE.test(m[2] ?? '')) vars.add((m[1] ?? '').toLowerCase())
  }
  return text.split(/\r?\n|;|&&|\|\|/).some(s => {
    if (!/--fixed-fps\b/.test(s)) return false
    if (FORK_EXE.test(s)) return true
    return [...vars].some(v => new RegExp(`\\$\\{?${v}\\b`, 'i').test(s))
  })
}

// The processes a command would stop: numeric PIDs, or every Godot (every Python) when it stops them by
// name.
export type StopTargets = { pids: number[]; allGodot: boolean; allPython: boolean }

export function stopTargets(text: string): StopTargets | undefined {
  if (!/\b(?:Stop-Process|spps|taskkill|kill)\b|\.Kill\(/i.test(text)) return undefined
  const pids = new Set<number>()
  const add = (list: string) => {
    for (const n of list.split(/[\s,]+/)) if (/^\d+$/.test(n)) pids.add(Number(n))
  }
  for (const m of text.matchAll(/(?:Stop-Process|spps)\b[^\n;|]*?(?:-Id|-PID)\s+((?:\d+\s*,\s*)*\d+)/gi)) add(m[1] ?? '')
  for (const m of text.matchAll(/(?:Stop-Process|spps)\s+((?:\d+\s*,\s*)*\d+)\b/gi)) add(m[1] ?? '')
  for (const m of text.matchAll(/taskkill\b[^\n;|]*?\/PID\s+(\d+)/gi)) add(m[1] ?? '')
  for (const m of text.matchAll(/\bkill\s+(?:-\w+\s+)*(\d+)/g)) add(m[1] ?? '')
  for (const m of text.matchAll(/Get-Process\s+-Id\s+(\d+)[^\n;]*\|\s*Stop-Process/gi)) add(m[1] ?? '')
  const allGodot =
    /(?:Stop-Process|spps)\b[^\n;|]*-Name\s+['"]?godot/i.test(text) ||
    /taskkill\b[^\n;|]*\/IM\s+['"]?godot/i.test(text) ||
    /Get-Process[^\n|]*godot[^\n]*\|\s*Stop-Process/i.test(text) ||
    /\b(?:pkill|killall)\b[^\n;|]*godot/i.test(text)
  const allPython =
    /(?:Stop-Process|spps)\b[^\n;|]*-Name\s+['"]?python/i.test(text) ||
    /taskkill\b[^\n;|]*\/IM\s+['"]?python/i.test(text) ||
    /Get-Process[^\n|]*python[^\n]*\|\s*Stop-Process/i.test(text) ||
    /\b(?:pkill|killall)\b[^\n;|]*python/i.test(text)
  if (pids.size === 0 && !allGodot && !allPython) return undefined
  return { pids: [...pids], allGodot, allPython }
}

// ---- ComfyUI ----

// A ComfyUI server from its Python command line. The author's own listens on 8188 (the portable
// build's default, no --port); a session's task-local one is started on another port with its own
// --base-directory, and is the session's to stop.
export type ComfyProc = { pid: number; port: number; mine: boolean; base: string; started: string }

export function comfyFrom(p: { pid: number; cmd: string; started: string }): ComfyProc | undefined {
  if (!/comfyui[\\/]+main\.py\b|\bmain\.py\b[^\n]*--base-directory/i.test(p.cmd)) return undefined
  const port = Number(p.cmd.match(/--port[=\s]+(\d+)/)?.[1] ?? 8188)
  const base = slash(p.cmd.match(/--base-directory[=\s]+("?)([^"\s]+)\1/)?.[2] ?? '')
  return { pid: p.pid, port, mine: port !== 8188, base, started: p.started }
}

export const COMFY_SCRIPT = [
  "Get-CimInstance Win32_Process -Filter \"Name like 'python%'\" | Where-Object { $_.CommandLine -match 'main\\.py' } | ForEach-Object {",
  "  [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; cmd = $_.CommandLine; title = ''; started = $_.CreationDate.ToString('HH:mm') }",
  '} | ConvertTo-Json -Compress',
].join('\n')

// A copy into the native demo's project (Copy-Item, cp, copy, robocopy, xcopy, shutil.copy).
export function copiesIntoDlss(text: string): boolean {
  return /(?:Copy-Item|\bcpi?\b|\bcopy\b|robocopy|xcopy|shutil\.copy\w*|copyfile)[^\n]*observatory-dlss/i.test(text)
}

// ---- Godot processes ----

export type GodotProc = { pid: number; ppid: number; cmd: string; title: string; started: string }
export type ProcKind = 'demo' | 'editor' | 'probe' | 'headless' | 'other'

// demo: what the author plays (the DLSS demo, a run from the editor, the project run bare); probe: a
// session's --script run; editor: the editor or project manager.
export function classify(p: GodotProc): ProcKind {
  const cmd = p.cmd
  if (/--headless\b/.test(cmd)) return 'headless'
  if (/dlss_play\.gd/i.test(cmd)) return 'demo'
  if (/--remote-debug\b/.test(cmd)) return 'demo'
  if (/(?:^|\s)(?:-e|--editor|-p|--project-manager)(?:\s|$)/.test(cmd)) return 'editor'
  if (/--script\b/.test(cmd)) return 'probe'
  if (/observatory/i.test(cmd) || /observatory/i.test(p.title)) return 'demo'
  if (!/--path\b/.test(cmd)) return 'editor'
  return 'other'
}

// What `Get-CimInstance … | ConvertTo-Json` printed: one object when one process matched, else a list.
export function parseProcs(json: string): GodotProc[] {
  const t = json.trim()
  if (!t) return []
  const raw = JSON.parse(t) as unknown
  const list = Array.isArray(raw) ? raw : [raw]
  return list.map(r => {
    const o = r as Record<string, unknown>
    return {
      pid: Number(o.pid ?? 0),
      ppid: Number(o.ppid ?? 0),
      cmd: String(o.cmd ?? ''),
      title: String(o.title ?? ''),
      started: String(o.started ?? ''),
    }
  })
}

export const PROCS_SCRIPT = [
  "$t = @{}; Get-Process -Name 'godot*' -ErrorAction SilentlyContinue | ForEach-Object { $t[$_.Id] = $_.MainWindowTitle }",
  "Get-CimInstance Win32_Process -Filter \"Name like 'godot%'\" | ForEach-Object {",
  "  [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; cmd = $_.CommandLine; title = $t[[int]$_.ProcessId]; started = $_.CreationDate.ToString('HH:mm') }",
  '} | ConvertTo-Json -Compress',
].join('\n')

// The command line cut to what tells runs apart: the exe's name and the arguments.
export function shortCmd(cmd: string): string {
  const m = cmd.match(/^\s*"?[^"]*?([^\\/"]+\.exe)"?\s*(.*)$/i)
  const text = m ? `${m[1]} ${m[2]}` : cmd
  return text.replace(/\s+/g, ' ').trim()
}
