import { describe, it, expect } from 'vitest'
import {
  PLUGIN_API_VERSIONS,
  PLUGIN_PERMISSIONS,
  PLUGIN_RESTRICTED_UI_NOTICE,
  PLUGIN_TRUST_WARNING,
  PLUGIN_UI_PERMISSIONS,
  incompatibility,
  parseManifest,
  contributionKey,
  pluginFolderName,
  pluginSchemeHost,
  satisfiesRange,
  type PluginManifest
} from './manifest'
import { makeActions } from '../keys/binding'

const valid = (astera: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: '@acme/astera-jira',
  version: '1.2.3',
  astera: { apiVersion: '1', entry: './dist/plugin.js', ...astera },
  ...top
})

const problemsOf = (pkg: unknown): string[] => {
  const r = parseManifest(pkg)
  if (r.ok) throw new Error('expected problems')
  return r.problems
}

const manifestOf = (pkg: unknown): PluginManifest => {
  const r = parseManifest(pkg)
  if (!r.ok) throw new Error(r.problems.join('; '))
  return r.manifest
}

describe('parseManifest', () => {
  it('reads a package.json with an astera field, filling the defaults', () => {
    expect(manifestOf(valid())).toEqual({
      id: '@acme/astera-jira',
      name: '@acme/astera-jira',
      displayName: '@acme/astera-jira',
      version: '1.2.3',
      apiVersion: '1',
      entry: './dist/plugin.js',
      capabilities: [],
      permissions: [],
      settings: [],
      contributes: { commands: [], panels: [] },
      trust: 'trusted'
    })
  })

  it('keeps what the package gives', () => {
    const m = manifestOf(
      valid(
        { capabilities: ['event'], permissions: ['jobs.read', 'jobs.create', 'events.subscribe'], minAsteraVersion: '1.5.0', settingsSchema: { type: 'object', properties: { token: { type: 'string', secret: true } }, required: ['token'] } },
        { displayName: '  Jira  ', description: 'Jobs from Jira issues' }
      )
    )
    expect(m).toMatchObject({
      displayName: 'Jira',
      description: 'Jobs from Jira issues',
      capabilities: ['event'],
      permissions: ['jobs.read', 'jobs.create', 'events.subscribe'],
      minAsteraVersion: '1.5.0',
      settings: [{ key: 'token', type: 'string', secret: true, required: true }]
    })
  })

  // Plugins 2c: the settings schema is part of the manifest, and its problems are the manifest's.
  it('lists the settings schema problems with the others', () => {
    expect(problemsOf(valid({ settingsSchema: { type: 'object', properties: { 'bad-key': { type: 'string' } } } }))).toEqual([
      'astera.settingsSchema: bad-key is not a settings key (a letter, then letters, digits or _, at most 64)'
    ])
  })

  it('cuts a long description to 500 characters', () => {
    expect(manifestOf(valid({}, { description: 'x'.repeat(600) })).description).toHaveLength(500)
  })

  it('refuses something that is not an object', () => {
    expect(problemsOf(null)).toEqual(['package.json is not a JSON object'])
    expect(problemsOf([])).toEqual(['package.json is not a JSON object'])
  })

  it('refuses a name npm would refuse', () => {
    for (const name of ['', 'Jira', 'has space', '@acme/', '../escape', 'a'.repeat(215), 7])
      expect(problemsOf(valid({}, { name }))).toEqual([expect.stringMatching(/^name /)])
  })

  // Final review m1: on Windows `astera~1` can be another folder's short name, `nul` is a device, and a trailing dot is
  // dropped; npm itself refuses `~` in new names.
  it('refuses a name that would not be its own folder on every system', () => {
    for (const name of ['astera~1', '~x', '@acme/x~1', 'nul', 'con', 'aux.js', 'com1', 'lpt9.x', '@nul/x', 'foo.', '@acme./x'])
      expect(problemsOf(valid({}, { name })), name).toEqual([expect.stringMatching(/^name /)])
    for (const name of ['nullable', 'console', 'auxiliary', 'com', 'lpt10', 'a.b', '@acme/con-tools'])
      expect(manifestOf(valid({}, { name })).id, name).toBe(name)
  })

  it('refuses a version that is not semver', () => {
    for (const version of ['1.2', 'v1.2.3', '', 1])
      expect(problemsOf(valid({}, { version }))).toEqual([expect.stringMatching(/^version /)])
    expect(manifestOf(valid({}, { version: '1.2.3-beta.1+build.5' })).version).toBe('1.2.3-beta.1+build.5')
  })

  it('refuses a displayName that is empty or longer than 64 characters', () => {
    expect(problemsOf(valid({}, { displayName: '   ' }))).toEqual([expect.stringMatching(/^displayName /)])
    expect(problemsOf(valid({}, { displayName: 'x'.repeat(65) }))).toEqual([expect.stringMatching(/^displayName /)])
    expect(problemsOf(valid({}, { displayName: 3 }))).toEqual([expect.stringMatching(/^displayName /)])
  })

  // Final review m5: both are printed in the approval message, where a line feed could fake lines ahead of the
  // permissions, and an escape could repaint the terminal.
  it('refuses control characters in the displayName and the description', () => {
    const lf = String.fromCharCode(10)
    const esc = String.fromCharCode(27)
    const del = String.fromCharCode(127)
    const c1 = String.fromCharCode(155)
    expect(problemsOf(valid({}, { displayName: `Jira${lf}asks for: nothing` }))).toEqual([expect.stringMatching(/^displayName /)])
    expect(problemsOf(valid({}, { displayName: `Jira${del}` }))).toEqual([expect.stringMatching(/^displayName /)])
    expect(problemsOf(valid({}, { description: `${esc}[2J` }))).toEqual([expect.stringMatching(/^description /)])
    expect(problemsOf(valid({}, { description: `x${c1}y` }))).toEqual([expect.stringMatching(/^description /)])
    expect(manifestOf(valid({}, { displayName: 'Jira 연동', description: 'Tabs	and Hangul 한글' })).displayName).toBe('Jira 연동')
  })

  it('refuses a description that is not a string', () => {
    expect(problemsOf(valid({}, { description: 3 }))).toEqual([expect.stringMatching(/^description /)])
  })

  it('needs an astera object', () => {
    expect(problemsOf({ name: 'x', version: '1.0.0' })).toEqual(['astera is missing: a plugin names its entry and Plugin API there'])
    expect(problemsOf({ name: 'x', version: '1.0.0', astera: [] })).toEqual([expect.stringMatching(/^astera /)])
  })

  it('needs an apiVersion', () => {
    expect(problemsOf(valid({ apiVersion: undefined }))).toEqual([expect.stringMatching(/^astera\.apiVersion /)])
    expect(problemsOf(valid({ apiVersion: 1 }))).toEqual([expect.stringMatching(/^astera\.apiVersion /)])
  })

  it('needs an entry that stays inside the plugin', () => {
    for (const entry of [undefined, '', '../x.js', 'dist/../../x.js', '/abs.js', '\\abs.js', 'C:/x.js', 'c:x.js', 'dist\\..\\..\\x.js'])
      expect(problemsOf(valid({ entry })), String(entry)).toEqual([expect.stringMatching(/^astera\.entry /)])
    expect(manifestOf(valid({ entry: 'plugin.mjs' })).entry).toBe('plugin.mjs')
  })

  it('refuses an unknown capability and a repeated one', () => {
    expect(problemsOf(valid({ capabilities: ['events'] }))).toEqual([
      'astera.capabilities: events is not a capability; they are event, job-source, completion-check, notification'
    ])
    expect(problemsOf(valid({ capabilities: ['event', 'event'], permissions: ['events.subscribe'] }))).toEqual(['astera.capabilities names event twice'])
    expect(problemsOf(valid({ capabilities: 'event' }))).toEqual(['astera.capabilities is not a list'])
  })

  // Plugin Phase 3 N4: both capabilities hand the plugin event content
  it('refuses an event or notification plugin that does not ask for events.subscribe', () => {
    expect(problemsOf(valid({ capabilities: ['event'], permissions: ['jobs.read'] }))).toEqual(['the event capability needs the events.subscribe permission'])
    expect(problemsOf(valid({ capabilities: ['notification'] }))).toEqual(['the notification capability needs the events.subscribe permission'])
    expect(manifestOf(valid({ capabilities: ['event'], permissions: ['events.subscribe'] })).capabilities).toEqual(['event'])
    expect(manifestOf(valid({ capabilities: ['job-source'] })).capabilities).toEqual(['job-source'])
  })

  it('refuses an unknown permission, naming the known ones, and a repeated one', () => {
    expect(problemsOf(valid({ permissions: ['jobs.write'] }))).toEqual([
      `astera.permissions: jobs.write is not a permission; they are ${PLUGIN_PERMISSIONS.join(', ')}`
    ])
    expect(problemsOf(valid({ permissions: ['jobs.read', 'jobs.read'] }))).toEqual(['astera.permissions names jobs.read twice'])
    expect(problemsOf(valid({ permissions: [3] }))).toEqual([expect.stringMatching(/^astera\.permissions: 3 is not a permission/)])
  })

  it('refuses a minAsteraVersion that is not semver', () => {
    expect(problemsOf(valid({ minAsteraVersion: '1.5' }))).toEqual([expect.stringMatching(/^astera\.minAsteraVersion /)])
  })

  it('lists every problem at once', () => {
    expect(problemsOf({ name: 'Bad Name', version: 'x', astera: { entry: '../x', permissions: ['nope'] } })).toHaveLength(5)
  })
})

