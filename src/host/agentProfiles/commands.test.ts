// Agent Profiles (design §4): the Host's agent-profiles commands. For the app and the CLI only, changes refused to an
// agent's shell, and a profile held by something live is never deleted from under it.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../core/testFixtures'
import { profilePaths } from '../../core/profile/paths'
import { readAgentProfiles } from '../../core/agentProfiles/store'
import { createHostAgentProfiles } from './commands'
import type { Account } from '../../core/types'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})

async function rig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-host-ap-'))
  dirs.push(root)
  const profileDir = path.join(root, 'profile')
  const acc = (id: string, provider: 'claude' | 'codex'): Account => ({ id, label: id, configDir: path.join(root, id), color: '#888', createdAt: '2026-10-22T00:00:00.000Z', provider })
  let accounts = [acc('acc_1', 'claude'), acc('acc_2', 'claude'), acc('acc_x', 'codex')]
  const held = new Set<string>()
  let clock = Date.parse('2026-10-22T10:00:00.000Z')
  const logs: string[] = []
  const hub = createHostAgentProfiles({
    profileDir,
    readAccounts: async () => accounts,
    inUse: async (id) => held.has(id),
    now: () => clock,
    log: (l) => logs.push(l)
  })
  const call = (cmd: string, args: Record<string, unknown> = {}, extra: { role?: 'app' | 'cli' | 'mcp' | 'agent'; agentRefusal?: string } = {}) => {
    const marks = { effects: 0 }
    return hub
      .command({ cmd, args, role: (extra.role ?? 'app') as 'app', ...(extra.agentRefusal ? { agentRefusal: extra.agentRefusal } : {}), marks })
      .then((r) => ({ ...r, marks }))
  }
  return {
    profileDir,
    call,
    held,
    logs,
    setAccounts: (a: Account[]) => (accounts = a),
    accounts: () => accounts,
    advance: (ms: number) => (clock += ms)
  }
}

const profileOf = (r: { body: unknown }) => (r.body as { profile: Record<string, unknown> }).profile

