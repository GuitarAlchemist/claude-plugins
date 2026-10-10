import { expect, test } from 'claude-code/testing'

// The PowerShell hook as the session meets it: commands typed on 2026-10-03, with the process lists
// and the user's answers stubbed.
const FORK = 'C:/tmp/godot-nvidia-dlss/godot/bin/godot.windows.editor.x86_64.console.exe'
const AUTHOR_COMFY = JSON.stringify({
  pid: 4242,
  ppid: 1,
  cmd: 'C:\\Users\\spare\\tools\\ComfyUI_windows_portable\\python_embeded\\python.exe -s ComfyUI\\main.py --windows-standalone-build',
  title: '',
  started: '09:00',
})
const SESSION_COMFY = JSON.stringify({
  pid: 28116,
  ppid: 1,
  cmd: 'python.exe -s ComfyUI/main.py --listen 127.0.0.1 --port 8195 --base-directory C:/tmp/x/comfyui/base',
  title: '',
  started: '10:12',
})

function shell(on: Parameters<Parameters<typeof test>[1]>[1], comfy: string, answer: string) {
  on('session.cwd', () => ({ value: 'C:/Users/spare/source/repos/learn' }))
  on('env.get', ($, e) => ({ value: e.name === 'OBSERVATORY_GUARD_ROOTS' ? 'C:/tmp/observatory-prototype-v1;C:/tmp/observatory-dlss' : 'C:/tools/stock.exe;D:/tools/fork.exe' }))
  on('fs.list', () => ({ deny: 'no such folder in a test' }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', ($, e) => ({
    value: { exitCode: 0, stdout: e.argv.join(' ').includes("'python%'") ? comfy : '', stderr: '' },
  }))
  on('tool.call', ($, e) =>
    e.tool === 'AskUserQuestion' ? { result: { answers: { [e.questions[0].question]: answer } } } : { result: 'ran' },
  )
}

test('a DLSS-fork run with --fixed-fps is refused before it runs', async ($, on) => {
  shell(on, '', 'Annuler')
  const out = await $.tool.call({
    tool: 'PowerShell',
    command: `$F = '${FORK}'; $p = Start-Process -FilePath $F -ArgumentList @('--path', 'C:/tmp/observatory-dlss', '--fixed-fps', '60', '--script', 'res://a.gd') -PassThru`,
  })
  expect(String(out.deny)).toMatch(/fork-fixed-fps/)
})

test("stopping the author's ComfyUI asks, and a cancel refuses", async ($, on) => {
  shell(on, AUTHOR_COMFY, 'Annuler')
  const out = await $.tool.call({ tool: 'PowerShell', command: 'Stop-Process -Id 4242 -Force' })
  expect(String(out.deny)).toMatch(/stop-comfyui/)
})

test("stopping the author's ComfyUI goes ahead when the user says so", async ($, on) => {
  shell(on, AUTHOR_COMFY, 'Arrêter quand même')
  const out = await $.tool.call({ tool: 'PowerShell', command: 'Stop-Process -Id 4242 -Force' })
  expect(out.deny).toBeUndefined()
  expect(out.result).toBe('ran')
})

test("stopping the session's own ComfyUI asks nothing", async ($, on) => {
  shell(on, SESSION_COMFY, 'Annuler')
  const out = await $.tool.call({ tool: 'PowerShell', command: 'Stop-Process -Id 28116' })
  expect(out.deny).toBeUndefined()
  expect(out.result).toBe('ran')
})

