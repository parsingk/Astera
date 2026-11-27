import { describe, it, expect } from 'vitest'
import { panelCommands, panelInfo, pluginRowsOf, pluginThemesOf, sidebarViewsOf, statusItemsOf, unusablePlugin, type PluginRow } from './pluginRows'

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

// Phase 2 remaining: the themes plugins offer
describe('pluginThemesOf', () => {
  const dusk = { id: 'dusk', title: 'Dusk', base: 'vega' as const, colors: { accent: '#3fa7d6' } }
  const themes = (over: Partial<PluginRow> = {}): PluginRow =>
    row({ id: 'dusk-theme', displayName: 'Dusk pack', ui: undefined, permissions: ['themes.register'], contributes: { commands: [], panels: [], themes: [dusk] }, ...over })

  it('lists each theme of an enabled, ready plugin, merged over its base and named by plugin', () => {
    const [t] = pluginThemesOf([themes()])
    expect(t).toMatchObject({ id: 'plugin:dusk-theme:dusk', name: 'Dusk', pluginId: 'dusk-theme', pluginName: 'Dusk pack', base: 'vega' })
    expect(t.theme.colors.accent).toBe('#3fa7d6')
  })

  it('needs no page: a themes-only plugin has none', () => {
    expect(pluginThemesOf([themes({ ui: undefined })])).toHaveLength(1)
  })

  it('leaves out a plugin turned off or not ready, and a theme the rules refuse though a Host listed it', () => {
    expect(pluginThemesOf([themes({ enabled: false })])).toEqual([])
    expect(pluginThemesOf([themes({ status: 'incompatible' })])).toEqual([])
    expect(pluginThemesOf([themes({ contributes: { commands: [], panels: [], themes: [{ ...dusk, colors: { accent: 'url(x)' } }] } })])).toEqual([])
  })

  it('leaves out a plugin the person did not grant themes.register', () => {
    expect(pluginThemesOf([themes({ permissions: [] })])).toEqual([])
  })
})

// Phase 2 remaining: the rail's plugin buttons
describe('sidebarViewsOf', () => {
  const withSide = (over: Partial<PluginRow> = {}): PluginRow =>
    row({ contributes: { commands: [], panels: [{ id: 'hello', title: 'Hello' }], sidebar: [{ id: 'side', title: 'Hello side', panel: 'hello' }] }, ...over })

  it('lists each sidebar view of a plugin that can show panels, keyed by plugin and view', () => {
    expect(sidebarViewsOf([withSide()])).toEqual([
      { key: 'hello-panel:side', pluginId: 'hello-panel', viewId: 'side', panelId: 'hello', title: 'Hello side', pluginName: 'Hello' }
    ])
  })

  it('leaves out a plugin that cannot show a panel now, and a view whose panel is not contributed', () => {
    expect(sidebarViewsOf([withSide({ enabled: false })])).toEqual([])
    expect(sidebarViewsOf([withSide({ status: 'failed' })])).toEqual([])
    expect(sidebarViewsOf([withSide({ ui: undefined })])).toEqual([])
    expect(sidebarViewsOf([withSide({ contributes: { commands: [], panels: [], sidebar: [{ id: 'side', title: 'S', panel: 'hello' }] } })])).toEqual([])
  })

  it('leaves out a plugin not granted panels.register', () => {
    expect(sidebarViewsOf([withSide({ permissions: [] })])).toEqual([])
  })
})