describe('the permission vocabulary', () => {
  it('is the design table, fifteen names', () => {
    expect([...PLUGIN_PERMISSIONS]).toEqual([
      'projects.read',
      'jobs.read',
      'jobs.create',
      'jobs.run',
      'runs.read',
      'runs.control',
      'tasks.read',
      'tasks.write',
      'questions.read',
      'questions.answer',
      'completion.read',
      'events.subscribe',
      'github.read',
      'github.write',
      'how-it-works.read'
    ])
  })
})

describe('pluginFolderName', () => {
  it('writes the scope slash as +, which no npm name holds', () => {
    expect(pluginFolderName('@acme/astera-jira')).toBe('@acme+astera-jira')
    expect(pluginFolderName('astera-webhook')).toBe('astera-webhook')
  })
})

describe('incompatibility', () => {
  const host = { version: '1.5.0', capabilities: [] as string[] }
  it('is null for a plugin this Astera runs', () => {
    expect(incompatibility(manifestOf(valid()), host)).toBeNull()
    expect(incompatibility(manifestOf(valid({ minAsteraVersion: '1.5.0' })), host)).toBeNull()
    expect(incompatibility(manifestOf(valid({ minAsteraVersion: '1.4.99' })), host)).toBeNull()
  })
  it('names a Plugin API this Astera does not speak', () => {
    expect(incompatibility(manifestOf(valid({ apiVersion: '3' })), host)).toBe('this Astera speaks Plugin API 1, 2; the plugin needs 3')
  })
  it('names a newer Astera the plugin needs', () => {
    expect(incompatibility(manifestOf(valid({ minAsteraVersion: '1.10.0' })), host)).toBe(
      'the plugin needs Astera 1.10.0 or newer; this is 1.5.0'
    )
  })
  it('reads a prerelease Astera as its release numbers', () => {
    expect(incompatibility(manifestOf(valid({ minAsteraVersion: '1.5.0' })), { ...host, version: '1.5.0-beta.1' })).toBeNull()
  })
  it('names a capability this Astera does not run yet', () => {
    expect(incompatibility(manifestOf(valid({ capabilities: ['event', 'job-source'], permissions: ['events.subscribe'] })), { ...host, capabilities: ['event'] })).toBe(
      'this Astera does not run job-source plugins yet'
    )
  })
})

