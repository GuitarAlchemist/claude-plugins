import { describe, expect, test } from 'claude-code/testing'

import {
  classify,
  comfyFrom,
  copiesIntoDlss,
  dlssCopySources,
  forkWithFixedFps,
  opensGodotWindow,
  parseErrors,
  parseProcs,
  rootOf,
  scriptPaths,
  shortCmd,
  stopTargets,
  toRes,
} from '../hooks/rules'

// Commands as sessions really typed them on 2026-10-02.
const STOCK = 'C:/Users/spare/AppData/Local/Microsoft/WinGet/Packages/GodotEngine.GodotEngine_Microsoft.Winget.Source_8wekyb3d8bbwe/Godot_v4.6.1-stable_win64_console.exe'
const FORK = 'C:/tmp/godot-nvidia-dlss/godot/bin/godot.windows.editor.x86_64.exe'

describe('paths', () => {
  test('a live project is found whatever the slashes and case', async () => {
    expect(rootOf('C:\\tmp\\Observatory-Prototype-v1\\scripts\\observatory.gd', ['C:/tmp/observatory-prototype-v1', 'C:/tmp/observatory-dlss'])).toBe('C:/tmp/observatory-prototype-v1')
    expect(rootOf('C:/tmp/observatory-dlss/artpass/dlss/dlss_play.gd', ['C:/tmp/observatory-prototype-v1', 'C:/tmp/observatory-dlss'])).toBe('C:/tmp/observatory-dlss')
    expect(rootOf('C:/tmp/observatory-web-build-17/scripts/observatory.gd', ['C:/tmp/observatory-prototype-v1', 'C:/tmp/observatory-dlss'])).toBeUndefined()
    expect(rootOf('C:/tmp/observatory-prototype-v1.bak/scripts/a.gd', ['C:/tmp/observatory-prototype-v1', 'C:/tmp/observatory-dlss'])).toBeUndefined()
  })

  test('res paths', async () => {
    expect(toRes('C:/tmp/observatory-dlss', 'C:/tmp/observatory-dlss/scripts/seldon_statue.gd')).toBe('res://scripts/seldon_statue.gd')
  })
})

describe('windows', () => {
  test('a check-only run opens no window', async () => {
    const cmd = `$G='${STOCK}'; & $G --headless --path C:/tmp/observatory-prototype-v1 --check-only --script res://scripts/observatory.gd`
    expect(opensGodotWindow(cmd)).toBe(false)
  })

  test('a capture or a probe opens one', async () => {
    expect(opensGodotWindow(`"${STOCK}" --path . --resolution 1600x900 -- --capture=renders`)).toBe(true)
    const probe = `$p = Start-Process -FilePath '${FORK}' -ArgumentList '--path','C:/tmp/observatory-dlss','--script','res://artpass/gilt/gilt_probe.gd' -PassThru`
    expect(opensGodotWindow(probe)).toBe(true)
    expect(opensGodotWindow('C:\\tmp\\godot-nvidia-dlss\\observatory-dlss.cmd')).toBe(true)
  })

  test('a headless run beside a windowed one still counts', async () => {
    const both = `& '${STOCK}' --headless --path C:/tmp/observatory-prototype-v1 -- --selftest; & '${STOCK}' --path C:/tmp/observatory-prototype-v1 --resolution 1600x900 --script res://artpass/curios/curiotest.gd`
    expect(opensGodotWindow(both)).toBe(true)
  })

  test('listing Godot processes is not a launch', async () => {
    expect(opensGodotWindow(`Get-CimInstance Win32_Process -Filter "Name like 'godot%'" | Select ProcessId, CommandLine`)).toBe(false)
  })
})

