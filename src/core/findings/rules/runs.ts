// token-spike (lifecycle design §4.11, plan ruling 8): a Run that spent at least 3 times the median of its group's other
// Runs in the last 30 days, with at least 5 Runs in the group. Tokens only: cost stays unknown (inventory §17 decision
// 6). The token totals are kept with Runs whether Observe is on or not, so it does not wait for Observe (§4).
import { runTokensOf } from '../../orchestration/publicViews'
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

/** The middle value, or the mean of the two middle values for an even count. */
function median(values: readonly number[]): number {
  const v = [...values].sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

/**
 * Each Run created in the last 30 days (`JobRun.createdAt`) whose tokens were read is placed in a group: its Job's
 * profile, else its first started Dispatch's profile, else that Dispatch's account. A Run with no tokens read is left
 * out, never counted as 0, and so is one with no group. A Run is raised when its total (its Tasks' plus its
 * coordinator's, runTokensOf) is at least 3 times the median of the group's other Runs, the group holds at least 5 Runs
 * counting it, and that median is above 0.
 */
export function tokenSpikeFindings(i: FindingInputs): Finding[] {
  const { orch, spent } = i
  if (orch === undefined || spent === undefined) return []
  const since = i.nowMs - SPIKE_WINDOW_DAYS * DAY_MS
  const runOfTask = new Map<string, string>()
  for (const t of orch.tasks) if (t.runId !== undefined) runOfTask.set(t.id, t.runId)
  const firstDispatch = new Map<string, Dispatch>()
  for (const d of orch.dispatches) {
    const runId = runOfTask.get(d.taskId)
    if (runId === undefined) continue
    const seen = firstDispatch.get(runId)
    if (seen === undefined || Date.parse(d.startedAt) < Date.parse(seen.startedAt)) firstDispatch.set(runId, d)
  }

  const jobs = new Map(orch.jobs.map((j) => [j.id, j]))
  const groups = new Map<string, Placed[]>()
  for (const run of orch.runs) {
    if (!(Date.parse(run.createdAt) >= since)) continue
    const { tokens, coordinatorTokens } = runTokensOf(orch, run.id, spent)
    if (tokens === undefined && coordinatorTokens === undefined) continue
    const total = (tokens?.total ?? 0) + (coordinatorTokens?.total ?? 0)
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
    for (const m of members) {
      const mid = median(members.filter((o) => o !== m).map((o) => o.total))
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
