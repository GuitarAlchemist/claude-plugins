import { expect, test } from 'claude-code/testing'

// The /godot pane before anything is read: no process, no check, buttons in place, on each surface
// that draws panes. Reading processes needs `$.process`, which tests do not have.
const PANE = {
  title: 'Godot',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

test('the /godot pane draws before anything is read', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'observatory-guard', surface, component: 'Pane', requestId: 'godot', props: PANE })
    expect(await ui.find({ key: 'refresh' })).toBeDefined()
    expect(await ui.find({ key: 'check' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /not read yet/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /none yet: C checks them/ })).toBeDefined()
    await ui.unmount()
  }
})
