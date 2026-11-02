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

type Entry = { name: string; source: string | object; version?: string; description?: string }
interface Layout {
  entries?: Entry[]
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
  await write(path.join(clone, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: MKT, owner: { name: 'o' }, plugins: entries }))
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

  it('a description-only change of another plugin does not', async () => {
    const entries = (other: string): Entry[] => [
      { name: 'probe', source: './probe', version: '1.0.0' },
      { name: 'other', source: './other', version: '1.0.0', description: other }
    ]
    const files = { 'probe/skills/a/SKILL.md': 'one', 'other/skills/b/SKILL.md': 'two' }
    const a = await fingerprint(await home({ entries: entries('before'), files }))
    const b = await fingerprint(await home({ entries: entries('after'), files }))
    expect(a).not.toBeNull()
    expect(b).toEqual(a)
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

  it('does not read .git, so a marketplace whose plugin is its own root keeps its fingerprint across a pull', async () => {
    const h = await home({ entries: [{ name: 'probe', source: './' }], files: { 'README.md': 'one', '.git/HEAD': 'ref: a' } })
    const before = await fingerprint(h)
    await fs.writeFile(path.join(h.clone, '.git', 'HEAD'), 'ref: b')
    await write(path.join(h.clone, '.git', 'objects', 'ab'), 'x')
    expect(await fingerprint(h)).toEqual(before)
    await fs.writeFile(path.join(h.clone, 'README.md'), 'two')
    expect((await fingerprint(h))?.fingerprint).not.toBe(before?.fingerprint)
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