describe('createHostAgentProfiles', () => {
  it('creates, lists, gets, updates, archives and restores a profile', async () => {
    const h = await rig()
    const created = await h.call('agent-profiles-create', { name: 'Reviewer', description: 'reads diffs', accountIds: ['acc_1'], mcpExclude: ['mcp-linear'], permission: 'ask' })
    expect(created.status).toBe(200)
    expect(created.marks.effects).toBe(1)
    const p = profileOf(created)
    expect(p).toMatchObject({ name: 'Reviewer', description: 'reads diffs', status: 'active', accountIds: ['acc_1'], mcpExclude: ['mcp-linear'], permission: 'ask' })
    expect(p.id).toMatch(/^ap_[0-9a-f]{12}$/)

    expect((await h.call('agent-profiles-list')).body).toMatchObject({ profiles: [{ id: p.id }] })
    expect(profileOf(await h.call('agent-profiles-get', { idOrName: p.id }))).toMatchObject({ name: 'Reviewer' })
    expect(profileOf(await h.call('agent-profiles-get', { idOrName: 'reviewer' }))).toMatchObject({ id: p.id })

    h.advance(1000)
    const updated = await h.call('agent-profiles-update', { id: p.id, name: 'Reviewer 2', accountIds: ['acc_1', 'acc_2'] })
    expect(updated.status).toBe(200)
    expect(updated.marks.effects).toBe(1)
    expect(profileOf(updated)).toMatchObject({ id: p.id, name: 'Reviewer 2', description: 'reads diffs', accountIds: ['acc_1', 'acc_2'], permission: 'ask', createdAt: p.createdAt })
    expect(profileOf(updated).updatedAt).not.toBe(p.updatedAt)

    expect(profileOf(await h.call('agent-profiles-archive', { id: p.id }))).toMatchObject({ status: 'archived' })
    expect(profileOf(await h.call('agent-profiles-restore', { id: p.id }))).toMatchObject({ status: 'active' })
    expect((await h.call('agent-profiles-get', { idOrName: 'nobody' })).status).toBe(404)
    expect((await h.call('agent-profiles-update', { id: 'ap_nope', name: 'x' })).status).toBe(404)
  })

  it('refuses a profile validateProfile refuses, with its reason, and writes nothing', async () => {
    const h = await rig()
    await h.call('agent-profiles-create', { name: 'Reviewer', accountIds: ['acc_1'] })
    const same = await h.call('agent-profiles-create', { name: 'reviewer', accountIds: ['acc_1'] })
    expect(same.status).toBe(400)
    expect(same.body).toMatchObject({ reason: 'name-taken' })
    expect(same.marks.effects).toBe(0)
    expect((await h.call('agent-profiles-create', { name: 'x'.repeat(61), accountIds: ['acc_1'] })).body).toMatchObject({ reason: 'name-too-long' })
    expect((await h.call('agent-profiles-create', { name: 'm', accountIds: ['acc_1', 'acc_x'] })).body).toMatchObject({ reason: 'mixed-provider' })
    expect((await h.call('agent-profiles-create', { name: 'm' })).status).toBe(400)
    expect((await readAgentProfiles(h.profileDir)).profiles).toHaveLength(1)
  })

  it('lets an update keep its own name, and refuses one that takes another profile\'s', async () => {
    const h = await rig()
    const a = profileOf(await h.call('agent-profiles-create', { name: 'A', accountIds: ['acc_1'] }))
    await h.call('agent-profiles-create', { name: 'B', accountIds: ['acc_1'] })
    expect((await h.call('agent-profiles-update', { id: a.id, name: 'a', description: 'd' })).status).toBe(200)
    expect((await h.call('agent-profiles-update', { id: a.id, name: 'b' })).body).toMatchObject({ reason: 'name-taken' })
  })

  it('answers accountIds without the accounts that were removed, leaving the stored list alone', async () => {
    const h = await rig()
    const p = profileOf(await h.call('agent-profiles-create', { name: 'A', accountIds: ['acc_1', 'acc_2'] }))
    h.setAccounts(h.accounts().filter((a) => a.id !== 'acc_2'))
    expect(profileOf(await h.call('agent-profiles-get', { idOrName: p.id })).accountIds).toEqual(['acc_1'])
    expect((await h.call('agent-profiles-list')).body).toMatchObject({ profiles: [{ accountIds: ['acc_1'] }] })
    expect((await readAgentProfiles(h.profileDir)).profiles[0]!.accountIds).toEqual(['acc_1', 'acc_2'])
  })

  it('refuses a caller that is not the app or the CLI, and a change from an agent\'s shell', async () => {
    const h = await rig()
    expect((await h.call('agent-profiles-list', {}, { role: 'agent' })).status).toBe(403)
    expect((await h.call('agent-profiles-list', {}, { role: 'mcp' })).status).toBe(403)
    const refused = await h.call('agent-profiles-create', { name: 'A', accountIds: ['acc_1'] }, { role: 'cli', agentRefusal: 'not from an agent' })
    expect(refused.status).toBe(403)
    expect(refused.body).toEqual({ error: 'not from an agent' })
    expect(refused.marks.effects).toBe(0)
    expect((await readAgentProfiles(h.profileDir)).profiles).toEqual([])
    // A read is allowed to an agent's shell
    expect((await h.call('agent-profiles-list', {}, { role: 'cli', agentRefusal: 'not from an agent' })).status).toBe(200)
  })

  it('deletes a profile, but answers 409 in-use while something holds it', async () => {
    const h = await rig()
    const p = profileOf(await h.call('agent-profiles-create', { name: 'A', accountIds: ['acc_1'] }))
    h.held.add(p.id as string)
    const r = await h.call('agent-profiles-delete', { id: p.id })
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ reason: 'in-use' })
    expect(r.marks.effects).toBe(0)
    expect((await readAgentProfiles(h.profileDir)).profiles).toHaveLength(1)
    h.held.clear()
    const ok = await h.call('agent-profiles-delete', { id: p.id })
    expect(ok.status).toBe(200)
    expect(ok.marks.effects).toBe(1)
    expect((await readAgentProfiles(h.profileDir)).profiles).toEqual([])
    expect((await h.call('agent-profiles-delete', { id: p.id })).status).toBe(404)
  })

  it('lands two concurrent updates in order', async () => {
    const h = await rig()
    const p = profileOf(await h.call('agent-profiles-create', { name: 'A', accountIds: ['acc_1'] }))
    const [r1, r2] = await Promise.all([
      h.call('agent-profiles-update', { id: p.id, description: 'first' }),
      h.call('agent-profiles-update', { id: p.id, mcpExclude: ['mcp-linear'] })
    ])
    expect([r1.status, r2.status]).toEqual([200, 200])
    // Neither overwrote the other's field: each read what the other had written
    expect((await readAgentProfiles(h.profileDir)).profiles[0]).toMatchObject({ description: 'first', mcpExclude: ['mcp-linear'] })
  })

  it('answers 409 when the store is damaged, and keeps a copy', async () => {
    const h = await rig()
    await fs.mkdir(path.dirname(profilePaths(h.profileDir).agentProfiles), { recursive: true })
    await fs.writeFile(profilePaths(h.profileDir).agentProfiles, '{ not json')
    const r = await h.call('agent-profiles-list')
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ error: expect.stringContaining('damaged') })
    expect((await h.call('agent-profiles-create', { name: 'A', accountIds: ['acc_1'] })).status).toBe(409)
  })

  it('stamps lastUsedAt at most once a minute, and never fails the caller', async () => {
    const h = await rig()
    const p = profileOf(await h.call('agent-profiles-create', { name: 'A', accountIds: ['acc_1'] }))
    const first = await h.call('agent-profiles-touch', { id: p.id })
    expect(first.status).toBe(200)
    expect(first.marks.effects).toBe(0)
    const stamped = (await readAgentProfiles(h.profileDir)).profiles[0]!.lastUsedAt
    expect(stamped).toBe('2026-10-22T10:00:00.000Z')
    const file = profilePaths(h.profileDir).agentProfiles
    const before = (await fs.stat(file)).mtimeMs
    h.advance(30_000)
    await h.call('agent-profiles-touch', { id: p.id })
    expect((await readAgentProfiles(h.profileDir)).profiles[0]!.lastUsedAt).toBe(stamped)
    expect((await fs.stat(file)).mtimeMs).toBe(before)
    h.advance(31_000)
    await h.call('agent-profiles-touch', { id: p.id })
    expect((await readAgentProfiles(h.profileDir)).profiles[0]!.lastUsedAt).toBe('2026-10-22T10:01:01.000Z')
    // Gone id, and a damaged store: still 200
    expect((await h.call('agent-profiles-touch', { id: 'ap_gone' })).status).toBe(200)
    await fs.writeFile(file, '{ not json')
    expect((await h.call('agent-profiles-touch', { id: p.id })).status).toBe(200)
    expect(h.logs.some((l) => l.includes('agent profiles'))).toBe(true)
  })
})
