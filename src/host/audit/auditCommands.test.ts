// Observe mode (design §7, §8, §12): the Host's audit commands read the records back with a decision computed from the
// rules in force at the read, so editing a rule changes what the past would have been. For the app and the CLI only, and
// never for an agent's shell, which must not read the log its own calls are kept in.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../core/testFixtures'
import { profilePaths } from '../../core/profile/paths'
import { STARTER_POLICY, writeAuditPolicy } from '../../core/audit/policy'
import { appendRecords, type AuditRecord } from '../../core/audit/store'
import { AUDIT_COMMANDS, createHostAudit } from './auditCommands'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})

const NOW = Date.parse('2026-10-23T03:00:00.000Z')
let n = 0
const rec = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  id: `au_${String(++n).padStart(4, '0')}`,
  at: new Date(NOW + n * 1000).toISOString(),
  sessionId: 'sess_a',
  provider: 'claude',
  kind: 'terminal',
  accountId: 'acc1',
  source: 'claude-hook',
  providerTool: 'Bash',
  action: 'git.remote.write',
  target: 'git push',
  confidence: 'high',
  status: 'ok',
  ...over
})

type Role = 'app' | 'cli' | 'mcp' | 'controller' | 'plugin'

async function rig(records: AuditRecord[] = []) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-host-audit-'))
  dirs.push(profileDir)
  if (records.length > 0) await appendRecords(profileDir, records, { now: () => NOW })
  const audit = createHostAudit({ profileDir })
  const call = (cmd: string, args: Record<string, unknown> = {}, extra: { role?: Role; agentRefusal?: string } = {}) => {
    const marks = { effects: 0 }
    return audit
      .command({ cmd, args, role: (extra.role ?? 'app') as 'app', ...(extra.agentRefusal ? { agentRefusal: extra.agentRefusal } : {}), marks })
      .then((r) => ({ ...r, marks }))
  }
  return { profileDir, call }
}

type Listed = {
  records: Array<AuditRecord & { decision: string; ruleId?: string }>
  truncated: boolean
  next: { until: string; beforeId: string } | null
}
const listed = (r: { body: unknown }): Listed => r.body as Listed

