// Observe mode (design §7, §12, ruling M1): the Host's policies commands. For the app and the CLI only, changes refused
// to an agent's shell; the starter rules are written the first time observe is turned on and kept after.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../core/testFixtures'
import { profilePaths } from '../../core/profile/paths'
import { COVERAGE, COVERAGE_ENFORCE, STARTER_POLICY, readAuditPolicy, readPolicyMode, writeAuditPolicy, type AuditPolicy, type AuditRule } from '../../core/audit/policy'
import { SANDBOX_COVERAGE } from '../../core/sandbox/coverage'
import { POLICY_CHANGES, POLICY_COMMANDS, createHostPolicies } from './policyCommands'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})

async function rig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-host-policies-'))
  dirs.push(root)
  const profileDir = path.join(root, 'profile')
  await fs.mkdir(profileDir)
  const hub = createHostPolicies({ profileDir })
  const call = (cmd: string, args: Record<string, unknown> = {}, extra: { role?: 'app' | 'cli' | 'mcp' | 'controller' | 'plugin'; agentRefusal?: string } = {}) => {
    const marks = { effects: 0 }
    return hub
      .command({ cmd, args, role: (extra.role ?? 'app') as 'app', ...(extra.agentRefusal ? { agentRefusal: extra.agentRefusal } : {}), marks })
      .then((r) => ({ ...r, marks }))
  }
  const file = profilePaths(profileDir).auditPolicy
  const exists = (): Promise<boolean> => fs.stat(file).then(() => true, () => false)
  return { profileDir, call, file, exists }
}

const policyOf = (r: { body: unknown }) => (r.body as { policy: AuditPolicy }).policy
const ruleOf = (r: { body: unknown }) => (r.body as { rule: AuditRule }).rule

