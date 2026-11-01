// Remote governance design §5.2, §5.3: this machine's shared extensions as the Runtime report gives them, names and
// states only, never a launch definition, an env value or a Gateway error.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { extensionPaths } from '../profile/paths'
import { writeExtensionRegistry } from '../extensions/registry'
import { compareHashTree } from '../extensions/compareHash'
import type { ExtensionEntry } from '../extensions/types'
import { localReportExtensions } from './local'

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) await removeFixture(d)
})

const ENTRIES: ExtensionEntry[] = [
  {
    id: 'mcp_1',
    kind: 'mcp',
    name: 'tracker',
    transport: 'stdio',
    command: 'tracker-server-bin',
    args: ['--root', 'secret-arg-value'],
    env: { TRACKER_TOKEN: { secret: 'mcp_1.TRACKER_TOKEN' }, TRACKER_REGION: { value: 'plain-region-value' }, HOME: { inherit: true } },
    providers: ['claude', 'codex'],
    importedFrom: 'acc1',
    enabled: true
  },
  { id: 'sk_1', kind: 'skill', name: 'review', hash: 'sha256:aa', providers: ['claude', 'codex'], importedFrom: 'acc1', enabled: true },
  { id: 'cm_1', kind: 'command', name: 'ship', hash: 'sha256:bb', providers: ['claude'], importedFrom: 'acc1', enabled: false }
]

async function profile(entries: ExtensionEntry[] = ENTRIES): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-local-'))
  dirs.push(d)
  await writeExtensionRegistry(d, { version: 1, entries })
  return d
}

describe('localReportExtensions (remote governance design §5.2)', () => {
  it('entries carry ids, kinds, names, enabled and providers, and nothing of the launch definition', async () => {
    const d = await profile()
    const out = await localReportExtensions(d)
    expect(out.map((e) => [e.id, e.kind, e.name, e.enabled, e.providers])).toEqual([
      ['mcp_1', 'mcp', 'tracker', true, ['claude', 'codex']],
      ['sk_1', 'skill', 'review', true, ['claude', 'codex']],
      ['cm_1', 'command', 'ship', false, ['claude']]
    ])
    const text = JSON.stringify(out)
    for (const leak of ['tracker-server-bin', '--root', 'secret-arg-value', 'plain-region-value', 'mcp_1.TRACKER_TOKEN', 'acc1', 'sha256:aa', 'stdio'])
      expect(text, leak).not.toContain(leak)
  })

  it('a skill carries its comparison hash; a missing canonical copy leaves it out', async () => {
    const d = await profile()
    const skill = path.join(extensionPaths(d).skills, 'review')
    await fs.mkdir(skill, { recursive: true })
    await fs.writeFile(path.join(skill, 'SKILL.md'), '# review\r\n')
    const out = await localReportExtensions(d)
    expect(out.find((e) => e.id === 'sk_1')?.compareHash).toBe(await compareHashTree(skill))
    // The command's canonical copy was never written
    expect(out.find((e) => e.id === 'cm_1')).not.toHaveProperty('compareHash')
    expect(out.find((e) => e.id === 'mcp_1')).not.toHaveProperty('compareHash')
  })

  it('an MCP server carries the env names of its secrets only, and its Gateway state when the Gateway holds one', async () => {
    const d = await profile()
    const lastError = 'spawn tracker-server-bin ENOENT at /srv/secret/path'
    const out = await localReportExtensions(d, [{ serverId: 'mcp_1', processes: 0, state: 'failed', lastError }])
    const mcp = out.find((e) => e.id === 'mcp_1')
    expect(mcp?.secretNames).toEqual(['TRACKER_TOKEN'])
    expect(mcp?.gateway).toBe('failed')
    expect(JSON.stringify(out)).not.toContain(lastError)
    expect(JSON.stringify(out)).not.toContain('ENOENT')
    // No state held: the field is absent
    expect((await localReportExtensions(d, [])).find((e) => e.id === 'mcp_1')).not.toHaveProperty('gateway')
    // Skills never carry secret names
    expect(out.find((e) => e.id === 'sk_1')).not.toHaveProperty('secretNames')
  })

  it('a registry that cannot be read throws', async () => {
    const d = await profile()
    await fs.writeFile(extensionPaths(d).registry, '{ not json')
    await expect(localReportExtensions(d)).rejects.toThrow()
  })
})

// Ruling R9-2: a report asked again and again does not read every skill again, nor all of them at once
describe('localReportExtensions hashing', () => {
  const skill = (name: string): ExtensionEntry => ({ id: `sk_${name}`, kind: 'skill', name, hash: 'sha256:x', providers: ['claude'], importedFrom: 'acc1', enabled: true })
  const readsUnder = (spy: { mock: { calls: unknown[][] } }, dir: string): number => spy.mock.calls.filter((c) => String(c[0]).startsWith(dir)).length

  it('an unchanged tree is not read again, and a changed file is', async () => {
    const d = await profile([skill('review')])
    const root = path.join(extensionPaths(d).skills, 'review')
    await fs.mkdir(path.join(root, 'refs'), { recursive: true })
    await fs.writeFile(path.join(root, 'SKILL.md'), '# review\n')
    await fs.writeFile(path.join(root, 'refs', 'a.md'), 'a')
    const first = (await localReportExtensions(d))[0].compareHash
    const reads = vi.spyOn(fs, 'readFile')
    expect((await localReportExtensions(d))[0].compareHash).toBe(first)
    expect(readsUnder(reads, extensionPaths(d).skills)).toBe(0)
    // An OS metadata file beside it changes neither the stamp nor the hash, as compareHash leaves it out
    await fs.writeFile(path.join(root, '.DS_Store'), 'junk')
    expect((await localReportExtensions(d))[0].compareHash).toBe(first)
    expect(readsUnder(reads, extensionPaths(d).skills)).toBe(0)
    // A changed file is read again, and the hash follows it
    await fs.writeFile(path.join(root, 'refs', 'a.md'), 'a changed')
    const changed = (await localReportExtensions(d))[0].compareHash
    expect(changed).not.toBe(first)
    expect(changed).toBe(await compareHashTree(root))
    expect(readsUnder(reads, extensionPaths(d).skills)).toBeGreaterThan(0)
  })

  it('hashes at most 8 entries at a time', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `s${i}`)
    const d = await profile(names.map(skill))
    for (const n of names) {
      await fs.mkdir(path.join(extensionPaths(d).skills, n), { recursive: true })
      await fs.writeFile(path.join(extensionPaths(d).skills, n, 'SKILL.md'), n)
    }
    const real = fs.readdir.bind(fs)
    let open = 0
    let most = 0
    vi.spyOn(fs, 'readdir').mockImplementation((async (...a: Parameters<typeof fs.readdir>) => {
      open++
      most = Math.max(most, open)
      try {
        await new Promise((r) => setTimeout(r, 5))
        return await (real as (...x: unknown[]) => Promise<unknown>)(...a)
      } finally {
        open--
      }
    }) as never)
    const out = await localReportExtensions(d)
    expect(out.every((e) => e.compareHash?.startsWith('cmp1:sha256:'))).toBe(true)
    expect(most).toBeGreaterThan(1)
    expect(most).toBeLessThanOrEqual(8)
  })
})
