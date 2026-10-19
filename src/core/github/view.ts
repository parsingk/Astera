// The public face of a lifecycle Run's GitHub side (GitHub lifecycle design §5.3, §8): derived on every read from what
// the Host last recorded, never stored. `runs get`, `jobs get`, MCP get_run, the SDK's runs.get and the run and github
// events carry it. Node-free.
import {
  GITHUB_CI_CHECK,
  roundReruns,
  type CiBasis,
  type CiFailureClass,
  type CiVerdict,
  type GitHubCiCheck,
  type GitHubInvalidatedReason,
  type GitHubLifecyclePolicy,
  type RunGitHubState
} from './lifecycle'
import type { Gate, RepairReason, Task } from '../orchestration/types'

/** G1's states, read from the Host's record, and the lifecycle Task's (G3c2): where it stands while it is open, with
 *  `ci-infrastructure-failure` (G4) while a CI rerun is in flight or asked about, and `merge-ready` (G5b) once its review
 *  found the pull request ready and while that holds. */
export type GitHubLifecycleState =
  | 'unbound'
  | 'pr-bound'
  | 'ci-pending'
  | 'ci-passed'
  | 'ci-failed'
  | 'pr-merged'
  | 'pr-closed'
  | 'external-state-unavailable'
  | 'pr-ready'
  | 'awaiting-push'
  | 'repairing'
  | 'reviewing'
  | 'waiting-for-user'
  | 'exhausted'
  | 'ci-infrastructure-failure'
  | 'merge-ready'

/** The Run's latest lifecycle Task and the question open on it (G3c2). */
export interface LifecycleTaskFacts {
  task: Task
  openGate?: Gate
  /** Its repairs so far against the Job's budget (G7b): the numbers the node's "Fix N/M" shows. */
  repairs?: { done: number; max: number }
  /** Why its open repair Dispatch runs, while one does (final review I1). */
  repairing?: RepairReason
  /** The first check its last round failed (`github:ci` for GitHub CI): what a check repair repairs (final review I1). */
  blocked?: { configId: string; name: string }
}

/** The lifecycle Task's state while it works (design §5.3), or undefined to let the read speak: a question open on it,
 *  then a failed Task, a repair, the review, and its validating round — local checks before the first push or after
 *  one, then CI awaited. A GitHub question keeps the round's wait on the blocked Task, so the question is read first.
 *  A failed Task whose pull request was merged or closed (github-pr-closed's mark-failed) lets the pull request speak
 *  (final review I1). Only a repair dispatches a lifecycle Task (L20), and its Task stays dispatched while a worker
 *  that ended without a report waits for recovery, so dispatched reads repairing (final review M1). */
function lifecycleStateOf(l: LifecycleTaskFacts, gs: RunGitHubState | undefined): GitHubLifecycleState | undefined {
  // A question offering a rerun is about a CI failure a rerun can cure (G4, design §5.3)
  if (l.openGate?.kind === 'github-ci-outside' && l.openGate.options?.includes('rerun')) return 'ci-infrastructure-failure'
  if (l.openGate) return l.openGate.kind === 'convergence-exhausted' ? 'exhausted' : 'waiting-for-user'
  if (l.task.status === 'failed') return gs?.pr?.state === 'merged' ? 'pr-merged' : gs?.pr?.state === 'closed' ? 'pr-closed' : 'exhausted'
  if (l.task.status === 'dispatched') return 'repairing'
  if (l.task.status === 'reviewing') return 'reviewing'
  if (l.task.status !== 'validating') return undefined
  if (l.task.ciWait) {
    if (gs?.lastReadError) return 'external-state-unavailable'
    // A wait whose head had a CI run rerun waits for that rerun (G4)
    const { sha, since } = l.task.ciWait
    return sha !== undefined && roundReruns(gs?.reruns, sha, since).length > 0 ? 'ci-infrastructure-failure' : 'ci-pending'
  }
  return gs?.lastPushedSha ? 'awaiting-push' : 'pr-ready'
}

/** What a lifecycle repair repairs (G7b final review I1). */
export type RepairSubject = { kind: 'ci'; check?: string } | { kind: 'local'; check: string } | { kind: 'review' }

/** A repair under way names its subject: the review's findings, else the round's first failed check — GitHub CI's
 *  failing check when that is `github:ci`, else the local check. Nothing while no repair runs. */
function repairSubjectOf(l: LifecycleTaskFacts, gs: RunGitHubState | undefined): RepairSubject | undefined {
  if (l.task.status !== 'dispatched') return undefined
  if (l.repairing === 'review-failure') return { kind: 'review' }
  if (l.blocked?.configId === GITHUB_CI_CHECK) return { kind: 'ci', ...(gs?.ci?.failing ? { check: gs.ci.failing } : {}) }
  if (l.blocked) return { kind: 'local', check: l.blocked.name }
  return undefined
}

