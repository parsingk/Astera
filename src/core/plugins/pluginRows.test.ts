import { describe, it, expect } from 'vitest'
import { panelCommands, panelInfo, pluginRowsOf, unusablePlugin, type PluginRow } from './pluginRows'

const row = (over: Partial<PluginRow> = {}): PluginRow => ({
  id: 'hello-panel',
  enabled: true,
  status: 'ready',
  ui: 'ui/index.html',
  dir: '/p/hello',
  permissions: ['commands.register', 'panels.register'],
  displayName: 'Hello',
  contributes: { commands: [{ id: 'open', title: 'Open Hello panel', panel: 'hello' }], panels: [{ id: 'hello', title: 'Hello' }] },
  ...over
})

describe('pluginRowsOf', () => {
  it('reads the rows a panel needs from the Host’s list, leaving out a malformed one', () => {
    expect(
      pluginRowsOf({
        plugins: [
          { id: 'hello-panel', enabled: true, status: 'ready', dir: '/p/hello', ui: 'dist/ui/index.html', displayName: 'Hello', installedAt: 12, installId: 'a1b2c3d4e5f6', permissions: ['panels.register', 7], contributes: { commands: [], panels: [{ id: 'main', title: 'Hello' }] } },
          { id: 'old', enabled: true, status: 'running', dir: '/p/old', permissions: [], displayName: 3 },
          { id: 'broken', status: 'ready' },
          'junk'
        ]
      })
    ).toEqual([
      { id: 'hello-panel', enabled: true, status: 'ready', dir: '/p/hello', ui: 'dist/ui/index.html', displayName: 'Hello', installedAt: 12, installId: 'a1b2c3d4e5f6', permissions: ['panels.register'], contributes: { commands: [], panels: [{ id: 'main', title: 'Hello' }] } },
      { id: 'old', enabled: true, status: 'running', dir: '/p/old', permissions: [] }
    ])
    expect(pluginRowsOf(null)).toEqual([])
  })
})

describe('unusablePlugin', () => {
  it('names why a plugin cannot show a panel by code, with main’s reason beside it', () => {
    expect(unusablePlugin('hello-panel', undefined)).toEqual({ code: 'missing', reason: 'no plugin hello-panel is installed' })
    expect(unusablePlugin('hello-panel', row({ enabled: false }))).toEqual({ code: 'disabled', reason: 'hello-panel is disabled' })
    expect(unusablePlugin('hello-panel', row({ status: 'incompatible' }))).toEqual({ code: 'notReady', reason: 'hello-panel is incompatible' })
    expect(unusablePlugin('hello-panel', row({ ui: undefined }))).toEqual({ code: 'noUi', reason: 'hello-panel has no ui page' })
    expect(unusablePlugin('hello-panel', row())).toBeNull()
    expect(unusablePlugin('hello-panel', row({ status: 'running' }))).toBeNull()
  })
})

describe('panelCommands', () => {
  it('lists the commands of usable plugins only, keyed by contribution, named by the plugin', () => {
    const rows = [
      row(),
      row({ id: 'off', enabled: false }),
      row({ id: 'stopped', status: 'crashed' }),
      row({ id: 'nameless', displayName: undefined, contributes: { commands: [{ id: 'go', title: 'Go', panel: 'p' }], panels: [{ id: 'p', title: 'P' }] } }),
      row({ id: 'old', ui: undefined, contributes: undefined })
    ]
    expect(panelCommands(rows)).toEqual([
      { key: 'hello-panel:open', pluginId: 'hello-panel', panelId: 'hello', title: 'Open Hello panel', panelTitle: 'Hello', pluginName: 'Hello' },
      { key: 'nameless:go', pluginId: 'nameless', panelId: 'p', title: 'Go', panelTitle: 'P', pluginName: 'nameless' }
    ])
  })

  it('leaves out a command whose panel the plugin does not contribute', () => {
    expect(panelCommands([row({ contributes: { commands: [{ id: 'open', title: 'Open', panel: 'gone' }], panels: [] } })])).toEqual([])
  })
})

describe('panelInfo', () => {
  it('finds an installed plugin’s panel whether or not the plugin can show it now', () => {
    expect(panelInfo([row()], 'hello-panel', 'hello')).toEqual({ title: 'Hello', pluginName: 'Hello' })
    expect(panelInfo([row({ enabled: false })], 'hello-panel', 'hello')).toEqual({ title: 'Hello', pluginName: 'Hello' })
    expect(panelInfo([row()], 'hello-panel', 'other')).toBeNull()
    expect(panelInfo([], 'hello-panel', 'hello')).toBeNull()
  })
})

// Final review (declined to judge, ruled a fix): a display name is now shown in the palette and on a tab, where an
// invisible or direction-changing character could make one plugin read as another
describe('a plugin’s name where it is shown', () => {
  it('is its id when its display name holds an invisible or direction-changing character', () => {
    const spoof = row({ displayName: 'Hello\u202epanel' })
    expect(panelCommands([spoof])[0].pluginName).toBe('hello-panel')
    expect(panelInfo([spoof], 'hello-panel', 'hello')?.pluginName).toBe('hello-panel')
  })
})
