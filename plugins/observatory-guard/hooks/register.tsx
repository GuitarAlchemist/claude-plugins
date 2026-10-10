import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ObservatoryGuardCheck, ObservatoryGuardComfy, ObservatoryGuardProc } from '../types'
import {
  classify,
  COMFY_SCRIPT,
  comfyFrom,
  copiesIntoDlss,
  forkWithFixedFps,
  godotFor,
  isScript,
  opensGodotWindow,
  parseErrors,
  parseProcs,
  PROCS_SCRIPT,
  rootOf,
  rootsFrom,
  scriptPaths,
  shortCmd,
  slash,
  STOCK_GODOT,
  stopTargets,
  toRes,
  WATCHED,
} from './rules'

// Everything that reaches the engine is in this file: the engine follows `$` only into functions
// declared here, which is how `claude plugin validate` can list all the module does.

const procsAtom = atom({ plugin: 'observatory-guard', key: 'procs' } as const, [])
const comfyAtom = atom({ plugin: 'observatory-guard', key: 'comfy' } as const, [])
const metaAtom = atom({ plugin: 'observatory-guard', key: 'meta' } as const, {
  isLoading: false,
  readAt: '',
  errors: [],
  outOfSync: [],
})
const checksAtom = atom({ plugin: 'observatory-guard', key: 'checks' } as const, [])

const RUN = 'Lancer quand même'
const STOP = 'Arrêter quand même'
const CANCEL = 'Annuler'
const PANE = 'godot'

async function stamp($: EngineInterface): Promise<string> {
  return `${new Date(await $.clock.now()).toISOString().slice(11, 19)}Z`
}

function errText(err: unknown): string {
  return String(err instanceof Error ? err.message : err).slice(0, 160)
}

// The prototype and its DLSS copy, or a throwaway pair named by OBSERVATORY_GUARD_ROOTS for a test.
async function liveRoots($: EngineInterface): Promise<readonly string[]> {
  try {
    return rootsFrom(await $.env.get('OBSERVATORY_GUARD_ROOTS'))
  } catch {
    return rootsFrom(undefined)
  }
}

// ---- Checking a script: `--check-only` with the Godot that runs its project ----

type Check = { ok: boolean; errors: string[]; skipped?: string }

async function checkScript($: EngineInterface, root: string, path: string): Promise<Check> {
  let exe = godotFor(root)
  if (!(await $.fs.exists(exe))) exe = STOCK_GODOT
  if (!(await $.fs.exists(exe))) return { ok: true, errors: [], skipped: 'no Godot executable found' }
  if (!(await $.fs.exists(`${root}/project.godot`))) return { ok: true, errors: [], skipped: 'no project.godot' }
  const r = await $.process.run([exe, '--headless', '--path', root, '--check-only', '--script', toRes(root, path)], {
    timeoutMs: 120_000,
  })
  const errors = parseErrors(`${r.stdout}\n${r.stderr}`)
  const ok = r.exitCode === 0 && errors.length === 0
  const result: Check = { ok, errors: ok ? [] : errors.length ? errors : [`Godot exited ${r.exitCode}`] }
  const row: ObservatoryGuardCheck = {
    at: await stamp($),
    root: root.split('/').pop() ?? root,
    file: path.slice(root.length + 1),
    ok,
    error: result.errors[0] ?? '',
  }
  await update($, checksAtom, rows => [row, ...rows.filter(c => !(c.root === row.root && c.file === row.file))].slice(0, 60))
  return result
}

function brokenNote(root: string, path: string, errors: string[], how: string): string {
  const copy = root.toLowerCase().endsWith('observatory-dlss')
  return [
    `observatory-guard: ${path} no longer parses (${how}; Godot --check-only):`,
    ...errors.map(l => `  ${l}`),
    copy
      ? 'This is the native DLSS copy the author launches with observatory-dlss.cmd: put back a version that parses now.'
      : 'The author may be running this project right now, and a scene script that fails to load shows them an empty void. Fix it before anything else, and do not copy it to C:/tmp/observatory-dlss until it passes there too.',
  ].join('\n')
}

// ---- After a shell command: the watched scripts it changed must still parse ----

type Snapshot = Map<string, number>