export interface GitHubLifecycleView {
  state: GitHubLifecycleState
  pr?: { number: number; url: string; isDraft: boolean; state: 'open' | 'closed' | 'merged'; mergeStateStatus?: string; reviewDecision?: string }
  headSha?: string
  ci?: { sha: string; basis: CiBasis; verdict: CiVerdict; checks: Pick<GitHubCiCheck, 'name' | 'status' | 'conclusion' | 'required'>[] }
  /** The check that failed first; `class` and `summary` say why, as Astera classified it (G2). */
  failing?: { check: string; class?: CiFailureClass; summary?: string; detailsUrl?: string }
  /** Open PRs that matched the Run's branch when more than one did; none is bound until there is one. */
  candidates?: number[]
  /** The source issue changed after the Job was made (§6); the objective did not. */
  sourceChanged?: true
  /** Merge-ready while it holds (G5b, design §8): the head the review's verdict found ready, when, and a person's choice to
   *  go on without CI if that is why CI did not decide. */
  mergeReady?: { headSha: string; evaluatedAt: string; ciOverride?: 'no-ci' }
  /** Why merge-ready was withheld by the verdict or withdrawn since (G5b, design §5.4). */
  invalidated?: { reason: GitHubInvalidatedReason; at: string }
  /** The commit Astera last pushed (G7b). */
  pushedSha?: string
  /** A head on GitHub Astera did not push, until Astera pushes again (G3b2; G7b shows it). */
  externalHead?: { sha?: string; at: string }
  /** The pull request's base as bound, and when a reconverge bound it again after a retarget (G6). */
  base?: { branch: string; reboundAt?: string }
  /** The lifecycle Task's repair attempt against the Job's budget, once it has repaired (G7b), and while a repair runs
   *  what it repairs: GitHub CI (the head's failing check), a local check the last round failed, or the review's findings
   *  (final review I1). */
  repair?: { attempt: number; max: number; subject?: RepairSubject }
  /** A person chose to go on without CI for the head (G3b2). */
  noCi?: true
}

/** Merge-ready holds while its evidence's head is the PR's head, the PR is open and nothing withdrew it (§5.4). */
const mergeReadyHolds = (gs: RunGitHubState | undefined): boolean =>
  gs?.mergeReady !== undefined && !gs.invalidated && gs.mergeReady.headSha === gs.headSha && gs.pr?.state === 'open'

function stateOf(gs: RunGitHubState | undefined): GitHubLifecycleState {
  if (gs?.lastReadError) return 'external-state-unavailable'
  if (!gs?.binding) return 'unbound'
  if (gs.pr?.state === 'merged') return 'pr-merged'
  if (gs.pr?.state === 'closed') return 'pr-closed'
  if (mergeReadyHolds(gs)) return 'merge-ready'
  // A verdict for a commit that is not the PR's head yet (GitHub between a push and the PR's own move) says nothing
  // about the head (final review I1).
  if (gs.ci && gs.headSha !== undefined && gs.ci.sha !== gs.headSha) return 'ci-pending'
  switch (gs.ci?.verdict) {
    case 'pending':
      return 'ci-pending'
    case 'passed':
      return 'ci-passed'
    case 'failed':
      return 'ci-failed'
    default:
      // No read yet, or a head with no check at all.
      return 'pr-bound'
  }
}

export function githubLifecycleOf(
  policy: GitHubLifecyclePolicy | undefined,
  gs: RunGitHubState | undefined,
  lifecycle?: LifecycleTaskFacts
): GitHubLifecycleView | undefined {
  if (!policy) return undefined
  const view: GitHubLifecycleView = { state: (lifecycle ? lifecycleStateOf(lifecycle, gs) : undefined) ?? stateOf(gs) }
  if (gs?.binding)
    view.pr = {
      number: gs.binding.number,
      url: gs.binding.url,
      isDraft: gs.pr?.isDraft ?? false,
      state: gs.pr?.state ?? 'open',
      ...(gs.pr?.mergeStateStatus ? { mergeStateStatus: gs.pr.mergeStateStatus } : {}),
      ...(gs.pr?.reviewDecision ? { reviewDecision: gs.pr.reviewDecision } : {})
    }
  if (gs?.headSha) view.headSha = gs.headSha
  const ci = gs?.ci
  if (ci) {
    view.ci = {
      sha: ci.sha,
      basis: ci.basis,
      verdict: ci.verdict,
      checks: ci.checks.map((c) => ({ name: c.name, status: c.status, ...(c.conclusion ? { conclusion: c.conclusion } : {}), required: c.required }))
    }
    if (ci.failing !== undefined) {
      const why = ci.failure?.check === ci.failing ? ci.failure : undefined
      view.failing = {
        check: ci.failing,
        ...(why ? { class: why.class, summary: why.summary } : {}),
        ...(ci.failingUrl ? { detailsUrl: ci.failingUrl } : {})
      }
    }
  }
  if (gs?.prCandidates?.length) view.candidates = [...gs.prCandidates]
  if (gs?.sourceChanged) view.sourceChanged = true
  if (gs?.mergeReady && mergeReadyHolds(gs))
    view.mergeReady = { headSha: gs.mergeReady.headSha, evaluatedAt: gs.mergeReady.evaluatedAt, ...(gs.mergeReady.ciOverride ? { ciOverride: gs.mergeReady.ciOverride } : {}) }
  if (gs?.invalidated) view.invalidated = { reason: gs.invalidated.reason, at: gs.invalidated.at }
  if (gs?.lastPushedSha) view.pushedSha = gs.lastPushedSha
  if (gs?.externalHeadChange)
    view.externalHead = { ...(gs.externalHeadChange.sha !== undefined ? { sha: gs.externalHeadChange.sha } : {}), at: gs.externalHeadChange.at }
  if (gs?.binding) view.base = { branch: gs.binding.baseBranch, ...(gs.baseReboundAt ? { reboundAt: gs.baseReboundAt } : {}) }
  if (lifecycle?.repairs && lifecycle.repairs.done > 0) {
    const subject = repairSubjectOf(lifecycle, gs)
    view.repair = { attempt: Math.min(lifecycle.repairs.done, lifecycle.repairs.max), max: lifecycle.repairs.max, ...(subject ? { subject } : {}) }
  }
  if (gs?.ciOverride && gs.ciOverride.sha === gs.headSha) view.noCi = true
  return view
}
