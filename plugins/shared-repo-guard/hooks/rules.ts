// Several sessions commit, stage and reset in the same clones on this machine: a blanket git command
// run by one of them reaches the others' work. Each rule below is one the sessions already follow by hand.
// Pure text work only: everything that reaches the engine (`$`) lives in register.tsx.

export type Rule = { id: string; re: RegExp; why: string }
// `match` is what the rule matched (it may stop at a flag); `segment` the whole command it is in, up to a separator.
export type Hit = { rule: Rule; match: string; segment: string; index: number }

const GIT = String.raw`\bgit(?:\.exe)?(?:\s+-[Cc]\s+\S+)*\s+` // `git`, `git -C dir`, `git -c key=value`
const ARGS = String.raw`[^\n;&|]*?` // the rest of one command, up to a separator
const END = String.raw`(?=\s|$|[;&|)"'])`

export const RULES: Rule[] = [
  {
    id: 'add-all',
    re: new RegExp(String.raw`${GIT}add\b${ARGS}\s(?:-A|--all|-u|--update|\.|\./|:/|\*)${END}`),
    why: 'stage explicit file paths only: the index is shared, and a blanket add sweeps in other sessions\' work',
  },
  {
    id: 'add-directory',
    re: new RegExp(String.raw`${GIT}add\b${ARGS}\s(?!-)[^\s;&|]+/${END}`),
    why: 'name files, not a directory: a folder picks up whatever other lanes left in it',
  },
  {
    id: 'commit-all',
    re: new RegExp(String.raw`${GIT}commit\b${ARGS}\s(?:-[a-zA-Z]*a[a-zA-Z]*|--all)${END}`),
    why: '`commit -a` stages every tracked change, other sessions\' included; stage explicit paths, then commit',
  },
  {
    id: 'push-force',
    re: new RegExp(
      String.raw`${GIT}push\b${ARGS}\s(?:--force(?:-with-lease|-if-includes)?(?:=\S*)?|-[a-zA-Z]*f[a-zA-Z]*|--mirror|--delete|-d|\+[^\s;&|]+)${END}`,
    ),
    why: 'no force-push, mirror or remote branch deletion: other sessions build on the remote branches',
  },
  {
    id: 'reset-hard',
    re: new RegExp(String.raw`${GIT}reset\b${ARGS}\s--hard${END}`),
    why: 'no `reset --hard` in a shared clone: it drops other sessions\' uncommitted work',
  },
  {
    id: 'stash',
    re: new RegExp(String.raw`${GIT}stash${END}(?!\s+(?:list|show)\b)(?![^\n;&|]*(?:\s--\s+\S|stash@\{))`),
    why: 'no bare stash: it takes every session\'s changes; use `git stash push -- <paths>`, or `stash@{n}` explicitly',
  },
  {
    id: 'clean',
    re: new RegExp(String.raw`${GIT}clean\b${ARGS}\s(?:-[a-zA-Z]*[fxX]|--force)`),
    why: '`git clean` deletes untracked files, and in a shared clone those are often another lane\'s new work',
  },
  {
    id: 'discard-all',
    re: new RegExp(String.raw`${GIT}(?:checkout|restore)\b${ARGS}\s(?:\.|:/|\*)${END}`),
    why: 'discarding the whole tree throws away other sessions\' edits; restore explicit paths',
  },
  {
    id: 'no-verify',
    re: new RegExp(String.raw`${GIT}${ARGS}\s(?:--no-verify|--no-gpg-sign)${END}|\bcommit\.gpgsign=false\b`),
    why: 'hooks and signing stay on; fix what the hook reports instead',
  },
  {
    id: 'index-lock',
    re: /(?:\brm\b|\bdel\b|\berase\b|Remove-Item|\bri\b|\bunlink\b)[^\n;&|]*index\.lock/,
    why: 'an index.lock belongs to whichever process holds it, possibly another session mid-commit; never remove it',
  },
  {
    id: 'self-merge',
    re: /\bgh\s+pr\s+merge\b|\bgh\s+api\b[^\n;&|]*\/pulls\/\d+\/merge\b/,
    why: 'no author self-merge: the integration authority merges',
  },
]

export function firstViolation(text: string): Hit | undefined {
  for (const rule of RULES) {
    const m = rule.re.exec(text)
    if (m) {
      const segment = (text.slice(m.index).split(/[\n;&|]/)[0] ?? m[0]).trim()
      return { rule, match: m[0].trim().slice(0, 160), segment, index: m.index }
    }
  }
  return undefined
}

