import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SharedRepoGuardPr, SharedRepoGuardPrCi } from '../types'
import { COLOR, FIELDS, GLYPH, needsAttention, REPOS, toRow } from './pr-rows'
import type { GhPr } from './pr-rows'
import { firstViolation, listing, probeFor, repoOf, scriptPaths, windowsPath, withoutComments } from './rules'
import type { Hit } from './rules'

// Everything that reaches the engine is in this file: the engine follows `$` only into functions
// declared here, which is how `claude plugin validate` can list all the module does.

// Where the lanes keep the one-heavy-command-at-a-time lock (`mkdir heavy.lock`, an `owner` file inside).
const LANES =
  'C:/Users/spare/AppData/Local/Temp/claude/C--Users-spare-source-repos/19b0bdae-e53e-4487-9b0c-42fcb0440719/scratchpad/lanes'

// ---- The guard: a matching command is held for the user's answer, with what it would touch ----

const RUN = 'Run anyway'
const CANCEL = 'Cancel'

async function readScripts($: EngineInterface, command: string): Promise<{ path: string; text: string }[]> {
  const found: { path: string; text: string }[] = []
  for (const spelled of scriptPaths(command)) {
    for (const path of [spelled, windowsPath(spelled)]) {
      try {
        if (!(await $.fs.exists(path))) continue
        found.push({ path, text: withoutComments(await $.fs.read(path)) })
        break
      } catch {
        // unreadable or over 4 MiB: judged by the command alone
      }
    }
  }
  return found
}

async function git($: EngineInterface, cwd: string | undefined, args: string[]): Promise<string[]> {
  // --no-optional-locks: a status here must not take the index lock from under another session
  const r = await $.process.run(['git', '--no-optional-locks', ...args], cwd ? { cwd, timeoutMs: 15_000 } : { timeoutMs: 15_000 })
  if (r.exitCode !== 0) throw new Error((r.stderr.trim().split('\n')[0] ?? '').slice(0, 120) || `git ${args[0]} failed`)
  return r.stdout.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.trim() !== '')
}