describe('stopping', () => {
  test('numeric PIDs', async () => {
    expect(stopTargets('Stop-Process -Id 129260 -Force')).toEqual({ pids: [129260], allGodot: false, allPython: false })
    expect(stopTargets('taskkill /PID 4242 /F')).toEqual({ pids: [4242], allGodot: false, allPython: false })
    expect(stopTargets('Stop-Process -Id 12, 34')).toEqual({ pids: [12, 34], allGodot: false, allPython: false })
  })

  test('every Python by name', async () => {
    expect(stopTargets('Stop-Process -Name python -Force')?.allPython).toBe(true)
    expect(stopTargets('taskkill /IM python.exe /F')?.allPython).toBe(true)
    expect(stopTargets('Get-Process python* | Stop-Process')?.allPython).toBe(true)
    expect(stopTargets('Stop-Process -Id 28116')?.allPython).toBe(false)
  })

  test('by name', async () => {
    expect(stopTargets('Get-Process godot* | Stop-Process')?.allGodot).toBe(true)
    expect(stopTargets('Stop-Process -Name godot -Force')?.allGodot).toBe(true)
    expect(stopTargets('taskkill /IM godot.windows.editor.x86_64.exe /F')?.allGodot).toBe(true)
  })

  test('a probe stopping its own process by variable is not judged', async () => {
    expect(stopTargets('if (-not $p.WaitForExit(240000)) { Stop-Process -Id $p.Id -Force }')).toBeUndefined()
    expect(stopTargets('Get-Process -Id 5 | Select-Object Name')).toBeUndefined()
  })
})

describe('copies', () => {
  test('into the DLSS copy', async () => {
    expect(copiesIntoDlss('Copy-Item C:/tmp/observatory-prototype-v1/scripts/observatory.gd C:/tmp/observatory-dlss/scripts/observatory.gd')).toBe(true)
    expect(copiesIntoDlss("shutil.copy2(src, 'C:/tmp/observatory-dlss/scripts/seldon_statue.gd')")).toBe(true)
    expect(copiesIntoDlss('Copy-Item a.png C:/tmp/observatory-prototype-v1/renders/')).toBe(true)
    expect(copiesIntoDlss('Get-Content C:/tmp/observatory-dlss/override.cfg')).toBe(false)
  })

  test('the scripts a command runs', async () => {
    expect(scriptPaths('pwsh C:/tmp/godot-nvidia-dlss/run-probe.ps1 C:/tmp/out --fg')).toContain('C:/tmp/godot-nvidia-dlss/run-probe.ps1')
    expect(scriptPaths('python scratchpad/edit_gilt.py')).toContain('scratchpad/edit_gilt.py')
  })
})

describe('processes', () => {
  const p = (cmd: string, title = '') => ({ pid: 1, ppid: 0, cmd, title, started: '17:00' })

  test('the author runs', async () => {
    expect(classify(p(`"${FORK}" --path C:\\tmp\\observatory-dlss --rendering-method forward_plus --maximized --script res://artpass/dlss/dlss_play.gd`))).toBe('demo')
    expect(classify(p(`"${STOCK}" --path C:/tmp/observatory-prototype-v1 --remote-debug tcp://127.0.0.1:6007 --editor-pid 900 res://main.tscn`))).toBe('demo')
    expect(classify(p(`"${STOCK}" --path C:/tmp/observatory-prototype-v1`, 'Observatory Prototype v1 (DEBUG)'))).toBe('demo')
  })

  test('the editor, probes and headless runs', async () => {
    expect(classify(p(`"${STOCK}" --path C:/tmp/observatory-prototype-v1 -e`))).toBe('editor')
    expect(classify(p(`"${STOCK}"`))).toBe('editor')
    expect(classify(p(`"${FORK}" --path C:/tmp/observatory-dlss --resolution 1600x900 --script res://artpass/gilt/gilt_probe.gd -- --out=x`))).toBe('probe')
    expect(classify(p(`"${STOCK}" --headless --path C:/tmp/observatory-prototype-v1 -- --selftest`))).toBe('headless')
  })

  test('ConvertTo-Json gives an object for one process, a list for several', async () => {
    expect(parseProcs('{"pid":7,"ppid":1,"cmd":"godot.exe","title":"","started":"17:01"}').length).toBe(1)
    expect(parseProcs('[{"pid":7},{"pid":8}]').map(x => x.pid)).toEqual([7, 8])
    expect(parseProcs('  ')).toEqual([])
  })

  test('short command lines', async () => {
    expect(shortCmd(`"${FORK}" --path C:\\tmp\\observatory-dlss`)).toBe('godot.windows.editor.x86_64.exe --path C:\\tmp\\observatory-dlss')
  })
})

