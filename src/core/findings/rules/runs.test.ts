// token-spike (lifecycle design §4.11): a Run that spent at least 3 times the median of its profile's other Runs in the
// last 30 days, with at least 5 Runs in the group. Tokens only, never a cost.
import { describe, it, expect } from 'vitest'
import { emptyState, type OrchState } from '../../orchestration/state'
import type { SpentTokens } from '../../orchestration/publicViews'
import type { AgentProfile } from '../../agentProfiles/types'
import { absPath } from '../../testPaths'
import type { FindingInputs } from '../compute'
import { tokenSpikeFindings } from './runs'

const NOW = Date.parse('2026-10-30T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString()
const PROJ = absPath('proj')

interface RunSpec {
  /** The tokens its Tasks' sessions spent, or none read. */
  tokens?: number
  /** What its coordinator spent. */
  coordinator?: number
  createdDaysAgo?: number
  /** The profile and account of its Dispatches, first started first. */
  dispatches?: Array<{ agentProfileId?: string; accountId: string }>
}

/** One Job with a Run per spec, numbered from 1, each with one Task and its Dispatches. */
function world(jobProfile: string | undefined, specs: RunSpec[]): { orch: OrchState; spent: SpentTokens[] } {
  const s: OrchState = {
    ...emptyState(),
    jobs: [{ id: 'job_1', objective: 'Nightly review', cwd: PROJ, createdAt: ago(60), ...(jobProfile ? { agentProfileId: jobProfile } : {}) }]
  }
  const spent: SpentTokens[] = []
  specs.forEach((r, i) => {
    const n = i + 1
    s.runs.push({ id: `run_${n}`, jobId: 'job_1', ordinal: n, createdAt: ago(r.createdDaysAgo ?? 1) })
    s.tasks.push({ id: `t_${n}`, runId: `run_${n}`, title: 't', spec: 's', deps: [], status: 'completed', consecutiveFailures: 0, createdAt: ago(1), updatedAt: ago(1) })
    const ds = r.dispatches ?? [{ accountId: 'acc_1' }]
    ds.forEach((d, k) => {
      s.dispatches.push({
        id: `d_${n}_${k}`,
        taskId: `t_${n}`,
        provider: 'claude',
        accountId: d.accountId,
        ...(d.agentProfileId ? { agentProfileId: d.agentProfileId } : {}),
        sessionId: `s_${n}_${k}`,
        cwd: PROJ,
        specPath: PROJ,
        // Listed later, started earlier: the first Dispatch is the first started, not the first listed
        startedAt: new Date(NOW - (r.createdDaysAgo ?? 1) * DAY + (ds.length - k) * 1000).toISOString(),
        workerState: 'ready',
        outcome: 'succeeded',
        retained: false
      })
    })
    if (r.tokens !== undefined) spent.push({ sessionId: `s_${n}_0`, dispatchId: `d_${n}_0`, input: r.tokens / 2, output: r.tokens / 2 })
    if (r.coordinator !== undefined) spent.push({ sessionId: `c_${n}`, coordinatorOf: `run_${n}`, input: r.coordinator, output: 0 })
  })
  return { orch: s, spent }
}

const prof = (id: string, name: string): AgentProfile => ({
  id, name, status: 'active', accountIds: ['acc_1'], mcpExclude: [], permission: 'inherit', sandbox: false, createdAt: ago(90), updatedAt: ago(90)
})
const inputs = (w: { orch: OrchState; spent: SpentTokens[] }, over: Partial<FindingInputs> = {}): FindingInputs => ({
  nowMs: NOW,
  platform: 'linux',
  findingsSince: ago(400),
  orch: w.orch,
  spent: w.spent,
  ...over
})
const four = (r: RunSpec = {}): RunSpec[] => [1, 2, 3, 4].map(() => ({ tokens: 1000, ...r }))

describe('token-spike (§4.11)', () => {
  it('a Run of 3000 tokens beside four of 1000 in the same profile is a token-spike: total 3000, median 1000, times 3', () => {
    const w = world('ap_a', [...four(), { tokens: 3000 }])
    expect(tokenSpikeFindings(inputs(w, { profiles: [prof('ap_a', 'Reviewer')] }))).toEqual([
      {
        key: 'token-spike:run_5',
        rule: 'token-spike',
        subject: { kind: 'run', id: 'run_5', name: 'Nightly review #5' },
        profileIds: ['ap_a'],
        message: {
          key: 'findings.reason.tokenSpike',
          params: { total: 3000, median: 1000, times: 3, group: { key: 'findings.group.profile', params: { name: 'Reviewer' } } }
        },
        reason: 'Used 3000 tokens, 3 times the median of 1000 for agent profile Reviewer.',
        suggestion: { key: 'findings.do.openRun' },
        action: 'Open the Run.',
        open: { kind: 'run', runId: 'run_5' },
        ignored: false
      }
    ])
    // Without the profiles read, the group is named by its id; times is rounded to one place
    const odd = world('ap_a', [...four(), { tokens: 3333 }])
    const [f] = tokenSpikeFindings(inputs(odd))
    expect(f.message.params).toMatchObject({ times: 3.3, group: { key: 'findings.group.profile', params: { name: 'ap_a' } } })
  })

  it('with four Runs in the group (the spiking one included) nothing is raised', () => {
    const w = world('ap_a', [{ tokens: 1000 }, { tokens: 1000 }, { tokens: 1000 }, { tokens: 3000 }])
    expect(tokenSpikeFindings(inputs(w))).toEqual([])
  })

  it("Runs with no profile group by their first Dispatch's account", () => {
    // acc_1's Dispatch is listed second but started first
    const first = { dispatches: [{ accountId: 'acc_2' }, { accountId: 'acc_1' }] }
    const w = world(undefined, [
      ...four(first),
      { tokens: 3000, ...first },
      // Another account's Runs are another group, too few to judge, and do not move this one's median
      { tokens: 9000, dispatches: [{ accountId: 'acc_2' }] },
      { tokens: 9000, dispatches: [{ accountId: 'acc_2' }] }
    ])
    const found = tokenSpikeFindings(inputs(w))
    expect(found.map((f) => [f.key, f.profileIds, f.message.params?.group, f.reason])).toEqual([
      ['token-spike:run_5', [], { key: 'findings.group.account', params: { id: 'acc_1' } }, 'Used 3000 tokens, 3 times the median of 1000 for account acc_1.']
    ])
    // With no Job profile, the first Dispatch's profile groups them
    const byDispatch = world(undefined, [...four({ dispatches: [{ agentProfileId: 'ap_b', accountId: 'acc_1' }] }), { tokens: 3000, dispatches: [{ agentProfileId: 'ap_b', accountId: 'acc_1' }] }])
    expect(tokenSpikeFindings(inputs(byDispatch)).map((f) => [f.key, f.profileIds])).toEqual([['token-spike:run_5', ['ap_b']]])
    // A Run with no Dispatch and no Job profile has no group, and is passed over
    expect(tokenSpikeFindings(inputs(world(undefined, [...four({ dispatches: [] }), { tokens: 3000, dispatches: [] }])))).toEqual([])
  })

  it('a Run created 31 days ago is outside the group', () => {
    const w = world('ap_a', [{ tokens: 1000, createdDaysAgo: 31 }, { tokens: 1000 }, { tokens: 1000 }, { tokens: 1000 }, { tokens: 3000 }])
    expect(tokenSpikeFindings(inputs(w))).toEqual([])
    // Inside the window it counts
    const inside = world('ap_a', [{ tokens: 1000, createdDaysAgo: 29 }, { tokens: 1000 }, { tokens: 1000 }, { tokens: 1000 }, { tokens: 3000 }])
    expect(tokenSpikeFindings(inputs(inside)).map((f) => f.key)).toEqual(['token-spike:run_5'])
    // And a spike older than the window is not judged
    const old = world('ap_a', [...four(), { tokens: 9000, createdDaysAgo: 31 }])
    expect(tokenSpikeFindings(inputs(old))).toEqual([])
  })

  it("the Run's total is its Tasks' plus its coordinator's tokens", () => {
    const w = world('ap_a', [...four(), { tokens: 2000, coordinator: 1000 }])
    expect(tokenSpikeFindings(inputs(w)).map((f) => f.message.params)).toEqual([
      { total: 3000, median: 1000, times: 3, group: { key: 'findings.group.profile', params: { name: 'ap_a' } } }
    ])
    // A coordinator alone is a total too
    const coordinatorOnly = world('ap_a', [...four(), { coordinator: 4000 }])
    expect(tokenSpikeFindings(inputs(coordinatorOnly)).map((f) => f.message.params?.total)).toEqual([4000])
  })

  // Final fix pass, M-3: the tokens are grouped in one pass and each group sorted once, so the work grows with the state and
  // not with its square. Counted, not timed
  it('reads the Tasks, Dispatches and spent tokens a few times over however many Runs there are, and pins a large state’s spikes', () => {
    const profileRun = (tokens: number): RunSpec => ({ tokens, dispatches: [{ agentProfileId: 'ap_a', accountId: 'acc_1' }] })
    const accountRun = (tokens: number): RunSpec => ({ tokens, dispatches: [{ accountId: 'acc_2' }] })
    const w = world(undefined, [
      ...Array.from({ length: 598 }, () => profileRun(1000)),
      profileRun(2999),
      profileRun(3000),
      // An even number of others for each: the median is the mean of the two middle ones
      ...Array.from({ length: 300 }, () => accountRun(100)),
      ...Array.from({ length: 300 }, () => accountRun(300)),
      accountRun(900)
    ])
    let reads = 0
    const counted = <T extends object>(list: T[]): T[] =>
      new Proxy(list, { get: (t, k, r) => (typeof k === 'string' && /^\d+$/.test(k) && reads++, Reflect.get(t, k, r)) })
    const orch = { ...w.orch, tasks: counted(w.orch.tasks), dispatches: counted(w.orch.dispatches) }
    const found = tokenSpikeFindings(inputs({ orch, spent: counted(w.spent) }))
    expect(found.map((f) => [f.key, f.message.params?.total, f.message.params?.median, f.message.params?.times])).toEqual([
      ['token-spike:run_600', 3000, 1000, 3],
      ['token-spike:run_1201', 900, 200, 4.5]
    ])
    expect(reads).toBeLessThanOrEqual(3 * (w.orch.tasks.length + w.orch.dispatches.length + w.spent.length))
  })

  it('a Run with no tokens read is skipped', () => {
    // Counted as 0 it would make a group of 5 with the median still 1000, and raise the spike
    const w = world('ap_a', [{ tokens: 1000 }, { tokens: 1000 }, { tokens: 1000 }, { tokens: 3000 }, {}])
    expect(tokenSpikeFindings(inputs(w))).toEqual([])
  })
})