describe('createHostAudit', () => {
  const push = rec()
  const readInside = rec({ action: 'filesystem.read', target: 'src/a.ts', insideProject: true, confidence: 'exact', providerTool: 'Read' })
  const writeOutside = rec({ action: 'filesystem.write', target: 'outside project: x.ts', insideProject: false, confidence: 'exact', providerTool: 'Write', sessionId: 'sess_b', jobId: 'job1', runId: 'run1', taskId: 'task1', agentProfileId: 'ap1' })
  const mystery = rec({ action: 'process.execute', target: 'foo-bar.sh', confidence: 'unknown' })
  const compound = rec({ action: 'process.execute', target: 'npm test', confidence: 'heuristic', commands: [{ action: 'process.execute' }, { action: 'git.remote.write' }] })
  const all = [push, readInside, writeOutside, mystery, compound]

  it('lists newest first with the decision the starter rules give while there is no rules file, and writes nothing', async () => {
    const h = await rig(all)
    const r = await h.call('audit-list')
    expect(r.status).toBe(200)
    expect(r.marks.effects).toBe(0)
    const { records, truncated } = listed(r)
    expect(truncated).toBe(false)
    expect(records.map((x) => [x.id, x.decision, x.ruleId])).toEqual([
      [compound.id, 'unknown', undefined],
      [mystery.id, 'unknown', undefined],
      [writeOutside.id, 'would-deny', 'starter-write-outside'],
      [readInside.id, 'allow', undefined],
      [push.id, 'would-deny', 'starter-git-remote-write']
    ])
    expect(records[2]).toEqual({ ...writeOutside, decision: 'would-deny', ruleId: 'starter-write-outside' })
    expect(await fs.stat(profilePaths(h.profileDir).auditPolicy).then(() => true, () => false)).toBe(false)
  })

  it('filters by session, Job, Run, Task, agent profile, action, decision and period, and says when the limit cut it', async () => {
    const h = await rig(all)
    const ids = async (args: Record<string, unknown>): Promise<string[]> => listed(await h.call('audit-list', args)).records.map((x) => x.id)
    expect(await ids({ sessionId: 'sess_b' })).toEqual([writeOutside.id])
    expect(await ids({ jobId: 'job1' })).toEqual([writeOutside.id])
    expect(await ids({ runId: 'run1' })).toEqual([writeOutside.id])
    expect(await ids({ taskId: 'task1' })).toEqual([writeOutside.id])
    expect(await ids({ agentProfileId: 'ap1' })).toEqual([writeOutside.id])
    expect(await ids({ action: 'filesystem.read' })).toEqual([readInside.id])
    expect(await ids({ action: 'filesystem.*' })).toEqual([writeOutside.id, readInside.id])
    expect(await ids({ decision: 'would-deny' })).toEqual([writeOutside.id, push.id])
    expect(await ids({ decision: 'allow' })).toEqual([readInside.id])
    expect(await ids({ since: readInside.at, until: mystery.at })).toEqual([writeOutside.id, readInside.id])
    const cut = listed(await h.call('audit-list', { limit: 2 }))
    expect(cut.records.map((x) => x.id)).toEqual([compound.id, mystery.id])
    expect(cut.truncated).toBe(true)
    // The limit counts what the decision filter kept
    const denied = listed(await h.call('audit-list', { decision: 'would-deny', limit: 1 }))
    expect(denied.records.map((x) => x.id)).toEqual([writeOutside.id])
    expect(denied.truncated).toBe(true)
    expect(listed(await h.call('audit-list', { decision: 'would-deny', limit: 2 })).truncated).toBe(false)
  })

  it('lists 200 by default and at most 2000', async () => {
    const h = await rig(Array.from({ length: 205 }, () => rec({ action: 'git.read', target: 'git status' })))
    const r = listed(await h.call('audit-list'))
    expect(r.records).toHaveLength(200)
    expect(r.truncated).toBe(true)
    expect((await h.call('audit-list', { limit: 2000 })).status).toBe(200)
    for (const limit of [0, 2001, 1.5, 'x']) expect((await h.call('audit-list', { limit })).status, String(limit)).toBe(400)
  })

  it('says where the next page starts, and paging by it sees each record once though several share a time', async () => {
    const t = new Date(NOW + 10_000).toISOString()
    const same = ['au_s1', 'au_s4', 'au_s2', 'au_s5', 'au_s3'].map((id) => rec({ id, at: t, action: 'git.read', target: 'git status' }))
    const h = await rig([rec({ id: 'au_old', at: new Date(NOW).toISOString() }), ...same, rec({ id: 'au_new', at: new Date(NOW + 20_000).toISOString() })])
    const seen: string[] = []
    let next: Listed['next'] = null
    let pages = 0
    do {
      const r = listed(await h.call('audit-list', { limit: 2, ...next }))
      seen.push(...r.records.map((x) => x.id))
      expect(r.next === null).toBe(!r.truncated)
      if (r.next) expect(r.next).toEqual({ until: r.records[1].at, beforeId: r.records[1].id })
      next = r.next
      pages++
    } while (next && pages < 10)
    expect(seen).toEqual(['au_new', 'au_s5', 'au_s4', 'au_s3', 'au_s2', 'au_s1', 'au_old'])
    expect(pages).toBe(4)
    // A decision filter pages the same way
    const denied = listed(await h.call('audit-list', { decision: 'would-deny', limit: 1 }))
    expect(denied.records.map((x) => x.id)).toEqual(['au_new'])
    expect(listed(await h.call('audit-list', { decision: 'would-deny', limit: 1, ...denied.next })).records.map((x) => x.id)).toEqual(['au_old'])
  })

  it('refuses filters it cannot read', async () => {
    const h = await rig()
    const until = new Date(NOW).toISOString()
    for (const args of [
      { since: 'yesterday' },
      { until: 5 },
      { decision: 'deny' },
      { sessionId: 7 },
      { action: '' },
      { action: 'git.push' },
      { action: 'foo.*' },
      { action: 'git*x' },
      // beforeId goes with until, as the next page's cursor
      { beforeId: 'au_1' },
      { until, beforeId: 5 },
      { until, beforeId: '' }
    ]) {
      const r = await h.call('audit-list', args)
      expect(r.status, JSON.stringify(args)).toBe(400)
      expect((await h.call('audit-summary', args)).status, JSON.stringify(args)).toBe(400)
    }
  })

  it('sums by decision and by action', async () => {
    const h = await rig(all)
    const r = await h.call('audit-summary')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      allow: 1,
      wouldDeny: 2,
      unknown: 2,
      byAction: {
        'git.remote.write': { allow: 0, wouldDeny: 1, unknown: 0 },
        'filesystem.read': { allow: 1, wouldDeny: 0, unknown: 0 },
        'filesystem.write': { allow: 0, wouldDeny: 1, unknown: 0 },
        'process.execute': { allow: 0, wouldDeny: 0, unknown: 2 }
      },
      stoppedAtLimit: false
    })
    expect((await h.call('audit-summary', { sessionId: 'sess_b' })).body).toEqual({
      allow: 0,
      wouldDeny: 1,
      unknown: 0,
      byAction: { 'filesystem.write': { allow: 0, wouldDeny: 1, unknown: 0 } },
      stoppedAtLimit: false
    })
  })

  it('says when the records of a day in the period stopped at the size', async () => {
    const h = await rig()
    const dir = profilePaths(h.profileDir).auditRecords
    await fs.mkdir(dir, { recursive: true })
    const day = new Date(NOW)
    const name = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}.jsonl`
    await fs.writeFile(path.join(dir, name), 'x'.repeat(1999) + '\n')
    await appendRecords(h.profileDir, [rec()], { now: () => NOW, maxBytes: 1000 })
    expect((await h.call('audit-summary')).body).toMatchObject({ stoppedAtLimit: true })
    expect((await h.call('audit-summary', { until: new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString() })).body).toMatchObject({ stoppedAtLimit: false })
  })

  it('judges with the rules in force at the read: editing a rule changes the summary of the past (acceptance 5)', async () => {
    const h = await rig(all)
    const before = (await h.call('audit-summary')).body as { allow: number; wouldDeny: number }
    expect([before.allow, before.wouldDeny]).toEqual([1, 2])
    await writeAuditPolicy(h.profileDir, {
      ...STARTER_POLICY,
      mode: 'observe',
      rules: STARTER_POLICY.rules.map((r) => (r.action === 'git.remote.write' ? { ...r, effect: 'allow' as const } : r))
    })
    // The push is allowed now, and so is the compound line whose push made it unknown
    const after = (await h.call('audit-summary')).body as { allow: number; wouldDeny: number; unknown: number }
    expect([after.allow, after.wouldDeny, after.unknown]).toEqual([3, 1, 1])
    const pushed = listed(await h.call('audit-list', { action: 'git.remote.write' })).records[0]
    expect([pushed.decision, pushed.ruleId]).toEqual(['allow', 'starter-git-remote-write'])
  })

  it('answers empty when nothing was recorded', async () => {
    const h = await rig()
    expect((await h.call('audit-list')).body).toEqual({ records: [], truncated: false, next: null })
    expect((await h.call('audit-summary')).body).toEqual({ allow: 0, wouldDeny: 0, unknown: 0, byAction: {}, stoppedAtLimit: false })
  })

  it('answers 409 while the rules file is damaged, since no decision can be made', async () => {
    const h = await rig(all)
    await fs.writeFile(profilePaths(h.profileDir).auditPolicy, '{ not json')
    for (const cmd of ['audit-list', 'audit-summary']) {
      const r = await h.call(cmd)
      expect(r.status).toBe(409)
      // The reason the screen offers starting over for (Task 8 fix round 1, ruling 1)
      expect(r.body, cmd).toMatchObject({ reason: 'damaged' })
    }
  })

  it('gives no reason for a rules file it could not read at all', async () => {
    const h = await rig(all)
    await fs.mkdir(profilePaths(h.profileDir).auditPolicy, { recursive: true })
    const r = await h.call('audit-list')
    expect(r.status).toBe(409)
    expect(r.body).not.toHaveProperty('reason')
  })

  it('is for the app and the CLI only, and refuses an agent’s shell even these reads', async () => {
    const h = await rig(all)
    expect([...AUDIT_COMMANDS].sort()).toEqual(['audit-list', 'audit-summary'])
    for (const cmd of AUDIT_COMMANDS) {
      expect((await h.call(cmd, {}, { role: 'cli' })).status).toBe(200)
      for (const role of ['mcp', 'controller', 'plugin'] as const) expect((await h.call(cmd, {}, { role })).status, `${cmd} ${role}`).toBe(403)
      const agent = await h.call(cmd, {}, { role: 'cli', agentRefusal: `${cmd} is for a person` })
      expect(agent.status).toBe(403)
      expect(agent.body).toEqual({ error: `${cmd} is for a person` })
    }
  })
})
