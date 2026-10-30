// The profile findings (lifecycle design §4.1-§4.4): unused, duplicated, pointing at something gone, and failing. Each
// is advice with one action; none of them acts.
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { emptyState, type OrchState } from '../../orchestration/state'
import type { Dispatch, Job, JobRun, Task } from '../../orchestration/types'
import type { AgentProfile } from '../../agentProfiles/types'
import type { ExtensionEntry } from '../../extensions/types'
import { absPath } from '../../testPaths'
import type { FindingInputs } from '../compute'
import { brokenProfileFindings, brokenWorkFindings, duplicateProfileFindings, failingProfileFindings, unusedProfileFindings } from './profiles'

const NOW = Date.parse('2026-10-30T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString()
const PROJ = absPath('proj')

/** A profile named after its id without the prefix, used yesterday. */
const prof = (id: string, over: Partial<AgentProfile> = {}): AgentProfile => ({
  id,
  name: id.replace(/^ap_/, ''),
  status: 'active',
  accountIds: ['acc_1'],
  mcpExclude: [],
  permission: 'inherit',
  sandbox: false,
  createdAt: ago(200),
  updatedAt: ago(200),
  lastUsedAt: ago(1),
  ...over
})
const job = (id: string, over: Partial<Job> = {}): Job => ({ id, objective: `Objective of ${id}`, cwd: PROJ, createdAt: ago(40), ...over })
const run = (id: string, jobId: string, ordinal: number, createdAt = ago(1)): JobRun => ({ id, jobId, ordinal, createdAt })
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  spec: 's',
  deps: [],
  status: 'ready',
  consecutiveFailures: 0,
  createdAt: ago(1),
  updatedAt: ago(1),
  ...over
})
const dispatch = (id: string, taskId: string, over: Partial<Dispatch> = {}): Dispatch => ({
  id,
  taskId,
  provider: 'claude',
  accountId: 'acc_1',
  sessionId: `s_${id}`,
  cwd: PROJ,
  specPath: PROJ,
  startedAt: ago(1),
  workerState: 'ready',
  retained: false,
  ...over
})
const orch = (over: Partial<OrchState> = {}): OrchState => ({ ...emptyState(), ...over })
const mcp = (id: string): ExtensionEntry => ({ id, kind: 'mcp', name: id, transport: 'stdio', command: 'x', env: {}, providers: ['claude'], importedFrom: 'acc_1', enabled: true })
const skill = (id: string): ExtensionEntry => ({ id, kind: 'skill', name: id, hash: 'h', providers: ['claude'], importedFrom: 'acc_1', enabled: true })
const inputs = (over: Partial<FindingInputs> = {}): FindingInputs => ({
  nowMs: NOW,
  platform: 'linux',
  findingsSince: ago(400),
  profiles: [],
  accounts: [
    { id: 'acc_1', provider: 'claude' },
    { id: 'acc_2', provider: 'claude' }
  ],
  orch: orch(),
  registry: [mcp('ext_1')],
  ...over
})

