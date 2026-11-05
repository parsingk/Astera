// The fingerprint of a shared plugin's catalog entry in Astera's own config folder (the "home"), which is how an update
// is found: the CLI has no "update available" output, so the entry is fingerprinted at install and again after
// `claude plugin marketplace update`. Homes here are temp folders with hand-written files.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../testFixtures'
import { catalogFingerprint } from './catalog'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const temp = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-claudeplugin-catalog-'))
  dirs.push(d)
  return d
}
const write = async (file: string, text: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

type Entry = { name: string; source: string | object; version?: string; description?: string; [field: string]: unknown }
interface Layout {
  entries?: Entry[]
  /** The catalog's `metadata` (where `pluginRoot` is). */
  metadata?: unknown
  /** Files under the marketplace folder, keyed by their path relative to it. */
  files?: Record<string, string>
}

const MKT = 'probe-mkt'

/** A home whose `known_marketplaces.json` points at a marketplace clone holding what `layout` says. */
const home = async (layout: Layout = {}): Promise<{ home: string; clone: string }> => {
  const root = await temp()
  const homeDir = path.join(root, 'home')
  const clone = path.join(homeDir, 'plugins', 'marketplaces', MKT)
  await write(
    path.join(homeDir, 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ [MKT]: { source: { source: 'github', repo: 'o/r' }, installLocation: clone, lastUpdated: '2026-11-02T00:00:00.000Z' } })
  )
  const entries = layout.entries ?? [{ name: 'probe', source: './probe', version: '1.0.0' }]
  await write(path.join(clone, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: MKT, owner: { name: 'o' }, metadata: layout.metadata, plugins: entries }))
  for (const [rel, text] of Object.entries(layout.files ?? { 'probe/skills/a/SKILL.md': 'one' })) await write(path.join(clone, rel), text)
  return { home: homeDir, clone }
}

const fingerprint = async (h: { home: string }, name = 'probe') => catalogFingerprint({ home: h.home, marketplace: MKT, name })

