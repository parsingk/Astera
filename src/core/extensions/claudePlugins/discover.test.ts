// Finding the Claude Code plugins installed in every Claude account, so the person can pick which to share. It reads
// account files only (installed_plugins.json, known_marketplaces.json, settings.json, a plugin's manifest) and writes
// none. Accounts here are temp config folders with hand-written files.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../testFixtures'
import { discoverClaudePlugins, marketplaceArg } from './discover'
import type { Account } from '../../types'
import type { ClaudePluginRefusal, MarketplaceSource, SharedClaudePlugin } from './types'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const temp = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-claudeplugin-find-'))
  dirs.push(d)
  return d
}
const write = async (file: string, text: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

const OFFICIAL = 'claude-plugins-official'
const GITHUB: MarketplaceSource = { source: 'github', repo: 'anthropics/claude-plugins-official' }

interface Held {
  version?: string
  scope?: string
  /** Written to <installPath>/.claude-plugin/plugin.json when given. */
  manifest?: object
}
interface Layout {
  plugins?: Record<string, Held[]>
  /** Raw JSON values of known_marketplaces.json: `{ source }` objects keyed by marketplace name. */
  marketplaces?: Record<string, unknown>
  /** Written to the marketplace's `installLocation` as `.claude-plugin/marketplace.json`, keyed by marketplace name; a
   *  string is written as it is (to make a damaged file). */
  catalogs?: Record<string, unknown>
  enabled?: Record<string, boolean>
}

/** An account whose config folder holds what `layout` says. A file the layout leaves out is not written. */
const account = async (home: string, id: string, layout: Layout = {}, provider: 'claude' | 'codex' = 'claude'): Promise<Account> => {
  const configDir = path.join(home, id)
  await fs.mkdir(configDir, { recursive: true })
  if (layout.plugins) {
    const installed: Record<string, object[]> = {}
    for (const [pluginId, helds] of Object.entries(layout.plugins)) {
      installed[pluginId] = []
      for (const [n, h] of helds.entries()) {
        const installPath = path.join(configDir, 'plugins', 'cache', pluginId.replace('@', '-'), `v${n}`)
        installed[pluginId].push({ scope: h.scope ?? 'user', installPath, version: h.version ?? '1.0.0' })
        if (h.manifest) await write(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify(h.manifest))
      }
    }
    await write(path.join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: installed }))
  }
  if (layout.marketplaces) {
    const known = Object.fromEntries(Object.entries(layout.marketplaces).map(([name, source]) => [name, { source, installLocation: path.join(configDir, 'plugins', 'marketplaces', name) }]))
    await write(path.join(configDir, 'plugins', 'known_marketplaces.json'), JSON.stringify(known))
  }
  for (const [name, catalog] of Object.entries(layout.catalogs ?? {})) {
    await write(path.join(configDir, 'plugins', 'marketplaces', name, '.claude-plugin', 'marketplace.json'), typeof catalog === 'string' ? catalog : JSON.stringify(catalog))
  }
  if (layout.enabled) await write(path.join(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: layout.enabled }))
  return { id, label: id, configDir, color: '#888', createdAt: '2026-11-02T00:00:00.000Z', ...(provider === 'codex' ? { provider } : {}) }
}

const sharedPlugin = (name: string, marketplace: string): SharedClaudePlugin => ({
  id: `${name}@${marketplace}`,
  name,
  marketplace,
  source: GITHUB,
  version: '1.0.0',
  installPath: path.join('plugins', 'cache', marketplace, name, '1.0.0'),
  dependencies: [],
  importedFrom: 'a',
  enabled: true,
  addedAt: '2026-11-02T00:00:00.000Z',
  lastUpdated: '2026-11-02T00:00:00.000Z',
  fingerprint: 'sha256:aa'
})

/** The one plugin a single account holds, as discovery reports it. */
const only = async (layout: Layout, shared: SharedClaudePlugin[] = []) => {
  const home = await temp()
  const found = await discoverClaudePlugins({ accounts: [await account(home, 'a', layout)], shared })
  expect(found.unreadable).toEqual([])
  expect(found.plugins).toHaveLength(1)
  return found.plugins[0]
}