describe('unused-profile (§4.1)', () => {
  it('lastUsedAt 91 days ago raises unused-profile with days 91, suggestion archive, open profiles [id]', () => {
    const found = unusedProfileFindings(inputs({ profiles: [prof('ap_a', { lastUsedAt: ago(91) }), prof('ap_b', { lastUsedAt: ago(89) })] }))
    expect(found).toEqual([
      {
        key: 'unused-profile:ap_a',
        rule: 'unused-profile',
        subject: { kind: 'profile', id: 'ap_a', name: 'a' },
        profileIds: ['ap_a'],
        message: { key: 'findings.reason.unusedProfile', params: { days: 91 } },
        reason: 'Not used in 91 days.',
        suggestion: { key: 'findings.do.archiveProfile' },
        action: 'Archive the profile.',
        open: { kind: 'profiles', profileIds: ['ap_a'] },
        ignored: false
      }
    ])
    // Never used: counted from when it was made, and says so
    const never = unusedProfileFindings(inputs({ profiles: [prof('ap_c', { createdAt: ago(120), lastUsedAt: undefined })] }))
    expect(never.map((f) => [f.message, f.reason])).toEqual([
      [{ key: 'findings.reason.unusedProfileNever', params: { days: 120 } }, 'Never used since it was made 120 days ago.']
    ])
  })

  it('created 89 days ago and never used is not raised', () => {
    expect(unusedProfileFindings(inputs({ profiles: [prof('ap_a', { createdAt: ago(89), lastUsedAt: undefined })] }))).toEqual([])
  })

  it('held by a scheduled Job is not raised', () => {
    const old = { lastUsedAt: ago(150) }
    const profiles = [prof('ap_own', old), prof('ap_plan', old), prof('ap_free', old)]
    const s = orch({
      // A scheduled Job holds the profile it runs as, paused or not, and each its plan's Tasks name (lifecycle design §5)
      jobs: [
        job('job_own', { schedule: { kind: 'daily', time: '09:00' }, agentProfileId: 'ap_own' }),
        job('job_plan', { schedule: { kind: 'interval', minutes: 60 }, paused: true }),
        // A Job with no schedule fires no more, and holds nothing for this rule
        job('job_once', { agentProfileId: 'ap_free' })
      ],
      tasks: [task('t_plan', { jobId: 'job_plan', agentProfileId: 'ap_plan' })]
    })
    expect(unusedProfileFindings(inputs({ profiles, orch: s })).map((f) => f.subject.id)).toEqual(['ap_free'])
  })

  it('archived profiles are never judged', () => {
    const p = prof('ap_a', { status: 'archived', lastUsedAt: ago(200), archivedAt: ago(100) })
    expect(unusedProfileFindings(inputs({ profiles: [p] }))).toEqual([])
    expect(failingProfileFindings(inputs({ profiles: [p] }))).toEqual([])
  })
})

describe('duplicate-profile (§4.2)', () => {
  const fp = (accountIds: string[], mcpExclude: string[], permission: string, sandbox: boolean): string =>
    'fp-' + createHash('sha256').update(JSON.stringify([accountIds, [...mcpExclude].sort(), permission, sandbox])).digest('hex').slice(0, 12)

  it('two active profiles with the same accounts in order, the same exclusion set, permission and sandbox are one duplicate-profile finding', () => {
    const same = { accountIds: ['acc_1', 'acc_2'], mcpExclude: ['ext_1'], permission: 'ask' as const, sandbox: true }
    const profiles = [
      // Name and description are not part of it; the members are in the order they were made
      prof('ap_b', { ...same, createdAt: ago(50), description: 'the copy' }),
      prof('ap_a', { ...same, createdAt: ago(100) }),
      prof('ap_c', { ...same, permission: 'bypass' }),
      prof('ap_d', { ...same, sandbox: false }),
      prof('ap_old', { ...same, status: 'archived' })
    ]
    const found = duplicateProfileFindings(inputs({ profiles }))
    expect(found).toEqual([
      {
        key: `duplicate-profile:${fp(same.accountIds, same.mcpExclude, 'ask', true)}`,
        rule: 'duplicate-profile',
        subject: { kind: 'profiles', id: fp(same.accountIds, same.mcpExclude, 'ask', true), name: 'a, b' },
        profileIds: ['ap_a', 'ap_b'],
        message: { key: 'findings.reason.duplicateProfile', params: { others: 'b' } },
        reason: 'Same accounts, MCP exclusions, permission and sandbox as b.',
        suggestion: { key: 'findings.do.keepOne' },
        action: 'Keep one and archive the others.',
        open: { kind: 'profiles', profileIds: ['ap_a', 'ap_b'] },
        ignored: false
      }
    ])
    expect(found[0].subject.id).toMatch(/^fp-[0-9a-f]{12}$/)
  })

  it('a different account order is not a duplicate', () => {
    const profiles = [prof('ap_a', { accountIds: ['acc_1', 'acc_2'] }), prof('ap_b', { accountIds: ['acc_2', 'acc_1'] })]
    expect(duplicateProfileFindings(inputs({ profiles }))).toEqual([])
  })

  it('the same exclusions in another order is a duplicate', () => {
    const profiles = [
      prof('ap_a', { mcpExclude: ['ext_1', 'ext_2'], createdAt: ago(9) }),
      prof('ap_b', { mcpExclude: ['ext_2', 'ext_1'], createdAt: ago(8) }),
      prof('ap_c', { mcpExclude: ['ext_1', 'ext_2'], createdAt: ago(7) })
    ]
    const found = duplicateProfileFindings(inputs({ profiles }))
    expect(found.map((f) => [f.subject.name, f.profileIds, f.reason])).toEqual([
      ['a, b, c', ['ap_a', 'ap_b', 'ap_c'], 'Same accounts, MCP exclusions, permission and sandbox as b, c.']
    ])
  })
})

