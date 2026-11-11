import { expect, test } from 'claude-code/testing'

const listed = [{
  number: 2, title: 'Already listed PR', headRefName: 'fix', headRefOid: 'abc1234',
  isDraft: false, mergeable: 'MERGEABLE', reviewDecision: 'APPROVED',
  statusCheckRollup: [{ name: 'check', conclusion: 'SUCCESS' }],
  url: 'https://github.com/GuitarAlchemist/claude-plugins/pull/2', updatedAt: '2026-10-10T00:00:00Z',
}]

for (const failure of ['exception', 'malformed JSON', 'nonzero exit'] as const) {
  test('a listed PR remains visible with unknown review state after ' + failure, async ($, on) => {
    on('clock.now', () => ({ value: 1791676800000 }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('process.run', (_$, e) => {
      if (e.argv[1] === 'pr') return { value: { exitCode: 0, stdout: JSON.stringify(e.argv.includes('GuitarAlchemist/claude-plugins') ? listed : []), stderr: '' } }
      if (failure === 'exception') throw new Error('GraphQL unavailable')
      return { value: { exitCode: failure === 'nonzero exit' ? 1 : 0, stdout: '{malformed', stderr: 'GraphQL unavailable' } }
    })
    await $.command.run({ command: 'prs', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
    const ui = await $.ui.mount({
      plugin: 'shared-repo-guard', surface: 'terminal', component: 'Pane', requestId: 'prs',
      props: { title: 'PRs', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    })
    expect(await ui.find({ type: 'Text', text: /Already listed PR/ })).toBeDefined()
    await ui.press({ key: 'filter' })
    expect(await ui.find({ type: 'Text', text: /Already listed PR/ })).toBeDefined()
    await ui.press({ key: 'open-GuitarAlchemist/claude-plugins#2' })
    expect(await ui.find({ type: 'Text', text: /unresolved reviews: unknown/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /readiness unknown/ })).toBeDefined()
  })
}