async function snapshot($: EngineInterface): Promise<Snapshot> {
  const seen: Snapshot = new Map()
  for (const root of await liveRoots($)) {
    for (const dir of WATCHED) {
      try {
        for (const entry of await $.fs.list(`${root}/${dir}`)) {
          if (entry.kind === 'file' && isScript(entry.name)) seen.set(`${root}/${dir}/${entry.name}`, entry.mtimeMs)
        }
      } catch {
        // no such folder here
      }
    }
  }
  return seen
}

async function changedScriptNotes($: EngineInterface, before: Snapshot): Promise<string[]> {
  const after = await snapshot($)
  const roots = await liveRoots($)
  const changed = [...after.entries()].filter(([path, mtime]) => before.get(path) !== mtime).map(([path]) => path)
  const notes: string[] = []
  for (const path of changed.slice(0, 8)) {
    const root = rootOf(path, roots)
    if (!root) continue
    try {
      const c = await checkScript($, root, path)
      if (!c.ok) notes.push(brokenNote(root, path, c.errors, 'changed by this command'))
    } catch (err) {
      notes.push(`observatory-guard: could not check ${path} (${errText(err)}).`)
    }
  }
  if (changed.length > 8) notes.push(`observatory-guard: ${changed.length - 8} more changed scripts were not checked.`)
  if (notes.length) $.ui.toast(`observatory-guard : ${notes.length} script(s) ne parsent plus`, { timeoutMs: 8000 })
  return notes
}

// ---- Before a shell command: copies into the DLSS copy, windows over the demo, stopping the demo ----

async function commandText($: EngineInterface, command: string): Promise<string> {
  const parts = [command]
  let cwd = ''
  try {
    cwd = slash(await $.session.cwd())
  } catch {
    // no cwd: absolute script paths only
  }
  for (const spelled of scriptPaths(command)) {
    const s = slash(spelled)
    for (const path of /^[A-Za-z]:\//.test(s) || !cwd ? [s] : [s, `${cwd}/${s}`]) {
      try {
        if (!(await $.fs.exists(path))) continue
        parts.push(await $.fs.read(path))
        break
      } catch {
        // unreadable: judged by the command alone
      }
    }
  }
  return parts.join('\n')
}

async function listProcs($: EngineInterface): Promise<ObservatoryGuardProc[]> {
  const r = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', PROCS_SCRIPT], {
    timeoutMs: 20_000,
  })
  if (r.exitCode !== 0) throw new Error((r.stderr.trim().split('\n')[0] ?? 'process listing failed').slice(0, 120))
  return parseProcs(r.stdout).map(p => ({
    pid: p.pid,
    kind: classify(p),
    title: p.title,
    started: p.started,
    cmd: shortCmd(p.cmd),
  }))
}

// The ComfyUI servers running: the author's on 8188, and any a session started for itself.
async function listComfy($: EngineInterface): Promise<ObservatoryGuardComfy[]> {
  const r = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', COMFY_SCRIPT], {
    timeoutMs: 20_000,
  })
  if (r.exitCode !== 0) throw new Error((r.stderr.trim().split('\n')[0] ?? 'process listing failed').slice(0, 120))
  return parseProcs(r.stdout)
    .map(p => comfyFrom(p))
    .filter((c): c is ObservatoryGuardComfy => c !== undefined)
}

// The prototype's watched scripts that differ from the DLSS copy's: what a sync would carry across.
async function outOfSync($: EngineInterface): Promise<string[]> {
  const [proto, copy] = await liveRoots($)
  const differ: string[] = []
  if (!proto || !copy) return differ
  for (const dir of WATCHED) {
    let entries: { name: string; kind: string }[] = []
    try {
      entries = await $.fs.list(`${proto}/${dir}`)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.kind !== 'file' || !isScript(entry.name)) continue
      const rel = `${dir}/${entry.name}`
      try {
        const a = await $.fs.read(`${proto}/${rel}`)
        const b = (await $.fs.exists(`${copy}/${rel}`)) ? await $.fs.read(`${copy}/${rel}`) : undefined
        if (a !== b) differ.push(rel)
      } catch {
        differ.push(rel)
      }
    }
  }
  return differ
}

async function ask($: EngineInterface, question: string, yes: string): Promise<string | undefined> {
  try {
    return await $.ui.ask(question, { options: [CANCEL, yes], header: 'Observatory' })
  } catch {
    return undefined // dismissed, interrupted, or a headless run with nobody to ask
  }
}

