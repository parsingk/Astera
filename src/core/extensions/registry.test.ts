// Agent Control Plane release 1 (design §4.3): the shared extensions are one versioned file under the profile, written
// atomically; a damaged file is kept aside and reported, never silently reset; secret values never reach it.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { extensionPaths } from '../profile/paths'
import { readExtensionRegistry, writeExtensionRegistry, registryIsEmpty } from './registry'
import { extensionSecrets } from './secrets'
import type { ExtensionRegistry } from './types'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const profile = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-extreg-'))
  dirs.push(d)
  return d
}

const REGISTRY: ExtensionRegistry = {
  version: 1,
  entries: [
    {
      id: 'mcp-github', kind: 'mcp', name: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'],
      env: { GITHUB_TOKEN: { secret: 'mcp.mcp-github.GITHUB_TOKEN' }, LOG_LEVEL: { value: 'info' } },
      providers: ['claude', 'codex'], importedFrom: 'acc_1', enabled: true
    },
    { id: 'skill-review', kind: 'skill', name: 'review', hash: 'sha256:aa', providers: ['claude', 'codex'], importedFrom: 'acc_1', enabled: true }
  ]
}

describe('extension registry', () => {
  it('reads a missing file as an empty registry', async () => {
    const p = await profile()
    const r = await readExtensionRegistry(p)
    expect(r).toEqual({ version: 1, entries: [] })
    expect(registryIsEmpty(r)).toBe(true)
  })

  it('round-trips, and is not empty once it holds an entry', async () => {
    const p = await profile()
    await writeExtensionRegistry(p, REGISTRY)
    const r = await readExtensionRegistry(p)
    expect(r).toEqual(REGISTRY)
    expect(registryIsEmpty(r)).toBe(false)
  })

  it('keeps a damaged file aside and reports it instead of starting empty', async () => {
    const p = await profile()
    const file = extensionPaths(p).registry
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{ broken')
    await expect(readExtensionRegistry(p)).rejects.toThrow(/registry\.json/)
    expect(await fs.readFile(file, 'utf8')).toBe('{ broken')
    const kept = (await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.bak'))
    expect(kept.length).toBe(1)
  })

  it('never holds a secret value: only the secret name is written', async () => {
    const p = await profile()
    await extensionSecrets(p).put('mcp.mcp-github.GITHUB_TOKEN', 'ghp_value_that_must_not_leak_123456')
    await writeExtensionRegistry(p, REGISTRY)
    const text = await fs.readFile(extensionPaths(p).registry, 'utf8')
    expect(text).not.toContain('ghp_value_that_must_not_leak_123456')
    expect(text).toContain('mcp.mcp-github.GITHUB_TOKEN')
  })
})

describe('extension secrets', () => {
  it('puts, gets, lists terms and removes', async () => {
    const p = await profile()
    const s = extensionSecrets(p)
    await s.put('mcp.a.KEY', 'value-one')
    await s.put('mcp.b.KEY', 'value-two')
    expect(await s.get('mcp.a.KEY')).toBe('value-one')
    expect((await s.terms()).sort()).toEqual(['value-one', 'value-two'])
    await s.remove('mcp.a.KEY')
    expect(await s.get('mcp.a.KEY')).toBeNull()
  })
})
