// Builds a finished Run's report from the orchestration state (run report design §4.1, §4.2, §4.4). Pure: it reads the
// state it is given and keeps nothing.
import { checkConfigIdsOf, repairCountIn, reviewRoundIn } from '../orchestration/convergence'
import { outcomeOf, runEndOf, tasksOwnedBy, withoutSupersededLifecycle } from '../orchestration/running'
import { jobOf, type OrchState } from '../orchestration/state'
import { jobName } from '../findings/make'
import { runTokensOf, type SpentTokens } from '../orchestration/publicViews'
import { HISTORY_MAX, type ActorGroup, type Dispatch, type Task } from '../orchestration/types'
import { GITHUB_CI_CHECK, RERUNS_MAX } from '../github/lifecycle'
import { mergeReadyHolds } from '../github/view'
import { cutCaveatText } from './render'
import {
  RUN_REPORT_VERSION,
  type RunReport,
  type RunReportCaveat,
  type RunReportCheck,
  type RunReportGitHub,
  type RunReportReview,
  type RunReportTask
} from './types'

const FIRST_CAVEATS: readonly RunReportCaveat['kind'][] = ['forced', 'check-skipped', 'ci-skipped']
const caveatRank = (c: RunReportCaveat): number => {
  const i = FIRST_CAVEATS.indexOf(c.kind)
  return i === -1 ? FIRST_CAVEATS.length : i
}

const reviewOf = (task: Task, ds: readonly Dispatch[]): RunReportReview | undefined => {
  const reviews = ds.filter((d) => d.review === true)
  if (reviews.length === 0 && task.reviewRequested !== true) return undefined
  const latest = reviews
    .filter((d) => d.outcome !== undefined)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1)
  const passed = latest?.outcome === 'succeeded'
  return {
    rounds: reviewRoundIn(ds),
    passed,
    blocking: passed ? [] : (task.reviewIssues ?? []).filter((i) => i.blocking).map((i) => i.title),
    ...(task.reviewFileToolsOnly ? { fileToolsOnly: true as const } : {})
  }
}

const checksOf = (task: Task): RunReportCheck[] => {
  const configured = checkConfigIdsOf(task)
  const ids = [...configured, ...(task.checks ?? []).map((c) => c.configId).filter((id) => !configured.includes(id))]
  return ids.map((id) => {
    const last = task.checks?.find((c) => c.configId === id)
    const history = task.checkHistory?.[id] ?? []
    return {
      name: last?.name ?? id,
      final: last?.status ?? 'not-run',
      failedRounds: history.filter((h) => h === 'failed').length,
      ...(history.length >= HISTORY_MAX ? { atLeast: true as const } : {}),
      ...(last?.unstable ? { unstable: true as const } : {}),
      ...(last?.skipped ? { skipped: true as const } : {}),
      ...(last?.outsideSandbox ? { outsideSandbox: true as const } : {})
    }
  })
}

const taskOf = (task: Task, ds: readonly Dispatch[]): RunReportTask => {
  const own = ds.filter((d) => d.review !== true)
  const review = reviewOf(task, ds)
  return {
    title: task.title,
    status: task.status,
    ...(task.kind === 'lifecycle' ? { lifecycle: true as const } : {}),
    attempts: own.length,
    repairs: {
      check: repairCountIn(own.filter((d) => d.repair === 'check-failure')),
      review: repairCountIn(own.filter((d) => d.repair === 'review-failure'))
    },
    grantedExtra: own.filter((d) => d.grantedExtra === true).length,
    checks: checksOf(task),
    ...(review ? { review } : {}),
    ...(task.completionOverride ? { override: { reason: task.completionOverride.reason, by: task.completionOverrideBy ?? 'unknown' } } : {})
  }
}

