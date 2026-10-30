// token-spike (lifecycle design §4.11, plan ruling 8): a Run that spent at least 3 times the median of its group's other
// Runs in the last 30 days, with at least 5 Runs in the group. Tokens only: cost stays unknown (inventory §17 decision
// 6). The token totals are kept with Runs whether Observe is on or not, so it does not wait for Observe (§4). It runs on
// the Host's thread, so the state is read in a few passes and each group sorted once (final fix list M-3), never once per
// Run.
import type { SpentTokens } from '../../orchestration/publicViews'
import type { Dispatch, JobRun } from '../../orchestration/types'
import type { Message } from '../../i18n'
import type { FindingInputs } from '../compute'
import { DAY_MS } from '../history'
import { finding, runName } from '../make'
import type { Finding } from '../types'

export const SPIKE_TIMES = 3
export const SPIKE_MIN_RUNS = 5
export const SPIKE_WINDOW_DAYS = 30

/** A Run in its group: by profile, or by account when no profile names it. */
type Placed = { run: JobRun; total: number } & ({ profileId: string } | { profileId?: undefined; accountId: string })

/** The median of `sorted` (ascending) without its value at `k`: the middle value of the rest, or the mean of the two
 *  middle ones for an even count. */
function medianWithout(sorted: readonly number[], k: number): number {
  const rest = sorted.length - 1
  const at = (j: number): number => sorted[j < k ? j : j + 1]
  const mid = Math.floor(rest / 2)
  return rest % 2 === 1 ? at(mid) : (at(mid - 1) + at(mid)) / 2
}

/** What a Run's sessions spent, summed as runTokensOf sums it: its Tasks' Dispatches' sessions apart from its
 *  coordinator's, input and output apart, each present only when something was read for it. */
type Sums = { tasks?: { input: number; output: number }; coordinator?: { input: number; output: number } }

const totalOf = (part: Sums['tasks']): number => (part === undefined ? 0 : part.input + part.output)

/** Every Run's tokens in one pass over what was spent (runTokensOf reads all of it for each Run it is asked about). */
function sumsByRun(runOfDispatch: ReadonlyMap<string, string>, spent: readonly SpentTokens[]): Map<string, Sums> {
  const sums = new Map<string, Sums>()
  const add = (runId: string, part: keyof Sums, e: SpentTokens): void => {
    let s = sums.get(runId)
    if (s === undefined) sums.set(runId, (s = {}))
    const into = (s[part] ??= { input: 0, output: 0 })
    into.input += e.input
    into.output += e.output
  }
  for (const e of spent) {
    const runId = e.dispatchId === undefined ? undefined : runOfDispatch.get(e.dispatchId)
    if (runId !== undefined) add(runId, 'tasks', e)
    if (e.coordinatorOf !== undefined) add(e.coordinatorOf, 'coordinator', e)
  }
  return sums
}

/**
 * Each Run created in the last 30 days (`JobRun.createdAt`) whose tokens were read is placed in a group: its Job's
 * profile, else its first started Dispatch's profile, else that Dispatch's account. A Run with no tokens read is left
 * out, never counted as 0, and so is one with no group. A Run is raised when its total (its Tasks' plus its
 * coordinator's, as runTokensOf counts them) is at least 3 times the median of the group's other Runs, the group holds at
 * least 5 Runs counting it, and that median is above 0.
 */
export function tokenSpikeFindings(i: FindingInputs): Finding[] {
  const { orch, spent } = i
  if (orch === undefined || spent === undefined) return []
  const since = i.nowMs - SPIKE_WINDOW_DAYS * DAY_MS
  const runOfTask = new Map<string, string>()
  for (const t of orch.tasks) if (t.runId !== undefined) runOfTask.set(t.id, t.runId)
  const firstDispatch = new Map<string, Dispatch>()
  const runOfDispatch = new Map<string, string>()
  for (const d of orch.dispatches) {
    const runId = runOfTask.get(d.taskId)
    if (runId === undefined) continue
    runOfDispatch.set(d.id, runId)
    const seen = firstDispatch.get(runId)
    if (seen === undefined || Date.parse(d.startedAt) < Date.parse(seen.startedAt)) firstDispatch.set(runId, d)
  }
  const sums = sumsByRun(runOfDispatch, spent)

  const jobs = new Map(orch.jobs.map((j) => [j.id, j]))
  const groups = new Map<string, Placed[]>()
  for (const run of orch.runs) {
    if (!(Date.parse(run.createdAt) >= since)) continue
    const s = sums.get(run.id)
    if (s === undefined) continue
    const total = totalOf(s.tasks) + totalOf(s.coordinator)
    const first = firstDispatch.get(run.id)
    const profileId = jobs.get(run.jobId)?.agentProfileId ?? first?.agentProfileId
    // No Dispatch and no Job profile: no group to judge it in
    const placed: Placed | undefined =
      profileId !== undefined ? { run, total, profileId } : first !== undefined ? { run, total, accountId: first.accountId } : undefined
    if (placed === undefined) continue
    const key = placed.profileId !== undefined ? placed.profileId : `account:${placed.accountId}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [placed])
    else group.push(placed)
  }

  const nameOf = (profileId: string): string => i.profiles?.find((p) => p.id === profileId)?.name ?? profileId
  const out: Finding[] = []
  for (const members of groups.values()) {
    if (members.length < SPIKE_MIN_RUNS) continue
    // Sorted once; each Run's median of the others is read from that by its own place in it
    const order = members.map((m, at) => ({ total: m.total, at })).sort((a, b) => a.total - b.total)
    const sorted = order.map((o) => o.total)
    const place: number[] = []
    order.forEach((o, k) => (place[o.at] = k))
    for (const [at, m] of members.entries()) {
      const mid = medianWithout(sorted, place[at])
      if (!(mid > 0) || m.total < SPIKE_TIMES * mid) continue
      const group: Message =
        m.profileId !== undefined
          ? { key: 'findings.group.profile', params: { name: nameOf(m.profileId) } }
          : { key: 'findings.group.account', params: { id: m.accountId } }
      out.push(
        finding({
          rule: 'token-spike',
          subject: { kind: 'run', id: m.run.id, name: runName(orch, m.run.id) },
          profileIds: m.profileId !== undefined ? [m.profileId] : [],
          // Whole tokens for the median a person reads; the times are taken from the exact median, to one place
          message: {
            key: 'findings.reason.tokenSpike',
            params: { total: m.total, median: Math.round(mid), times: Math.round((m.total / mid) * 10) / 10, group }
          },
          suggestion: { key: 'findings.do.openRun' },
          open: { kind: 'run', runId: m.run.id }
        })
      )
    }
  }
  return out
}