export function windowsPath(path: string): string {
  return path.replace(/^\/([a-zA-Z])\//, (_, d: string) => `${d.toUpperCase()}:/`)
}

// The `.sh` scripts a command names, its own variable assignments expanded (`$S='…'`, `S=…`).
export function scriptPaths(command: string): string[] {
  const vars = new Map<string, string>()
  for (const [, name = '', value = ''] of command.matchAll(/\$(\w+)\s*=\s*['"]([^'"]+)['"]/g)) vars.set(name, value)
  for (const [, name = '', , value = ''] of command.matchAll(/(?:^|[\s;])(\w+)=(['"]?)([^\s'";]+)\2/g)) vars.set(name, value)
  const expanded = command.replace(/\$\{?(\w+)\}?/g, (s, name: string) => vars.get(name) ?? s)
  return [...expanded.matchAll(/([^\s"';&|<>]+\.sh)(?=[\s"';&|<>]|$)/g)].map(([, path = '']) => path)
}

// A script's commands: a comment that names a rule is not a command.
export function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n')
}

// The directory the matched command runs in: its own `-C`, else the last `cd` before it, else the session's.
export function repoOf(text: string, hit: Hit): string | undefined {
  const unquote = (s: string) => windowsPath(s.replace(/^["']|["']$/g, ''))
  const own = /\s-C\s+("[^"]+"|'[^']+'|\S+)/.exec(hit.match)
  if (own?.[1]) return own[1].includes('$') ? undefined : unquote(own[1])
  let dir: string | undefined
  for (const [, d = ''] of text.slice(0, hit.index).matchAll(/(?:^|[\s;&|(])(?:cd|Set-Location|pushd)\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) {
    dir = d
  }
  return dir && !dir.includes('$') ? unquote(dir) : undefined
}

export function listing(title: string, items: string[]): string[] {
  if (items.length === 0) return [`${title}: nothing at the moment.`]
  const shown = items.slice(0, 8).map(item => `  ${item}`)
  return [`${title} (${items.length}):`, ...shown, ...(items.length > 8 ? [`  … and ${items.length - 8} more`] : [])]
}

// What to read to show what a held command would touch: a git argument vector (after `git`) and the
// title of its answer, or the lock file whose age to give.
export type Probe = { title: string; args: string[] } | { lockPath: string } | undefined

export function probeFor(hit: Hit, branch?: string): Probe {
  const m = ` ${hit.segment} `
  switch (hit.rule.id) {
    case 'add-all': {
      const trackedOnly = /\s(?:-u|--update)\s/.test(m)
      const whole = /\s(?:-A|--all|-u|--update|:\/)\s/.test(m)
      const args = ['status', '--porcelain=v1', trackedOnly ? '--untracked-files=no' : '--untracked-files=all']
      return { title: 'Would be staged', args: whole ? args : [...args, '--', '.'] }
    }
    case 'add-directory': {
      const dir = /\s((?!-)[^\s;&|]+\/)(?=\s)/.exec(m)?.[1] ?? '.'
      return { title: `Would be staged under ${dir}`, args: ['status', '--porcelain=v1', '--untracked-files=all', '--', dir] }
    }
    case 'commit-all':
      return { title: 'Would be committed', args: ['status', '--porcelain=v1', '--untracked-files=no'] }
    case 'push-force': {
      // The branch the push replaces: the one the command names (`origin main`, `+main`, `src:dst`), else
      // the current branch's namesake on the remote; not the upstream, which is often main here.
      const words = hit.segment.replace(/^.*?\bpush\b/, '').split(/\s+/).filter(w => w && !w.startsWith('-'))
      const [remote = 'origin', spec] = words
      const dst = spec?.replace(/^\+/, '').split(':').pop() || branch || 'HEAD'
      const theirs = `${remote}/${dst === 'HEAD' && branch ? branch : dst}`
      return {
        title: `Commits on ${theirs} missing locally, which the push would overwrite (as of the last fetch)`,
        args: ['log', '--oneline', `HEAD..${theirs}`],
      }
    }
    case 'reset-hard':
      return { title: 'Uncommitted changes lost', args: ['status', '--porcelain=v1', '--untracked-files=no'] }
    case 'stash': {
      const untracked = /\s(?:-u|--include-untracked|-a|--all)\s/.test(m)
      return {
        title: 'Would be stashed',
        args: ['status', '--porcelain=v1', untracked ? '--untracked-files=all' : '--untracked-files=no'],
      }
    }
    case 'clean': {
      const flags = /\s-[a-zA-Z]*x/.test(m) ? ['-x'] : /\s-[a-zA-Z]*X/.test(m) ? ['-X'] : []
      return { title: 'Would be deleted', args: ['clean', '-nd', ...flags] }
    }
    case 'discard-all':
      return { title: 'Changes discarded', args: ['diff', '--name-only', ...(/\s:\/\s/.test(m) ? [] : ['--', '.'])] }
    case 'index-lock': {
      const spelled = /[^\s"';&|]*index\.lock/.exec(hit.match)?.[0]
      return spelled ? { lockPath: windowsPath(spelled.replace(/\\/g, '/')) } : undefined
    }
    default:
      return undefined
  }
}