function refusal(rule: string, why: string, answer: string | undefined): string {
  const who =
    answer === undefined
      ? 'Nobody confirmed it (the question was dismissed, or the session is headless).'
      : answer === CANCEL
        ? 'The user chose to cancel it.'
        : `The user answered instead: "${answer.slice(0, 300)}".`
  return `observatory-guard: refused (${rule}). ${why} ${who}`
}

// Undefined when the command may run; otherwise the refusal the model reads.
async function beforeShell($: EngineInterface, command: string): Promise<string | undefined> {
  const text = await commandText($, command)

  if (copiesIntoDlss(text)) {
    const [proto] = await liveRoots($)
    const broken: string[] = []
    for (const rel of proto ? (await outOfSync($)).slice(0, 12) : []) {
      const c = await checkScript($, proto ?? '', `${proto}/${rel}`)
      if (!c.ok) broken.push(`${rel}: ${c.errors.slice(0, 2).join(' | ')}`)
    }
    if (broken.length) {
      $.ui.toast('observatory-guard : copie vers observatory-dlss refusée (script cassé)', { timeoutMs: 8000 })
      return [
        'observatory-guard: refused (copy-broken). The command copies into C:/tmp/observatory-dlss, the native demo the author launches,',
        'while scripts that differ between the two projects do not parse in the prototype:',
        ...broken.map(b => `  ${b}`),
        'Fix them in the prototype first (--check-only and -- --selftest), then copy.',
      ].join('\n')
    }
  }

  if (forkWithFixedFps(text)) {
    $.ui.toast('observatory-guard : fork DLSS avec --fixed-fps refusé', { timeoutMs: 8000 })
    return [
      'observatory-guard: refused (fork-fixed-fps). The command runs the DLSS fork with --fixed-fps. On 2026-10-03 that drew',
      'haze over black that never changed under path tracing + Ray Reconstruction, with Streamline logging',
      '`slSetConstants ... eErrorDuplicatedConstants` every frame; the same probe without --fixed-fps was clean',
      '(artpass/dlss/NOTES.md). Run it without --fixed-fps. If this run truly needs it (no DLSS, say), put `fixed-fps-ok`',
      'in a comment in the command.',
    ].join('\n')
  }

  const window = opensGodotWindow(text)
  const stop = stopTargets(text)
  if (!window && !stop) return undefined

  if (stop && (stop.allPython || stop.pids.length)) {
    let comfy: ObservatoryGuardComfy[] = []
    try {
      comfy = await listComfy($)
    } catch {
      comfy = [] // cannot tell: the shell's own permission prompt still applies
    }
    const theirs = comfy.filter(c => !c.mine && (stop.allPython || stop.pids.includes(c.pid)))
    if (theirs.length) {
      const answer = await ask(
        $,
        [
          'Cette commande arrêterait ton ComfyUI :',
          ...theirs.map(c => `PID ${c.pid}, port ${c.port} (depuis ${c.started})`),
          'L’arrêter quand même ?',
        ].join('\n'),
        STOP,
      )
      if (answer !== STOP) {
        $.ui.toast('observatory-guard : arrêt de ComfyUI refusé')
        return refusal(
          'stop-comfyui',
          `It would stop the author's own ComfyUI on port 8188 (${theirs.map(c => c.pid).join(', ')}); a session stops only the server it started, by its PID.`,
          answer,
        )
      }
    }
  }
  if (!window && !(stop && (stop.allGodot || stop.pids.length))) return undefined

  let procs: ObservatoryGuardProc[]
  try {
    procs = await listProcs($)
  } catch {
    return undefined // cannot tell what runs: the shell's own permission prompt still applies
  }
  const demos = procs.filter(p => p.kind === 'demo')
  const describe = (p: ObservatoryGuardProc) => `PID ${p.pid}${p.title ? ` « ${p.title} »` : ''} (depuis ${p.started}) : ${p.cmd.slice(0, 140)}`

  if (stop) {
    const hit = demos.filter(p => stop.allGodot || stop.pids.includes(p.pid))
    if (hit.length) {
      const answer = await ask(
        $,
        ['Cette commande arrêterait ta démo Observatory :', ...hit.map(describe), 'L’arrêter quand même ?'].join('\n'),
        STOP,
      )
      if (answer !== STOP) {
        $.ui.toast('observatory-guard : arrêt de la démo refusé')
        return refusal('stop-demo', `It would stop the author's own Godot window (${hit.map(p => p.pid).join(', ')}).`, answer)
      }
    }
  }

  if (window && demos.length) {
    const answer = await ask(
      $,
      [
        'Ta démo Observatory tourne :',
        ...demos.map(describe),
        'Cette commande ouvrirait une autre fenêtre Godot par-dessus. La lancer quand même ?',
      ].join('\n'),
      RUN,
    )
    if (answer !== RUN) {
      $.ui.toast('observatory-guard : fenêtre Godot non lancée')
      return refusal(
        'window-over-demo',
        'It opens a Godot window while the author plays the Observatory; wait until their demo is closed, or run headless.',
        answer,
      )
    }
  }
  return undefined
}