// What the held command would touch, read without changing anything.
async function blastRadius($: EngineInterface, hit: Hit, cwd: string | undefined): Promise<string[]> {
  const first = probeFor(hit)
  if (!first) return []
  if ('lockPath' in first) {
    const path = cwd && !/^[A-Za-z]:|^\//.test(first.lockPath) ? `${cwd}/${first.lockPath}` : first.lockPath
    try {
      const minutes = Math.round(((await $.clock.now()) - (await $.fs.stat(path)).mtimeMs) / 60000)
      return [`This lock is ${minutes} min old: another session may be in the middle of a commit.`]
    } catch {
      return ['This lock does not exist (any more).']
    }
  }
  const [top = '?', branch = '?'] = await git($, cwd, ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'])
  const out = [`Repository ${top}, branch ${branch}.`]
  const probe = probeFor(hit, branch === '?' || branch === 'HEAD' ? undefined : branch) // a push needs the branch
  if (!probe || 'lockPath' in probe) return out
  try {
    const items = (await git($, cwd, probe.args)).map(line => line.replace(/^Would remove /, ''))
    out.push(...listing(probe.title, items))
  } catch (err) {
    out.push(`${probe.title}: unreadable (${String(err instanceof Error ? err.message : err).slice(0, 100)}).`)
  }
  return out
}

// Undefined when the command may run: no rule matched, or the user said so. Otherwise the refusal the model reads.
async function guard($: EngineInterface, command: string): Promise<string | undefined> {
  let where = ''
  let text = command
  let hit = firstViolation(command)
  if (!hit) {
    for (const script of await readScripts($, command)) {
      const found = firstViolation(script.text)
      if (found) {
        hit = found
        where = script.path
        text = script.text
        break
      }
    }
  }
  if (!hit) return undefined

  let preview: string[]
  try {
    preview = await blastRadius($, hit, repoOf(text, hit))
  } catch (err) {
    preview = [`(preview unavailable: ${String(err instanceof Error ? err.message : err).slice(0, 120)})`]
  }
  const question = [
    `\`${hit.match}\`${where ? ` (in ${where})` : ''}`,
    `Rule ${hit.rule.id}: ${hit.rule.why}.`,
    ...preview,
    'Run it anyway?',
  ].join('\n')

  let answer: string | undefined
  try {
    answer = await $.ui.ask(question, { options: [CANCEL, RUN], header: 'Repo guard' })
  } catch {
    answer = undefined // dismissed, interrupted, or a headless run with nobody to ask
  }
  if (answer === RUN) {
    $.ui.toast(`shared-repo-guard: ran on your confirmation (${hit.rule.id})`)
    return undefined
  }
  $.ui.toast(`shared-repo-guard: refused (${hit.rule.id})`)
  const who =
    answer === undefined
      ? 'Nobody confirmed it (the question was dismissed, or the session is headless).'
      : answer === CANCEL
        ? 'The user chose to cancel it.'
        : `The user answered instead: "${answer.slice(0, 300)}".`
  return `${$.plugin.name}: refused (${hit.rule.id}) in ${where || 'the command'}: \`${hit.match}\`. Rule: ${hit.rule.why}. ${who}`
}

// A guard that fails must not let the command through: the engine skips a failed hook and runs the tool.
async function guarded($: EngineInterface, command: unknown): Promise<string | undefined> {
  if (typeof command !== 'string') return undefined // the matcher picks the tool; the type is every tool's
  try {
    return await guard($, command)
  } catch (err) {
    return firstViolation(command)
      ? `${$.plugin.name}: the guard failed (${String(err instanceof Error ? err.message : err).slice(0, 120)}) on a command one of its rules matches; refused to be safe.`
      : undefined
  }
}

// ---- /lanes: the heavy lock and the newest claims row of each lane ----

async function lanes($: EngineInterface): Promise<string> {
  const lines: string[] = []
  const lock = `${LANES}/heavy.lock`
  if (await $.fs.exists(lock)) {
    let who = '(no owner file)'
    try {
      who = (await $.fs.read(`${lock}/owner`)).trim()
    } catch {
      // taken a moment ago, owner not written yet
    }
    let age = ''
    try {
      const minutes = Math.round(((await $.clock.now()) - (await $.fs.stat(lock)).mtimeMs) / 60000)
      age = `, for ${minutes} min`
    } catch {
      // released meanwhile
    }
    lines.push(`Heavy lock: held by ${who}${age}`)
  } else {
    lines.push('Heavy lock: free')
  }

  // The eight lanes written to last, one row each: a lane that logs every step would otherwise fill the list.
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (home) {
    try {
      type Claim = { ts?: string; lane?: string; status?: string; evidence?: string }
      const latest = new Map<string, Claim>()
      for (const row of (await $.fs.read(`${home}/.agents/claims.jsonl`)).split('\n')) {
        if (!row.trim()) continue
        try {
          const c = JSON.parse(row) as Claim
          const lane = c.lane ?? '?'
          latest.delete(lane) // re-inserted last, so the Map keeps lanes in order of their newest row
          latest.set(lane, c)
        } catch {
          // a line another writer is halfway through
        }
      }
      const recent = [...latest.entries()].slice(-8)
      lines.push('', `Latest row of the ${recent.length} most recently active lanes (of ${latest.size}):`)
      for (const [lane, c] of recent) {
        lines.push(`- ${(c.ts ?? '?').slice(0, 19)}Z  ${lane}  [${c.status ?? '?'}]  ${(c.evidence ?? '').slice(0, 110)}`)
      }
    } catch {
      lines.push('', 'No readable ~/.agents/claims.jsonl.')
    }
  }
  return lines.join('\n')
}

// ---- /prs: the open pull requests, read with gh when asked, never on a timer ----

const PRS_PANE = 'prs'
const prs = atom({ plugin: 'shared-repo-guard', key: 'prs' } as const, [])
const meta = atom({ plugin: 'shared-repo-guard', key: 'prsMeta' } as const, { isLoading: false, readAt: '', errors: [] })
const expanded = atom({ plugin: 'shared-repo-guard', key: 'prsExpanded' } as const, '')
const filter = atom({ plugin: 'shared-repo-guard', key: 'prsFilter' } as const, 'all')

async function refreshPrs($: EngineInterface): Promise<void> {
  if ((await read($, meta)).isLoading) return
  await update($, meta, m => ({ ...m, isLoading: true }))
  const errors: string[] = []
  const rows: SharedRepoGuardPr[] = []
  try {
    await Promise.all(
      REPOS.map(async repo => {
        try {
          const r = await $.process.run(
            ['gh', 'pr', 'list', '-R', repo, '--state', 'open', '--author', '@me', '--limit', '100', '--json', FIELDS],
            { timeoutMs: 60_000 },
          )
          if (r.exitCode !== 0) {
            errors.push(`${repo}: ${(r.stderr.trim().split('\n')[0] ?? 'gh failed').slice(0, 100)}`)
            return
          }
          const listed = JSON.parse(r.stdout) as GhPr[]
          if (listed.length) {
            try {
              const [owner, name] = repo.split('/')
              // One bounded query per repository. Missing/truncated/stale evidence stays unknown.
              const query = `query { repository(owner: "${owner}", name: "${name}") { pullRequests(first: 100, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number headRefOid reviewThreads(first: 100) { pageInfo { hasNextPage } nodes { isResolved } } } } } }`
              const review = await $.process.run(['gh', 'api', 'graphql', '-f', `query=${query}`], { timeoutMs: 30_000 })
              if (review.exitCode === 0) {
                const data = JSON.parse(review.stdout)
                for (const p of listed) {
                  const found = data.data?.repository?.pullRequests?.nodes?.find((n: {number: number}) => n.number === p.number)
                  const threads = found?.reviewThreads
                  if (Array.isArray(threads?.nodes) && typeof threads.pageInfo?.hasNextPage === 'boolean') {
                    p.reviewThreads = { head: found.headRefOid, complete: !threads.pageInfo.hasNextPage,
                      unresolved: threads.nodes.filter((t: {isResolved?: boolean}) => t.isResolved !== true).length }
                  }
                }
              } else errors.push(`${repo}: review threads unavailable; readiness unknown`)
            } catch {
              errors.push(`${repo}: review threads unavailable; readiness unknown`)
            }
          }
          for (const p of listed) rows.push(toRow(repo, p))
        } catch (err) {
          errors.push(`${repo}: ${String(err instanceof Error ? err.message : err).slice(0, 100)}`)
        }
      }),
    )
    rows.sort((a, b) => a.repo.localeCompare(b.repo) || b.number - a.number)
    await update($, prs, () => rows)
  } finally {
    const readAt = new Date(await $.clock.now()).toISOString().slice(11, 16)
    await update($, meta, () => ({ isLoading: false, readAt: `${readAt}Z`, errors }))
  }
}

export const register: Register = on => {
  // The matcher picks the tool; the input's type is still every tool's, hence `guarded` takes unknown.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = await guarded($, e.command)
    return deny ? { deny } : next(e)
  })

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const deny = await guarded($, e.command)
    return deny ? { deny } : next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'lanes',
      description: 'The lanes\' heavy lock and the latest claims row of each lane',
    })
    await $.command.register({
      name: 'prs',
      description: 'Pane of your open PRs (learn, ga, ix, Demerzel) and their CI, read on demand',
    })
    return next(e)
  })

  on('command.run', { command: 'lanes' }, async $ => ({ text: await lanes($) }))

  on('command.run', { command: 'prs' }, async $ => {
    await $.ui.open({ id: PRS_PANE, title: 'PRs' })
    await refreshPrs($)
    return { text: 'PR pane open: R refreshes, F shows only what needs attention.' }
  })

  on('ui.render', { component: 'Pane', requestId: PRS_PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const rows = await read($, prs)
    const m = await read($, meta)
    const onlyTodo = (await read($, filter)) === 'todo'
    const open = await read($, expanded)

    const shown = onlyTodo ? rows.filter(needsAttention) : rows
    const count = (ci: SharedRepoGuardPrCi) => rows.filter(r => r.ci === ci).length
    const summary = m.readAt
      ? `${rows.length} PRs · ✓ ${count('pass')} · ✗ ${count('fail')} · … ${count('pending')} · read at ${m.readAt}`
      : 'not read yet'

    // The rows that fit, an opened row's details counted, so the buttons stay on screen.
    const room = Math.max(3, (e.viewport?.rows ?? 30) - 4 - m.errors.length)
    const lines: JSX.Element[] = []
    let used = 0
    let rowsShown = 0
    let repo = ''
    for (const r of shown) {
      const id = `${r.repo}#${r.number}`
      const details = id === open ? 3 : 0
      const header = r.repo !== repo ? 1 : 0
      if (used + header + 1 + details > room) break
      if (header) {
        repo = r.repo
        lines.push(
          <Text key={`h-${repo}`} bold>
            {repo}
          </Text>,
        )
      }
      lines.push(
        <Box key={`row-${id}`}>
          <Text color={COLOR[r.ci]}>CI {GLYPH[r.ci]} </Text>
          <Link href={r.url} label={`#${r.number}`} />
          <Text dimColor>{r.mergeable === 'CONFLICTING' ? ' conflict' : r.isDraft ? ' draft' : ''} </Text>
          <Button
            key={`open-${id}`}
            plain
            dimColor
            label={id === open ? '▾' : '▸'}
            onPress={() => update($, expanded, cur => (cur === id ? '' : id))}
          />
          <Text wrap="truncate-end"> {r.title}</Text>
        </Box>,
      )
      if (details) {
        lines.push(
          <Text key={`d1-${id}`} dimColor wrap="truncate-end">
            {'   '}
            {r.branch} @ {r.head} · {r.mergeable.toLowerCase()} · review: {r.review ? r.review.toLowerCase() : 'none'} · updated{' '}
            {r.updatedAt.slice(0, 16).replace('T', ' ')}Z
          </Text>,
          <Text key={`d2-${id}`} color={r.failing.length ? 'red' : undefined} dimColor={!r.failing.length} wrap="truncate-end">
            {'   '}failing: {r.failing.length ? r.failing.join(', ') : 'none'}
          </Text>,
          <Text key={`d3-${id}`} dimColor wrap="truncate-end">
            {'   '}pending: {r.pending.length ? r.pending.join(', ') : 'none'} · passed: {r.passed} · unresolved reviews: {r.unresolvedReviews ?? 'unknown'}
          </Text>,
        )
      }
      used += header + 1 + details
      rowsShown += 1
    }
    const hidden = shown.length - rowsShown

    return (
      <Box flexDirection="column">
        <Box>
          <Button
            key="refresh"
            hotkey="r"
            variant="primary"
            label={m.isLoading ? 'Reading…' : 'Refresh'}
            onPress={() => refreshPrs($)}
          />
          <Text> </Text>
          <Button
            key="filter"
            hotkey="f"
            label={onlyTodo ? 'Show all' : 'Needs attention'}
            onPress={() => update($, filter, f => (f === 'todo' ? 'all' : 'todo'))}
          />
          <Text dimColor> {summary}</Text>
        </Box>
        {m.errors.map(err => (
          <Text key={`err-${err.slice(0, 30)}`} color="yellow" wrap="truncate-end">
            {err}
          </Text>
        ))}
        {shown.length === 0 && m.readAt !== '' && (
          <Text dimColor>{onlyTodo ? 'No CI/review alerts. Dependencies and merge authorization still need verification.' : 'No open PRs.'}</Text>
        )}
        {lines}
        {hidden > 0 && <Text dimColor>… and {hidden} more (enlarge the pane, or show only what needs attention)</Text>}
      </Box>
    )
  })
}
