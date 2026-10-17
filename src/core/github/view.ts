// The public face of a lifecycle Run's GitHub side (GitHub lifecycle design §5.3, §8): derived on every read from what
// the Host last recorded, never stored. `runs get`, `jobs get`, MCP get_run, the SDK's runs.get and the run and github
// events carry it. Node-free.
import type { CiBasis, CiVerdict, GitHubCiCheck, GitHubLifecyclePolicy, RunGitHubState } from './lifecycle'

/** G1's states. Later slices add the lifecycle Task's (repairing, reviewing, merge-ready, ...). */
export type GitHubLifecycleState =
  | 'unbound'
  | 'pr-bound'
  | 'ci-pending'
  | 'ci-passed'
  | 'ci-failed'
  | 'pr-merged'
  | 'pr-closed'
  | 'external-state-unavailable'

export interface GitHubLifecycleView {
  state: GitHubLifecycleState
  pr?: { number: number; url: string; isDraft: boolean; state: 'open' | 'closed' | 'merged'; mergeStateStatus?: string }
  headSha?: string
  ci?: { sha: string; basis: CiBasis; verdict: CiVerdict; checks: Pick<GitHubCiCheck, 'name' | 'status' | 'conclusion' | 'required'>[] }
  failing?: { check: string; detailsUrl?: string }
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

export function githubLifecycleOf(policy: GitHubLifecyclePolicy | undefined, gs: RunGitHubState | undefined): GitHubLifecycleView | undefined {
  if (!policy) return undefined
  const view: GitHubLifecycleView = { state: stateOf(gs) }
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
      const url = ci.checks.find((c) => c.name === ci.failing)?.detailsUrl
      view.failing = { check: ci.failing, ...(url ? { detailsUrl: url } : {}) }
    }
  }
  if (gs?.prCandidates?.length) view.candidates = [...gs.prCandidates]
  if (gs?.sourceChanged) view.sourceChanged = true
  return view
}