describe('broken-reference (§4.3)', () => {
  it('a profile naming a removed account is broken-reference with that id', () => {
    const found = brokenProfileFindings(inputs({ profiles: [prof('ap_a', { accountIds: ['acc_1', 'acc_9'] }), prof('ap_b')] }))
    expect(found).toEqual([
      {
        key: 'broken-reference:ap_a',
        rule: 'broken-reference',
        subject: { kind: 'profile', id: 'ap_a', name: 'a' },
        profileIds: ['ap_a'],
        message: { key: 'findings.reason.removedAccount', params: { ids: 'acc_9' } },
        reason: 'Uses an account that was removed: acc_9.',
        suggestion: { key: 'findings.do.editProfile' },
        action: 'Edit the profile.',
        open: { kind: 'profiles', profileIds: ['ap_a'] },
        ignored: false
      }
    ])
  })

  it('a profile excluding a removed shared MCP server is broken-reference', () => {
    // ext_2 is a skill, not an MCP server: an exclusion naming it names no server there is
    const registry = [mcp('ext_1'), skill('ext_2')]
    const found = brokenProfileFindings(inputs({ registry, profiles: [prof('ap_a', { mcpExclude: ['ext_1', 'ext_2', 'ext_3'] })] }))
    expect(found.map((f) => [f.key, f.message, f.reason])).toEqual([
      ['broken-reference:ap_a', { key: 'findings.reason.removedMcp', params: { ids: 'ext_2, ext_3' } }, 'Leaves out an MCP server that was removed: ext_2, ext_3.']
    ])
    // Both at once are one finding that says both
    const both = brokenProfileFindings(inputs({ registry, profiles: [prof('ap_a', { accountIds: ['acc_9'], mcpExclude: ['ext_3'] })] }))
    expect(both).toHaveLength(1)
    expect(both[0].reason).toBe('Uses an account that was removed: acc_9. Leaves out an MCP server that was removed: ext_3.')
    // An archived profile is not judged
    expect(brokenProfileFindings(inputs({ registry, profiles: [prof('ap_a', { status: 'archived', accountIds: ['acc_9'] })] }))).toEqual([])
  })

  it('an unfinished Job naming a gone profile is broken-reference on the Job', () => {
    const s = orch({
      jobs: [
        job('job_new', { agentProfileId: 'ap_gone', objective: 'Ship the\n  release notes' }),
        // Ended: its only Run completed, so it names a profile nothing resolves again
        job('job_done', { agentProfileId: 'ap_gone' })
      ],
      runs: [run('run_done', 'job_done', 1)],
      tasks: [task('t_done', { runId: 'run_done', status: 'completed' })]
    })
    expect(brokenWorkFindings(inputs({ profiles: [prof('ap_a')], orch: s }))).toEqual([
      {
        key: 'broken-reference:job_new',
        rule: 'broken-reference',
        subject: { kind: 'job', id: 'job_new', name: 'Ship the release notes' },
        profileIds: ['ap_gone'],
        message: { key: 'findings.reason.profileGone', params: { id: 'ap_gone' } },
        reason: 'Runs as agent profile ap_gone, which no longer exists.',
        suggestion: { key: 'findings.do.repointJob' },
        action: 'Point the Job at another profile.',
        open: { kind: 'job', jobId: 'job_new' },
        ignored: false
      }
    ])
  })

  it('an unfinished Task naming an archived profile is broken-reference on the Task', () => {
    const s = orch({
      jobs: [job('job_1')],
      runs: [run('run_1', 'job_1', 1)],
      tasks: [
        task('t_open', { runId: 'run_1', agentProfileId: 'ap_old', title: 'Write the tests' }),
        task('t_end', { runId: 'run_1', agentProfileId: 'ap_old', status: 'completed' })
      ]
    })
    const found = brokenWorkFindings(inputs({ profiles: [prof('ap_old', { status: 'archived' })], orch: s }))
    expect(found.map((f) => [f.key, f.subject, f.profileIds, f.reason, f.open])).toEqual([
      [
        'broken-reference:t_open',
        { kind: 'task', id: 't_open', name: 'Write the tests' },
        ['ap_old'],
        'Runs as agent profile old, which is archived.',
        { kind: 'run', runId: 'run_1' }
      ]
    ])
  })

  it('a scheduled Job whose profile is archived is not broken-reference', () => {
    const daily = { kind: 'daily' as const, time: '09:00' }
    const s = orch({
      jobs: [
        // §5 says these wait, and why: not this rule's
        job('job_sched', { schedule: daily, agentProfileId: 'ap_old' }),
        job('job_plan', { schedule: daily }),
        // A profile gone is not §5's: the fire falls back, so this one is said
        job('job_gone', { schedule: daily, agentProfileId: 'ap_gone' })
      ],
      tasks: [task('t_plan', { jobId: 'job_plan', agentProfileId: 'ap_old' })]
    })
    const found = brokenWorkFindings(inputs({ profiles: [prof('ap_old', { status: 'archived' })], orch: s }))
    expect(found.map((f) => f.key)).toEqual(['broken-reference:job_gone'])
  })
})

