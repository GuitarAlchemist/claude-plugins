// What the /prs pane keeps between draws: the open pull requests read with `gh`, and how the pane shows them.

export type SharedRepoGuardPrCi = 'pass' | 'fail' | 'pending' | 'none'

export type SharedRepoGuardPr = {
  repo: string
  number: number
  title: string
  branch: string
  head: string
  url: string
  isDraft: boolean
  mergeable: string
  review: string
  updatedAt: string
  ci: SharedRepoGuardPrCi
  failing: string[]
  pending: string[]
  passed: number
}

export type SharedRepoGuardPrMeta = { isLoading: boolean; readAt: string; errors: string[] }

declare module 'claude-code' {
  interface PluginState {
    'shared-repo-guard': {
      prs: SharedRepoGuardPr[]
      prsMeta: SharedRepoGuardPrMeta
      prsExpanded: string
      prsFilter: 'all' | 'todo'
    }
  }
}