// Commands as a session really typed them on 2026-10-03.
const FORK_CONSOLE = 'C:/tmp/godot-nvidia-dlss/godot/bin/godot.windows.editor.x86_64.console.exe'

describe('the DLSS fork and --fixed-fps', () => {
  test('the run that froze, through two variables', async () => {
    const cmd = `$bin = 'C:/tmp/godot-nvidia-dlss/godot/bin'; $F = "$bin/godot.windows.editor.x86_64.console.exe"; $O = 'C:/tmp/x'; $p = Start-Process -FilePath $F -ArgumentList @('--path', 'C:/tmp/observatory-dlss', '--rendering-method', 'forward_plus', '--resolution', '1600x900', '--fixed-fps', '60', '--script', 'res://artpass/frescovideo/motion_probe.gd', '--', '--pt') -PassThru`
    expect(forkWithFixedFps(cmd)).toBe(true)
  })

  test('the fork named directly', async () => {
    expect(forkWithFixedFps(`& '${FORK_CONSOLE}' --path C:/tmp/observatory-dlss --fixed-fps 60 --script res://a.gd`)).toBe(true)
    expect(forkWithFixedFps(`"${FORK}" --path C:/tmp/observatory-dlss --fixed-fps 60`)).toBe(true)
  })

  test('the same run without it, and the clean rerun', async () => {
    const cmd = `$F = '${FORK_CONSOLE}'; $p = Start-Process -FilePath $F -ArgumentList @('--path', 'C:/tmp/observatory-dlss', '--resolution', '1600x900', '--script', 'res://artpass/frescovideo/motion_probe.gd', '--', '--pt') -PassThru`
    expect(forkWithFixedFps(cmd)).toBe(false)
  })

  test('stock Godot with --fixed-fps beside a fork check', async () => {
    const cmd = `$G = '${STOCK}'; $F = '${FORK_CONSOLE}'; & $F --headless --path C:/tmp/observatory-dlss --check-only --script res://scripts/fresco_frieze.gd; & $G --path C:/tmp/observatory-prototype-v1 --fixed-fps 60 --script res://artpass/frescovideo/motion_probe.gd`
    expect(forkWithFixedFps(cmd)).toBe(false)
  })

  test('the regression scripts, which pin fps on stock Godot', async () => {
    const sh = 'G="${GODOT:-/c/Users/spare/AppData/Local/Microsoft/WinGet/Packages/GodotEngine.GodotEngine.Mono_Microsoft.Winget.Source_8wekyb3d8bbwe/Godot_v4.6.1-stable_mono_win64/Godot_v4.6.1-stable_mono_win64_console.exe}"\nt lean_keys --path . --fixed-fps 60 --script "$A/lean/leantest.gd"'
    expect(forkWithFixedFps(sh)).toBe(false)
  })

  test('a run that says it means it', async () => {
    expect(forkWithFixedFps(`& '${FORK_CONSOLE}' --path C:/tmp/observatory-dlss --fixed-fps 60  # fixed-fps-ok: raster, no DLSS`)).toBe(false)
  })
})

