// The GitHub lifecycle's shared shapes (design 2026-10-17-github-lifecycle-design.md §5): the Job's policy, the Run's
// GitHub side as the Host last read it, and one CI check normalized from GitHub's answer. Node-free on purpose: the
// orchestration types, the public views and the renderer read these.

/** Which checks decide a PR head (L3). `required`: the branch rules' required checks, or every reported check except
 *  skipped and neutral when the rules name none. `selected`: exactly these names. */
export interface GitHubCiPolicy {
  mode: 'required' | 'selected'
  selectedChecks?: string[]
}

/** `Job.github` (L10): written once when the Job is made, never read from Settings again. Its presence is the Job's
 *  consent to push, open a PR and rerun CI on its Runs' branches (L2). */
export interface GitHubLifecyclePolicy {
  ci: GitHubCiPolicy
  autoRerunInfrastructureFailures: boolean
  maxInfrastructureReruns: number
  ciWaitMinutes: number
}

export const GITHUB_LIFECYCLE_DEFAULTS: Omit<GitHubLifecyclePolicy, 'ci'> = {
  autoRerunInfrastructureFailures: true,
  maxInfrastructureReruns: 2,
  ciWaitMinutes: 90
}

/** GitHub's CheckConclusionState, lower-cased; `unknown` is ours, for a value GitHub adds later. */
export type GitHubCiConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed-out'
  | 'action-required'
  | 'stale'
  | 'startup-failure'
  | 'unknown'

export interface GitHubCiCheck {
  /** `run:<databaseId>` for a check run, `status:<context>` for a commit status. */
  externalId: string
  name: string
  workflow?: string
  status: 'queued' | 'in-progress' | 'completed'
  conclusion?: GitHubCiConclusion
  required: boolean
  detailsUrl?: string
  /** The Actions run behind a check run. */
  ciRunId?: number
  /** The Actions job behind a check run: its databaseId. */
  jobId?: number
  startedAt?: string
  completedAt?: string
}

export type CiBasis = 'required' | 'all-reported' | 'selected'
/** `none`: the commit has no check at all. */
export type CiVerdict = 'pending' | 'passed' | 'failed' | 'none'

/** Why a check failed (design §4.5): the classes the routing of G3/G4 reads. `code` stays for the spec's list; the
 *  classifier names the kind of code failure instead (test, build, lint, typecheck). */
export type CiFailureClass =
  | 'code'
  | 'test'
  | 'build'
  | 'lint'
  | 'typecheck'
  | 'configuration'
  | 'environment'
  | 'infrastructure'
  | 'timeout'
  | 'cancelled'
  | 'permission'
  | 'unknown'

export interface GitHubBinding {
  /** `owner/name`; `host` is set only for a host other than github.com. */
  repository: string
  host?: string
  number: number
  url: string
  baseBranch: string
  headBranch: string
  createdByAstera: boolean
  boundAt: string
}

/** GitHub's own view of the PR (§46): what it says about merging, beside Astera's verdict. */
export interface GitHubPrFacts {
  state: 'open' | 'closed' | 'merged'
  isDraft: boolean
  baseBranch: string
  mergeStateStatus?: string
  reviewDecision?: string
}

export interface GitHubCiSnapshot {
  /** The commit these checks belong to. */
  sha: string
  basis: CiBasis
  verdict: CiVerdict
  /** The first target check that failed, by name. */
  failing?: string
  /** That check's details link, kept with the verdict: a name can repeat, and the check can fall past CI_CHECKS_MAX. */
  failingUrl?: string
  /** At most CI_CHECKS_MAX. */
  checks: GitHubCiCheck[]
  /** When this snapshot last changed, not when it was last read: a read that finds nothing new writes nothing. */
  changedAt: string
}

export type GitHubLogKind = 'pr-bound' | 'head-changed' | 'ci-passed' | 'ci-failed' | 'source-changed'

export interface GitHubLogEntry {
  /** From 1, never reused: a public event is one entry past the last one seen. */
  seq: number
  at: string
  kind: GitHubLogKind
  pr?: number
  sha?: string
  check?: string
}

/** `JobRun.githubState`: what the Host last read of the Run's GitHub side. Written only by `runs-github-record`. */
export interface RunGitHubState {
  binding?: GitHubBinding
  /** More than one open PR matched the Run's branch and base; none was bound (§7). */
  prCandidates?: number[]
  headSha?: string
  pr?: GitHubPrFacts
  ci?: GitHubCiSnapshot
  lastReadError?: { kind: string; since: string }
  sourceChanged?: { at: string }
  /** At most GITHUB_LOG_MAX, oldest dropped: the timeline's source. */
  log: GitHubLogEntry[]
  /** The last entry's seq. */
  seq: number
}

export const CI_CHECKS_MAX = 50
export const GITHUB_LOG_MAX = 100