describe('failing-profile (§4.4)', () => {
  /** Two Runs of one Job, and a Task in each, for the Dispatches to start. */
  const work = (dispatches: Dispatch[]): OrchState =>
    orch({
      jobs: [job('job_1', { objective: 'Nightly review' })],
      runs: [run('run_1', 'job_1', 1, ago(12)), run('run_2', 'job_1', 2, ago(3))],
      tasks: [task('t_1', { runId: 'run_1' }), task('t_2', { runId: 'run_2' })],
      dispatches
    })
  const as = (outcome: Dispatch['outcome'], daysAgo: number, taskId = 't_1', agentProfileId = 'ap_a'): Partial<Dispatch> => ({
    agentProfileId,
    startedAt: ago(daysAgo),
    ...(outcome ? { outcome } : {})
  })

  it("5 Dispatches in 30 days, 3 failed, raises failing-profile naming 3 of 5 and the last failure's Run", () => {
    const s = work([
      dispatch('d1', 't_1', as('succeeded', 10)),
      dispatch('d2', 't_1', as('failed', 9)),
      dispatch('d3', 't_2', as('failed', 2)),
      dispatch('d4', 't_1', as('failed', 5)),
      dispatch('d5', 't_2', as('succeeded', 1)),
      // Another profile's are not counted
      dispatch('d6', 't_2', as('failed', 1, 't_2', 'ap_b'))
    ])
    const found = failingProfileFindings(inputs({ profiles: [prof('ap_a'), prof('ap_b')], orch: s }))
    expect(found).toEqual([
      {
        key: 'failing-profile:ap_a',
        rule: 'failing-profile',
        subject: { kind: 'profile', id: 'ap_a', name: 'a' },
        profileIds: ['ap_a'],
        message: { key: 'findings.reason.failingProfile', params: { failed: 3, total: 5, run: 'Nightly review #2' } },
        reason: '3 of its 5 worker starts in 30 days failed. The last failure was in Nightly review #2.',
        suggestion: { key: 'findings.do.openRuns' },
        action: 'Open the Runs.',
        open: { kind: 'run', runId: 'run_2' },
        ignored: false
      }
    ])
  })

  it('4 Dispatches, all failed, is not raised', () => {
    const s = work([1, 2, 3, 4].map((n) => dispatch(`d${n}`, 't_1', as('failed', n))))
    expect(failingProfileFindings(inputs({ profiles: [prof('ap_a')], orch: s }))).toEqual([])
  })

  it('a Dispatch started 31 days ago is not counted', () => {
    // Inside the 30 days, 2 of 5 failed; counting the old failure would make it 3 of 6
    const s = work([
      ...[1, 2, 3].map((n) => dispatch(`ok${n}`, 't_1', as('succeeded', n))),
      ...[4, 5].map((n) => dispatch(`bad${n}`, 't_1', as('failed', n))),
      dispatch('old', 't_1', as('failed', 31))
    ])
    expect(failingProfileFindings(inputs({ profiles: [prof('ap_a')], orch: s }))).toEqual([])
  })

  it('a Dispatch with no outcome yet is not counted', () => {
    // 3 of 4 have failed; the one still working would make it 3 of 5
    const s = work([
      ...[1, 2, 3].map((n) => dispatch(`bad${n}`, 't_1', as('failed', n))),
      dispatch('ok', 't_1', as('succeeded', 4)),
      dispatch('busy', 't_2', as(undefined, 0))
    ])
    expect(failingProfileFindings(inputs({ profiles: [prof('ap_a')], orch: s }))).toEqual([])
  })
})