describe('PLUGIN_TRUST_WARNING', () => {
  it('says plainly that a plugin is not a sandbox', () => {
    expect(PLUGIN_TRUST_WARNING).toBe(
      'Plugins run trusted code on this machine: a plugin can do anything you can, and its permissions limit only what it asks Astera for.'
    )
  })
})

describe('the plugin SDK', () => {
  it('is written for a Plugin API this Astera speaks', async () => {
    const { PLUGIN_API_VERSION } = await import('../../../packages/plugin-sdk/src/index.js')
    expect((PLUGIN_API_VERSIONS as readonly string[]).includes(PLUGIN_API_VERSION)).toBe(true)
  })
})

// Plugin API 2 (spec E2, ADR-008): an optional host entry, a UI page, contributed commands and panels, an engines range
describe('Plugin API 2', () => {
  const v2 = (astera: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'hello-panel',
    version: '0.1.0',
    astera: {
      apiVersion: '2',
      ui: 'dist/ui/index.html',
      permissions: ['commands.register', 'panels.register'],
      contributes: {
        commands: [{ id: 'open', title: 'Open Hello', panel: 'main' }],
        panels: [{ id: 'main', title: 'Hello' }]
      },
      ...astera
    },
    ...top
  })

  it('speaks API 1 and 2, and keeps the UI permissions apart from the Host command ones', () => {
    expect([...PLUGIN_API_VERSIONS]).toEqual(['1', '2'])
    expect([...PLUGIN_UI_PERMISSIONS]).toEqual(['commands.register', 'panels.register', 'workspace.read'])
    for (const p of PLUGIN_UI_PERMISSIONS) expect((PLUGIN_PERMISSIONS as readonly string[]).includes(p)).toBe(false)
  })

  it('reads a UI-only plugin as restricted UI, with its page and contributions', () => {
    const m = manifestOf(v2())
    expect(m.trust).toBe('restricted-ui')
    expect(m.entry).toBeUndefined()
    expect(m.ui).toBe('dist/ui/index.html')
    expect(m.contributes).toEqual({ commands: [{ id: 'open', title: 'Open Hello', panel: 'main' }], panels: [{ id: 'main', title: 'Hello' }] })
    expect(m.permissions).toEqual(['commands.register', 'panels.register'])
  })

  it('reads a plugin with a host entry as trusted, whether or not it has a UI', () => {
    expect(manifestOf(v2({ entry: 'dist/host.js' })).trust).toBe('trusted')
    expect(manifestOf(v2({ entry: 'dist/host.js', ui: undefined, contributes: undefined, permissions: [] })).trust).toBe('trusted')
  })

  it('needs an entry, a UI or both', () => {
    expect(problemsOf(v2({ ui: undefined, contributes: undefined, permissions: [] }))).toContain(
      'astera needs an entry, a ui or both: the Node file Astera starts, the page its panels show'
    )
  })

  it('refuses a UI page that is not a relative .html file inside the plugin', () => {
    for (const ui of ['https://x.example/ui.html', '//host/ui.html', 'file:///C:/ui.html', '../ui.html', 'C:\\ui.html', '/ui.html', 'dist/ui.js']) {
      expect(problemsOf(v2({ ui })).some((p) => p.startsWith(`astera.ui ${ui}`)), ui).toBe(true)
    }
    // A host entry that names a URL is refused as well
    expect(problemsOf(v2({ entry: 'https://x.example/plugin.js' })).some((p) => p.startsWith('astera.entry https://x.example/plugin.js'))).toBe(true)
  })

  it('needs the UI for contributions, and the permission for each kind', () => {
    expect(problemsOf(v2({ ui: undefined, entry: 'dist/host.js' }))).toContain('astera.contributes needs astera.ui: a panel is a page of the plugin’s UI')
    expect(problemsOf(v2({ permissions: ['panels.register'] }))).toContain('contributing commands needs the commands.register permission')
    expect(problemsOf(v2({ permissions: ['commands.register'] }))).toContain('contributing panels needs the panels.register permission')
  })

  it('refuses a bad id, a repeated id, a long or control-holding title, and a command whose panel is not contributed', () => {
    const c = (commands: unknown[], panels: unknown[] = [{ id: 'main', title: 'Hello' }]): Record<string, unknown> => v2({ contributes: { commands, panels } })
    expect(problemsOf(c([{ id: 'Open', title: 'x', panel: 'main' }]))).toContain('astera.contributes.commands: Open is not an id of lower-case letters, digits and . _ - (at most 64)')
    expect(problemsOf(c([{ id: 'open', title: 'x', panel: 'main' }, { id: 'open', title: 'y', panel: 'main' }]))).toContain('astera.contributes.commands names open twice')
    expect(problemsOf(c([{ id: 'open', title: 'x'.repeat(65), panel: 'main' }]))).toContain('astera.contributes.commands: open needs a title of 1 to 64 characters')
    expect(problemsOf(c([{ id: 'open', title: 'a\nb', panel: 'main' }]))).toContain('astera.contributes.commands: open’s title holds a control character')
    expect(problemsOf(c([{ id: 'open', title: 'x', panel: 'side' }]))).toContain('astera.contributes.commands: open opens side, which is not a contributed panel')
    expect(problemsOf(c([{ id: 'open', title: 'x' }]))).toContain('astera.contributes.commands: open opens side, which is not a contributed panel'.replace('opens side, which is not a contributed panel', 'names no panel to open'))
  })

  it('takes at most 50 commands and 20 panels', () => {
    const panels = Array.from({ length: 21 }, (_, i) => ({ id: `p${i}`, title: `P${i}` }))
    expect(problemsOf(v2({ contributes: { commands: [], panels } }))).toContain('astera.contributes.panels lists 21; at most 20')
    const commands = Array.from({ length: 51 }, (_, i) => ({ id: `c${i}`, title: `C${i}`, panel: 'main' }))
    expect(problemsOf(v2({ contributes: { commands, panels: [{ id: 'main', title: 'M' }] } }))).toContain('astera.contributes.commands lists 51; at most 50')
  })

  it('takes the UI permissions in API 2 only', () => {
    expect(problemsOf(valid({ permissions: ['panels.register'] }))).toContain('astera.permissions: panels.register needs Plugin API 2')
    // A Host command permission beside them needs a host entry (final review I2)
    expect(manifestOf(v2({ entry: 'dist/host.js', permissions: ['commands.register', 'panels.register', 'workspace.read', 'jobs.read'] })).permissions).toEqual([
      'commands.register',
      'panels.register',
      'workspace.read',
      'jobs.read'
    ])
  })

  it('reads engines.astera from the top of the package, and refuses a range it does not understand', () => {
    expect(manifestOf(v2({}, { engines: { astera: '>=1.7.0 <2.0.0', node: '>=20' } })).engines).toBe('>=1.7.0 <2.0.0')
    for (const range of ['^1.7.0', '~1.7.0', '1.x', '>=1.7.0 || >=2.0.0', '>=1.7', 'latest', '']) {
      expect(problemsOf(v2({}, { engines: { astera: range } })), range).toContain(
        `engines.astera ${JSON.stringify(range)} is not a range Astera reads: use comparators such as ">=1.7.0 <2.0.0" (>=, >, <=, <, = or a bare version, all of them must hold)`
      )
    }
  })

  it('says why this Astera does not satisfy the plugin’s engines range', () => {
    const host = { version: '1.6.0', capabilities: [] as string[] }
    expect(incompatibility(manifestOf(v2({}, { engines: { astera: '>=1.6.0 <2.0.0' } })), host)).toBeNull()
    expect(incompatibility(manifestOf(v2({}, { engines: { astera: '>=1.7.0' } })), host)).toBe('the plugin needs Astera >=1.7.0; this is 1.6.0')
  })

  it('compares versions by their release, a prerelease host as its release', () => {
    expect(satisfiesRange('1.7.0', '>=1.7.0 <2.0.0')).toBe(true)
    expect(satisfiesRange('2.0.0', '>=1.7.0 <2.0.0')).toBe(false)
    expect(satisfiesRange('1.7.0-beta.1', '>=1.7.0')).toBe(true)
    expect(satisfiesRange('1.6.9', '1.6.9')).toBe(true)
    expect(satisfiesRange('1.6.9', '=1.7.0')).toBe(false)
    expect(satisfiesRange('1.7.0', '^1.7.0')).toBeNull()
  })

  it('has a notice for a UI-only plugin that never calls it trusted code', () => {
    expect(PLUGIN_RESTRICTED_UI_NOTICE).not.toContain(PLUGIN_TRUST_WARNING)
    expect(PLUGIN_RESTRICTED_UI_NOTICE).toMatch(/panel/i)
  })
})

