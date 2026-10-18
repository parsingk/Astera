// The public face of a lifecycle Run's GitHub side (GitHub lifecycle design §5.3, §8): derived on every read from what
// the Host last recorded, never stored. `runs get`, `jobs get`, MCP get_run, the SDK's runs.get and the run and github
// events carry it. Node-free.
import type { CiBasis, CiFailureClass, CiVerdict, GitHubCiCheck, GitHubLifecyclePolicy, RunGitHubState } from './lifecycle'
import type { Gate, Task } from '../orchestration/types'

/** G1's states, read from the Host's record, and the lifecycle Task's (G3c2): where it stands while it is open, with
 *  `ci-infrastructure-failure` (G4) while a CI rerun is in flight or asked about. Later slices add merge-ready and
 *  invalidated (G5). */
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

/** The Run's latest lifecycle Task and the question open on it (G3c2). */
export interface LifecycleTaskFacts {
  task: Task
  openGate?: Gate
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
    const sha = l.task.ciWait.sha
    return sha !== undefined && gs?.reruns?.some((r) => r.sha === sha) ? 'ci-infrastructure-failure' : 'ci-pending'
  }
  return gs?.lastPushedSha ? 'awaiting-push' : 'pr-ready'
}

export interface GitHubLifecycleView {
  state: GitHubLifecycleState
  pr?: { number: number; url: string; isDraft: boolean; state: 'open' | 'closed' | 'merged'; mergeStateStatus?: string }
  headSha?: string
  ci?: { sha: string; basis: CiBasis; verdict: CiVerdict; checks: Pick<GitHubCiCheck, 'name' | 'status' | 'conclusion' | 'required'>[] }
  /** The check that failed first; `class` and `summary` say why, as Astera classified it (G2). */
  failing?: { check: string; class?: CiFailureClass; summary?: string; detailsUrl?: string }
  /** Open PRs that matched the Run's branch when more than one did; none is bound until there is one. */
  candidates?: number[]
  /** The source issue changed after the Job was made (§6); the objective did not. */
  sourceChanged?: true
}

function stateOf(gs: RunGitHubState | undefined): GitHubLifecycleState {
  if (gs?.lastReadError) return 'external-state-unavailable'
  if (!gs?.binding) return 'unbound'
  if (gs.pr?.state === 'merged') return 'pr-merged'
  if (gs.pr?.state === 'closed') return 'pr-closed'
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
      ...(gs.pr?.mergeStateStatus ? { mergeStateStatus: gs.pr.mergeStateStatus } : {})
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
  return view
}