describe('ComfyUI', () => {
  const p = (cmd: string) => ({ pid: 28116, cmd, started: '10:12' })

  test("the author's, on 8188", async () => {
    const c = comfyFrom(p('C:\\Users\\spare\\tools\\ComfyUI_windows_portable\\python_embeded\\python.exe -s ComfyUI\\main.py --windows-standalone-build'))
    expect(c).toEqual({ pid: 28116, port: 8188, mine: false, base: '', started: '10:12' })
  })

  test("a session's, on its own port and base", async () => {
    const c = comfyFrom(p('"C:\\Users\\spare\\tools\\ComfyUI_windows_portable\\python_embeded\\python.exe" -s ComfyUI/main.py --listen 127.0.0.1 --port 8195 --base-directory C:/tmp/observatory-prototype-v1/artpass/frescovideo/comfyui/base --database-url sqlite:///:memory: --disable-all-custom-nodes --disable-api-nodes'))
    expect(c?.port).toBe(8195)
    expect(c?.mine).toBe(true)
    expect(c?.base).toBe('C:/tmp/observatory-prototype-v1/artpass/frescovideo/comfyui/base')
  })

  test('another Python is not ComfyUI', async () => {
    expect(comfyFrom(p('python C:/tmp/observatory-prototype-v1/artpass/frescovideo/make_clips.py 14 1280 320 49'))).toBeUndefined()
    expect(comfyFrom(p('python -m http.server 8188'))).toBeUndefined()
  })
})

describe('errors', () => {
  test('the parse error that left the author a void', async () => {
    const out = [
      'Godot Engine v4.6.1.stable.official.14d19694e - https://godotengine.org',
      'SCRIPT ERROR: Parse Error: Cannot infer the type of "at" variable because the value doesn\'t have a set type.',
      '   at: GDScript::reload (res://scripts/observatory.gd:1043)',
      'ERROR: Failed to load script "res://scripts/observatory.gd" with error "Parse error".',
      '   at: load (modules/gdscript/gdscript.cpp:2907)',
    ].join('\r\n')
    const errors = parseErrors(out)
    expect(errors.length).toBe(4)
    expect(errors[1]).toBe('at: GDScript::reload (res://scripts/observatory.gd:1043)')
  })

  test('the fork\'s Streamline lines are not errors', async () => {
    expect(parseErrors("File 'C:\\tmp\\godot-nvidia-dlss\\godot\\bin\\/sl.nis.dll' is signed by NVIDIA and the signature was verified.")).toEqual([])
  })
})

describe('window launches without --path', () => {
  test('bare, editor and script launches still open a window', async () => {
    expect(opensGodotWindow('godot.exe')).toBe(true)
    expect(opensGodotWindow('godot.exe --editor')).toBe(true)
    expect(opensGodotWindow('godot.exe --script res://probe.gd')).toBe(true)
    expect(opensGodotWindow(`& '${STOCK}' --headless; & '${STOCK}' --editor`)).toBe(true)
  })
  test('headless and non-window modes without --path remain allowed', async () => {
    expect(opensGodotWindow('godot.exe --headless')).toBe(false)
    expect(opensGodotWindow('godot.exe --help')).toBe(false)
    expect(opensGodotWindow('godot.exe --version')).toBe(false)
    expect(opensGodotWindow('godot.exe --headless --check-only --script res://probe.gd')).toBe(false)
    expect(opensGodotWindow('godot.exe --headless --import')).toBe(false)
    expect(opensGodotWindow('godot.exe --headless --export-release Windows out.exe')).toBe(false)
  })
})

describe('configured project and executable identities', () => {
  test('configured executable names are recognized as window launches', async () => {
    expect(opensGodotWindow("& 'D:/tools/fork.exe' --editor", ['C:/tools/stock.exe', 'D:/tools/fork.exe'])).toBe(true)
    expect(opensGodotWindow("& 'D:/tools/fork.exe' --headless", ['C:/tools/stock.exe', 'D:/tools/fork.exe'])).toBe(false)
  })
  test('the configured protected project is a demo even with a different name', async () => {
    expect(classify({ pid: 1, ppid: 0, cmd: 'D:/tools/fork.exe --path D:/demo-copy', title: '', started: '10:00' }, ['C:/prototype', 'D:/demo-copy'])).toBe('demo')
  })
  test('fixed fps is refused for the configured fork executable', async () => {
    expect(forkWithFixedFps("& 'D:/tools/fork.exe' --fixed-fps 60", 'D:/tools/fork.exe')).toBe(true)
    expect(forkWithFixedFps("& 'C:/tools/stock.exe' --fixed-fps 60", 'D:/tools/fork.exe')).toBe(false)
  })
})