// Public hook regression fixtures: no real project, executable or command is touched.
function copyFixture(on: Parameters<Parameters<typeof test>[1]>[1], sourceBroken: boolean, removed = false, noGodot = false, cwd = 'C:/work') {
  let ran = false
  const checked: string[] = []
  on('session.cwd', () => ({ value: cwd }))
  on('env.get', ($, e) => ({ value: e.name === 'OBSERVATORY_GUARD_ROOTS' ? 'C:/tmp/observatory-prototype-v1;C:/tmp/observatory-dlss' : 'C:/tools/stock.exe;D:/tools/fork.exe' }))
  on('clock.now', () => ({ value: 1791600000000 }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({ value: !noGodot || !String(e.path).endsWith('.exe') }))
  on('fs.read', () => ({ value: 'same prototype and DLSS contents' }))
  on('fs.list', ($, e) => ({ value: /[\\/]scripts$/.test(String(e.path)) && !(removed && ran)
    ? [{ name: 'scene.gd', kind: 'file', mtimeMs: 1 }] : [] }))
  on('process.run', ($, e) => {
    checked.push(e.argv.join(' '))
    return { value: { exitCode: sourceBroken ? 1 : 0, stdout: '', stderr: sourceBroken ? 'SCRIPT ERROR: Parse Error: broken source' : '' } }
  })
  on('tool.call', () => { ran = true; return { result: 'ran' } })
  return { checked, ran: () => ran }
}

test('copy validates the actual source even when prototype and DLSS are in sync', async ($, on) => {
  const f = copyFixture(on, true)
  const out = await $.tool.call({ tool: 'PowerShell', command: 'Copy-Item C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd' })
  expect(String(out.deny)).toMatch(/copy-broken/)
  expect(f.ran()).toBe(false)
  expect(f.checked.join('\n')).toMatch(/--path C:\/other .*res:\/\/scripts\/scene.gd/)
})

test('a checked literal source copy can run', async ($, on) => {
  const f = copyFixture(on, false)
  const out = await $.tool.call({ tool: 'Bash', command: "cp 'C:/other/scripts/scene.gd' 'C:/tmp/observatory-dlss/scripts/scene.gd'" })
  expect(out.deny).toBeUndefined()
  expect(f.ran()).toBe(true)
  expect(f.checked.length).toBe(1)
})

test('unsupported dynamic copy syntax fails closed before the shell', async ($, on) => {
  const f = copyFixture(on, false)
  const out = await $.tool.call({ tool: 'PowerShell', command: 'Copy-Item $source C:/tmp/observatory-dlss/scripts/scene.gd' })
  expect(String(out.deny)).toMatch(/copy-unverified/)
  expect(f.ran()).toBe(false)
})

test('a missing checker cannot approve a DLSS copy', async ($, on) => {
  const f = copyFixture(on, false, false, true)
  const out = await $.tool.call({ tool: 'PowerShell', command: 'Copy-Item C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd' })
  expect(String(out.deny)).toMatch(/copy-unverified/)
  expect(f.ran()).toBe(false)
})

test('shell deletion reports watched scripts and never runs a deleted script', async ($, on) => {
  const f = copyFixture(on, false, true)
  const out = await $.tool.call({ tool: 'Bash', command: 'rm C:/tmp/observatory-prototype-v1/scripts/scene.gd' })
  expect(out.deny).toBeUndefined()
  expect((out.context ?? []).join('\n')).toMatch(/removed.*scene\.gd/)
  expect(f.checked.length).toBe(0)
})


test('literal named and spaced source paths are checked in the source project', async ($, on) => {
  const f = copyFixture(on, false)
  const out = await $.tool.call({ tool: 'PowerShell', command: "Copy-Item -LiteralPath 'C:/other project/scripts/scene.gd' -Destination 'C:/tmp/observatory-dlss/scripts/scene.gd' -Force" })
  expect(out.deny).toBeUndefined()
  expect(f.checked.join('\n')).toMatch(/--path C:\/other project .*res:\/\/scripts\/scene\.gd/)
})

test('directory, wildcard and embedded script copies are held without executing', async ($, on) => {
  const f = copyFixture(on, false)
  for (const command of [
    'Copy-Item C:/other/scripts C:/tmp/observatory-dlss/scripts -Recurse',
    'cp C:/other/scripts/*.gd C:/tmp/observatory-dlss/scripts/',
    "python -c \"shutil.copy2(src, 'C:/tmp/observatory-dlss/scripts/scene.gd')\"",
  ]) {
    const out = await $.tool.call({ tool: 'PowerShell', command })
    expect(String(out.deny)).toMatch(/copy-unverified/)
  }
  expect(f.ran()).toBe(false)
  expect(f.checked.length).toBe(0)
})

test('more than twelve copy sources are refused rather than partially checked', async ($, on) => {
  const f = copyFixture(on, false)
  const command = Array.from({ length: 13 }, (_, i) => `Copy-Item C:/other/scripts/s${i}.gd C:/tmp/observatory-dlss/scripts/s${i}.gd`).join('; ')
  const out = await $.tool.call({ tool: 'PowerShell', command })
  expect(String(out.deny)).toMatch(/copy-unverified/)
  expect(f.ran()).toBe(false)
  expect(f.checked.length).toBe(0)
})

test('Godot without --path asks before opening over the running demo', async ($, on) => {
  let ran = false
  on('session.cwd', () => ({ value: 'C:/work' }))
  on('env.get', ($, e) => ({ value: e.name === 'OBSERVATORY_GUARD_ROOTS' ? 'C:/tmp/observatory-prototype-v1;C:/tmp/observatory-dlss' : 'C:/tools/stock.exe;D:/tools/fork.exe' }))
  on('fs.list', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ pid: 7, cmd: 'godot.exe --path C:/tmp/observatory-dlss', title: 'Observatory', started: '10:00' }), stderr: '' } }))
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') return { result: { answers: { [e.questions[0].question]: 'Annuler' } } }
    ran = true
    return { result: 'ran' }
  })
  const out = await $.tool.call({ tool: 'PowerShell', command: 'godot.exe --editor' })
  expect(String(out.deny)).toMatch(/window-over-demo/)
  expect(ran).toBe(false)
})


