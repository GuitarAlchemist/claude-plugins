import { expect, test } from 'claude-code/testing'
import type { CommandRunInput, On } from 'claude-code'

import { parseRepos } from './pr-rows'

// The test's own hooks stand for the engine: the environment, files in memory, and a `gh` that
// records what it was asked and answers one pull request per repository.

const NOW = Date.UTC(2026, 9, 18, 12, 0)

type World = { files: Map<string, string>; gh: string[][]; opened: string[] }

function engine(on: On, env: Record<string, string> = { USERPROFILE: 'C:\\Users\\tester' }): World {
  const world: World = { files: new Map(), gh: [], opened: [] }
  // Matched by their end: off Windows the engine resolves `C:/...` under the working directory.
  const find = (path: string) => [...world.files.keys()].find(k => path.replace(/\\/g, '/').endsWith(k))
  on('clock.now', () => ({ value: NOW }))
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('fs.exists', (_$, e) => ({ value: find(e.path) !== undefined }))
  on('fs.read', (_$, e) => {
    const key = find(e.path)
    return key === undefined ? { deny: `ENOENT: ${e.path}` } : { value: world.files.get(key) ?? '' }
  })
  on('fs.stat', (_$, e) =>
    find(e.path) === undefined
      ? { deny: `ENOENT: ${e.path}` }
      : { value: { kind: 'dir' as const, size: 0, mtimeMs: NOW - 12 * 60_000, isLink: false } },
  )
  on('process.run', (_$, e) => {
    world.gh.push([...e.argv])
    const repo = e.argv[e.argv.indexOf('-R') + 1] ?? '?'
    const pr = {
      number: 7,
      title: 'A change',
      headRefName: 'feat/x',
      headRefOid: '0123456789abcdef',
      isDraft: false,
      mergeable: 'MERGEABLE',
      reviewDecision: '',
      statusCheckRollup: [{ name: 'check', conclusion: 'SUCCESS' }],
      url: `https://github.com/${repo}/pull/7`,
      updatedAt: '2026-10-18T11:00:00Z',
    }
    return { value: { exitCode: 0, stdout: JSON.stringify([pr]), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd })) // the bottom
  on('ui.open', (_$, e) => {
    world.opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.toast', () => ({ value: undefined }))
  return world
}

const run = (command: string): CommandRunInput => ({
  command,
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
})

const PANE_PROPS = { title: 'PRs', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

test('the repos option is owner/repo names split on spaces or commas, each once', () => {
  expect(parseRepos(' acme/one, acme/two\tacme/one ')).toEqual(['acme/one', 'acme/two'])
  expect(parseRepos('')).toEqual([])
  expect(parseRepos(undefined)).toEqual([])
})

test('unset, the lanes are in ~/.claude/lanes and /prs lists nothing, saying how to set it', async ($, on) => {
  const world = engine(on)

  const lanes = await $.command.run(run('lanes'))
  const prs = await $.command.run(run('prs'))
  const ui = await $.ui.mount({ plugin: 'shared-repo-guard', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'prs' })

  expect(lanes.text).toContain('Heavy lock: free (C:/Users/tester/.claude/lanes/heavy.lock)')
  expect(lanes.text).toContain('No readable ~/.agents/claims.jsonl.')
  expect(prs.text).toContain('set the `repos` option')
  expect(world.gh).toEqual([])
  expect(world.opened).toEqual([])
  expect(await ui.find({ type: 'Text', text: /set the `repos` option/ })).toBeDefined()
})

test('unset, the lanes follow CLAUDE_CONFIG_DIR when it moves the Claude Code folder', async ($, on) => {
  engine(on, { USERPROFILE: 'C:\\Users\\tester', CLAUDE_CONFIG_DIR: 'C:\\cfg\\claude\\' })

  const lanes = await $.command.run(run('lanes'))

  expect(lanes.text).toContain('Heavy lock: free (C:/cfg/claude/lanes/heavy.lock)')
})

test(
  'set, the options name the lanes folder and the repositories /prs reads',
  { options: { lanesDir: 'D:\\work\\lanes\\', repos: 'acme/one, acme/two' } },
  async ($, on) => {
    const world = engine(on)
    world.files.set('work/lanes/heavy.lock', '')
    world.files.set('work/lanes/heavy.lock/owner', 'ga-36 cargo build')

    const lanes = await $.command.run(run('lanes'))
    const prs = await $.command.run(run('prs'))
    const ui = await $.ui.mount({ plugin: 'shared-repo-guard', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'prs' })

    expect(lanes.text).toContain('Heavy lock: held by ga-36 cargo build, for 12 min (D:/work/lanes/heavy.lock)')
    expect(prs.text).toContain('PR pane open')
    expect(world.opened).toEqual(['prs'])
    expect(world.gh.map(argv => argv.slice(0, 5).join(' ')).sort()).toEqual(['gh pr list -R acme/one', 'gh pr list -R acme/two'])
    expect(await ui.find({ type: 'Text', text: /2 PRs · ✓ 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^acme\/two$/ })).toBeDefined()
  },
)