describe('catalogFingerprint', () => {
  it('same catalog gives the same fingerprint', async () => {
    const a = await home()
    const first = await fingerprint(a)
    expect(first?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await fingerprint(a)).toEqual(first)
    // the same content somewhere else is the same catalog: a relative plugin's digest does not depend on where it sits
    expect(await fingerprint(await home())).toEqual(first)
  })

  it('a changed file in a relative plugin folder changes it', async () => {
    const h = await home()
    const before = await fingerprint(h)
    await fs.writeFile(path.join(h.clone, 'probe', 'skills', 'a', 'SKILL.md'), 'two')
    const edited = await fingerprint(h)
    expect(edited?.fingerprint).not.toBe(before?.fingerprint)
    await write(path.join(h.clone, 'probe', 'hooks', 'hooks.json'), '{}')
    expect((await fingerprint(h))?.fingerprint).not.toBe(edited?.fingerprint)
  })

  it('a changed entry version changes it', async () => {
    const entry = (version: string): Entry => ({ name: 'probe', source: './probe', version })
    const a = await fingerprint(await home({ entries: [entry('1.0.0')] }))
    const b = await fingerprint(await home({ entries: [entry('1.0.1')] }))
    expect(b?.fingerprint).not.toBe(a?.fingerprint)
  })

  it('a changed source changes it, including the sha an object source pins', async () => {
    const source = (sha: string) => ({ source: 'git-subdir', url: 'https://example.invalid/r.git', path: 'plugins/p', sha })
    const a = await fingerprint(await home({ entries: [{ name: 'probe', source: source('aaa') }], files: {} }))
    const same = await fingerprint(await home({ entries: [{ name: 'probe', source: source('aaa') }], files: {} }))
    const b = await fingerprint(await home({ entries: [{ name: 'probe', source: source('bbb') }], files: {} }))
    expect(a).not.toBeNull()
    expect(same).toEqual(a)
    expect(b?.fingerprint).not.toBe(a?.fingerprint)
  })

  it('does not depend on the order of the keys in the entry', async () => {
    const a = await fingerprint(await home({ entries: [{ name: 'probe', source: { source: 'url', url: 'https://x.invalid/r.git' }, version: '1' }], files: {} }))
    const b = await fingerprint(await home({ entries: [{ version: '1', source: { url: 'https://x.invalid/r.git', source: 'url' }, name: 'probe' }], files: {} }))
    expect(b).toEqual(a)
  })

  it('a description-only change of another plugin does not, nor one of the plugin itself', async () => {
    const entries = (own: string, other: string): Entry[] => [
      { name: 'probe', source: './probe', version: '1.0.0', description: own },
      { name: 'other', source: './other', version: '1.0.0', description: other }
    ]
    const files = { 'probe/skills/a/SKILL.md': 'one', 'other/skills/b/SKILL.md': 'two' }
    const a = await fingerprint(await home({ entries: entries('own before', 'other before'), files }))
    expect(a).not.toBeNull()
    expect(await fingerprint(await home({ entries: entries('own before', 'other after'), files }))).toEqual(a)
    expect(await fingerprint(await home({ entries: entries('own after', 'other before'), files }))).toEqual(a)
    // a description that is not there at all is the same
    expect(await fingerprint(await home({ entries: [{ name: 'probe', source: './probe', version: '1.0.0' }], files }))).toEqual(a)
  })

  it('a changed hooks field in the entry changes it', async () => {
    const entry = (hooks: object | undefined): Entry => ({ name: 'probe', source: './probe', strict: false, hooks })
    const hook = (command: string) => ({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] })
    const a = await fingerprint(await home({ entries: [entry(hook('echo one'))] }))
    expect(await fingerprint(await home({ entries: [entry(hook('echo one'))] }))).toEqual(a)
    expect((await fingerprint(await home({ entries: [entry(hook('echo two'))] })))?.fingerprint).not.toBe(a?.fingerprint)
    expect((await fingerprint(await home({ entries: [entry(undefined)] })))?.fingerprint).not.toBe(a?.fingerprint)
  })

  it('any other field of the entry counts too', async () => {
    const entry = (extra: object): Entry => ({ name: 'probe', source: './probe', ...extra })
    const a = await fingerprint(await home({ entries: [entry({ mcpServers: { s: { command: 'a' } } })] }))
    expect((await fingerprint(await home({ entries: [entry({ mcpServers: { s: { command: 'b' } } })] })))?.fingerprint).not.toBe(a?.fingerprint)
    expect((await fingerprint(await home({ entries: [entry({ commands: ['./c.md'] })] })))?.fingerprint).not.toBe(a?.fingerprint)
  })

  it('a change in the folder of another plugin does not either', async () => {
    const entries: Entry[] = [
      { name: 'probe', source: './probe' },
      { name: 'other', source: './other' }
    ]
    const h = await home({ entries, files: { 'probe/a.md': 'one', 'other/b.md': 'two' } })
    const before = await fingerprint(h)
    await fs.writeFile(path.join(h.clone, 'other', 'b.md'), 'three')
    expect(await fingerprint(h)).toEqual(before)
  })

  describe('line endings', () => {
    const NUL = String.fromCharCode(0)
    const text = { 'probe/skills/a/SKILL.md': 'one\ntwo\n', 'probe/hooks/hooks.json': '{\n  "a": 1\n}\n' }
    const crlf = (files: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.replace(/\n/g, '\r\n')]))

    // `claude plugin marketplace add` clones with git, which on Windows writes text files with CRLF; the first `marketplace
    // update` replaces the clone with a download of the same commit, with LF
    it('the same tree with CRLF and LF text files gives the same fingerprint', async () => {
      const lf = await fingerprint(await home({ files: text }))
      expect(lf).not.toBeNull()
      expect(await fingerprint(await home({ files: crlf(text) }))).toEqual(lf)
      // a real change in a CRLF tree still counts, and so does a lone CR, which is not a line ending of either kind
      expect((await fingerprint(await home({ files: crlf({ ...text, 'probe/skills/a/SKILL.md': 'one\ntwo changed\n' }) })))?.fingerprint).not.toBe(lf?.fingerprint)
      const joined = await fingerprint(await home({ files: { ...text, 'probe/skills/a/SKILL.md': 'onetwo\n' } }))
      expect((await fingerprint(await home({ files: { ...text, 'probe/skills/a/SKILL.md': 'one\rtwo\n' } })))?.fingerprint).not.toBe(joined?.fingerprint)
    })

    it("a binary file's bytes still count as they are", async () => {
      const binary = (body: string) => ({ ...text, 'probe/assets/icon.bin': `a${NUL}b${body}c` })
      const lf = await fingerprint(await home({ files: binary('\n') }))
      expect((await fingerprint(await home({ files: binary('\r\n') })))?.fingerprint).not.toBe(lf?.fingerprint)
      expect(await fingerprint(await home({ files: binary('\n') }))).toEqual(lf)
    })

    // git's rule, the one the Runtime comparison hash uses too (compareHash.ts): only the first 8000 bytes are looked at
    it('a NUL byte after the first 8000 bytes does not make a file binary', async () => {
      const late = (body: string) => ({ ...text, 'probe/assets/big.dat': `${'x'.repeat(9000)}${NUL}${body}` })
      const lf = await fingerprint(await home({ files: late('\n') }))
      expect(await fingerprint(await home({ files: late('\r\n') }))).toEqual(lf)
    })
  })

  it('does not read .git, so a marketplace whose plugin is its own root keeps its fingerprint across a pull', async () => {
    const h = await home({ entries: [{ name: 'probe', source: './' }], files: { 'README.md': 'one', '.git/HEAD': 'ref: a' } })
    const before = await fingerprint(h)
    await fs.writeFile(path.join(h.clone, '.git', 'HEAD'), 'ref: b')
    await write(path.join(h.clone, '.git', 'objects', 'ab'), 'x')
    expect(await fingerprint(h)).toEqual(before)
    await fs.writeFile(path.join(h.clone, 'README.md'), 'two')
    expect((await fingerprint(h))?.fingerprint).not.toBe(before?.fingerprint)
  })

  describe('a bare source (a name, not ./ or ../)', () => {
    const entries: Entry[] = [{ name: 'probe', source: 'probe', version: '1.0.0' }]
    const under = { pluginRoot: './plugins' }
    const files = {
      'plugins/probe/skills/a/SKILL.md': 'one',
      'plugins/probe/.claude-plugin/plugin.json': JSON.stringify({ name: 'probe', version: '2.0.0' }),
      // a folder of the same name at the root of the marketplace is not the plugin
      'probe/skills/a/SKILL.md': 'decoy'
    }

    it('resolves under metadata.pluginRoot', async () => {
      const h = await home({ entries, metadata: under, files })
      const before = await fingerprint(h)
      expect(before?.offeredVersion).toBe('2.0.0')
      await fs.writeFile(path.join(h.clone, 'probe', 'skills', 'a', 'SKILL.md'), 'decoy changed')
      expect(await fingerprint(h)).toEqual(before)
      await fs.writeFile(path.join(h.clone, 'plugins', 'probe', 'skills', 'a', 'SKILL.md'), 'two')
      expect((await fingerprint(h))?.fingerprint).not.toBe(before?.fingerprint)
    })

    it('gives null without a pluginRoot, though a folder of that name is at the root', async () => {
      expect(await fingerprint(await home({ entries, files }))).toBeNull()
      expect(await fingerprint(await home({ entries, files, metadata: {} }))).toBeNull()
      expect(await fingerprint(await home({ entries, files, metadata: { pluginRoot: '' } }))).toBeNull()
      expect(await fingerprint(await home({ entries, files, metadata: { pluginRoot: 7 } }))).toBeNull()
    })

    it('gives null when pluginRoot, or the name under it, leaves the marketplace folder', async () => {
      expect(await fingerprint(await home({ entries, files, metadata: { pluginRoot: '../elsewhere' } }))).toBeNull()
      expect(await fingerprint(await home({ entries: [{ name: 'probe', source: 'a/../../../x' }], files, metadata: under }))).toBeNull()
      // a root outside is refused even when the name climbs back into a folder of the marketplace
      const inside = [{ name: 'probe', source: 'y/../../plugins/probe' }]
      expect(await fingerprint(await home({ entries: inside, files, metadata: { pluginRoot: './x' } }))).not.toBeNull()
      const back = [{ name: 'probe', source: `y/../../${MKT}/plugins/probe` }]
      expect(await fingerprint(await home({ entries: back, files, metadata: { pluginRoot: '../x' } }))).toBeNull()
    })

    it('leaves a ./ source alone: pluginRoot does not apply to it', async () => {
      const h = await home({ entries: [{ name: 'probe', source: './probe' }], metadata: under, files })
      const before = await fingerprint(h)
      await fs.writeFile(path.join(h.clone, 'plugins', 'probe', 'skills', 'a', 'SKILL.md'), 'two')
      expect(await fingerprint(h)).toEqual(before)
      await fs.writeFile(path.join(h.clone, 'probe', 'skills', 'a', 'SKILL.md'), 'decoy changed')
      expect((await fingerprint(h))?.fingerprint).not.toBe(before?.fingerprint)
    })
  })

  describe('offeredVersion', () => {
    it('prefers the folder manifest', async () => {
      const h = await home({
        entries: [{ name: 'probe', source: './probe', version: '1.0.0' }],
        files: { 'probe/.claude-plugin/plugin.json': JSON.stringify({ name: 'probe', version: '2.0.0' }) }
      })
      expect((await fingerprint(h))?.offeredVersion).toBe('2.0.0')
    })

    it('falls back to the entry version when the folder manifest has none, is damaged or is missing', async () => {
      const entries: Entry[] = [{ name: 'probe', source: './probe', version: '1.0.0' }]
      const layouts: Record<string, string>[] = [
        { 'probe/.claude-plugin/plugin.json': JSON.stringify({ name: 'probe' }) },
        { 'probe/.claude-plugin/plugin.json': '{ not json' },
        { 'probe/skills/a/SKILL.md': 'one' }
      ]
      for (const files of layouts) {
        expect((await fingerprint(await home({ entries, files })))?.offeredVersion).toBe('1.0.0')
      }
    })

    it('is the entry version for a source that is not a folder of the marketplace, and null when there is none', async () => {
      const source = { source: 'url', url: 'https://x.invalid/r.git' }
      expect((await fingerprint(await home({ entries: [{ name: 'probe', source, version: '3.1.0' }], files: {} })))?.offeredVersion).toBe('3.1.0')
      expect((await fingerprint(await home({ entries: [{ name: 'probe', source }], files: {} })))?.offeredVersion).toBeNull()
      expect((await fingerprint(await home({ entries: [{ name: 'probe', source: './probe' }] })))?.offeredVersion).toBeNull()
    })
  })

  describe('null', () => {
    it('when the marketplace is unknown', async () => {
      const h = await home()
      expect(await catalogFingerprint({ home: h.home, marketplace: 'no-such-mkt', name: 'probe' })).toBeNull()
    })

    it('when the home has no known_marketplaces.json, or it is damaged', async () => {
      const root = await temp()
      expect(await catalogFingerprint({ home: path.join(root, 'empty'), marketplace: MKT, name: 'probe' })).toBeNull()
      const h = await home()
      await fs.writeFile(path.join(h.home, 'plugins', 'known_marketplaces.json'), '{ not json')
      expect(await fingerprint(h)).toBeNull()
    })

    it('when the catalog is missing or damaged', async () => {
      const h = await home()
      await fs.writeFile(path.join(h.clone, '.claude-plugin', 'marketplace.json'), '{ not json')
      expect(await fingerprint(h)).toBeNull()
      await fs.rm(path.join(h.clone, '.claude-plugin', 'marketplace.json'))
      expect(await fingerprint(h)).toBeNull()
    })

    it('when the catalog has no such plugin', async () => {
      const h = await home()
      expect(await fingerprint(h, 'other')).toBeNull()
    })

    it('when the folder of a relative source is missing', async () => {
      const h = await home({ files: { 'unrelated.md': 'x' } })
      expect(await fingerprint(h)).toBeNull()
    })

    it('when a relative source leaves the marketplace folder', async () => {
      const h = await home({ entries: [{ name: 'probe', source: '../../..' }] })
      expect(await fingerprint(h)).toBeNull()
    })
  })
})