// Phase 2 remaining: the status bar's plugin items
describe('statusItemsOf', () => {
  const withItem = (over: Partial<PluginRow> = {}, items = [{ id: 'hi', text: 'Hello', command: 'open' }]): PluginRow =>
    row({ contributes: { commands: [{ id: 'open', title: 'Open Hello panel', panel: 'hello' }], panels: [{ id: 'hello', title: 'Hello' }], statusBar: items }, ...over })

  it('gives each item its text and the command it runs, keyed by plugin and item', () => {
    const [item] = statusItemsOf([withItem()])
    expect(item).toMatchObject({ key: 'hello-panel:hi', text: 'Hello', pluginName: 'Hello' })
    expect(item.command).toMatchObject({ key: 'hello-panel:open', pluginId: 'hello-panel', panelId: 'hello', title: 'Open Hello panel', panelTitle: 'Hello' })
  })

  it('leaves out a plugin that cannot show its panel now, one not granted commands.register, and an item whose command is not contributed', () => {
    expect(statusItemsOf([withItem({ enabled: false })])).toEqual([])
    expect(statusItemsOf([withItem({ status: 'incompatible' })])).toEqual([])
    expect(statusItemsOf([withItem({ permissions: ['panels.register'] })])).toEqual([])
    expect(statusItemsOf([withItem({}, [{ id: 'hi', text: 'Hello', command: 'gone' }])])).toEqual([])
  })

  it('shows at most 6 in all, in plugin id order', () => {
    const rows = ['f', 'e', 'd', 'c', 'b', 'a'].map((id) => withItem({ id, displayName: id }, [{ id: 'one', text: `${id}1`, command: 'open' }, { id: 'two', text: `${id}2`, command: 'open' }]))
    expect(statusItemsOf(rows).map((i) => i.text)).toEqual(['a1', 'a2', 'b1', 'b2', 'c1', 'c2'])
  })
})

// Phase 2 remaining, final review M6: a theme is data the app applies, so a trusted plugin's process starting, stopped or
// failed does not take it away; turned off or incompatible does
describe('pluginThemesOf while a trusted plugin is not running', () => {
  const dusk = { id: 'dusk', title: 'Dusk', base: 'vega' as const, colors: { accent: '#3fa7d6' } }
  const trusted = (status: string): PluginRow =>
    row({ id: 'both', status, permissions: ['themes.register'], contributes: { commands: [], panels: [], themes: [dusk] } })
  it('keeps the themes of a plugin starting, stopped or failed, and drops an incompatible one', () => {
    for (const s of ['starting', 'stopped', 'failed', 'running']) expect(pluginThemesOf([trusted(s)]), s).toHaveLength(1)
    expect(pluginThemesOf([trusted('incompatible')])).toEqual([])
    expect(pluginThemesOf([trusted('disabled')])).toEqual([])
  })
})

// Final review M7: the renderer re-checks the shape of what the Host listed, not only a theme's colours
describe('pluginRowsOf with a malformed contribution', () => {
  const listed = (contributes: unknown): PluginRow[] => pluginRowsOf({ plugins: [{ id: 'x', dir: '/x', status: 'ready', enabled: true, contributes }] })
  it('drops a list that is not one, and an item whose fields are not text', () => {
    const [p] = listed({
      commands: [{ id: 'open', title: 'Open', panel: 'main' }, { id: 7, title: 'x', panel: 'main' }],
      panels: [{ id: 'main', title: { evil: true } }, { id: 'side', title: 'Side' }],
      sidebar: 'nope',
      statusBar: [null, { id: 'hi', text: 'Hi', command: 'open' }],
      themes: [{ id: 'd', title: 'D', base: 'vega', colors: { accent: '#3fa7d6' } }, 5]
    })
    expect(p.contributes).toEqual({
      commands: [{ id: 'open', title: 'Open', panel: 'main' }],
      panels: [{ id: 'side', title: 'Side' }],
      statusBar: [{ id: 'hi', text: 'Hi', command: 'open' }],
      themes: [{ id: 'd', title: 'D', base: 'vega', colors: { accent: '#3fa7d6' } }]
    })
  })
  it('keeps no contributions when panels or commands are not lists', () => {
    expect(listed({ commands: 'x', panels: [] })[0].contributes).toBeUndefined()
  })
})

// Phase 4: in Safe Mode nothing of a plugin draws: no panel, sidebar view, status item or theme
describe('pluginRowsOf in Safe Mode', () => {
  it('lists no row when the Host says Safe Mode is on', () => {
    expect(pluginRowsOf({ safeMode: true, plugins: [{ id: 'x', dir: '/x', status: 'stopped', enabled: true }] })).toEqual([])
  })
})
