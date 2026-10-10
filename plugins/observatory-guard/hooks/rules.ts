// The author runs the Observatory prototype and its native DLSS copy while sessions edit them. A scene
// script that stops parsing shows them a void with only the steel cube, a probe window pops over their
// demo, and a PID typed from memory can stop their window. Each rule below is one those sessions
// already follow by hand (the godot-rtx skill).
// Pure text work only: everything that reaches the engine (`$`) lives in register.tsx.

// Configuration is explicit: no host-specific project or executable is selected implicitly.
export const WATCHED = ['scripts', 'artpass/dlss'] as const
export type GuardConfig = { roots: readonly [string, string]; godot: readonly [string, string] }

export function slash(path: string): string {
  return path.replace(/\\/g, '/')
}

// Lexical normalization only. UNC/device paths, relative paths and traversal above the anchor
// are unsupported; filesystem aliases/symlinks are not claimed to be resolved here.
export function normalizePath(path: string): string | undefined {
  const p = slash(path)
  if (!p || /[\x00-\x1f]/.test(p) || p.startsWith('//')) return undefined
  const anchor = p.match(/^[A-Za-z]:\//)?.[0] ?? (p.startsWith('/') ? '/' : '')
  if (!anchor) return undefined
  const parts: string[] = []
  for (const part of p.slice(anchor.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!parts.length) return undefined; parts.pop() }
    else { if (part.includes(':')) return undefined; parts.push(part) }
  }
  return `${anchor}${parts.join('/')}`
}

export function rootOf(path: string, roots: readonly string[] = []): string | undefined {
  const p = normalizePath(path)?.toLowerCase()
  return p ? roots.find(r => p.startsWith(`${r.toLowerCase()}/`)) : undefined
}

export function rootsFrom(value: string | undefined): readonly [string, string] {
  const list = (value ?? '').split(';').map(s => normalizePath(s.trim()))
  if (list.length !== 2 || list.some(p => !p || /^(?:[A-Za-z]:\/|\/)$/.test(p))) {
    throw new Error('OBSERVATORY_GUARD_ROOTS requires two absolute project paths')
  }
  const [a, b] = list as [string, string]
  if (a.toLowerCase() === b.toLowerCase() || rootOf(a, [b]) || rootOf(b, [a])) {
    throw new Error('OBSERVATORY_GUARD_ROOTS projects must be distinct and non-overlapping')
  }
  return [a, b]
}

export function configFrom(roots: string | undefined, binaries: string | undefined): GuardConfig {
  const projects = rootsFrom(roots)
  const list = (binaries ?? '').split(';').map(s => normalizePath(s.trim()))
  if (list.length !== 2 || list.some(p => !p || /^(?:[A-Za-z]:\/|\/)$/.test(p))) {
    throw new Error('OBSERVATORY_GUARD_GODOT requires two absolute executable paths')
  }
  return { roots: projects, godot: list as [string, string] }
}

export function godotFor(root: string, config: GuardConfig): string {
  // An alternate incoming source project uses the configured prototype checker.
  return root.toLowerCase() === config.roots[1].toLowerCase() ? config.godot[1] : config.godot[0]
}