test('relative destination inside the DLSS cwd still checks the actual source', async ($, on) => {
  const f = copyFixture(on, true, false, false, 'C:/tmp/observatory-dlss')
  const out = await $.tool.call({ tool: 'PowerShell', command: 'Copy-Item C:/other/scripts/scene.gd scripts/scene.gd' })
  expect(String(out.deny)).toMatch(/copy-broken/)
  expect(f.ran()).toBe(false)
})

test('copying out of DLSS does not validate unrelated prototype scripts', async ($, on) => {
  const f = copyFixture(on, true)
  const out = await $.tool.call({ tool: 'PowerShell', command: 'Copy-Item C:/tmp/observatory-dlss/scripts/scene.gd C:/backup/scene.gd' })
  expect(out.deny).toBeUndefined()
  expect(f.ran()).toBe(true)
  expect(f.checked.length).toBe(0)
})

function portableFixture(on: Parameters<Parameters<typeof test>[1]>[1], roots = 'C:/prototype;D:/demo-copy', binaries = 'C:/tools/stock.exe;D:/tools/fork.exe', missing = false) {
  let ran = false
  const checked: string[][] = []
  on('session.cwd', () => ({ value: 'C:/work' }))
  on('env.get', ($, e) => ({ value: e.name === 'OBSERVATORY_GUARD_ROOTS' ? roots : binaries }))
  on('clock.now', () => ({ value: 1791600000000 }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', ($, e) => ({ value: !(missing && String(e.path).endsWith('.exe')) }))
  on('fs.read', () => ({ value: '' }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', ($, e) => { checked.push([...e.argv]); return { value: { exitCode: 1, stdout: '', stderr: 'SCRIPT ERROR: Parse Error: broken' } } })
  on('tool.call', () => { ran = true; return { result: 'ran' } })
  return { checked, ran: () => ran }
}

test('configured renamed protected project validates alternate copy source', async ($, on) => {
  const f = portableFixture(on)
  const out = await $.tool.call({ tool: 'PowerShell', command: 'Copy-Item C:/other/scripts/broken.gd D:/demo-copy/scripts/broken.gd' })
  expect(String(out.deny)).toMatch(/copy-broken/)
  expect(f.ran()).toBe(false)
  expect(f.checked[0]?.[0]).toBe('C:/tools/stock.exe')
})

test('dot segments cannot bypass protected destination checks', async ($, on) => {
  const f = portableFixture(on, 'C:/prototype;C:/tmp/observatory-dlss')
  const out = await $.tool.call({ tool: 'Bash', command: 'cp C:/other/scripts/broken.gd C:/tmp/./observatory-dlss/scripts/broken.gd' })
  expect(String(out.deny)).toMatch(/copy-broken|copy-unverified/)
  expect(f.ran()).toBe(false)
})

test('configured copy checker is selected by project identity, not basename', async ($, on) => {
  const f = portableFixture(on)
  const out = await $.tool.call({ tool: 'Edit', file_path: 'D:/demo-copy/scripts/scene.gd', old_string: '', new_string: 'bad' })
  expect((out.context ?? []).join('\n')).toMatch(/no longer parses/)
  expect(f.checked[0]?.[0]).toBe('D:/tools/fork.exe')
})

test('missing configured checker after an edit produces an explicit unchecked warning', async ($, on) => {
  const f = portableFixture(on, undefined, undefined, true)
  const out = await $.tool.call({ tool: 'Write', file_path: 'D:/demo-copy/scripts/scene.gd', content: 'bad' })
  expect((out.context ?? []).join('\n')).toMatch(/check-unavailable.*Godot/)
  expect(f.checked.length).toBe(0)
})

test('malformed configuration refuses copy without falling back to host paths', async ($, on) => {
  const f = portableFixture(on, 'relative;D:/demo-copy')
  const out = await $.tool.call({ tool: 'PowerShell', command: 'Copy-Item C:/other/scripts/broken.gd D:/demo-copy/scripts/broken.gd' })
  expect(String(out.deny)).toMatch(/config-unavailable/)
  expect(f.checked.length).toBe(0)
  expect(f.ran()).toBe(false)
})

test('missing configuration is reported after edit and does not read host defaults', async ($, on) => {
  const f = portableFixture(on, '', '')
  const out = await $.tool.call({ tool: 'Edit', file_path: 'C:/prototype/scripts/scene.gd', old_string: '', new_string: 'bad' })
  expect((out.context ?? []).join('\n')).toMatch(/check-unavailable.*OBSERVATORY_GUARD_ROOTS/)
  expect(f.checked.length).toBe(0)
})

test('malformed executable configuration never falls back to an installed Godot', async ($, on) => {
  const f = portableFixture(on, undefined, 'relative.exe;D:/tools/fork.exe')
  const out = await $.tool.call({ tool: 'PowerShell', command: 'Copy-Item C:/other/scripts/broken.gd D:/demo-copy/scripts/broken.gd' })
  expect(String(out.deny)).toMatch(/config-unavailable/)
  expect(f.ran()).toBe(false)
  expect(f.checked.length).toBe(0)
})

test('overlapping configured projects are refused rather than choosing a checker ambiguously', async ($, on) => {
  const f = portableFixture(on, 'C:/prototype;C:/prototype/demo-copy')
  const out = await $.tool.call({ tool: 'PowerShell', command: 'Copy-Item C:/other/scripts/broken.gd C:/prototype/demo-copy/scripts/broken.gd' })
  expect(String(out.deny)).toMatch(/config-unavailable/)
  expect(f.checked.length).toBe(0)
  expect(f.ran()).toBe(false)
})

test('copy words in arguments and comments do not block ordinary shell commands', async ($, on) => {
  const f = copyFixture(on, false, false, false, 'C:/tmp/observatory-dlss')
  for (const command of [
    'git log --grep=copy', 'echo copy', 'pwsh -Command \"git log --grep=copy\"', 'echo "Copy-Item a.gd; cp b.gd c.gd"',
    'git status # Copy-Item a.gd C:/tmp/observatory-dlss/scripts/a.gd',
    '# Copy-Item a.gd C:/tmp/observatory-dlss/scripts/a.gd\ngit status',
  ]) {
    const out = await $.tool.call({ tool: 'PowerShell', command })
    expect(out.deny).toBeUndefined()
    expect(out.result).toBe('ran')
  }
  expect(f.checked.length).toBe(0)
})

function configuredDemoFixture(on: Parameters<Parameters<typeof test>[1]>[1]) {
  let ran = false
  let asks = 0
  const queries: string[] = []
  on('session.cwd', () => ({ value: 'C:/work' }))
  on('env.get', ($, e) => ({ value: e.name === 'OBSERVATORY_GUARD_ROOTS' ? 'C:/prototype;D:/demo-copy' : 'C:/tools/stock.exe;D:/tools/fork.exe' }))
  on('fs.list', () => ({ value: [] }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', ($, e) => {
    const query = e.argv.join(' ')
    queries.push(query)
    const findsConfiguredDemo = query.includes('fork.exe') && query.includes('Get-CimInstance')
    return { value: { exitCode: 0, stdout: findsConfiguredDemo ? JSON.stringify({ pid: 777, ppid: 1, cmd: 'D:/tools/fork.exe --path D:/demo-copy', title: 'Demo', started: '10:00' }) : '', stderr: '' } }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'AskUserQuestion') { asks++; return { result: { answers: { [e.questions[0].question]: 'Annuler' } } } }
    ran = true
    return { result: 'ran' }
  })
  return { ran: () => ran, asks: () => asks, queries }
}

test('configured executable outside godot prefix is discovered before another window opens', async ($, on) => {
  const f = configuredDemoFixture(on)
  const out = await $.tool.call({ tool: 'PowerShell', command: "& 'C:/tools/stock.exe' --editor" })
  expect(String(out.deny)).toMatch(/window-over-demo/)
  expect(f.asks()).toBe(1)
  expect(f.ran()).toBe(false)
})

test('configured executable outside godot prefix is discovered before stopping its PID', async ($, on) => {
  const f = configuredDemoFixture(on)
  const out = await $.tool.call({ tool: 'PowerShell', command: 'Stop-Process -Id 777' })
  expect(String(out.deny)).toMatch(/stop-demo/)
  expect(f.asks()).toBe(1)
  expect(f.ran()).toBe(false)
})


test('real copy invocations following other commands or comments are still checked', async ($, on) => {
  const f = copyFixture(on, true)
  for (const command of [
    'if ($true) { Copy-Item C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd }',
    'echo copy; Copy-Item C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd # copied script',
    "git status && cp 'C:/other/scripts/scene.gd' 'C:/tmp/observatory-dlss/scripts/scene.gd'",
  ]) {
    const out = await $.tool.call({ tool: 'PowerShell', command })
    expect(String(out.deny)).toMatch(/copy-broken/)
  }
  expect(f.ran()).toBe(false)
})

test('configured demo is protected when stopped by its executable name', async ($, on) => {
  const f = configuredDemoFixture(on)
  const out = await $.tool.call({ tool: 'PowerShell', command: 'Stop-Process -Name fork' })
  expect(String(out.deny)).toMatch(/stop-demo/)
  expect(f.asks()).toBe(1)
  expect(f.ran()).toBe(false)
})
