// The profile findings (lifecycle design §4.1 to §4.4): a profile nobody has used for 90 days, profiles that duplicate
// each other, a profile, Job or Task that points at something gone, and a profile whose workers keep failing. Each is
// advice that names one action and takes none (§1). §4.1, §4.2 and §4.4 judge active profiles only, as the spec says,
// since the person already set the archived ones aside. §4.3 judges every profile: an archived one still runs for the
// work that holds it, and one restored meets what was removed.
import { createHash } from 'node:crypto'
import { archivedProfilesOfJob, profileIdsOfJob } from '../../orchestration/archivedProfiles'
import { isTerminal, outcomeOf } from '../../orchestration/running'
import type { AgentProfile } from '../../agentProfiles/types'
import type { Dispatch, Job } from '../../orchestration/types'
import type { Message } from '../../i18n'
import type { FindingInputs } from '../compute'
import { DAY_MS, ageDays } from '../history'
import { finding, jobName, oneLineName, runName } from '../make'
import type { Finding, FindingPlace } from '../types'

/** §4.1: a profile is unused when it was last used (or made, when never used) more than this many days ago. */
export const UNUSED_PROFILE_DAYS = 90
/** §4.4: at least this many Dispatches with an outcome in the window, at least half of them failed. */
export const FAILING_MIN_DISPATCHES = 5
export const FAILING_WINDOW_DAYS = 30

/** A finding about one profile: it is the subject, and the button opens it. */
const aboutProfile = (p: AgentProfile): { subject: Finding['subject']; profileIds: string[]; open: FindingPlace } => ({
  subject: { kind: 'profile', id: p.id, name: p.name },
  profileIds: [p.id],
  open: { kind: 'profiles', profileIds: [p.id] }
})

/** §4.1. Not raised while a scheduled Job holds the profile, paused or not: its own profile and its plan Tasks' are what a
 *  fire runs as (archivedProfiles.ts), so they are in use. */
export function unusedProfileFindings(i: FindingInputs): Finding[] {
  const { profiles, orch } = i
  if (profiles === undefined || orch === undefined) return []
  const held = new Set(orch.jobs.filter((j) => j.schedule !== undefined).flatMap((j) => profileIdsOfJob(orch, j.id)))
  const out: Finding[] = []
  for (const p of profiles) {
    if (p.status !== 'active' || held.has(p.id)) continue
    const since = p.lastUsedAt ?? p.createdAt
    // More than 90 days, to the millisecond; a time that does not parse is never taken for old
    if (!(i.nowMs - Date.parse(since) > UNUSED_PROFILE_DAYS * DAY_MS)) continue
    out.push(
      finding({
        rule: 'unused-profile',
        ...aboutProfile(p),
        message: {
          key: p.lastUsedAt !== undefined ? 'findings.reason.unusedProfile' : 'findings.reason.unusedProfileNever',
          params: { days: ageDays(since, i.nowMs) }
        },
        suggestion: { key: 'findings.do.archiveProfile' }
      })
    )
  }
  return out
}

/** §4.2's fingerprint: the accounts in their order, the set of MCP exclusions, the permission and the sandbox switch. Name
 *  and description are not part of it. */
const fingerprint = (p: AgentProfile): string =>
  'fp-' + createHash('sha256').update(JSON.stringify([p.accountIds, [...p.mcpExclude].sort(), p.permission, p.sandbox])).digest('hex').slice(0, 12)

/** Oldest first: the order the group is named in. */
const byCreated = (a: AgentProfile, b: AgentProfile): number =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** §4.2: one finding per group of two or more active profiles with one fingerprint. Its subject is the group, and the
 *  reason names every member, oldest first, so the same sentence is right on each member's mark (ruling R3-1). */
export function duplicateProfileFindings(i: FindingInputs): Finding[] {
  if (i.profiles === undefined) return []
  const groups = new Map<string, AgentProfile[]>()
  for (const p of i.profiles) {
    if (p.status !== 'active') continue
    const fp = fingerprint(p)
    const group = groups.get(fp)
    if (group === undefined) groups.set(fp, [p])
    else group.push(p)
  }
  const out: Finding[] = []
  for (const [fp, members] of groups) {
    if (members.length < 2) continue
    const sorted = [...members].sort(byCreated)
    const ids = sorted.map((p) => p.id)
    const names = sorted.map((p) => p.name).join(', ')
    out.push(
      finding({
        rule: 'duplicate-profile',
        subject: { kind: 'profiles', id: fp, name: names },
        profileIds: ids,
        message: { key: 'findings.reason.duplicateProfile', params: { names } },
        suggestion: { key: 'findings.do.keepOne' },
        open: { kind: 'profiles', profileIds: ids }
      })
    )
  }
  return out
}

/** §4.3 on a profile, archived or not: an account it names that is no longer an account, or an MCP exclusion that names
 *  no shared MCP server. Both at once are one finding that says both. */
export function brokenProfileFindings(i: FindingInputs): Finding[] {
  const { profiles, accounts, registry } = i
  if (profiles === undefined || accounts === undefined || registry === undefined) return []
  const accountIds = new Set(accounts.map((a) => a.id))
  const servers = new Set(registry.filter((e) => e.kind === 'mcp').map((e) => e.id))
  const out: Finding[] = []
  for (const p of profiles) {
    const gone = [...new Set(p.accountIds.filter((id) => !accountIds.has(id)))]
    const left = [...new Set(p.mcpExclude.filter((id) => !servers.has(id)))]
    if (gone.length === 0 && left.length === 0) continue
    const account: Message = { key: 'findings.reason.removedAccount', params: { ids: gone.join(', ') } }
    const server: Message = { key: 'findings.reason.removedMcp', params: { ids: left.join(', ') } }
    const message: Message =
      gone.length > 0 && left.length > 0 ? { key: 'findings.reason.pair', params: { first: account, second: server } } : gone.length > 0 ? account : server
    out.push(finding({ rule: 'broken-reference', ...aboutProfile(p), message, suggestion: { key: 'findings.do.editProfile' } }))
  }
  return out
}