describe('wrapped copy command positions', () => {
  test('Bash combined and split code options reveal executable copies, not echoed data', async () => {
    for (const command of [
      "bash -lc 'cp C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd'",
      "bash -cl 'cp C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd'",
      "bash -l -c 'cp C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd'",
      "/bin/bash -lc 'cp C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd'",
    ]) expect(copiesIntoDlss(command)).toBe(true)
    expect(copiesIntoDlss("bash -lc 'echo \"cp C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd\"'")).toBe(false)
    expect(copiesIntoDlss("bash -lc 'echo ready # cp a.gd C:/tmp/observatory-dlss/scripts/scene.gd'")).toBe(false)
  })

  test('PowerShell assigned copy invocations reveal copies, not quoted RHS data', async () => {
    for (const command of [
      '$null = Copy-Item C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd',
      "$copied = & 'Copy-Item' C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd",
      '$global:copied = (Copy-Item C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd)',
      '$copied = $(Copy-Item C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd)',
      '$copied = @(Copy-Item C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd)',
      '[string]$copied = Copy-Item C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd',
    ]) expect(copiesIntoDlss(command)).toBe(true)
    expect(copiesIntoDlss("$note = 'Copy-Item'")).toBe(false)
    expect(copiesIntoDlss("$note = 'Copy-Item a.gd C:/tmp/observatory-dlss/scripts/scene.gd'")).toBe(false)
    expect(copiesIntoDlss("$note = 'ready; Copy-Item a.gd C:/tmp/observatory-dlss/scripts/scene.gd'")).toBe(false)
    expect(copiesIntoDlss("$note = ('Copy-Item')")).toBe(false)
    expect(copiesIntoDlss('# $null = Copy-Item a.gd C:/tmp/observatory-dlss/scripts/scene.gd')).toBe(false)
  })
})

test('PowerShell interpolation copies are executable, while literal and escaped data is not', async () => {
  const copy = 'Copy-Item C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd'
  const tick = String.fromCharCode(96)
  expect(copiesIntoDlss('$copied = "$(' + copy + ')"')).toBe(true)
  expect(copiesIntoDlss('[string]$copied = "$(' + copy + ')"')).toBe(true)
  expect(copiesIntoDlss('$copied = "' + tick + tick + '$(' + copy + ')"')).toBe(true)
  expect(copiesIntoDlss('$copied = "$(\'literal\'; ' + copy + ')"')).toBe(true)
  expect(copiesIntoDlss('$note = "' + tick + '$(' + copy + ')"')).toBe(false)
  expect(copiesIntoDlss("$note = '$(" + copy + ")'")).toBe(false)
  expect(copiesIntoDlss('$note = "$(\'Copy-Item\')"')).toBe(false)
  expect(copiesIntoDlss('$note = "Copy-Item"')).toBe(false)
})


test('PowerShell interpolation preserves quoted parentheses and nested groups', async () => {
  const copy = 'Copy-Item C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd'
  for (const command of [
    '$copied = "$(\')\'; ' + copy + ')"',
    '$copied = "$((\'literal\'); ' + copy + ')"',
    '$copied = "$(((' + copy + ')))"',
    '$copied = "$(# ignored )\n' + copy + ')"',
  ]) expect(copiesIntoDlss(command)).toBe(true)
  expect(copiesIntoDlss('$note = "$(\')\')"')).toBe(false)
  expect(dlssCopySources("$copied = & 'Copy-Item' C:/other/scripts/scene.gd C:/tmp/observatory-dlss/scripts/scene.gd", 'C:/tmp', 'C:/tmp/observatory-dlss').error).toBeDefined()
})