export function buildRunReport(s: OrchState, runId: string, o: { spent?: readonly SpentTokens[] } = {}): RunReport | null {
  const run = s.runs.find((r) => r.id === runId)
  if (!run) return null
  const outcome = outcomeOf(s, runId)
  if (outcome === 'running') return null
  const job = jobOf(s, run)
  const tasks = [...withoutSupersededLifecycle(tasksOwnedBy(s, runId))].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const dispatchesOf = new Map<string, Dispatch[]>()
  for (const t of tasks) dispatchesOf.set(t.id, [])
  for (const d of s.dispatches) dispatchesOf.get(d.taskId)?.push(d)
  const endedAt = run.endedAt ?? new Date(runEndOf(s, run)).toISOString()
  const endMs = Date.parse(endedAt)

  const gs = run.githubState
  let github: RunReportGitHub | undefined
  if (job?.github) {
    const lifecycle = tasks.find((t) => t.kind === 'lifecycle')
    const ciHistory = lifecycle?.checkHistory?.[GITHUB_CI_CHECK] ?? []
    const reruns = gs?.reruns ?? []
    github = {
      ...(gs?.binding ? { pr: { number: gs.binding.number, url: gs.binding.url } } : {}),
      ...(gs?.ci ? { ci: { verdict: gs.ci.verdict, sha: gs.ci.sha } } : {}),
      ciFailedRounds: ciHistory.filter((h) => h === 'failed').length,
      ...(ciHistory.length >= HISTORY_MAX ? { ciFailedAtLeast: true as const } : {}),
      reruns: {
        astera: reruns.filter((r) => r.by === 'astera').length,
        person: reruns.filter((r) => r.by === 'person').length,
        ...(reruns.length === RERUNS_MAX ? { atLeast: true as const } : {})
      },
      ...(mergeReadyHolds(gs) && gs?.mergeReady
        ? { mergeReady: { headSha: gs.mergeReady.headSha } }
        : gs?.invalidated
          ? { withheld: gs.invalidated.reason }
          : {})
    }
  }

  let limitWaits = 0
  let waitedMs = 0
  let switches = 0
  let restarts = 0
  const all = tasks.flatMap((t) => dispatchesOf.get(t.id) ?? [])
  const lost = new Set(all.filter((d) => d.workerState === 'outcome_unknown').map((d) => d.id))
  for (const d of all) {
    if (d.retryOf !== undefined && lost.has(d.retryOf)) restarts++
    for (const r of d.resumes ?? []) {
      if (r.reason === 'switching') switches++
      else {
        limitWaits++
        const until = r.resumedAt !== undefined ? Date.parse(r.resumedAt) : endMs
        waitedMs += Math.max(0, until - Date.parse(r.stoppedAt))
      }
    }
  }

  const answers: Record<ActorGroup, number> = { person: 0, coordinator: 0, astera: 0, unknown: 0 }
  for (const g of s.gates)
    if (g.runId === runId && g.status === 'resolved' && g.resolution !== 'superseded') answers[g.resolvedBy ?? 'unknown']++
  const forced = tasks
    .filter((t) => t.completionOverride)
    .map((t) => ({ task: t.title, by: t.completionOverrideBy ?? ('unknown' as ActorGroup) }))
  const noPersonSteppedIn = answers.person === 0 && answers.unknown === 0 && forced.every((f) => f.by === 'coordinator' || f.by === 'astera')

  const ciSkipped = gs?.ciOverride !== undefined || gs?.mergeReady?.ciOverride === 'no-ci'
  const caveats: RunReportCaveat[] = []
  if (ciSkipped) caveats.push({ kind: 'ci-skipped' })
  for (const t of tasks) {
    const checks = checksOf(t)
    const ref = { task: t.title, ...(t.kind === 'lifecycle' ? { lifecycle: true as const } : {}) }
    if (t.completionOverride)
      caveats.push({ kind: 'forced', ...ref, by: t.completionOverrideBy ?? 'unknown', reason: cutCaveatText(t.completionOverride.reason) })
    for (const c of checks) if (c.skipped) caveats.push({ kind: 'check-skipped', ...ref, check: c.name })
    const outside = checks.filter((c) => c.outsideSandbox).map((c) => c.name)
    if (outside.length > 0) caveats.push({ kind: 'outside-sandbox', ...ref, checks: outside })
    if (t.reviewFileToolsOnly) caveats.push({ kind: 'review-outside-sandbox', ...ref })
    if (t.policyChanged) caveats.push({ kind: 'policy-changed', ...ref })
    if (t.suspiciousFiles?.length) caveats.push({ kind: 'suspicious-files', ...ref, count: t.suspiciousFiles.length })
    for (const c of checks) if (c.unstable) caveats.push({ kind: 'unstable', ...ref, check: c.name })
  }
  // What let the work past a check comes first, in this order, then the rest in Task order (a stable sort)
  caveats.sort((a, b) => caveatRank(a) - caveatRank(b))

  const accountIds: string[] = []
  const see = (id: string | undefined): void => {
    if (id !== undefined && !accountIds.includes(id)) accountIds.push(id)
  }
  for (const d of [...all].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    see(d.accountId)
    for (const r of d.resumes ?? []) see(r.toAccountId)
  }
  see(job?.coordinatorAccountId)
  const tokens = o.spent ? runTokensOf(s, runId, o.spent) : {}
  const cost = tokens.tokens || tokens.coordinatorTokens || accountIds.length > 0 ? { ...tokens, accountIds } : undefined

  return {
    version: RUN_REPORT_VERSION,
    runId,
    // On one line, cut at 60 as the run record names it: a Job with no ticket title is named by its whole objective
    job: job ? jobName(job) : '',
    ordinal: run.ordinal,
    outcome,
    startedAt: run.createdAt,
    endedAt,
    tasks: tasks.map((t) => taskOf(t, dispatchesOf.get(t.id) ?? [])),
    ...(github ? { github } : {}),
    interruptions: { limitWaits, waitedMs, switches, restarts },
    interventions: { answers, forced, noPersonSteppedIn },
    caveats,
    ...(cost ? { cost } : {})
  }
}