/**
 * §4.3 on a Job or a Task that has not ended and names a profile that is gone from the store or archived.
 *
 * Not ended is what holdsAgentProfile reads (running.ts): a Job with a schedule, with no Run yet, or with a Run still
 * running; a Run's Task until it is terminal; a plan Task while its Job has not ended. A scheduled Job's archived
 * profiles, its own and its plan Tasks' (archivedProfilesOfJob), are left to §5, which says why the Job waits; a profile
 * gone from the store is not §5's, since the fire falls back without it, so that one is said here.
 */
export function brokenWorkFindings(i: FindingInputs): Finding[] {
  const { profiles, orch } = i
  if (profiles === undefined || orch === undefined) return []
  const byId = new Map(profiles.map((p) => [p.id, p]))
  const jobs = new Map(orch.jobs.map((j) => [j.id, j]))
  /** Why a profile id cannot be run as, or null when it can. */
  const problem = (id: string): Message | null => {
    const p = byId.get(id)
    if (p === undefined) return { key: 'findings.reason.profileGone', params: { id } }
    if (p.status === 'archived') return { key: 'findings.reason.profileArchived', params: { name: p.name } }
    return null
  }
  const ended = new Map<string, boolean>()
  const notEnded = (job: Job): boolean => {
    let v = ended.get(job.id)
    if (v === undefined) {
      const runs = orch.runs.filter((r) => r.jobId === job.id)
      v = job.schedule !== undefined || runs.length === 0 || runs.some((r) => outcomeOf(orch, r.id) === 'running')
      ended.set(job.id, v)
    }
    return v
  }
  const waits = new Map<string, ReadonlySet<string>>()
  /** The profiles §5 reports the Job waiting on: none unless it is scheduled. */
  const waitingOn = (job: Job): ReadonlySet<string> => {
    let v = waits.get(job.id)
    if (v === undefined) {
      v = new Set(job.schedule === undefined ? [] : archivedProfilesOfJob(orch, job.id, profiles).map((p) => p.id))
      waits.set(job.id, v)
    }
    return v
  }
  const raise = (subject: Finding['subject'], profileId: string, message: Message, open: FindingPlace): Finding =>
    finding({ rule: 'broken-reference', subject, profileIds: [profileId], message, suggestion: { key: 'findings.do.repointJob' }, open })

  const out: Finding[] = []
  for (const job of orch.jobs) {
    const id = job.agentProfileId
    if (id === undefined || !notEnded(job) || waitingOn(job).has(id)) continue
    const why = problem(id)
    if (why !== null) out.push(raise({ kind: 'job', id: job.id, name: jobName(job) }, id, why, { kind: 'job', jobId: job.id }))
  }
  for (const t of orch.tasks) {
    const id = t.agentProfileId
    if (id === undefined) continue
    let open: FindingPlace
    if (t.runId !== undefined) {
      if (isTerminal(t)) continue
      open = { kind: 'run', runId: t.runId }
    } else {
      const job = t.jobId === undefined ? undefined : jobs.get(t.jobId)
      if (job === undefined || !notEnded(job) || waitingOn(job).has(id)) continue
      open = { kind: 'job', jobId: job.id }
    }
    const why = problem(id)
    if (why !== null) out.push(raise({ kind: 'task', id: t.id, name: oneLineName(t.title) }, id, why, open))
  }
  return out
}

/** §4.4: the profile's Dispatches with an outcome that started in the last 30 days; raised at 5 or more with at least
 *  half failed. The reason names the Run of the failure that started last, and the button opens it. */
export function failingProfileFindings(i: FindingInputs): Finding[] {
  const { profiles, orch } = i
  if (profiles === undefined || orch === undefined) return []
  const since = i.nowMs - FAILING_WINDOW_DAYS * DAY_MS
  const byProfile = new Map<string, Dispatch[]>()
  for (const d of orch.dispatches) {
    // A Dispatch still working has no outcome yet and is not counted either way
    if (d.agentProfileId === undefined || d.outcome === undefined || !(Date.parse(d.startedAt) >= since)) continue
    const own = byProfile.get(d.agentProfileId)
    if (own === undefined) byProfile.set(d.agentProfileId, [d])
    else own.push(d)
  }
  const out: Finding[] = []
  for (const p of profiles) {
    if (p.status !== 'active') continue
    const counted = byProfile.get(p.id) ?? []
    const failed = counted.filter((d) => d.outcome === 'failed')
    if (counted.length < FAILING_MIN_DISPATCHES || failed.length * 2 < counted.length) continue
    const last = failed.reduce((a, b) => (Date.parse(b.startedAt) > Date.parse(a.startedAt) ? b : a))
    const runId = orch.tasks.find((t) => t.id === last.taskId)?.runId
    // A Dispatch's Task is a Run's (plan Tasks are never dispatched) and is pruned with it, so the Run is there; should
    // the Task be missing all the same, the reason names it and the button opens the profile
    const run = runId !== undefined ? runName(orch, runId) : `task ${last.taskId}`
    const about = aboutProfile(p)
    const open: FindingPlace = runId !== undefined ? { kind: 'run', runId } : about.open
    out.push(
      finding({
        rule: 'failing-profile',
        ...about,
        open,
        message: { key: 'findings.reason.failingProfile', params: { failed: failed.length, total: counted.length, run } },
        suggestion: { key: 'findings.do.openRuns' }
      })
    )
  }
  return out
}
