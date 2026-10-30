// Agent Control Plane release 1 (design §4.4, D5, D11): picked items are imported once; secret values move to the
// store and nowhere else; files are copied with a stable hash; the source account is not touched; a server whose
// environment name another shared server uses with a different value is refused.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { extensionPaths } from '../profile/paths'
import { readExtensionRegistry } from './registry'
import { extensionSecrets } from './secrets'
import { entryId, importItems, removeEntry, setEnabled } from './importItems'
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

  // Gateway design §4.6: each server's values go to its own process, so two may give one name different values
  it('shares a server whose environment name another shared server gives another value', async () => {
    const s = await setup()
    await importItems({ profileDir: s.profileDir, homeDir: s.home, account: s.account, picks: [{ kind: 'mcp', name: 'linear' }] })
    const other = path.join(s.home, '.claude-accounts', 'b')
    await write(path.join(other, '.claude.json'), JSON.stringify({ mcpServers: { linear2: { command: 'x', env: { LINEAR_API_KEY: 'another_value_000000000000' } } } }))
    const b: Account = { ...s.account, id: 'acc_2', configDir: other }
    const r = await importItems({ profileDir: s.profileDir, homeDir: s.home, account: b, picks: [{ kind: 'mcp', name: 'linear2' }] })
    expect(r).toEqual({ imported: ['linear2'], refused: [] })
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

  // Lifecycle design §4.5, §4.9 and plan ruling 2: an item is not judged unused before it has been shared for the window
  it('an imported MCP server and skill carry addedAt', async () => {
    const s = await setup()
    const before = Date.now()
    await importItems({ profileDir: s.profileDir, homeDir: s.home, account: s.account, picks: [{ kind: 'mcp', name: 'linear' }, { kind: 'skill', name: 'review' }, { kind: 'command', name: 'ship' }] })
    const after = Date.now()
    const entries = (await readExtensionRegistry(s.profileDir)).entries
    expect(entries.map((e) => e.kind)).toEqual(['mcp', 'skill', 'command'])
    for (const e of entries) {
      expect(typeof e.addedAt, e.name).toBe('string')
      const at = Date.parse(e.addedAt!)
      expect(new Date(at).toISOString(), e.name).toBe(e.addedAt)
      expect(at >= before && at <= after, e.name).toBe(true)
    }
  })

  // Ruling R4-3: a server switched back on is aged from then, so it is not called unused for the days it was off
  it('setEnabled stamps enabledAt when an MCP server goes from off to on, and leaves it otherwise', async () => {
    const s = await setup()
    await importItems({ profileDir: s.profileDir, homeDir: s.home, account: s.account, picks: [{ kind: 'mcp', name: 'linear' }] })
    const read = async () => (await readExtensionRegistry(s.profileDir)).entries[0]
    const id = (await read()).id
    // On already: the switch did not move
    await setEnabled(s.profileDir, id, true)
    expect(await read()).not.toHaveProperty('enabledAt')
    await setEnabled(s.profileDir, id, false)
    expect(await read()).not.toHaveProperty('enabledAt')
    // Only the clock is faked, so the file system's own timers run as they do
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
      await setEnabled(s.profileDir, id, true)
      expect(await read()).toMatchObject({ enabled: true, enabledAt: '2026-10-01T00:00:00.000Z' })
      // setEnabled(true) on an enabled entry does not move the stamp, and switching off keeps it
      vi.setSystemTime(new Date('2026-10-05T00:00:00.000Z'))
      await setEnabled(s.profileDir, id, true)
      expect(await read()).toMatchObject({ enabledAt: '2026-10-01T00:00:00.000Z' })
      await setEnabled(s.profileDir, id, false)
      expect(await read()).toMatchObject({ enabled: false, enabledAt: '2026-10-01T00:00:00.000Z' })
      // On again: stamped anew
      vi.setSystemTime(new Date('2026-10-09T00:00:00.000Z'))
      await setEnabled(s.profileDir, id, true)
      expect(await read()).toMatchObject({ enabled: true, enabledAt: '2026-10-09T00:00:00.000Z' })
    } finally {
      vi.useRealTimers()
    }
  })
})