// Final review of manifest v2
describe('Plugin API 2: final review fixes', () => {
  const v2 = (astera: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'hello-panel',
    version: '0.1.0',
    astera: { apiVersion: '2', ui: 'dist/ui/index.html', permissions: [], ...astera },
    ...top
  })

  // I1: only a host program serves a capability or receives settings
  it('refuses capabilities and settings on a plugin with no host entry', () => {
    expect(problemsOf(v2({ capabilities: ['completion-check'] }))).toContain('astera.capabilities needs astera.entry: only a plugin’s host program serves them')
    expect(problemsOf(v2({ settingsSchema: { type: 'object', properties: { token: { type: 'string', secret: true } } } }))).toContain(
      'astera.settingsSchema needs astera.entry: settings reach a plugin’s host program'
    )
  })

  // I2: a restricted UI plugin asks for the UI permissions only
  it('refuses a Host command permission on a plugin with no host entry', () => {
    expect(problemsOf(v2({ permissions: ['jobs.run'] }))).toContain(
      'astera.permissions: jobs.run needs astera.entry; a restricted UI plugin asks only for commands.register, panels.register, workspace.read'
    )
  })

  // M8: a UI permission on a plugin with no page
  it('refuses a UI permission on a plugin with no UI page', () => {
    expect(problemsOf(v2({ ui: undefined, entry: 'dist/host.js', permissions: ['panels.register'] }))).toContain('astera.permissions: panels.register needs astera.ui')
  })

  // M1: an API 1 manifest is read exactly as before, whatever its engines field holds
  it('reads engines.astera for API 2 only', () => {
    const v1 = manifestOf(valid({}, { engines: { astera: '^1.4.0' } }))
    expect(v1.engines).toBeUndefined()
    expect(incompatibility(v1, { version: '1.6.0', capabilities: [] })).toBeNull()
  })

  // M2: the page path is the file the scheme will serve, with nothing to decode
  it('refuses a page path holding %, a backslash, a control character, an empty part or a part ending in a dot or space', () => {
    for (const ui of ['dist/%2e%2e/ui.html', 'dist\\ui.html', 'dist/u\u0001i.html', 'dist//ui.html', 'dist./ui.html', 'dist /ui.html', 'ui.html.']) {
      expect(problemsOf(v2({ ui })).some((p) => p.startsWith(`astera.ui ${ui}`)), JSON.stringify(ui)).toBe(true)
    }
    expect(manifestOf(v2({ ui: 'dist/ui-1.0/index.html' })).ui).toBe('dist/ui-1.0/index.html')
  })

  // M10: titles sit beside core actions in the palette
  it('refuses a title with an invisible or direction-changing character', () => {
    for (const ch of ['\u202e', '\u200b', '\u2066', '\ufeff']) {
      const contributes = { panels: [{ id: 'main', title: `He${ch}llo` }] }
      expect(problemsOf(v2({ permissions: ['panels.register'], contributes })), JSON.stringify(ch)).toContain(
        'astera.contributes.panels: main’s title holds an invisible or direction-changing character'
      )
    }
  })

  // M6: one separator nothing else uses, so a plugin's command never reads as a core action
  it('keys a contribution as plugin id, colon, its id, which no core action id or npm name holds', () => {
    expect(contributionKey('run', 'run')).toBe('run:run')
    expect(contributionKey('@acme/x', 'open')).toBe('@acme/x:open')
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      for (const a of makeActions(platform)) expect(a.id.includes(':'), a.id).toBe(false)
    }
  })

  // ADR-008 (M5): the scheme host names one plugin, a scoped one too
  it('gives each plugin its own scheme host, a scoped one written scope+name', () => {
    expect(pluginSchemeHost('hello-panel')).toBe('hello-panel')
    expect(pluginSchemeHost('@acme/x')).toBe('acme+x')
    expect(pluginSchemeHost('@acme/x')).not.toBe(pluginSchemeHost('acme'))
    expect(new URL(`astera-plugin://${pluginSchemeHost('@acme/x')}/index.html`).host).toBe('acme+x')
  })
})

// Plugin panels step: a leading ./ is how many packages write a path; the trailing-dot rule must not refuse it
describe('Plugin API 2: a ui page written with a leading ./', () => {
  it('reads ./dist/ui/index.html as dist/ui/index.html, and still refuses ./../x.html', () => {
    const pkg = (ui: string): Record<string, unknown> => ({ name: 'hello-panel', version: '0.1.0', astera: { apiVersion: '2', ui, permissions: [] } })
    expect(manifestOf(pkg('./dist/ui/index.html')).ui).toBe('./dist/ui/index.html')
    expect(problemsOf(pkg('./../x.html')).some((p) => p.startsWith('astera.ui ./../x.html'))).toBe(true)
    expect(problemsOf(pkg('dist/./ui.html')).some((p) => p.startsWith('astera.ui dist/./ui.html'))).toBe(true)
  })
})