// ---- /godot: the Godot processes, whether the two projects are in sync, the last checks ----

async function refresh($: EngineInterface): Promise<void> {
  if ((await read($, metaAtom)).isLoading) return
  await update($, metaAtom, m => ({ ...m, isLoading: true }))
  const errors: string[] = []
  let sync: string[] = []
  try {
    try {
      const procs = await listProcs($)
      await update($, procsAtom, () => procs)
    } catch (err) {
      errors.push(`processes: ${errText(err)}`)
    }
    try {
      const comfy = await listComfy($)
      await update($, comfyAtom, () => comfy)
    } catch (err) {
      errors.push(`comfyui: ${errText(err)}`)
    }
    try {
      sync = await outOfSync($)
    } catch (err) {
      errors.push(`sync: ${errText(err)}`)
    }
  } finally {
    const readAt = await stamp($)
    await update($, metaAtom, () => ({ isLoading: false, readAt, errors, outOfSync: sync }))
  }
}

async function checkAll($: EngineInterface): Promise<void> {
  if ((await read($, metaAtom)).isLoading) return
  await update($, metaAtom, m => ({ ...m, isLoading: true }))
  try {
    const jobs: { root: string; path: string }[] = []
    for (const root of await liveRoots($)) {
      for (const dir of WATCHED) {
        try {
          for (const entry of await $.fs.list(`${root}/${dir}`)) {
            if (entry.kind === 'file' && isScript(entry.name)) jobs.push({ root, path: `${root}/${dir}/${entry.name}` })
          }
        } catch {
          // no such folder here
        }
      }
    }
    let next = 0
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++]
        if (!job) break
        try {
          await checkScript($, job.root, job.path)
        } catch {
          // recorded nothing: the next refresh shows it unchecked
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()])
  } finally {
    await update($, metaAtom, m => ({ ...m, isLoading: false }))
  }
  await refresh($)
}

const KIND_COLOR: Record<ObservatoryGuardProc['kind'], string | undefined> = {
  demo: 'green',
  editor: 'cyan',
  probe: 'yellow',
  headless: undefined,
  other: undefined,
}

