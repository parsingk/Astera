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

/** How many checks a Job may name to wait for, and how long a name may be (G7a): a Run keeps at most 50 checks of a
 *  read, and a name is a check's name, not a document. run-create and MCP's create_job hold both. */
export const LIFECYCLE_CHECKS_MAX = 20
export const LIFECYCLE_CHECK_NAME_MAX = 100

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
  /** That run's attempt as read: 1, then one more for each rerun (G4). */
  ciRunAttempt?: number
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
  /** At most 20: the annotations that say something (not the runner's boilerplate); `warning` marks a warning's. */
  diagnostics: { path?: string; line?: number; message: string; warning?: true }[]
  /** How many there were, when more than the 20 kept (G3b1 final review M5). */
  diagnosticsTotal?: number
  /** The failing step's lines: at most 4000 characters and 80 lines. Absent for a commit status (no job log). */
  logExcerpt?: string
  url?: string
  /** Set while the evidence lacks what a later read can still bring (G2 final review I1): the job log of an Actions run
   *  still going (gh gives none until the whole run ends, measured), or reads that failed for a reason that passes,
   *  counted in `tries` up to EVIDENCE_TRIES. A log that is gone (expired) is final and sets nothing. */
  incomplete?: { reason: 'run-in-progress' | 'read-failed'; tries: number }
  /** The failing check's Actions run and that run's attempt as read (G4 final review M2): the run a rerun reruns, known
   *  whatever the snapshot keeps of the checks. Absent for a commit status. */
  ciRunId?: number
  ciRunAttempt?: number
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
  /** The names CI was judged on, from the whole read (`ciTargets`): kept whole, though `checks` keeps CI_CHECKS_MAX, so
   *  merge-ready's evidence and the watch's later comparison see the same set (G5b final review I1). */
  targetNames?: string[]
  /** When this snapshot last changed, not when it was last read: a read that finds nothing new writes nothing. */
  changedAt: string
}

/** `pr-created`: the pull request the Run is bound to is one Astera opened (G3b1); `pr-bound`: one it found;
 *  `ci-rerun`: a CI run of the head was rerun (G4); `merge-ready` / `invalidated`: the review's verdict made the pull
 *  request ready to merge, or merge-ready was withheld or withdrawn (G5b); `pushed`: Astera pushed the branch, and
 *  `ci-started`: a read first saw the head's CI running (G7b, the timeline's lines; no public event or journal row). */
export type GitHubLogKind =
  | 'pr-bound'
  | 'pr-created'
  | 'pushed'
  | 'ci-started'
  | 'head-changed'
  | 'ci-passed'
  | 'ci-failed'
  | 'ci-rerun'
  | 'source-changed'
  | 'merge-ready'
  | 'invalidated'

/** Why merge-ready was withheld by the review's verdict (the first seven, and external-state-unavailable while GitHub
 *  cannot be read) or withdrawn by a later read (the last six) (G5b, design §5.4): a code a script switches on. */
export type GitHubInvalidatedReason =
  | 'not-bound'
  | 'external-state-unavailable'
  | 'pr-not-open'
  | 'head-not-pushed'
  | 'review-of-another-head'
  | 'ci-not-passed'
  | 'question-open'
  | 'local-check-failed'
  | 'local-check-skipped'
  | 'closed'
  | 'merged'
  | 'head-changed'
  | 'base-changed'
  | 'ci-failed'
  | 'checks-changed'

/** Why the pull request is ready to merge, decided from Astera's state when the lifecycle review passed (G5b, design
 *  §5.2, §5.4): its head is the one Astera pushed, CI passed on it (or a person chose to go on without CI), the review
 *  read that head, and no question was open. `ciChecks`: the checks CI was judged on, by the record's basis; a read of
 *  the same head that judges on others withdraws it. */
export interface MergeReadyEvidence {
  pullRequestNumber: number
  headSha: string
  localChecksPassed: boolean
  requiredCiPassed: boolean
  ciOverride?: 'no-ci'
  reviewPassed: boolean
  unresolvedQuestions: number
  ciChecks: string[]
  evaluatedAt: string
}

