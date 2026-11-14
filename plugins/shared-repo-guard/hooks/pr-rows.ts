import type { SharedRepoGuardPr, SharedRepoGuardPrCi } from '../types'

// What `gh pr list --json` answers, turned into the rows the /prs pane draws. Pure: no `$` here.

// The `repos` option: `owner/repo` names separated by spaces or commas, each read once.
export function parseRepos(option: unknown): string[] {
  return [...new Set(String(option ?? '').split(/[\s,]+/).filter(Boolean))]
}

export const NO_REPOS =
  'No repositories to list: set the `repos` option to owner/repo names separated by spaces or commas, in /config or with `claude plugin configure shared-repo-guard@guitaralchemist`.'

export const FIELDS = 'number,title,headRefName,headRefOid,isDraft,mergeable,reviewDecision,statusCheckRollup,url,updatedAt'

type GhCheck = { name?: string; context?: string; conclusion?: string; state?: string; status?: string }
export type GhPr = {
  number: number
  title: string
  headRefName: string
  headRefOid: string
  isDraft: boolean
  mergeable: string
  reviewDecision: string
  statusCheckRollup: GhCheck[] | null
  url: string
  updatedAt: string
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

export function toRow(repo: string, p: GhPr): SharedRepoGuardPr {
  const failing: string[] = []
  const pending: string[] = []
  let passed = 0
  for (const c of p.statusCheckRollup ?? []) {
    // a check run has `conclusion` once completed and `status` before; a commit status has `state`
    const state = (c.conclusion || c.state || c.status || '').toUpperCase()
    const name = c.name || c.context || '?'
    if (FAILED.has(state)) failing.push(name)
    else if (PASSED.has(state)) passed += 1
    else pending.push(name)
  }
  const ci: SharedRepoGuardPrCi =
    failing.length > 0 ? 'fail' : pending.length > 0 ? 'pending' : passed > 0 ? 'pass' : 'none'
  return {
    repo,
    number: p.number,
    title: p.title,
    branch: p.headRefName,
    head: p.headRefOid.slice(0, 7),
    url: p.url,
    isDraft: p.isDraft,
    mergeable: p.mergeable,
    review: p.reviewDecision || '',
    updatedAt: p.updatedAt,
    ci,
    failing,
    pending,
    passed,
  }
}

export const GLYPH: Record<SharedRepoGuardPrCi, string> = { pass: '✓', fail: '✗', pending: '…', none: '·' }
export const COLOR: Record<SharedRepoGuardPrCi, string> = { pass: 'green', fail: 'red', pending: 'yellow', none: 'gray' }

export const needsAttention = (r: SharedRepoGuardPr) => r.ci !== 'pass' || r.mergeable === 'CONFLICTING'