export const register: Register = on => {
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || r.isError) return r
    const path = typeof e.file_path === 'string' ? slash(e.file_path) : ''
    const root = rootOf(path, await liveRoots($))
    if (!root || !isScript(path)) return r
    try {
      const c = await checkScript($, root, path)
      if (c.ok) return r
      $.ui.toast(`observatory-guard : ${path.split('/').pop()} ne parse plus`, { timeoutMs: 8000 })
      return { ...r, context: [...(r.context ?? []), brokenNote(root, path, c.errors, 'just written')] }
    } catch {
      return r
    }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || r.isError) return r
    const path = typeof e.file_path === 'string' ? slash(e.file_path) : ''
    const root = rootOf(path, await liveRoots($))
    if (!root || !isScript(path)) return r
    try {
      const c = await checkScript($, root, path)
      if (c.ok) return r
      $.ui.toast(`observatory-guard : ${path.split('/').pop()} ne parse plus`, { timeoutMs: 8000 })
      return { ...r, context: [...(r.context ?? []), brokenNote(root, path, c.errors, 'just edited')] }
    } catch {
      return r
    }
  })

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const command = typeof e.command === 'string' ? e.command : ''
    let deny: string | undefined
    try {
      deny = await beforeShell($, command)
    } catch {
      deny = undefined // a guard that fails here only loses its question; the tool's own permission still applies
    }
    if (deny) return { deny }
    const before = await snapshot($)
    const r = await next(e)
    if (r.deny !== undefined) return r
    const notes = await changedScriptNotes($, before)
    return notes.length ? { ...r, context: [...(r.context ?? []), ...notes] } : r
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = typeof e.command === 'string' ? e.command : ''
    let deny: string | undefined
    try {
      deny = await beforeShell($, command)
    } catch {
      deny = undefined
    }
    if (deny) return { deny }
    const before = await snapshot($)
    const r = await next(e)
    if (r.deny !== undefined) return r
    const notes = await changedScriptNotes($, before)
    return notes.length ? { ...r, context: [...(r.context ?? []), ...notes] } : r
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'godot',
      description: 'Observatory: the running Godot and ComfyUI processes, prototype ↔ DLSS copy sync, script checks',
    })
    return next(e)
  })

  on('command.run', { command: 'godot' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Godot' })
    await refresh($)
    return { text: 'Godot pane open: R refreshes, C checks every scene and demo script in both projects.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const procs = await read($, procsAtom)
    const comfy = await read($, comfyAtom)
    const m = await read($, metaAtom)
    const checks = await read($, checksAtom)
    const failing = checks.filter(c => !c.ok)
    const recent = [...failing, ...checks.filter(c => c.ok)].slice(
      0,
      Math.max(3, (e.viewport?.rows ?? 30) - procs.length - comfy.length - 11),
    )
    const demos = procs.filter(p => p.kind === 'demo').length

    return (
      <Box flexDirection="column">
        <Box>
          <Button key="refresh" hotkey="r" variant="primary" label={m.isLoading ? 'Working…' : 'Refresh'} onPress={() => refresh($)} />
          <Text> </Text>
          <Button key="check" hotkey="c" label="Check scripts" onPress={() => checkAll($)} />
          <Text dimColor>
            {' '}
            {m.readAt ? `read at ${m.readAt} · ${procs.length} Godot · ${demos ? `${demos} demo running` : 'no demo running'}` : 'not read yet'}
          </Text>
        </Box>
        {m.errors.map(err => (
          <Text key={`err-${err.slice(0, 30)}`} color="yellow" wrap="truncate-end">
            {err}
          </Text>
        ))}
        <Text bold>Processes</Text>
        {procs.length === 0 && <Text dimColor>  none</Text>}
        {procs.map(p => (
          <Box key={`p-${p.pid}`}>
            <Text color={KIND_COLOR[p.kind]}>{`  ${p.kind.padEnd(8)}`}</Text>
            <Text>{`${String(p.pid).padStart(6)} ${p.started} `}</Text>
            <Text bold>{p.title ? `${p.title} · ` : ''}</Text>
            <Text dimColor wrap="truncate-end">
              {p.cmd}
            </Text>
          </Box>
        ))}
        <Text bold>ComfyUI</Text>
        {comfy.length === 0 && <Text dimColor>{m.readAt ? '  none' : '  not read yet'}</Text>}
        {comfy.map(c => (
          <Box key={`comfy-${c.pid}`}>
            <Text color={c.mine ? 'yellow' : 'green'}>{`  ${(c.mine ? 'session' : 'yours').padEnd(8)}`}</Text>
            <Text>{`${String(c.pid).padStart(6)} ${c.started} port ${c.port} `}</Text>
            <Text dimColor wrap="truncate-end">
              {c.base}
            </Text>
          </Box>
        ))}
        <Text bold>Prototype ↔ observatory-dlss</Text>
        <Text color={m.outOfSync.length ? 'yellow' : undefined} dimColor={!m.outOfSync.length} wrap="truncate-end">
          {'  '}
          {m.readAt === '' ? 'not read yet' : m.outOfSync.length ? `${m.outOfSync.length} differ: ${m.outOfSync.join(', ')}` : 'scene and demo scripts in sync'}
        </Text>
        <Text bold>
          Checks {checks.length ? `(${checks.length - failing.length} ok, ${failing.length} failing)` : '(none yet: C checks them)'}
        </Text>
        {recent.map(c => (
          <Text key={`c-${c.root}-${c.file}`} color={c.ok ? undefined : 'red'} dimColor={c.ok} wrap="truncate-end">
            {'  '}
            {c.ok ? '✓' : '✗'} {c.at} {c.root}/{c.file}
            {c.ok ? '' : ` — ${c.error}`}
          </Text>
        ))}
      </Box>
    )
  })
}