/** One rerun of a CI run's failed jobs (G4, design §4.6, §5.2). `attempt` is the attempt that failed and was rerun, so
 *  the rerun has shown once a read gives that run a later one; `sha` is the head it was asked on. `by: 'astera'` is the
 *  Host's own (L9), which the Job's budget counts; `'person'` was asked by a person's answer or command. */
export interface GitHubRerun {
  ciRunId: number
  attempt: number
  sha: string
  check?: string
  /** The failing check run that was rerun (G4 final review M3): while a read still shows it, the rerun has not shown. */
  externalId?: string
  by: 'astera' | 'person'
  at: string
}

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
  /** An invalidated entry's reason (G7b): why merge-ready was withheld or withdrawn. */
  reason?: GitHubInvalidatedReason
}

/** `JobRun.githubState`: what the Host last read of the Run's GitHub side. Written by the Host's `runs-github-record`
 *  and, for merge-ready, by the lifecycle review's verdict in its own write (G5b). */
export interface RunGitHubState {
  binding?: GitHubBinding
  /** More than one open PR matched the Run's branch and base; none was bound (§7). */
  prCandidates?: number[]
  headSha?: string
  /** The head Astera last pushed to the Run's branch (G3b1, design §4.2). */
  lastPushedSha?: string
  /** GitHub has a head on the Run's branch Astera did not push (G3b2, design §4.2, §4.4): seen in the PR (`sha`) or as
   *  a refused push (no sha). Kept until Astera pushes again. */
  externalHeadChange?: { sha?: string; at: string }
  /** A person chose to go on without CI for this head (G3b2, design §4.4 grace, S10): merge-ready says so. */
  ciOverride?: { sha: string; at: string }
  pr?: GitHubPrFacts
  ci?: GitHubCiSnapshot
  lastReadError?: { kind: string; since: string }
  sourceChanged?: { at: string }
  /** At most RERUNS_MAX, oldest dropped (G4). */
  reruns?: GitHubRerun[]
  /** The pull request is ready to merge, as the review's verdict decided (G5b); shown while its head is the PR's head
   *  and nothing withdrew it. */
  mergeReady?: MergeReadyEvidence
  /** Why merge-ready was withheld by the verdict or withdrawn since (G5b, design §5.4). */
  invalidated?: { reason: GitHubInvalidatedReason; at: string }
  /** When runs reconverge bound the base the pull request was retargeted to (G6): CI that started before it was judged
   *  against the old base, and stands for merge-ready no more (G6 final review I2). */
  baseReboundAt?: string
  /** At most GITHUB_LOG_MAX, oldest dropped: the timeline's source. */
  log: GitHubLogEntry[]
  /** The last entry's seq. */
  seq: number
}

export const CI_CHECKS_MAX = 50
export const GITHUB_LOG_MAX = 100
export const RERUNS_MAX = 20

/** The names of the checks CI is judged on by `basis`, sorted, once (GitHub lifecycle G5b): the required ones present,
 *  the selected ones present, or every reported one but those settled skipped or neutral (evaluateCi's all-reported
 *  targets). Kept with merge-ready; a later read of the same head that judges on other names withdraws it. Here, not in
 *  ciVerdict, because the renderer's build reaches it through lifecycleTask and ciVerdict reaches gh. */
export function ciTargetNames(checks: readonly GitHubCiCheck[], basis: CiBasis, selected: readonly string[] = []): string[] {
  const nothingChecked = (c: GitHubCiCheck): boolean =>
    c.status === 'completed' && (c.conclusion === 'skipped' || c.conclusion === 'neutral')
  const targets =
    basis === 'required'
      ? checks.filter((c) => c.required)
      : basis === 'selected'
        ? checks.filter((c) => selected.includes(c.name))
        : checks.filter((c) => !nothingChecked(c))
  return [...new Set(targets.map((c) => c.name))].sort()
}

/** The reruns asked in the round `since` names, on its head `sha` (G4 final review I1, M5): a rerun of an earlier round
 *  of the same head is that round's, not this one's. */
export const roundReruns = (reruns: readonly GitHubRerun[] | undefined, sha: string, since: string): GitHubRerun[] =>
  (reruns ?? []).filter((r) => r.sha === sha && r.at >= since)
