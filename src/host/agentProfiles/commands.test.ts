// Agent Profiles (design §4): the Host's agent-profiles commands. For the app and the CLI only, changes refused to an
// agent's shell, and a profile held by something live is never deleted from under it.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../core/testFixtures'
import { profilePaths } from '../../core/profile/paths'
import { readAgentProfiles } from '../../core/agentProfiles/store'
import { agentProfileInUse, createHostAgentProfiles } from './commands'
import { createJob, createTask, emptyState, startJobRun, type OrchState } from '../../core/orchestration/state'
import type { Account } from '../../core/types'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})

async function rig(o: { sandboxSetup?: Parameters<typeof createHostAgentProfiles>[0]['sandboxSetup'] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-host-ap-'))
  dirs.push(root)
  const profileDir = path.join(root, 'profile')
  const acc = (id: string, provider: 'claude' | 'codex'): Account => ({ id, label: id, configDir: path.join(root, id), color: '#888', createdAt: '2026-10-22T00:00:00.000Z', provider })
  let accounts = [acc('acc_1', 'claude'), acc('acc_2', 'claude'), acc('acc_x', 'codex'), acc('acc_y', 'codex')]
  const held = new Set<string>()
  let clock = Date.parse('2026-10-22T10:00:00.000Z')
  const logs: string[] = []
  let accountReads = 0
  const hub = createHostAgentProfiles({
    profileDir,
    readAccounts: async () => (accountReads++, accounts),
    inUse: async (id) => held.has(id),
    now: () => clock,
    log: (l) => logs.push(l),
    ...(o.sandboxSetup ? { sandboxSetup: o.sandboxSetup } : {})
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
    accountReads: () => accountReads,
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

  // Final review I2: an update that leaves the accounts alone keeps the ones still registered, so a profile that lost an
  // account to its removal from Astera can still be changed; and an update keeps the profile's status and last use
  it('an update without accountIds keeps the live accounts, and the status and lastUsedAt survive it', async () => {
    const h = await rig()
    const p = profileOf(await h.call('agent-profiles-create', { name: 'A', accountIds: ['acc_1', 'acc_2'] }))
    await h.call('agent-profiles-touch', { id: p.id })
    await h.call('agent-profiles-archive', { id: p.id })
    h.setAccounts(h.accounts().filter((a) => a.id !== 'acc_2'))
    h.advance(1_000)
    const r = await h.call('agent-profiles-update', { id: p.id, permission: 'ask' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect((await readAgentProfiles(h.profileDir)).profiles[0]).toMatchObject({
      accountIds: ['acc_1'],
      permission: 'ask',
      status: 'archived',
      lastUsedAt: '2026-10-22T10:00:00.000Z',
      updatedAt: '2026-10-22T10:00:01.000Z'
    })
    // An accountIds given is still checked whole: the removed account is refused by name
    expect((await h.call('agent-profiles-update', { id: p.id, accountIds: ['acc_1', 'acc_2'] })).body).toMatchObject({ reason: 'unknown-account' })
  })

  it('refuses a caller that is not the app or the CLI, and a change from an agent\'s shell', async () => {
    const h = await rig()
    expect((await h.call('agent-profiles-list', {}, { role: 'agent' })).status).toBe(403)
    // An MCP client lists them (list_agent_profiles, behind the MCP gate) and sends nothing else (Agent Profiles design §6)
    expect((await h.call('agent-profiles-list', {}, { role: 'mcp' })).status).toBe(200)
    for (const cmd of ['agent-profiles-get', 'agent-profiles-create', 'agent-profiles-update', 'agent-profiles-archive', 'agent-profiles-restore', 'agent-profiles-delete', 'agent-profiles-touch'])
      expect((await h.call(cmd, { id: 'ap_000000000001', name: 'A', accountIds: ['acc_1'] }, { role: 'mcp' })).status, cmd).toBe(403)
    const refused = await h.call('agent-profiles-create', { name: 'A', accountIds: ['acc_1'] }, { role: 'cli', agentRefusal: 'not from an agent' })
    expect(refused.status).toBe(403)
    expect(refused.body).toEqual({ error: 'not from an agent' })
    expect(refused.marks.effects).toBe(0)
    expect((await readAgentProfiles(h.profileDir)).profiles).toEqual([])
    // A read is allowed to an agent's shell
    expect((await h.call('agent-profiles-list', {}, { role: 'cli', agentRefusal: 'not from an agent' })).status).toBe(200)
  })

  // Sandbox design §6: the switch is the person's, off unless they turn it on, and kept by an update that leaves it alone
  it('create and update take sandbox, and the list shows it', async () => {
    const h = await rig()
    const off = profileOf(await h.call('agent-profiles-create', { name: 'Open', accountIds: ['acc_x'] }))
    expect(off.sandbox).toBe(false)
    const on = await h.call('agent-profiles-create', { name: 'Boxed', accountIds: ['acc_x'], sandbox: true })
    expect(on.status).toBe(200)
    expect(profileOf(on).sandbox).toBe(true)
    expect((await h.call('agent-profiles-list')).body).toMatchObject({ profiles: [{ name: 'Open', sandbox: false }, { name: 'Boxed', sandbox: true }] })
    expect(profileOf(await h.call('agent-profiles-update', { id: off.id, sandbox: true })).sandbox).toBe(true)
    // An update that does not name it keeps it
    expect(profileOf(await h.call('agent-profiles-update', { id: off.id, description: 'd' })).sandbox).toBe(true)
    expect(profileOf(await h.call('agent-profiles-update', { id: profileOf(on).id, sandbox: false })).sandbox).toBe(false)
    expect((await readAgentProfiles(h.profileDir)).profiles.map((p) => p.sandbox)).toEqual([true, false])
    // Only a boolean, and nothing is written for anything else
    for (const sandbox of ['on', 1, null]) {
      expect((await h.call('agent-profiles-create', { name: 'X', accountIds: ['acc_x'], sandbox })).status, String(sandbox)).toBe(400)
      expect((await h.call('agent-profiles-update', { id: off.id, sandbox })).status, String(sandbox)).toBe(400)
    }
    expect((await readAgentProfiles(h.profileDir)).profiles.map((p) => p.sandbox)).toEqual([true, false])
  })

  // Review Focus 5: an agent cannot switch off what keeps it in, from its own shell; the person's CLI and the app can
  it("an agent's shell cannot change sandbox", async () => {
    const h = await rig()
    const p = profileOf(await h.call('agent-profiles-create', { name: 'Boxed', accountIds: ['acc_x'], sandbox: true }))
    const agent = { role: 'cli' as const, agentRefusal: 'not from an agent' }
    const off = await h.call('agent-profiles-update', { id: p.id, sandbox: false }, agent)
    expect(off.status).toBe(403)
    expect(off.body).toEqual({ error: 'not from an agent' })
    expect(off.marks.effects).toBe(0)
    expect((await h.call('agent-profiles-create', { name: 'Open', accountIds: ['acc_x'], sandbox: false }, agent)).status).toBe(403)
    expect((await readAgentProfiles(h.profileDir)).profiles).toMatchObject([{ id: p.id, sandbox: true }])
    expect((await h.call('agent-profiles-update', { id: p.id, sandbox: false }, { role: 'cli' })).status).toBe(200)
    expect((await readAgentProfiles(h.profileDir)).profiles[0]!.sandbox).toBe(false)
  })

  // Sandbox design §6, as the person decided (Task 6): 설정하기 sets up the one Codex account being started, from the
  // app only. It brings up Windows' administrator prompt, so neither an agent's shell nor anything else may ask for it.
  it('agent-profiles-sandbox-setup sets up the one Codex account of the profile, for the app only', async () => {
    const set: string[] = []
    const h = await rig({ sandboxSetup: async (account) => (set.push(account.id), { ok: true, out: 'set up' }) })
    const p = profileOf(await h.call('agent-profiles-create', { name: 'Boxed', accountIds: ['acc_x', 'acc_y'], sandbox: true }))
    const r = await h.call('agent-profiles-sandbox-setup', { id: p.id, accountId: 'acc_y' })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toEqual({ ok: true, out: 'set up' })
    expect(r.marks.effects).toBe(0)
    // Only that account, not every Codex account of the profile
    expect(set).toEqual(['acc_y'])
    for (const extra of [{ role: 'cli' as const, agentRefusal: 'not from an agent' }, { role: 'cli' as const }, { role: 'mcp' as const }, { role: 'agent' as const }])
      expect((await h.call('agent-profiles-sandbox-setup', { id: p.id, accountId: 'acc_x' }, extra)).status, JSON.stringify(extra)).toBe(403)
    // An account that is not the profile's, or not a Codex one, and a profile that is not there
    const claude = profileOf(await h.call('agent-profiles-create', { name: 'Claude', accountIds: ['acc_1'] }))
    expect((await h.call('agent-profiles-sandbox-setup', { id: p.id, accountId: 'acc_1' })).status).toBe(400)
    expect((await h.call('agent-profiles-sandbox-setup', { id: claude.id, accountId: 'acc_1' })).status).toBe(400)
    expect((await h.call('agent-profiles-sandbox-setup', { id: 'ap_nope', accountId: 'acc_x' })).status).toBe(404)
    expect((await h.call('agent-profiles-sandbox-setup', { id: p.id })).status).toBe(400)
    expect(set).toEqual(['acc_y'])
    // A failed setup is answered as Codex said it, still a 200: the command ran
    const failing = await rig({ sandboxSetup: async () => ({ ok: false, out: 'Error: the elevation was cancelled' }) })
    const q = profileOf(await failing.call('agent-profiles-create', { name: 'Boxed', accountIds: ['acc_x'], sandbox: true }))
    expect((await failing.call('agent-profiles-sandbox-setup', { id: q.id, accountId: 'acc_x' })).body).toEqual({ ok: false, out: 'Error: the elevation was cancelled' })
    // A Host with no Windows sandbox to set up (macOS, Linux) says so
    const none = await rig()
    const n = profileOf(await none.call('agent-profiles-create', { name: 'Boxed', accountIds: ['acc_x'], sandbox: true }))
    expect((await none.call('agent-profiles-sandbox-setup', { id: n.id, accountId: 'acc_x' })).status).toBe(501)
  })

  // Task 6 fix round 1: a second press of 설정하기 for the account while its setup runs (the administrator prompt is up)
  // shares that setup, so the person sees one prompt; another account's waits its turn
  it('two presses for the same account while its setup runs share it', async () => {
    const started: string[] = []
    const finish: Record<string, (r: { ok: boolean; out: string }) => void> = {}
    const h = await rig({ sandboxSetup: (account) => new Promise((resolve) => (started.push(account.id), (finish[account.id] = resolve))) })
    const p = profileOf(await h.call('agent-profiles-create', { name: 'Boxed', accountIds: ['acc_x', 'acc_y'], sandbox: true }))
    const first = h.call('agent-profiles-sandbox-setup', { id: p.id, accountId: 'acc_x' })
    await vi.waitFor(() => expect(started).toEqual(['acc_x']))
    const second = h.call('agent-profiles-sandbox-setup', { id: p.id, accountId: 'acc_x' })
    const other = h.call('agent-profiles-sandbox-setup', { id: p.id, accountId: 'acc_y' })
    // Each press reads the accounts before it reaches the setup: once both have, the second shares the first's setup and
    // the other account's waits its turn
    const reads = h.accountReads()
    await vi.waitFor(() => expect(h.accountReads()).toBe(reads + 2))
    await new Promise((r) => setTimeout(r, 0))
    expect(started).toEqual(['acc_x'])
    finish.acc_x({ ok: true, out: 'set up' })
    expect((await first).body).toEqual({ ok: true, out: 'set up' })
    expect((await second).body).toEqual({ ok: true, out: 'set up' })
    await vi.waitFor(() => expect(started).toEqual(['acc_x', 'acc_y']))
    finish.acc_y({ ok: false, out: 'cancelled' })
    expect((await other).body).toEqual({ ok: false, out: 'cancelled' })
    // Once it settled, a new press is a new setup
    const again = h.call('agent-profiles-sandbox-setup', { id: p.id, accountId: 'acc_x' })
    await vi.waitFor(() => expect(started).toEqual(['acc_x', 'acc_y', 'acc_x']))
    finish.acc_x({ ok: true, out: 'again' })
    expect((await again).body).toEqual({ ok: true, out: 'again' })
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

// Ruling P1: what holds a profile on this Host, the delete guard's `inUse`: a live session started from it, and
// unfinished orchestration work (a Job, a Task, an open Dispatch), read once the state is loaded
describe('agentProfileInUse', () => {
  const T0 = '2026-10-22T00:00:00.000Z'
  const unwrapped = <T>(r: { ok: true; state: OrchState; value: T } | { ok: false; error: string }): { state: OrchState; value: T } => {
    if (!r.ok) throw new Error(r.error)
    return r
  }

  it('is held by a live session, not a dead one; and by a queued Task, once the state is loaded', async () => {
    let state = emptyState()
    let loaded = false
    const sessions = [
      { alive: true, meta: { restore: { agentProfileId: 'ap_live' } } },
      { alive: false, meta: { restore: { agentProfileId: 'ap_dead' } } },
      { alive: true }
    ]
    const inUse = agentProfileInUse({
      sessions: () => sessions,
      orch: () => ({
        ready: async () => {
          loaded = true
        },
        state: () => {
          if (!loaded) throw new Error('read before the load')
          return state
        }
      })
    })
    expect(await inUse('ap_live')).toBe(true)
    expect(await inUse('ap_dead')).toBe(false)
    const job = unwrapped(createJob(emptyState(), { objective: 'o', cwd: '/p' }, T0))
    const run = unwrapped(startJobRun(job.state, job.value.id, T0))
    state = unwrapped(createTask(run.state, { runId: run.value.id, title: 't', spec: 's', deps: [], accountIds: ['acc_1'], agentProfileId: 'ap_q' }, T0)).state
    expect(await inUse('ap_q')).toBe(true)
    expect(await inUse('ap_other')).toBe(false)
  })
})
