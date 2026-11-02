// Shared Claude Code plugins live in a store of their own beside the extension registry, so an older build that reads
// the registry never meets a plugin. The Host alone writes it, one change at a time; a damaged file is kept aside and
// reported, never taken for "nothing shared", and a store that cannot be read counts as shared.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../testFixtures'
import { extensionPaths } from '../../profile/paths'
import { RepairNeeded } from '../../settings/repairNeeded'
import { readClaudePlugins, updateClaudePlugins, claudePluginsShared } from './store'
import type { SharedClaudePlugin } from './types'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const profile = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-claudeplugins-'))
  dirs.push(d)
  return d
}

const plugin = (name: string): SharedClaudePlugin => ({
  id: `${name}@market`,
  name,
  marketplace: 'market',
  source: { source: 'github', repo: 'acme/market' },
  version: '1.0.0',
  installPath: path.join('plugins', 'cache', 'market', name, '1.0.0'),
  dependencies: [],
  importedFrom: 'acc_1',
  enabled: true,
  addedAt: '2026-11-02T00:00:00.000Z',
  lastUpdated: '2026-11-02T00:00:00.000Z',
  fingerprint: 'sha256:aa'
})

const damage = async (p: string): Promise<string> => {
  const file = extensionPaths(p).claudePlugins
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, '{ broken')
  return file
}

describe('shared Claude Code plugin store', () => {
  it('reads a missing store as empty', async () => {
    const p = await profile()
    expect(await readClaudePlugins(p)).toEqual({ version: 1, plugins: [] })
  })

  it('round-trips an entry through updateClaudePlugins', async () => {
    const p = await profile()
    const entry: SharedClaudePlugin = {
      ...plugin('review'),
      source: { source: 'git', url: 'https://git.example/market.git', ref: 'main' },
      dependencies: [{ id: 'base@market', version: '2.1.0', installPath: path.join('plugins', 'cache', 'market', 'base', '2.1.0') }],
      enabledAt: '2026-11-02T01:00:00.000Z',
      update: { version: '1.1.0', fingerprint: 'sha256:bb', checkedAt: '2026-11-02T02:00:00.000Z' }
    }
    const written = await updateClaudePlugins(p, (s) => ({ ...s, plugins: [...s.plugins, entry], lastCheck: { at: '2026-11-02T02:00:00.000Z' } }))
    const expected = { version: 1, plugins: [entry], lastCheck: { at: '2026-11-02T02:00:00.000Z' } }
    expect(written).toEqual(expected)
    expect(await readClaudePlugins(p)).toEqual(expected)
    expect((await fs.readFile(extensionPaths(p).claudePlugins, 'utf8')).endsWith('}\n')).toBe(true)
  })

  it('gives the update the store as it was read, and accepts an async update', async () => {
    const p = await profile()
    await updateClaudePlugins(p, (s) => ({ ...s, plugins: [plugin('a')] }))
    let seen: string[] = []
    await updateClaudePlugins(p, async (s) => {
      seen = s.plugins.map((e) => e.name)
      await new Promise((r) => setTimeout(r, 5))
      return { ...s, plugins: [...s.plugins, plugin('b')] }
    })
    expect(seen).toEqual(['a'])
    expect((await readClaudePlugins(p)).plugins.map((e) => e.name)).toEqual(['a', 'b'])
  })

  it('serialises concurrent updates', async () => {
    const p = await profile()
    // Each update reads, waits, then pushes: without a lock the later write would drop the earlier entry.
    const add = (name: string, ms: number): Promise<unknown> =>
      updateClaudePlugins(p, async (s) => {
        await new Promise((r) => setTimeout(r, ms))
        return { ...s, plugins: [...s.plugins, plugin(name)] }
      })
    await Promise.all([add('slow', 40), add('fast', 0), add('third', 10)])
    expect((await readClaudePlugins(p)).plugins.map((e) => e.name)).toEqual(['slow', 'fast', 'third'])
  })

  it('writes nothing when the update throws, and the next update still runs', async () => {
    const p = await profile()
    await updateClaudePlugins(p, (s) => ({ ...s, plugins: [plugin('kept')] }))
    await expect(
      updateClaudePlugins(p, () => {
        throw new Error('the update failed')
      })
    ).rejects.toThrow('the update failed')
    expect((await readClaudePlugins(p)).plugins.map((e) => e.name)).toEqual(['kept'])
    await updateClaudePlugins(p, (s) => ({ ...s, plugins: [...s.plugins, plugin('after')] }))
    expect((await readClaudePlugins(p)).plugins.map((e) => e.name)).toEqual(['kept', 'after'])
  })

  it('keeps a damaged store as .bak and throws RepairNeeded', async () => {
    const p = await profile()
    const file = await damage(p)
    const err = await readClaudePlugins(p).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RepairNeeded)
    expect((err as RepairNeeded).file).toBe(path.join('extensions', 'claude-plugins.json'))
    expect(await fs.readFile(file, 'utf8')).toBe('{ broken')
    const kept = (await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.bak'))
    expect(kept.length).toBe(1)
    expect(await fs.readFile(path.join(path.dirname(file), kept[0]), 'utf8')).toBe('{ broken')
  })

  it('refuses an update on a damaged store and leaves the file as it is', async () => {
    const p = await profile()
    const file = await damage(p)
    await expect(updateClaudePlugins(p, (s) => ({ ...s, plugins: [plugin('x')] }))).rejects.toBeInstanceOf(RepairNeeded)
    expect(await fs.readFile(file, 'utf8')).toBe('{ broken')
  })

  it('takes a store of another shape for damaged', async () => {
    const p = await profile()
    const file = extensionPaths(p).claudePlugins
    await fs.mkdir(path.dirname(file), { recursive: true })
    for (const text of ['{"version":2,"plugins":[]}', '{"version":1}', '{"version":1,"plugins":{}}', 'null', '[]']) {
      await fs.writeFile(file, text)
      await expect(readClaudePlugins(p, { keepDamaged: false })).rejects.toBeInstanceOf(RepairNeeded)
    }
  })

  it('claudePluginsShared is false when empty, true with an entry, true when damaged', async () => {
    const p = await profile()
    expect(await claudePluginsShared(p)).toBe(false)
    await updateClaudePlugins(p, (s) => ({ ...s, plugins: [plugin('one')] }))
    expect(await claudePluginsShared(p)).toBe(true)
    const file = await damage(p)
    expect(await claudePluginsShared(p)).toBe(true)
    // A question asked of the store writes nothing: the copy of the damage is the Host's own reading's to keep.
    expect(await fs.readFile(file, 'utf8')).toBe('{ broken')
    expect((await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.bak'))).toEqual([])
  })

  it('claudePluginsShared is false for a store that was emptied again', async () => {
    const p = await profile()
    await updateClaudePlugins(p, (s) => ({ ...s, plugins: [plugin('one')] }))
    await updateClaudePlugins(p, (s) => ({ ...s, plugins: [] }))
    expect(await claudePluginsShared(p)).toBe(false)
  })

  it('extensionPaths names the store and the home under extensions/', () => {
    const p = path.join(path.parse(process.cwd()).root, 'profile')
    const paths = extensionPaths(p)
    expect(paths.claudePlugins).toBe(path.join(p, 'extensions', 'claude-plugins.json'))
    expect(paths.claudePluginHome).toBe(path.join(p, 'extensions', 'claude-plugins'))
  })
})
