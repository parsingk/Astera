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
  /** `run:<databaseId>` for a check run, `status:<context>` for a commit status, `suite:<workflow run databaseId>` for
   *  an Actions workflow that failed before any job started (an invalid workflow file: GitHub makes a suite and no check
   *  run, measured). */
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

/** What a failed check left to read (design §4.7), bounded and redacted where it was made (evidence.ts). */
export interface GitHubCiFailure {
  check: string
  externalId: string
  class: CiFailureClass
  /** At most 1000 characters: the check, its class and one line that says why. */
  summary: string
  /** At most 20: the annotations that say something (not the runner's boilerplate). */
  diagnostics: { path?: string; line?: number; message: string }[]
  /** The failing step's lines: at most 4000 characters and 80 lines. Absent for a commit status (no job log). */
  logExcerpt?: string
  url?: string
  /** Set while the evidence lacks what a later read can still bring (G2 final review I1): the job log of an Actions run
   *  still going (gh gives none until the whole run ends, measured), or reads that failed for a reason that passes,
   *  counted in `tries` up to EVIDENCE_TRIES. A log that is gone (expired) is final and sets nothing. */
  incomplete?: { reason: 'run-in-progress' | 'read-failed'; tries: number }
}

/** How many times the watch makes evidence reads that failed for a reason that passes (G2 final review I1). */
export const EVIDENCE_TRIES = 3

/** The check entry a lifecycle Task's round hands to the Host: GitHub CI on the pushed head (design §4). */
export const GITHUB_CI_CHECK = 'github:ci'

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
  /** The evidence of `failing` (G2), fetched once per commit and check by the watch. */
  failure?: GitHubCiFailure
  /** At most CI_CHECKS_MAX. */
  checks: GitHubCiCheck[]
  /** When this snapshot last changed, not when it was last read: a read that finds nothing new writes nothing. */
  changedAt: string
}

/** `pr-created`: the pull request the Run is bound to is one Astera opened (G3b1); `pr-bound`: one it found. */
export type GitHubLogKind = 'pr-bound' | 'pr-created' | 'head-changed' | 'ci-passed' | 'ci-failed' | 'source-changed'

export interface GitHubLogEntry {
  /** From 1, never reused: a public event is one entry past the last one seen. */
  seq: number
  at: string
  kind: GitHubLogKind
  pr?: number
  sha?: string
  check?: string
  /** A ci-failed entry's class, when complete evidence was read with the verdict. */
  class?: CiFailureClass
}

/** `JobRun.githubState`: what the Host last read of the Run's GitHub side. Written only by `runs-github-record`. */
export interface RunGitHubState {
  binding?: GitHubBinding
  /** More than one open PR matched the Run's branch and base; none was bound (§7). */
  prCandidates?: number[]
  headSha?: string
  /** The head Astera last pushed to the Run's branch (G3b1, design §4.2). */
  lastPushedSha?: string
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