export function toRes(root: string, path: string): string {
  return `res://${normalizePath(path)?.slice(root.length + 1) ?? ''}`
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

// Judge each invocation, including a bare executable (Godot uses the current project or opens
// its project manager). Assignments are not launches; headless flags apply only to that invocation.
export function opensGodotWindow(text: string, binaries: readonly string[] = []): boolean {
  const exe = /godot[^\s"'\\/]*\.exe/i
  const namesGodot = (value: string) => exe.test(value) || binaries.some(b => slash(value).toLowerCase().includes(b.toLowerCase()))
  const vars = new Set<string>()
  for (const m of text.matchAll(/\$(\w+)\s*=\s*['"]([^'"\n]+)['"]/g)) {
    if (namesGodot(m[2] ?? '')) vars.add(m[1] ?? '')
  }
  return text.split(/\r?\n|;|&&|\|\|/).some(statement => {
    if (/observatory-dlss\.cmd/i.test(statement)) return true
    if (/^\s*\$\w+\s*=\s*['"][^'"]+['"]\s*$/.test(statement)) return false
    const viaVariable = [...vars].some(v =>
      new RegExp(`(?:&\\s*|-(?:FilePath|f)\\s+)\\$${v}\\b`, 'i').test(statement))
    if (!namesGodot(statement) && !viaVariable) return false
    if (/--(?:headless|help|version)\b/.test(statement)) return false
    return !/--check-only|--export-(?:release|debug|pack)|--import\b/.test(statement) ||
      /--resolution|--maximized|--fullscreen/.test(statement)
  })
}

// A run of NVIDIA's DLSS fork with --fixed-fps. On 2026-10-03, under path tracing with Ray
// Reconstruction, it drew haze over black and never changed, with Streamline's `slSetConstants ...
// eErrorDuplicatedConstants` on every frame; the same probe without --fixed-fps was clean
// (artpass/dlss/NOTES.md in the prototype). Judged statement by statement, so that a stock Godot run
// with --fixed-fps beside a fork run is not caught, and through variables that hold the fork's path.
// A command that means it says so with `fixed-fps-ok` (in a comment).
const FORK_EXE = /godot-nvidia-dlss[\\/][^\s'"]*\.exe|godot\.windows\.(?:editor|template)[\w.]*\.exe/i

export function forkWithFixedFps(text: string, fork?: string): boolean {
  const isFork = (value: string) => FORK_EXE.test(value) || !!fork && slash(value).toLowerCase().includes(fork.toLowerCase())
  if (/fixed-fps-ok/i.test(text)) return false
  const vars = new Set<string>()
  for (const m of text.matchAll(/\$?\{?(\w+)\}?\s*=\s*["']?([^\n;"']+)/g)) {
    if (isFork(m[2] ?? '')) vars.add((m[1] ?? '').toLowerCase())
  }
  return text.split(/\r?\n|;|&&|\|\|/).some(s => {
    if (!/--fixed-fps\b/.test(s)) return false
    if (isFork(s)) return true
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

// A copy candidate; its actual normalized destination is checked by dlssCopySources below.
export function copiesIntoDlss(text: string): boolean {
  return /\b(?:Copy-Item|cpi|cp|copy|robocopy|xcopy|shutil\.copy\w*|copyfile)\b/i.test(text)
}

// ---- Godot processes ----

export type GodotProc = { pid: number; ppid: number; cmd: string; title: string; started: string }
export type ProcKind = 'demo' | 'editor' | 'probe' | 'headless' | 'other'

// demo: what the author plays (the DLSS demo, a run from the editor, the project run bare); probe: a
// session's --script run; editor: the editor or project manager.
export function classify(p: GodotProc, roots: readonly string[] = []): ProcKind {
  const cmd = p.cmd
  if (/--headless\b/.test(cmd)) return 'headless'
  if (/dlss_play\.gd/i.test(cmd)) return 'demo'
  if (/--remote-debug\b/.test(cmd)) return 'demo'
  if (/(?:^|\s)(?:-e|--editor|-p|--project-manager)(?:\s|$)/.test(cmd)) return 'editor'
  if (/--script\b/.test(cmd)) return 'probe'
  const project = cmd.match(/--path(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/)
  const path = normalizePath(project?.[1] ?? project?.[2] ?? project?.[3] ?? '')?.toLowerCase()
  if (path && roots.some(root => root.toLowerCase() === path)) return 'demo'
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

// Supported copy guard syntax: literal single-file Copy-Item/cp/copy commands only. Directory,
// wildcard, computed, wrapper and script copies require an explicit supported form first.
export function dlssCopySources(text: string, cwd: string, copy: string): { sources: string[]; error?: string } {
  const sources: string[] = []
  const resolve = (path: string) => {
    const p = slash(path)
    if (/[\$`*?{}()[\],]/.test(p)) return undefined
    return normalizePath(/^[A-Za-z]:\//.test(p) || p.startsWith('/') ? p : cwd ? `${cwd}/${p}` : '')
  }
  const statements = text.split(/\r?\n|;/).filter(s => copiesIntoDlss(s) || /^\s*(?:Copy-Item|cpi|cp|copy)\b/i.test(s))
  if (!statements.length) return { sources, error: 'no literal copy statement could be resolved' }
  for (const statement of statements) {
    const tokens: string[] = []
    const pattern = /\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"']+))/gy
    let at = 0
    while (at < statement.length) {
      pattern.lastIndex = at
      const m = pattern.exec(statement)
      if (!m) {
        if (statement.slice(at).trim()) return { sources, error: 'unsupported copy syntax' }
        break
      }
      tokens.push(m[1] ?? m[2] ?? m[3] ?? '')
      at = pattern.lastIndex
    }
    const cmd = (tokens.shift() ?? '').toLowerCase()
    if (!['copy-item', 'cpi', 'cp', 'copy'].includes(cmd)) return { sources, error: 'unsupported copy program or wrapper' }
    let source: string | undefined
    let destination: string | undefined
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i] ?? ''
      if (/^-(?:path|literalpath)$/i.test(t) && cmd === 'copy-item') source = tokens[++i]
      else if (/^-destination$/i.test(t) && cmd === 'copy-item') destination = tokens[++i]
      else if (/^(?:-force|-f|--|\/y)$/i.test(t)) continue
      else if (t.startsWith('-') || ['&', '|', '>', '<'].some(c => t.includes(c))) return { sources, error: 'unsupported copy option or shell operator' }
      else if (!source) source = t
      else if (!destination) destination = t
      else return { sources, error: 'copy must name exactly one source and destination' }
    }
    const src = source ? resolve(source) : undefined
    const dst = destination ? resolve(destination) : undefined
    if (!src || !dst) return { sources, error: 'copy paths must be literal and resolvable' }
    const target = normalizePath(copy)?.toLowerCase()
    if (!target) return { sources, error: 'protected project path is unavailable' }
    if (dst.toLowerCase() !== target && !dst.toLowerCase().startsWith(`${target}/`)) continue
    if (!isScript(src)) return { sources, error: 'only explicit single-script copies can be checked' }
    sources.push(src)
  }
  if (sources.length > 12) return { sources, error: 'copy exceeds 12 scripts' }
  return { sources: [...new Set(sources)] }
}
