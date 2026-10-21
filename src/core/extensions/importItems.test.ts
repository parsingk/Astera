// Agent Control Plane release 1 (design §4.4, D5, D11): picked items are imported once; secret values move to the
// store and nowhere else; files are copied with a stable hash; the source account is not touched; a server whose
// environment name another shared server uses with a different value is refused.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { extensionPaths } from '../profile/paths'
import { readExtensionRegistry } from './registry'
import { extensionSecrets } from './secrets'
import { importItems, removeEntry, setEnabled } from './importItems'
import type { Account } from '../types'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const temp = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-import-'))
  dirs.push(d)
  return d
}
const write = async (file: string, text: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const SECRET = 'lin_api_value_that_must_stay_in_the_store_01'

async function setup() {
  const home = await temp()
  const profileDir = await temp()
  const configDir = path.join(home, '.claude-accounts', 'a')
  await write(
    path.join(configDir, '.claude.json'),
    JSON.stringify({ mcpServers: { linear: { command: 'npx', args: ['-y', 'linear-mcp'], env: { LINEAR_API_KEY: SECRET, LOG_LEVEL: 'info' } } } })
  )
  await write(path.join(configDir, 'skills', 'review', 'SKILL.md'), '# review')
  await write(path.join(configDir, 'skills', 'review', 'ref', 'notes.md'), 'notes')
  await write(path.join(configDir, 'commands', 'ship.md'), 'ship it')
  const account: Account = { id: 'acc_1', label: 'a', configDir, color: '#888', createdAt: '2026-10-21T00:00:00.000Z', provider: 'claude' }
  return { home, profileDir, configDir, account }
}

const snapshot = async (dir: string): Promise<Record<string, string>> => {
  const out: Record<string, string> = {}
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else out[path.relative(dir, p)] = await fs.readFile(p, 'utf8')
    }
  }
  await walk(dir)
  return out
}

describe('importItems', () => {
  it('moves a secret value to the store and keeps only its name in the registry', async () => {
    const s = await setup()
    const r = await importItems({ profileDir: s.profileDir, homeDir: s.home, account: s.account, picks: [{ kind: 'mcp', name: 'linear' }] })
    expect(r).toEqual({ imported: ['linear'], refused: [] })
    const text = await fs.readFile(extensionPaths(s.profileDir).registry, 'utf8')
    expect(text).not.toContain(SECRET)
    const reg = await readExtensionRegistry(s.profileDir)
    const e = reg.entries[0]
    expect(e).toMatchObject({ kind: 'mcp', name: 'linear', command: 'npx', args: ['-y', 'linear-mcp'], importedFrom: 'acc_1', enabled: true, providers: ['claude', 'codex'] })
    if (e.kind !== 'mcp') throw new Error('mcp expected')
    expect(e.env.LOG_LEVEL).toEqual({ value: 'info' })
    const ref = e.env.LINEAR_API_KEY
    if (!('secret' in ref)) throw new Error('secret expected')
    expect(await extensionSecrets(s.profileDir).get(ref.secret)).toBe(SECRET)
  })

  it('copies skills and commands with a hash that does not change on a second import, and leaves the source alone', async () => {
    const s = await setup()
    const before = await snapshot(s.configDir)
    await importItems({ profileDir: s.profileDir, homeDir: s.home, account: s.account, picks: [{ kind: 'skill', name: 'review' }, { kind: 'command', name: 'ship' }] })
    const first = (await readExtensionRegistry(s.profileDir)).entries
    const p = extensionPaths(s.profileDir)
    expect(await fs.readFile(path.join(p.skills, 'review', 'ref', 'notes.md'), 'utf8')).toBe('notes')
    expect(await fs.readFile(path.join(p.commands, 'ship.md'), 'utf8')).toBe('ship it')
    await removeEntry(s.profileDir, first[0].id)
    await importItems({ profileDir: s.profileDir, homeDir: s.home, account: s.account, picks: [{ kind: 'skill', name: 'review' }] })
    const again = (await readExtensionRegistry(s.profileDir)).entries.find((e) => e.name === 'review')!
    expect('hash' in again && 'hash' in first[0] ? again.hash : null).toBe('hash' in first[0] ? first[0].hash : 'x')
    expect(await snapshot(s.configDir)).toEqual(before)
  })

  it('refuses a server whose environment name a shared server already gives another value', async () => {
    const s = await setup()
    await importItems({ profileDir: s.profileDir, homeDir: s.home, account: s.account, picks: [{ kind: 'mcp', name: 'linear' }] })
    const other = path.join(s.home, '.claude-accounts', 'b')
    await write(path.join(other, '.claude.json'), JSON.stringify({ mcpServers: { linear2: { command: 'x', env: { LINEAR_API_KEY: 'another_value_000000000000' } } } }))
    const b: Account = { ...s.account, id: 'acc_2', configDir: other }
    const r = await importItems({ profileDir: s.profileDir, homeDir: s.home, account: b, picks: [{ kind: 'mcp', name: 'linear2' }] })
    expect(r).toEqual({ imported: [], refused: [{ name: 'linear2', reason: 'env-name-clash' }] })
  })

  it('removeEntry deletes its secrets and canonical files; setEnabled flips one entry', async () => {
    const s = await setup()
    await importItems({ profileDir: s.profileDir, homeDir: s.home, account: s.account, picks: [{ kind: 'mcp', name: 'linear' }, { kind: 'skill', name: 'review' }] })
    const reg = await readExtensionRegistry(s.profileDir)
    const mcp = reg.entries.find((e) => e.kind === 'mcp')!
    const skill = reg.entries.find((e) => e.kind === 'skill')!
    await setEnabled(s.profileDir, skill.id, false)
    expect((await readExtensionRegistry(s.profileDir)).entries.find((e) => e.id === skill.id)?.enabled).toBe(false)
    await removeEntry(s.profileDir, mcp.id)
    await removeEntry(s.profileDir, skill.id)
    expect((await readExtensionRegistry(s.profileDir)).entries).toEqual([])
    expect(await extensionSecrets(s.profileDir).terms()).toEqual([])
    await expect(fs.stat(path.join(extensionPaths(s.profileDir).skills, 'review'))).rejects.toThrow()
  })
})