describe('discoverClaudePlugins', () => {
  it("unions plugins across accounts with each holder's version", async () => {
    const home = await temp()
    const id = `superpowers@${OFFICIAL}`
    const a = await account(home, 'a', { plugins: { [id]: [{ version: '6.3.0' }] }, marketplaces: { [OFFICIAL]: GITHUB }, enabled: { [id]: true } })
    const b = await account(home, 'b', { plugins: { [id]: [{ version: '7.0.0' }] }, marketplaces: { [OFFICIAL]: GITHUB }, enabled: { [id]: false } })
    const found = await discoverClaudePlugins({ accounts: [a, b], shared: [] })
    expect(found.unreadable).toEqual([])
    expect(found.plugins).toEqual([
      {
        id,
        name: 'superpowers',
        marketplace: OFFICIAL,
        holders: [
          { accountId: 'a', version: '6.3.0', enabled: true },
          { accountId: 'b', version: '7.0.0', enabled: false }
        ],
        source: GITHUB,
        sourceAccountId: 'a',
        shareable: true
      }
    ])
  })

  it('counts a plugin not named in enabledPlugins, or an account with no settings.json, as not enabled', async () => {
    const home = await temp()
    const id = `hud@${OFFICIAL}`
    const a = await account(home, 'a', { plugins: { [id]: [{}] }, marketplaces: { [OFFICIAL]: GITHUB }, enabled: { [`other@${OFFICIAL}`]: true } })
    const b = await account(home, 'b', { plugins: { [id]: [{}] }, marketplaces: { [OFFICIAL]: GITHUB } })
    const found = await discoverClaudePlugins({ accounts: [a, b], shared: [] })
    expect(found.plugins[0].holders.map((h) => h.enabled)).toEqual([false, false])
  })

  it('looks at user scope only', async () => {
    const home = await temp()
    const id = `hud@${OFFICIAL}`
    const a = await account(home, 'a', { plugins: { [id]: [{ scope: 'project', version: '1.0.0' }, { scope: 'user', version: '2.0.0' }] }, marketplaces: { [OFFICIAL]: GITHUB } })
    const b = await account(home, 'b', { plugins: { [id]: [{ scope: 'local' }], [`only-project@${OFFICIAL}`]: [{ scope: 'project' }] }, marketplaces: { [OFFICIAL]: GITHUB } })
    const found = await discoverClaudePlugins({ accounts: [a, b], shared: [] })
    expect(found.plugins.map((p) => [p.id, p.holders])).toEqual([[id, [{ accountId: 'a', version: '2.0.0', enabled: false }]]])
  })

  it('reads Claude accounts only', async () => {
    const home = await temp()
    const id = `hud@${OFFICIAL}`
    const layout: Layout = { plugins: { [id]: [{}] }, marketplaces: { [OFFICIAL]: GITHUB } }
    const codex = await account(home, 'codex', layout, 'codex')
    const claude = await account(home, 'claude', layout)
    const found = await discoverClaudePlugins({ accounts: [codex, claude], shared: [] })
    expect(found.plugins[0].holders.map((h) => h.accountId)).toEqual(['claude'])
    expect(found.plugins[0].sourceAccountId).toBe('claude')
  })

  it('takes the source from the first account, in the given order, that holds the plugin and knows its marketplace', async () => {
    const home = await temp()
    const id = `p@${OFFICIAL}`
    const first: MarketplaceSource = { source: 'git', url: 'https://git.example.com/first.git' }
    const second: MarketplaceSource = { source: 'git', url: 'https://git.example.com/second.git' }
    const holdsOnly = await account(home, 'holds-only', { plugins: { [id]: [{}] } })
    const knowsOnly = await account(home, 'knows-only', { marketplaces: { [OFFICIAL]: GITHUB } })
    const one = await account(home, 'one', { plugins: { [id]: [{}] }, marketplaces: { [OFFICIAL]: first } })
    const two = await account(home, 'two', { plugins: { [id]: [{}] }, marketplaces: { [OFFICIAL]: second } })
    const found = await discoverClaudePlugins({ accounts: [holdsOnly, knowsOnly, one, two], shared: [] })
    expect(found.plugins).toHaveLength(1)
    expect(found.plugins[0]).toMatchObject({ sourceAccountId: 'one', source: first, shareable: true })
    expect(found.plugins[0].holders.map((h) => h.accountId)).toEqual(['holds-only', 'one', 'two'])
  })

  it('leaves out a plugin already shared', async () => {
    const home = await temp()
    const kept = `kept@${OFFICIAL}`
    const done = `done@${OFFICIAL}`
    const a = await account(home, 'a', { plugins: { [kept]: [{}], [done]: [{}] }, marketplaces: { [OFFICIAL]: GITHUB } })
    const found = await discoverClaudePlugins({ accounts: [a], shared: [sharedPlugin('done', OFFICIAL)] })
    expect(found.plugins.map((p) => p.id)).toEqual([kept])
  })

  it('treats an account without plugin files as holding none, and keeps its id out of unreadable', async () => {
    const home = await temp()
    const id = `hud@${OFFICIAL}`
    const bare = await account(home, 'bare')
    const a = await account(home, 'a', { plugins: { [id]: [{}] }, marketplaces: { [OFFICIAL]: GITHUB } })
    const missingDir: Account = { ...bare, id: 'gone', configDir: path.join(home, 'no-such-folder') }
    const found = await discoverClaudePlugins({ accounts: [bare, missingDir, a], shared: [] })
    expect(found.unreadable).toEqual([])
    expect(found.plugins.map((p) => p.id)).toEqual([id])
  })

  describe('refuses a plugin that cannot be shared, with the first reason that applies', () => {
    const reasonOf = async (layout: Layout, shared: SharedClaudePlugin[] = []): Promise<ClaudePluginRefusal | null> => {
      const p = await only(layout, shared)
      return p.shareable ? null : p.reason
    }

    it.each(['inline', 'builtin', 'skills-dir'])('not-from-marketplace: the marketplace is %s', async (marketplace) => {
      const id = `thing@${marketplace}`
      const p = await only({ plugins: { [id]: [{}] }, marketplaces: {} })
      expect(p).toMatchObject({ id, marketplace, source: null, shareable: false, reason: 'not-from-marketplace' })
    })

    it('name-taken: a shared plugin has the same name from another marketplace', async () => {
      const layout: Layout = { plugins: { [`superpowers@${OFFICIAL}`]: [{}] }, marketplaces: { [OFFICIAL]: GITHUB } }
      expect(await only(layout, [sharedPlugin('superpowers', 'other-market')])).toMatchObject({ shareable: false, reason: 'name-taken' })
      // the same name from the same marketplace is the plugin itself (left out), and another name is no clash
      expect(await reasonOf(layout, [sharedPlugin('another', 'other-market')])).toBeNull()
    })

    it.each<[string, unknown]>([
      ['an npm source', { source: 'npm', package: '@acme/market' }],
      ['a settings source', { source: 'settings', name: 'inline-market', plugins: [] }],
      ['an unknown source', { source: 'carrier-pigeon', coop: 'attic' }],
      ['a github source with a path', { source: 'github', repo: 'acme/market', path: 'sub' }],
      ['a git source with sparsePaths', { source: 'git', url: 'https://git.example.com/m.git', sparsePaths: ['plugins'] }],
      ['a source that is not an object', 'acme/market'],
      ['a github source without a repo', { source: 'github' }]
    ])('source-unsupported: %s', async (_name, source) => {
      const p = await only({ plugins: { [`x@m`]: [{}] }, marketplaces: { m: source } })
      expect(p).toMatchObject({ source: null, shareable: false, reason: 'source-unsupported' })
    })

    it('source-unsupported: no account that holds the plugin knows its marketplace', async () => {
      const p = await only({ plugins: { [`x@m`]: [{}] }, marketplaces: { other: GITHUB } })
      expect(p).toMatchObject({ sourceAccountId: 'a', source: null, shareable: false, reason: 'source-unsupported' })
    })

    // The refusal carries source null: the object goes to the renderer, and it must not hold the credential
    it.each([
      ['a password in the address', 'https://user:hunter2@git.example.com/m.git', 'hunter2'],
      ['a secret-named query parameter', 'https://git.example.com/m.git?access_token=abc123', 'abc123'],
      ['a token as the whole user name of an https address', 'https://ghp_abc123@git.example.com/m.git', 'ghp_abc123'],
      ['a token as the whole user name of an http address', 'http://ghp_abc123@10.0.0.5/m.git', 'ghp_abc123']
    ])('source-credential: %s', async (_name, url, secret) => {
      for (const source of [{ source: 'git', url }, { source: 'url', url }]) {
        const p = await only({ plugins: { [`x@m`]: [{}] }, marketplaces: { m: source } })
        expect(p).toMatchObject({ source: null, sourceAccountId: 'a', shareable: false, reason: 'source-credential' })
        expect(JSON.stringify(p)).not.toContain(secret)
      }
    })

    // Another reason may win the order, but the credential must not travel with the item whatever the reason is
    describe('never carries a credentialed source out, whichever reason wins', () => {
      const credentialed: [string, unknown, string][] = [
        ['a password in the address', { source: 'git', url: 'https://user:hunter2@git.example.com/m.git' }, 'hunter2'],
        ['a secret-named query parameter', { source: 'url', url: 'https://git.example.com/m.json?access_token=abc123' }, 'abc123'],
        ['a token as the user name', { source: 'git', url: 'https://ghp_abc123@git.example.com/m.git' }, 'ghp_abc123'],
        ['headers', { source: 'url', url: 'https://market.example.com/m.json', headers: { Authorization: 'Bearer HEADER_VALUE_MUST_NOT_APPEAR' } }, 'HEADER_VALUE_MUST_NOT_APPEAR']
      ]
      it.each(credentialed)('name-taken with %s', async (_name, source, secret) => {
        const p = await only({ plugins: { 'x@m': [{}] }, marketplaces: { m: source } }, [sharedPlugin('x', 'other')])
        expect(p).toMatchObject({ source: null, sourceAccountId: 'a', shareable: false, reason: 'name-taken' })
        expect(JSON.stringify(p)).not.toContain(secret)
      })

      it.each(credentialed)('not-from-marketplace with %s', async (_name, source, secret) => {
        const p = await only({ plugins: { 'x@inline': [{}] }, marketplaces: { inline: source } })
        expect(p).toMatchObject({ source: null, shareable: false, reason: 'not-from-marketplace' })
        expect(JSON.stringify(p)).not.toContain(secret)
      })

      it('keeps the source of a plugin refused for another reason when it holds no credential', async () => {
        const p = await only({ plugins: { 'x@m': [{}] }, marketplaces: { m: GITHUB } }, [sharedPlugin('x', 'other')])
        expect(p).toMatchObject({ source: GITHUB, reason: 'name-taken' })
      })
    })

    it('source-credential: a url source with headers, whatever they hold', async () => {
      const url = 'https://market.example.com/marketplace.json'
      const raw = { source: 'url', url, headers: { Authorization: 'Bearer HEADER_VALUE_MUST_NOT_APPEAR' } }
      const p = await only({ plugins: { 'x@m': [{}] }, marketplaces: { m: raw } })
      expect(p).toMatchObject({ source: null, shareable: false, reason: 'source-credential' })
      expect(JSON.stringify(p)).not.toContain('HEADER_VALUE_MUST_NOT_APPEAR')
    })

    it.each([
      ['an ssh address with a login name', { source: 'git', url: 'ssh://git@git.example.com/m.git' }],
      ['an scp-style address', { source: 'git', url: 'git@git.example.com:o/m.git' }],
      ['an https address with no user', { source: 'git', url: 'https://git.example.com/m.git' }],
      ['a url source with empty headers', { source: 'url', url: 'https://market.example.com/marketplace.json', headers: {} }]
    ])('shares %s, which holds no credential', async (_name, source) => {
      const p = await only({ plugins: { 'x@m': [{}] }, marketplaces: { m: source } })
      expect(p).toMatchObject({ shareable: true })
      expect(p.source).not.toBeNull()
    })

    it('user-config: the plugin declares a non-empty userConfig', async () => {
      const userConfig = { api_key: { type: 'string', title: 'API key', sensitive: true } }
      const p = await only({ plugins: { [`x@${OFFICIAL}`]: [{ manifest: { name: 'x', userConfig } }] }, marketplaces: { [OFFICIAL]: GITHUB } })
      expect(p).toMatchObject({ source: GITHUB, shareable: false, reason: 'user-config' })
    })

    it('user-config: any account holding the plugin may be the one that declares it', async () => {
      const home = await temp()
      const id = `x@${OFFICIAL}`
      const layout = (manifest: object): Layout => ({ plugins: { [id]: [{ manifest }] }, marketplaces: { [OFFICIAL]: GITHUB } })
      const clean = await account(home, 'a', layout({ name: 'x' }))
      const declares = await account(home, 'b', layout({ name: 'x', userConfig: { token: { type: 'string' } } }))
      const found = await discoverClaudePlugins({ accounts: [clean, declares], shared: [] })
      expect(found.plugins[0]).toMatchObject({ shareable: false, reason: 'user-config' })
    })

    it('shares a plugin whose manifest declares an empty userConfig, has none, or is missing', async () => {
      for (const manifest of [{ name: 'x', userConfig: {} }, { name: 'x' }, undefined]) {
        const p = await only({ plugins: { [`x@${OFFICIAL}`]: [{ manifest }] }, marketplaces: { [OFFICIAL]: GITHUB } })
        expect(p).toMatchObject({ shareable: true })
      }
    })

    it('shares a plugin whose manifest cannot be parsed, since the marketplace copy is what Astera installs', async () => {
      const home = await temp()
      const a = await account(home, 'a', { plugins: { [`x@${OFFICIAL}`]: [{}] }, marketplaces: { [OFFICIAL]: GITHUB } })
      const installed = JSON.parse(await fs.readFile(path.join(a.configDir, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins: Record<string, { installPath: string }[]> }
      await write(path.join(installed.plugins[`x@${OFFICIAL}`][0].installPath, '.claude-plugin', 'plugin.json'), '{')
      const found = await discoverClaudePlugins({ accounts: [a], shared: [] })
      expect(found.plugins[0]).toMatchObject({ shareable: true })
    })

    describe('user-config declared in the marketplace catalog entry', () => {
      const ask = { api_key: { type: 'string', title: 'API key', sensitive: true } }
      const catalog = (...plugins: object[]) => ({ name: OFFICIAL, plugins })
      const layout = (catalogs: Record<string, unknown>): Layout => ({ plugins: { [`x@${OFFICIAL}`]: [{ manifest: { name: 'x' } }] }, marketplaces: { [OFFICIAL]: GITHUB }, catalogs })

      it('refuses when the entry with the plugin name has a non-empty userConfig', async () => {
        const p = await only(layout({ [OFFICIAL]: catalog({ name: 'other' }, { name: 'x', source: './x', userConfig: ask }) }))
        expect(p).toMatchObject({ source: GITHUB, shareable: false, reason: 'user-config' })
      })

      it("is not asked by another plugin's entry, an empty userConfig, or an entry with none", async () => {
        for (const entries of [[{ name: 'other', userConfig: ask }, { name: 'x' }], [{ name: 'x', userConfig: {} }], [{ name: 'other' }]]) {
          expect(await only(layout({ [OFFICIAL]: catalog(...entries) }))).toMatchObject({ shareable: true })
        }
      })

      it.each([
        ['has no catalog file', undefined],
        ['holds a catalog that cannot be parsed', '{'],
        ['holds a catalog with no plugin list', { name: OFFICIAL }],
        ['holds a plugin list with entries that are not objects', { plugins: ['x', null, 3] }]
      ])('counts a marketplace folder that %s as declaring none', async (_name, content) => {
        const p = await only(layout(content === undefined ? {} : { [OFFICIAL]: content }))
        expect(p).toMatchObject({ shareable: true })
      })

      it('asks the catalog of every account holding the plugin', async () => {
        const home = await temp()
        const a = await account(home, 'a', layout({ [OFFICIAL]: catalog({ name: 'x' }) }))
        const b = await account(home, 'b', layout({ [OFFICIAL]: catalog({ name: 'x', userConfig: ask }) }))
        const found = await discoverClaudePlugins({ accounts: [a, b], shared: [] })
        expect(found.plugins[0]).toMatchObject({ shareable: false, reason: 'user-config' })
      })
    })

    it('goes by the order: marketplace kind, then name taken, then source, then credential, then userConfig', async () => {
      const userConfig = { k: { type: 'string' } }
      const credentialed = { source: 'git', url: 'https://u:p@git.example.com/m.git' }
      const manifest = { name: 'x', userConfig }
      // inline beats a taken name
      expect(await reasonOf({ plugins: { 'x@inline': [{ manifest }] } }, [sharedPlugin('x', 'other')])).toBe('not-from-marketplace')
      // a taken name beats an unsupported source
      expect(await reasonOf({ plugins: { 'x@m': [{ manifest }] }, marketplaces: { m: { source: 'npm', package: 'p' } } }, [sharedPlugin('x', 'other')])).toBe('name-taken')
      // an unsupported source beats userConfig
      expect(await reasonOf({ plugins: { 'x@m': [{ manifest }] }, marketplaces: { m: { source: 'npm', package: 'p' } } })).toBe('source-unsupported')
      // a credential beats userConfig
      expect(await reasonOf({ plugins: { 'x@m': [{ manifest }] }, marketplaces: { m: credentialed } })).toBe('source-credential')
      // ... also when the catalog is what asks
      const catalogs = { m: { plugins: [{ name: 'x', userConfig }] } }
      expect(await reasonOf({ plugins: { 'x@m': [{}] }, marketplaces: { m: credentialed }, catalogs })).toBe('source-credential')
      expect(await reasonOf({ plugins: { 'x@m': [{}] }, marketplaces: { m: { source: 'github', repo: 'o/r' } }, catalogs })).toBe('user-config')
    })
  })

  it('carries over only the fields a source is made of, nothing else the account recorded', async () => {
    const url = 'https://market.example.com/marketplace.json'
    const github = await only({ plugins: { 'x@m': [{}] }, marketplaces: { m: { source: 'github', repo: 'o/r', ref: 'v2', autoUpdate: true, note: 'n' } } })
    expect(github.source).toEqual({ source: 'github', repo: 'o/r', ref: 'v2' })
    const plain = await only({ plugins: { 'x@m': [{}] }, marketplaces: { m: { source: 'url', url, headers: {}, extra: 1 } } })
    expect(plain.source).toEqual({ source: 'url', url })
  })

  it('does not write to an account folder', async () => {
    const home = await temp()
    const id = `hud@${OFFICIAL}`
    const a = await account(home, 'a', { plugins: { [id]: [{ manifest: { name: 'hud' } }] }, marketplaces: { [OFFICIAL]: GITHUB }, enabled: { [id]: true } })
    const snapshot = async (): Promise<string[]> => {
      const out: string[] = []
      const walk = async (dir: string): Promise<void> => {
        for (const e of await fs.readdir(dir, { withFileTypes: true })) {
          const f = path.join(dir, e.name)
          if (e.isDirectory()) await walk(f)
          else out.push(`${f}:${(await fs.stat(f)).mtimeMs}:${(await fs.readFile(f, 'utf8')).length}`)
        }
      }
      await walk(a.configDir)
      return out.sort()
    }
    const before = await snapshot()
    await discoverClaudePlugins({ accounts: [a], shared: [] })
    expect(await snapshot()).toEqual(before)
  })

  describe('an unreadable account', () => {
    const id = `hud@${OFFICIAL}`
    const good: Layout = { plugins: { [id]: [{ version: '0.8.0' }] }, marketplaces: { [OFFICIAL]: GITHUB } }

    it('does not hide the others', async () => {
      const home = await temp()
      const a = await account(home, 'a', good)
      const b = await account(home, 'b', good)
      await write(path.join(b.configDir, 'plugins', 'installed_plugins.json'), '{')
      const c = await account(home, 'c', { ...good, plugins: { [id]: [{ version: '0.9.0' }], [`more@${OFFICIAL}`]: [{}] } })
      const found = await discoverClaudePlugins({ accounts: [a, b, c], shared: [] })
      expect(found.unreadable).toEqual(['b'])
      expect(found.plugins.map((p) => [p.id, p.holders.map((h) => `${h.accountId}:${h.version}`)])).toEqual([
        [id, ['a:0.8.0', 'c:0.9.0']],
        [`more@${OFFICIAL}`, ['c:1.0.0']]
      ])
    })

    it.each([
      ['plugins/installed_plugins.json', '{'],
      ['plugins/installed_plugins.json', ''],
      ['plugins/installed_plugins.json', '[]'],
      ['plugins/installed_plugins.json', '{"version":2}'],
      ['plugins/known_marketplaces.json', '{"x":'],
      ['settings.json', '{ "enabledPlugins": ']
    ])('is listed when %s holds %j', async (file, text) => {
      const home = await temp()
      const a = await account(home, 'a', { ...good, enabled: { [id]: true } })
      await write(path.join(a.configDir, ...file.split('/')), text)
      const found = await discoverClaudePlugins({ accounts: [a], shared: [] })
      expect(found.unreadable).toEqual(['a'])
      expect(found.plugins).toEqual([])
    })

    it('is listed when a file cannot be read at all', async () => {
      const home = await temp()
      const a = await account(home, 'a', good)
      // a folder where the file belongs: readFile fails with something other than "not found"
      await fs.rm(path.join(a.configDir, 'plugins', 'known_marketplaces.json'))
      await fs.mkdir(path.join(a.configDir, 'plugins', 'known_marketplaces.json'))
      const found = await discoverClaudePlugins({ accounts: [a], shared: [] })
      expect(found.unreadable).toEqual(['a'])
    })
  })
})

describe('marketplaceArg', () => {
  const cases: [string, unknown, string | null][] = [
    ['github repo', { source: 'github', repo: 'acme/market' }, 'acme/market'],
    ['github repo with a ref', { source: 'github', repo: 'acme/market', ref: 'v2' }, 'acme/market#v2'],
    ['git url', { source: 'git', url: 'https://git.example.com/m.git' }, 'https://git.example.com/m.git'],
    ['git url with a ref', { source: 'git', url: 'http://10.0.0.5/m.git', ref: 'main' }, 'http://10.0.0.5/m.git#main'],
    ['directory', { source: 'directory', path: path.join('C:', 'Users', '가나 다', 'market') }, path.join('C:', 'Users', '가나 다', 'market')],
    ['file', { source: 'file', path: path.join('C:', 'market', 'marketplace.json') }, path.join('C:', 'market', 'marketplace.json')],
    ['url', { source: 'url', url: 'https://market.example.com/marketplace.json' }, 'https://market.example.com/marketplace.json'],
    ['github with a path', { source: 'github', repo: 'acme/market', path: 'sub' }, null],
    ['github with sparsePaths', { source: 'github', repo: 'acme/market', sparsePaths: ['a'] }, null],
    ['git with a path', { source: 'git', url: 'https://git.example.com/m.git', path: 'sub' }, null],
    ['git with sparsePaths and a ref', { source: 'git', url: 'https://git.example.com/m.git', ref: 'x', sparsePaths: ['a'] }, null],
    ['settings', { source: 'settings', name: 'm', plugins: [] }, null],
    ['npm', { source: 'npm', package: '@acme/market' }, null],
    ['an unknown kind', { source: 'hg', url: 'https://hg.example.com/m' }, null],
    ['no kind', { repo: 'acme/market' }, null],
    ['a github source with no repo', { source: 'github' }, null],
    ['a github source with an empty repo', { source: 'github', repo: '' }, null],
    ['a ref that is not text', { source: 'github', repo: 'acme/market', ref: 7 }, null]
  ]
  it('maps every M10 shape and gives null for the rest', () => {
    const got = cases.map(([name, source]) => [name, marketplaceArg(source as MarketplaceSource)])
    expect(got).toEqual(cases.map(([name, , arg]) => [name, arg]))
  })
})
