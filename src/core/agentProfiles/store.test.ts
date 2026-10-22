// Agent Profiles design §4: a versioned file under the profile, written atomically; a damaged file is kept aside and
// reported, never read as "no profiles"; a profile needs a unique name and accounts of one provider.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../testFixtures'
import { profilePaths } from '../profile/paths'
import { RepairNeeded } from '../settings/repairNeeded'
import type { Account } from '../types'
import type { AgentProfile, AgentProfileStore } from './types'
import { readAgentProfiles, writeAgentProfiles, validateProfile, liveAccounts, findProfile, newProfileId } from './store'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const profile = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-agentprof-'))
  dirs.push(d)
  return d
}

const acc = (id: string, provider?: 'claude' | 'codex'): Account => ({
  id, label: id, configDir: `/x/${id}`, color: '#000', createdAt: '2026-01-01T00:00:00.000Z', ...(provider ? { provider } : {})
})
const ACCOUNTS = [acc('acc_c1'), acc('acc_c2', 'claude'), acc('acc_x1', 'codex')]

const P = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'ap_000000000001', name: 'Reviewer', status: 'active', accountIds: ['acc_c1'], mcpExclude: [], permission: 'inherit',
  createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', ...over
})
const input = (over: Record<string, unknown> = {}) => ({ name: 'Writer', accountIds: ['acc_c1'], ...over })

describe('agent profile store', () => {
  it('reads a missing file as an empty store', async () => {
    expect(await readAgentProfiles(await profile())).toEqual({ version: 1, profiles: [] })
  })

  it('round trips', async () => {
    const p = await profile()
    const s: AgentProfileStore = { version: 1, profiles: [P(), P({ id: 'ap_000000000002', name: 'Other', description: 'd', lastUsedAt: '2026-10-22T01:00:00.000Z' })] }
    await writeAgentProfiles(p, s)
    expect(await readAgentProfiles(p)).toEqual(s)
    expect(path.basename(profilePaths(p).agentProfiles)).toBe('agent-profiles.json')
  })

  it('keeps a damaged file aside and reports it instead of starting empty', async () => {
    const p = await profile()
    const file = profilePaths(p).agentProfiles
    await fs.writeFile(file, '{ not json')
    await expect(readAgentProfiles(p)).rejects.toBeInstanceOf(RepairNeeded)
    const kept = (await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.bak'))
    expect(kept).toHaveLength(1)
    expect(await fs.readFile(file, 'utf8')).toBe('{ not json')
  })

  // Every profiled spawn, touch and dialog open reads the store: the same damage is kept aside once, and still refused
  // every time; a different damage is kept too
  it('keeps one copy of the same damage however often it is read', async () => {
    const p = await profile()
    const file = profilePaths(p).agentProfiles
    const kept = async (): Promise<string[]> => (await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.bak'))
    await fs.writeFile(file, '{ not json')
    for (let i = 0; i < 3; i++) await expect(readAgentProfiles(p)).rejects.toBeInstanceOf(RepairNeeded)
    expect(await kept()).toHaveLength(1)
    await fs.writeFile(file, '{ "version": 2 }')
    for (let i = 0; i < 2; i++) await expect(readAgentProfiles(p)).rejects.toBeInstanceOf(RepairNeeded)
    expect(await kept()).toHaveLength(2)
  })

  // A profiled spawn reads it up to three times at once: those reads keep one copy between them too. With a copy of an
  // older damage already beside it, each copy takes a stamped name, so racing reads would each keep one
  it('keeps one copy when the same damage is read several times at once', async () => {
    const p = await profile()
    const file = profilePaths(p).agentProfiles
    await fs.writeFile(`${file}.bak`, 'an older damage')
    await fs.writeFile(file, '{ "damaged": true }')
    let t = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => ++t)
    try {
      const reads = await Promise.allSettled([readAgentProfiles(p), readAgentProfiles(p), readAgentProfiles(p)])
      expect(reads.every((r) => r.status === 'rejected' && r.reason instanceof RepairNeeded)).toBe(true)
    } finally {
      clock.mockRestore()
    }
    expect((await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.bak'))).toHaveLength(2)
  })

  it('generates ids as ap_ and 12 hex characters', () => {
    expect(newProfileId()).toMatch(/^ap_[0-9a-f]{12}$/)
  })
})

describe('validateProfile', () => {
  const others = [P()]
  const reason = (r: ReturnType<typeof validateProfile>) => (r.ok ? 'ok' : r.reason)

  it('rejects an empty or blank name', () => {
    expect(reason(validateProfile(input({ name: '' }), ACCOUNTS, others))).toBe('name-empty')
    expect(reason(validateProfile(input({ name: '   ' }), ACCOUNTS, others))).toBe('name-empty')
  })
  it('rejects a name longer than 60 characters', () => {
    expect(reason(validateProfile(input({ name: 'x'.repeat(61) }), ACCOUNTS, others))).toBe('name-too-long')
    expect(reason(validateProfile(input({ name: '  ' + 'x'.repeat(60) + '  ' }), ACCOUNTS, others))).toBe('ok')
  })
  it('rejects a name another profile has in any case', () => {
    expect(reason(validateProfile(input({ name: 'reviewer' }), ACCOUNTS, others))).toBe('name-taken')
  })
  it('rejects no accounts and an unknown account', () => {
    expect(reason(validateProfile(input({ accountIds: [] }), ACCOUNTS, others))).toBe('no-account')
    expect(reason(validateProfile(input({ accountIds: ['acc_gone'] }), ACCOUNTS, others))).toBe('unknown-account')
  })
  it('rejects accounts of two providers', () => {
    expect(reason(validateProfile(input({ accountIds: ['acc_c1', 'acc_x1'] }), ACCOUNTS, others))).toBe('mixed-provider')
  })
  it('accepts one name of at most 60 characters, trimmed, and fills the defaults', () => {
    const name = 'y'.repeat(60)
    const r = validateProfile(input({ name: `  ${name}  `, accountIds: ['acc_c1', 'acc_c2'] }), ACCOUNTS, others)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.profile.name).toBe(name)
    expect(r.profile.id).toMatch(/^ap_[0-9a-f]{12}$/)
    expect(r.profile).toMatchObject({ status: 'active', accountIds: ['acc_c1', 'acc_c2'], mcpExclude: [], permission: 'inherit' })
  })
  it('lets a profile keep its own name when it is not among others', () => {
    expect(validateProfile(input({ name: 'Reviewer' }), ACCOUNTS, [])).toMatchObject({ ok: true })
  })
})

describe('liveAccounts and findProfile', () => {
  it('drops an account that is no longer there and keeps the order', () => {
    expect(liveAccounts(P({ accountIds: ['acc_c2', 'acc_gone', 'acc_c1'] }), ACCOUNTS)).toEqual(['acc_c2', 'acc_c1'])
  })
  it('finds by id, else by name in any case', () => {
    const s: AgentProfileStore = { version: 1, profiles: [P(), P({ id: 'ap_000000000002', name: 'Writer' })] }
    expect(findProfile(s, 'ap_000000000002')?.name).toBe('Writer')
    expect(findProfile(s, 'REVIEWER')?.id).toBe('ap_000000000001')
    expect(findProfile(s, 'nobody')).toBeNull()
  })
})