describe('createHostPolicies', () => {
  it('shows compatibility, the starter rules and the coverage when nothing was set, and writes nothing', async () => {
    const h = await rig()
    const r = await h.call('policies-show')
    expect(r.status).toBe(200)
    // With what Enforce would block, so the screen's preview says it before Enforce is on, and what the sandbox blocks per
    // CLI and OS (sandbox design §6), the second table beside it
    expect(r.body).toEqual({ mode: 'compatibility', policy: STARTER_POLICY, coverage: COVERAGE, enforceCoverage: COVERAGE_ENFORCE, sandboxCoverage: SANDBOX_COVERAGE })
    expect(r.marks.effects).toBe(0)
    expect(await h.exists()).toBe(false)
  })

  it('writes the starter rules the first time observe is turned on, and keeps the person’s rules after', async () => {
    const h = await rig()
    const on = await h.call('policies-set-mode', { mode: 'observe' })
    expect(on.status).toBe(200)
    expect(on.marks.effects).toBe(1)
    expect(await readAuditPolicy(h.profileDir)).toEqual({ ...STARTER_POLICY, mode: 'observe' })

    const added = ruleOf(await h.call('policies-rules-add', { effect: 'deny', action: 'package.install' }))
    expect((await h.call('policies-set-mode', { mode: 'compatibility' })).status).toBe(200)
    expect(await readAuditPolicy(h.profileDir)).toMatchObject({ mode: 'compatibility', rules: [...STARTER_POLICY.rules, added] })
    await h.call('policies-set-mode', { mode: 'observe' })
    const after = (await h.call('policies-show')).body as { mode: string; policy: AuditPolicy }
    expect(after.mode).toBe('observe')
    expect(after.policy.rules).toEqual([...STARTER_POLICY.rules, added])
  })

  it('writes no file to turn compatibility on when there is none, and refuses a mode it does not know', async () => {
    const h = await rig()
    const r = await h.call('policies-set-mode', { mode: 'compatibility' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ mode: 'compatibility' })
    expect(await h.exists()).toBe(false)
    for (const mode of ['strict', undefined, 'OBSERVE', 'ENFORCE']) {
      const bad = await h.call('policies-set-mode', { mode })
      expect(bad.status).toBe(400)
      expect(bad.marks.effects).toBe(0)
    }
    expect(await h.exists()).toBe(false)
  })

  // Enforce (enforce design §5, E1): set like observe, the starter rules written the first time, never by an agent
  it('sets the mode to enforce from the app and the CLI, not from an agent’s shell', async () => {
    const h = await rig()
    const on = await h.call('policies-set-mode', { mode: 'enforce' })
    expect(on.status).toBe(200)
    expect(await readAuditPolicy(h.profileDir)).toEqual({ ...STARTER_POLICY, mode: 'enforce' })
    expect((await h.call('policies-set-mode', { mode: 'observe' }, { role: 'cli' })).status).toBe(200)
    expect((await h.call('policies-set-mode', { mode: 'enforce' }, { role: 'cli' })).status).toBe(200)
    const agent = await h.call('policies-set-mode', { mode: 'compatibility' }, { role: 'cli', agentRefusal: 'not from an agent session' })
    expect(agent.status).toBe(403)
    expect(await readPolicyMode(h.profileDir)).toBe('enforce')
  })

  it('adds a rule at the end or at a position, with an id of its own', async () => {
    const h = await rig()
    const end = await h.call('policies-rules-add', { effect: 'allow', action: 'git.*', scope: 'inside-project' })
    expect(end.status).toBe(200)
    expect(end.marks.effects).toBe(1)
    const rule = ruleOf(end)
    expect(rule).toEqual({ id: expect.stringMatching(/^ar_[0-9a-f]{12}$/), effect: 'allow', action: 'git.*', scope: 'inside-project' })
    expect(policyOf(end).rules).toEqual([...STARTER_POLICY.rules, rule])
    // The first add with no file starts from the starter rules, in compatibility
    expect(policyOf(end).mode).toBe('compatibility')

    const first = ruleOf(await h.call('policies-rules-add', { effect: 'deny', action: 'mcp.call', at: 0 }))
    expect(first).not.toHaveProperty('scope')
    expect((await readAuditPolicy(h.profileDir))!.rules.map((r) => r.id)).toEqual([first.id, ...STARTER_POLICY.rules.map((r) => r.id), rule.id])
  })

  it('refuses a rule it cannot read', async () => {
    const h = await rig()
    for (const args of [
      { effect: 'block', action: 'git.*' },
      { effect: 'deny', action: 'git.push' },
      { effect: 'deny', action: 'foo.*' },
      { effect: 'deny' },
      { effect: 'deny', action: 'git.*', scope: 'anywhere' },
      { effect: 'deny', action: 'git.*', at: 99 },
      { effect: 'deny', action: 'git.*', at: -1 },
      { effect: 'deny', action: 'git.*', at: 1.5 }
    ]) {
      const r = await h.call('policies-rules-add', args)
      expect(r.status).toBe(400)
      expect(r.marks.effects).toBe(0)
    }
    expect(await h.exists()).toBe(false)
  })

  it('removes and moves a rule, and answers 404 for one it does not have', async () => {
    const h = await rig()
    const ids = STARTER_POLICY.rules.map((r) => r.id)
    const moved = await h.call('policies-rules-move', { id: ids[3], to: 0 })
    expect(moved.status).toBe(200)
    expect(moved.marks.effects).toBe(1)
    expect(policyOf(moved).rules.map((r) => r.id)).toEqual([ids[3], ids[0], ids[1], ids[2], ids[4]])
    expect(policyOf(await h.call('policies-rules-move', { id: ids[3], to: 4 })).rules.map((r) => r.id)).toEqual([ids[0], ids[1], ids[2], ids[4], ids[3]])
    expect((await h.call('policies-rules-move', { id: ids[3], to: 5 })).status).toBe(400)
    expect((await h.call('policies-rules-move', { id: 'ar_nope', to: 0 })).status).toBe(404)

    const removed = await h.call('policies-rules-remove', { id: ids[0] })
    expect(removed.status).toBe(200)
    expect(policyOf(removed).rules.map((r) => r.id)).toEqual([ids[1], ids[2], ids[4], ids[3]])
    const gone = await h.call('policies-rules-remove', { id: ids[0] })
    expect(gone.status).toBe(404)
    expect(gone.marks.effects).toBe(0)
    expect((await h.call('policies-rules-remove', {})).status).toBe(400)
  })

  it('sets what happens when no rule matches', async () => {
    const h = await rig()
    const r = await h.call('policies-set-otherwise', { otherwise: 'deny' })
    expect(r.status).toBe(200)
    expect((await readAuditPolicy(h.profileDir))!.otherwise).toBe('deny')
    expect((await h.call('policies-set-otherwise', { otherwise: 'maybe' })).status).toBe(400)
  })

  it('starts over with the starter rules, keeping the mode', async () => {
    const h = await rig()
    await h.call('policies-set-mode', { mode: 'observe' })
    await h.call('policies-rules-remove', { id: STARTER_POLICY.rules[0].id })
    await h.call('policies-rules-add', { effect: 'allow', action: '*' })
    await h.call('policies-set-otherwise', { otherwise: 'deny' })
    const r = await h.call('policies-rules-reset')
    expect(r.status).toBe(200)
    expect(r.marks.effects).toBe(1)
    expect(await readAuditPolicy(h.profileDir)).toEqual({ ...STARTER_POLICY, mode: 'observe' })
  })

  it('refuses every change to an agent’s shell, and lets it read', async () => {
    const h = await rig()
    const changes: Array<[string, Record<string, unknown>]> = [
      ['policies-set-mode', { mode: 'observe' }],
      ['policies-set-otherwise', { otherwise: 'deny' }],
      ['policies-rules-add', { effect: 'allow', action: '*' }],
      ['policies-rules-edit', { id: STARTER_POLICY.rules[0].id, effect: 'allow' }],
      ['policies-rules-remove', { id: STARTER_POLICY.rules[0].id }],
      ['policies-rules-move', { id: STARTER_POLICY.rules[0].id, to: 1 }],
      ['policies-rules-reset', {}]
    ]
    expect(changes.map(([c]) => c).sort()).toEqual([...POLICY_CHANGES].sort())
    for (const [cmd, args] of changes) {
      const refused = await h.call(cmd, args, { role: 'cli', agentRefusal: 'not from an agent' })
      expect(refused.status).toBe(403)
      expect(refused.body).toEqual({ error: 'not from an agent' })
      expect(refused.marks.effects).toBe(0)
    }
    expect(await h.exists()).toBe(false)
    expect((await h.call('policies-show', {}, { role: 'cli', agentRefusal: 'not from an agent' })).status).toBe(200)
  })

  it('answers the app and the CLI only', async () => {
    const h = await rig()
    for (const role of ['mcp', 'controller', 'plugin'] as const)
      for (const cmd of POLICY_COMMANDS) expect((await h.call(cmd, { mode: 'observe' }, { role })).status).toBe(403)
    expect(await h.exists()).toBe(false)
    expect((await h.call('policies-show', {}, { role: 'cli' })).status).toBe(200)
  })

  it('answers 409 when the file is damaged, and writes nothing over it', async () => {
    const h = await rig()
    await fs.writeFile(h.file, '{ not json')
    const r = await h.call('policies-show')
    expect(r.status).toBe(409)
    // The reason the screen offers its repair for (Task 8 fix round 1, ruling 1)
    expect(r.body).toMatchObject({ error: expect.stringContaining('damaged'), reason: 'damaged' })
    for (const [cmd, args] of [
      ['policies-set-mode', { mode: 'observe' }],
      ['policies-rules-add', { effect: 'deny', action: 'git.*' }],
      ['policies-rules-edit', { id: STARTER_POLICY.rules[0].id, effect: 'allow' }]
    ] as const) {
      const refused = await h.call(cmd, args)
      expect(refused.status).toBe(409)
      expect(refused.marks.effects).toBe(0)
    }
    expect(await fs.readFile(h.file, 'utf8')).toBe('{ not json')
  })

  it('repairs a damaged file by starting over with the starter rules, its damage kept aside', async () => {
    const h = await rig()
    const kept = async (): Promise<string[]> => (await fs.readdir(path.dirname(h.file))).filter((f) => f.endsWith('.bak'))
    await fs.writeFile(h.file, '{ not json')
    const r = await h.call('policies-rules-reset')
    expect(r.status).toBe(200)
    expect(r.marks.effects).toBe(1)
    // A mode that cannot be read is compatibility
    expect(await readAuditPolicy(h.profileDir)).toEqual(STARTER_POLICY)
    expect(await kept()).toHaveLength(1)
    expect(await fs.readFile(path.join(path.dirname(h.file), (await kept())[0]), 'utf8')).toBe('{ not json')

    // A mode the damaged file names is not turned on by the repair: while it was damaged sessions started in compatibility
    await fs.writeFile(h.file, JSON.stringify({ ...STARTER_POLICY, mode: 'observe', rules: [{ id: 'x', effect: 'maybe', action: 'git.*' }] }))
    expect((await h.call('policies-rules-reset')).status).toBe(200)
    expect(await readAuditPolicy(h.profileDir)).toEqual({ ...STARTER_POLICY, mode: 'compatibility' })
    expect(await kept()).toHaveLength(2)
  })

  it('the repair writes the mode the damaged file was in effect, never turning observing on or off by itself', async () => {
    for (const named of ['observe', 'compatibility'] as const) {
      const h = await rig()
      // Damaged for its rules, though it names a mode: what sessions started in meanwhile is what readPolicyMode says
      await fs.writeFile(h.file, JSON.stringify({ ...STARTER_POLICY, mode: named, rules: [{ id: 'x', effect: 'maybe', action: 'git.*' }] }))
      const inEffect = await readPolicyMode(h.profileDir)
      expect(inEffect).toBe('compatibility')
      expect((await h.call('policies-rules-reset')).status).toBe(200)
      expect(await readPolicyMode(h.profileDir)).toBe(inEffect)
      expect(await readAuditPolicy(h.profileDir)).toEqual({ ...STARTER_POLICY, mode: inEffect })
    }
    // A file that reads keeps its own mode through the reset
    const ok = await rig()
    await writeAuditPolicy(ok.profileDir, { ...STARTER_POLICY, mode: 'observe', otherwise: 'deny' })
    expect((await ok.call('policies-rules-reset')).status).toBe(200)
    expect(await readAuditPolicy(ok.profileDir)).toEqual({ ...STARTER_POLICY, mode: 'observe' })
  })

  it('refuses to start over when the damaged copy could not be kept, and leaves the file as it is', async () => {
    const h = await rig()
    await fs.writeFile(h.file, '{ not json')
    // Nothing can be written beside the file with `wx`, which is how a kept copy is made
    const real = fs.writeFile.bind(fs)
    const spy = vi.spyOn(fs, 'writeFile').mockImplementation(((f: unknown, d: unknown, o?: { flag?: string }) =>
      o && typeof o === 'object' && o.flag === 'wx' ? Promise.reject(new Error('disk full')) : real(f as string, d as string, o as never)) as typeof fs.writeFile)
    try {
      const r = await h.call('policies-rules-reset')
      expect(r.status).toBe(409)
      expect(r.marks.effects).toBe(0)
      expect(r.body).toMatchObject({ error: expect.stringContaining('copy'), repair: 'audit-policy.json' })
      // Not a damage the repair can fix, so no reason to offer it
      expect((r.body as { reason?: unknown }).reason).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
    expect(await fs.readFile(h.file, 'utf8')).toBe('{ not json')
    // With the disk back, the same repair keeps its copy and goes through
    expect((await h.call('policies-rules-reset')).status).toBe(200)
    expect((await fs.readdir(path.dirname(h.file))).filter((f) => f.endsWith('.bak'))).toHaveLength(1)
  })

  it('never writes over a file it could not read, even to start over', async () => {
    const h = await rig()
    // A folder where the file goes: there, but no read gets its bytes
    await fs.mkdir(h.file)
    const r = await h.call('policies-rules-reset')
    expect(r.status).toBe(409)
    expect(r.marks.effects).toBe(0)
    expect((await fs.stat(h.file)).isDirectory()).toBe(true)
    // Not damaged: starting over cannot repair it, so it gives no reason to offer that
    expect((r.body as { reason?: unknown }).reason).toBeUndefined()
    expect((await h.call('policies-show')).body).not.toHaveProperty('reason')
  })

  it('edits a rule in place, and clears its scope', async () => {
    const h = await rig()
    const rule = ruleOf(await h.call('policies-rules-add', { effect: 'deny', action: 'git.*', scope: 'outside-project', at: 1 }))
    const edited = await h.call('policies-rules-edit', { id: rule.id, effect: 'allow', action: 'github.*' })
    expect(edited.status).toBe(200)
    expect(edited.marks.effects).toBe(1)
    expect(ruleOf(edited)).toEqual({ id: rule.id, effect: 'allow', action: 'github.*', scope: 'outside-project' })
    expect(policyOf(edited).rules[1]).toEqual(ruleOf(edited))
    expect(policyOf(edited).rules).toHaveLength(STARTER_POLICY.rules.length + 1)

    const scoped = await h.call('policies-rules-edit', { id: rule.id, scope: 'inside-project' })
    expect(ruleOf(scoped)).toEqual({ id: rule.id, effect: 'allow', action: 'github.*', scope: 'inside-project' })
    const cleared = await h.call('policies-rules-edit', { id: rule.id, scope: null })
    expect(ruleOf(cleared)).toEqual({ id: rule.id, effect: 'allow', action: 'github.*' })
    expect((await readAuditPolicy(h.profileDir))!.rules[1]).toEqual({ id: rule.id, effect: 'allow', action: 'github.*' })
  })

  it('refuses an edit that changes nothing, with the reason, and writes nothing', async () => {
    const h = await rig()
    const id = STARTER_POLICY.rules[0].id
    const r = await h.call('policies-rules-edit', { id })
    expect(r.status).toBe(400)
    expect(r.marks.effects).toBe(0)
    expect(r.body).toMatchObject({ reason: 'nothing-to-change' })
    expect(await h.exists()).toBe(false)
    // A scope of null is a change (it clears the scope)
    expect((await h.call('policies-rules-edit', { id, scope: null })).status).toBe(200)
  })

  it('refuses an edit it cannot read, and answers 404 for a rule it does not have', async () => {
    const h = await rig()
    const id = STARTER_POLICY.rules[0].id
    for (const args of [
      { id, effect: 'block' },
      { id, action: 'foo.*' },
      { id, action: '' },
      { id, scope: 'anywhere' },
      { effect: 'allow' }
    ]) {
      const r = await h.call('policies-rules-edit', args)
      expect(r.status).toBe(400)
      expect(r.marks.effects).toBe(0)
    }
    expect(await h.exists()).toBe(false)
    const gone = await h.call('policies-rules-edit', { id: 'ar_nope', effect: 'allow' })
    expect(gone.status).toBe(404)
    expect(await h.exists()).toBe(false)
  })

  it('tells onChange after each change that landed, so the recorder reads the mode again, and not after a read or a refusal', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-host-policies-'))
    dirs.push(root)
    let changes = 0
    const told: string[] = []
    const hub = createHostPolicies({
      profileDir: root,
      onChange: (cmd) => {
        changes++
        told.push(cmd)
      }
    })
    const call = (cmd: string, args: Record<string, unknown> = {}, agentRefusal?: string) =>
      hub.command({ cmd, args, role: 'app', ...(agentRefusal ? { agentRefusal } : {}), marks: { effects: 0 } })
    await call('policies-show')
    await call('policies-set-mode', { mode: 'strict' })
    await call('policies-set-mode', { mode: 'observe' }, 'not an agent')
    expect(changes).toBe(0)
    await call('policies-set-mode', { mode: 'observe' })
    expect(changes).toBe(1)
    await call('policies-rules-reset')
    expect(changes).toBe(2)
    // It says which change it was, so the recorder knows whether the mode may have turned
    expect(told).toEqual(['policies-set-mode', 'policies-rules-reset'])
  })

  it('lands two concurrent changes in order', async () => {
    const h = await rig()
    await writeAuditPolicy(h.profileDir, { ...STARTER_POLICY, mode: 'observe' })
    const [a, b] = await Promise.all([
      h.call('policies-rules-add', { effect: 'deny', action: 'package.install' }),
      h.call('policies-set-otherwise', { otherwise: 'deny' })
    ])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(await readAuditPolicy(h.profileDir)).toMatchObject({ mode: 'observe', otherwise: 'deny', rules: [...STARTER_POLICY.rules, ruleOf(a)] })
  })
})
