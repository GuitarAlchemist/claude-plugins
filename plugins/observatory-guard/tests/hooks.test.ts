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
  on('env.get', () => ({ value: undefined }))
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