// Final review M1, M4, M8
describe('importItems, after the final review', () => {
  it('stores a long server\u2019s secret under a name the store takes, and keeps two similar names apart', async () => {
    const s = await setup()
    const long = 'x'.repeat(55)
    await write(path.join(s.configDir, '.claude.json'), JSON.stringify({ mcpServers: {
      [long]: { command: 'npx', env: { ATLASSIAN_API_TOKEN: SECRET } },
      'a.b': { command: 'npx' },
      a_b: { command: 'npx' }
    } }))
    const r = await importItems({ profileDir: s.profileDir, homeDir: s.home, account: s.account, picks: [{ kind: 'mcp', name: long }, { kind: 'mcp', name: 'a.b' }, { kind: 'mcp', name: 'a_b' }] })
    expect(r.imported).toEqual([long, 'a.b', 'a_b'])
    const reg = await readExtensionRegistry(s.profileDir)
    expect(new Set(reg.entries.map((e) => e.id)).size).toBe(3)
    expect(entryId('mcp', 'a.b')).not.toBe(entryId('mcp', 'a_b'))
    const e = reg.entries.find((x) => x.name === long)!
    const ref = e.kind === 'mcp' ? (e.env.ATLASSIAN_API_TOKEN as { secret: string }).secret : ''
    expect(await extensionSecrets(s.profileDir).get(ref)).toBe(SECRET)
  })

  it('keeps a self-reference as the session\u2019s own variable and refuses a reference to another name', async () => {
    const s = await setup()
    await write(path.join(s.configDir, '.claude.json'), JSON.stringify({ mcpServers: {
      self: { command: 'npx', env: { GH_HOST: '${GH_HOST}' } },
      other: { command: 'npx', env: { API_KEY: '${MY_KEY}' } }
    } }))
    const r = await importItems({ profileDir: s.profileDir, homeDir: s.home, account: s.account, picks: [{ kind: 'mcp', name: 'self' }, { kind: 'mcp', name: 'other' }] })
    expect(r).toEqual({ imported: ['self'], refused: [{ name: 'other', reason: 'env-reference' }] })
    const e = (await readExtensionRegistry(s.profileDir)).entries[0]
    expect(e.kind === 'mcp' && e.env).toEqual({ GH_HOST: { inherit: true } })
  })

  it('shares a server that sets a name another shared server passes through', async () => {
    const s = await setup()
    await write(path.join(s.configDir, '.claude.json'), JSON.stringify({ mcpServers: {
      passes: { command: 'npx', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
      sets: { command: 'npx', env: { GITHUB_TOKEN: 'ghp_other_value_00000000' } }
    } }))
    const r = await importItems({ profileDir: s.profileDir, homeDir: s.home, account: s.account, picks: [{ kind: 'mcp', name: 'passes' }, { kind: 'mcp', name: 'sets' }] })
    expect(r).toEqual({ imported: ['passes', 'sets'], refused: [] })
  })
})

// Gateway design G8, §4.6
describe('importItems, release 2', () => {
  it('marks a browser server one process per session, and shares a server needing OPENAI_API_KEY or PATH', async () => {
    const s = await setup()
    await write(path.join(s.configDir, '.claude.json'), JSON.stringify({ mcpServers: {
      browser: { command: 'npx', args: ['@playwright/mcp'] },
      llm: { command: 'npx', env: { OPENAI_API_KEY: 'sk-test-value-0000000000', PATH: 'C:/tools' } }
    } }))
    const r = await importItems({ profileDir: s.profileDir, homeDir: s.home, account: s.account, picks: [{ kind: 'mcp', name: 'browser' }, { kind: 'mcp', name: 'llm' }] })
    expect(r).toEqual({ imported: ['browser', 'llm'], refused: [] })
    const reg = await readExtensionRegistry(s.profileDir)
    const byName = Object.fromEntries(reg.entries.map((e) => [e.name, e]))
    expect(byName.browser).toMatchObject({ isolation: 'session' })
    expect(byName.llm).not.toHaveProperty('isolation')
  })
})
