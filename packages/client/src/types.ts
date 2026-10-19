// The public DTOs: what the client's typed methods return, in the public shape the CLI prints (fields.ts). The app
// checks at compile time that its own objects fit these (src/core/orchestration/publicTypes.ts), so a field added,
// renamed or retyped on either side breaks its typecheck. Answers the app builds as plain records (the Job and Run
// views' derived fields, wait endings, a stop's answer) are defined here and pinned by tests.

export type Provider = 'claude' | 'codex'
export type TaskStatus = 'pending' | 'ready' | 'dispatched' | 'validating' | 'reviewing' | 'completed' | 'failed' | 'blocked'
export type Outcome = 'succeeded' | 'failed'
export type MessageType = 'status' | 'worker_done' | 'question' | 'escalation' | 'heartbeat' | 'decision_gate'
export type RepairReason = 'check-failure' | 'review-failure'
export type GateKind =
  | 'convergence-exhausted'
  | 'convergence-blocked'
  | 'check-unavailable'
  | 'github-no-ci'
  | 'github-ci-cap'
  | 'github-external-head'
  | 'github-pr-ambiguous'
  | 'github-pr-closed'
  | 'github-ci-outside'
  | 'github-carry'
export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'

/** When a scheduled Job fires again. */
export type ScheduleRule =
  | { readonly kind: 'interval'; readonly minutes: number }
  | { readonly kind: 'daily'; readonly time: string }
  | { readonly kind: 'weekly'; readonly weekdays: readonly number[]; readonly time: string }
  | { readonly kind: 'monthly'; readonly days: readonly number[]; readonly time: string }

/** Repair and recheck a failing Task within these bounds. Present (even empty) means on. */
export interface ConvergencePolicy {
  readonly maxFixAttempts?: number
  readonly maxReviewRounds?: number
  readonly blockingSeverity?: 'high' | 'medium'
  readonly maxTotalMinutes?: number
}

export interface GitRange {
  readonly base?: string
  readonly head?: string
}

export interface Progress {
  /** Tasks completed. */
  readonly done: number
  readonly total: number
}

/** How a Job stands: `pending` before its first Run, `paused` when its latest Run is. */
export type JobOutcome = 'running' | 'completed' | 'failed' | 'paused' | 'pending'
export type RunOutcome = 'running' | 'completed' | 'failed' | 'paused'

export interface Project {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly addedAt: string
}

/** A job source's item a Job was made from: the source (a plugin's id, or `github` for GitHub issues), the item's id
 *  there, how a person names it (`Linear ENG-123`), and where to open it. */
export interface JobSource {
  readonly id: string
  readonly itemId: string
  readonly label: string
  /** The item's title, as the app names the Job: someone else's text, at most 300 characters. */
  readonly title?: string
  readonly url?: string
  /** A GitHub issue's body hash and update time when the Job was made (Astera 1.4.15 and later): Astera compares them
   *  to notice an edit after the Job began. */
  readonly capturedBodyHash?: string
  readonly capturedUpdatedAt?: string
}

/** A Job's GitHub lifecycle policy (Astera 1.4.15 and later): which CI checks decide a pull request's head, and the
 *  bounds of reruns and waits. Its presence means Astera may push, open a PR and rerun CI on the Job's branches. */
export interface GitHubLifecyclePolicy {
  readonly ci: { readonly mode: 'required' | 'selected'; readonly selectedChecks?: readonly string[] }
  readonly autoRerunInfrastructureFailures: boolean
  readonly maxInfrastructureReruns: number
  readonly ciWaitMinutes: number
}

/** Where a GitHub lifecycle Run's pull request stands, or, while the Run's lifecycle Task works, where that Task stands
 *  (Astera 1.4.15 and later). */
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

/** Why merge-ready was withheld by the review's verdict or withdrawn by a later read (Astera 1.4.15 and later). */
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

/** A GitHub lifecycle Run's pull request and CI, as Astera last read them. */
export interface GitHubLifecycle {
  readonly state: GitHubLifecycleState
  readonly pr?: {
    readonly number: number
    readonly url: string
    readonly isDraft: boolean
    readonly state: 'open' | 'closed' | 'merged'
    readonly mergeStateStatus?: string
    /** GitHub's own review decision (APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED); shown, never Astera's verdict. */
    readonly reviewDecision?: string
  }
  /** The PR's head commit. */
  readonly headSha?: string
  readonly ci?: {
    /** The commit these checks belong to. */
    readonly sha: string
    /** Which checks decide: the required ones, every reported one (no required checks), or the Job's selection. */
    readonly basis: 'required' | 'all-reported' | 'selected'
    readonly verdict: 'pending' | 'passed' | 'failed' | 'none'
    readonly checks: readonly { readonly name: string; readonly status: 'queued' | 'in-progress' | 'completed'; readonly conclusion?: string; readonly required: boolean }[]
  }
  /** The check that failed first; `class` (test, build, lint, typecheck, infrastructure, ...) and `summary` say why, as
   *  Astera classified it. */
  readonly failing?: { readonly check: string; readonly class?: string; readonly summary?: string; readonly detailsUrl?: string }
  readonly candidates?: readonly number[]
  readonly sourceChanged?: true
  /** Merge-ready while it holds: the head Astera's review found ready, when, and `ciOverride: 'no-ci'` when a person chose
   *  to go on without CI. */
  readonly mergeReady?: { readonly headSha: string; readonly evaluatedAt: string; readonly ciOverride?: 'no-ci' }
  /** Why merge-ready was withheld by the review's verdict or withdrawn since (`GitHubInvalidatedReason`). */
  readonly invalidated?: { readonly reason: GitHubInvalidatedReason; readonly at: string }
  /** The commit Astera last pushed. */
  readonly pushedSha?: string
  /** A head on GitHub Astera did not push, until Astera pushes again. */
  readonly externalHead?: { readonly sha?: string; readonly at: string }
  /** The pull request's base as bound, and when it was bound again after the pull request was retargeted. */
  readonly base?: { readonly branch: string; readonly reboundAt?: string }
  /** The lifecycle Task's repair attempt against the Job's budget, once it has repaired, and while a repair runs what it
   *  repairs: GitHub CI (its failing check), a local check the last round failed, or the review's findings. */
  readonly repair?: {
    readonly attempt: number
    readonly max: number
    readonly subject?: { readonly kind: 'ci'; readonly check?: string } | { readonly kind: 'local'; readonly check: string } | { readonly kind: 'review' }
  }
  /** A person chose to go on without CI for the head. */
  readonly noCi?: true
}

export interface Job {
  readonly id: string
  readonly objective: string
  readonly cwd: string
  readonly projectId?: string
  readonly createdAt: string
  readonly concurrency?: number
  readonly coordinatorAccountId?: string
  readonly autoDispatch?: boolean
  readonly schedule?: ScheduleRule
  readonly fireCount?: number
  readonly pendingStart?: boolean
  readonly paused?: boolean
  readonly convergence?: ConvergencePolicy
  /** Where the Job came from: a job source and its item, set by Astera when it made the Job from that item (Astera
   *  1.4.14 and later). */
  readonly source?: JobSource
  /** The GitHub lifecycle policy, when the Job carries its work through a pull request and GitHub CI. */
  readonly github?: GitHubLifecyclePolicy
  /** Derived on every read: how the Job's latest Run (or the Job itself before one) stands. */
  readonly outcome: JobOutcome
  readonly progress: Progress
  readonly questionsOpen: number
}

export interface Run {
  readonly id: string
  readonly jobId: string
  /** From 1: the Job's first Run is 1. */
  readonly ordinal: number
  readonly createdAt: string
  readonly coordinatorSessionId?: string
  /** The folder the Run works in, when it has its own worktree. */
  readonly worktree?: string
  readonly git?: GitRange
  readonly paused?: boolean
  readonly autoDispatch?: boolean
  readonly outcome: RunOutcome
  readonly progress: Progress
  readonly questionsOpen: number
  /** `runs.get` only, and only above zero: Tasks whose worker shows a permission prompt. */
  readonly waitingForApproval?: number
  /** A GitHub lifecycle Job's Run only: its pull request and CI, derived on every read. */
  readonly github?: GitHubLifecycle
}

/** `jobs.get`: the Job, with the Run it names or its latest folded in. */
export type JobWithRun = Job & { readonly run?: Run }

/** One finding of a completion check plugin (Astera 1.4.14). */
export interface CheckDiagnostic {
  readonly file?: string
  readonly line?: number
  readonly message: string
  readonly severity?: 'error' | 'warning'
}

export interface CheckResult {
  /** A run configuration's id, or `plugin:<pluginId>` for a completion check plugin's check. */
  readonly configId: string
  readonly name: string
  /** `error`: a plugin's check could not be made (twice); the Task waits on a `check-unavailable` question. */
  readonly status: 'passed' | 'failed' | 'timed-out' | 'not-run' | 'error'
  readonly exitCode?: number
  /** The last 4000 characters of the check's output. */
  readonly outputTail?: string
  readonly startedAt?: string
  readonly endedAt?: string
  readonly unstable?: true
  /** A plugin check's own words: what it found, or why it could not be made. */
  readonly summary?: string
  /** A plugin check's findings, at most 20; a passed check keeps none. */
  readonly diagnostics?: readonly CheckDiagnostic[]
  /** How many findings it gave, when more than `diagnostics` holds: Astera keeps 20, and a completion event lists none. */
  readonly diagnosticsTotal?: number
  /** Where a plugin check's whole report is. */
  readonly externalUrl?: string
  /** A person let the round go on without this check; its status is `not-run`. */
  readonly skipped?: true
}

export interface ReviewIssue {
  readonly id: string
  readonly severity: ReviewSeverity
  readonly blocking: boolean
  readonly title: string
  readonly description: string
  readonly file?: string
  readonly line?: number
  readonly suggestedFix?: string
}

export interface Task {
  readonly id: string
  /** Exactly one of `runId` (a Run's Task) and `jobId` (a Job's definition Task). */
  readonly runId?: string
  readonly jobId?: string
  readonly title: string
  readonly spec: string
  readonly deps: readonly string[]
  readonly parentId?: string
  readonly status: TaskStatus
  readonly result?: string
  readonly filesModified?: readonly string[]
  readonly accountIds?: readonly string[]
  readonly validateConfigId?: string
  readonly validateConfigIds?: readonly string[]
  readonly checks?: readonly CheckResult[]
  readonly reviewIssues?: readonly ReviewIssue[]
  /** A person's decision to pass the Task over its checks. */
  readonly completionOverride?: { readonly reason: string; readonly at: string }
  readonly consecutiveFailures: number
  /** `'lifecycle'`: the Task Astera adds once every other Task of a GitHub lifecycle Run is completed, to carry the
   *  Run through GitHub (push, draft pull request, CI, repair, review). It has no worker. Absent on every other Task. */
  readonly kind?: 'lifecycle'
  readonly createdAt: string
  readonly updatedAt: string
  /** `tasks.list({ brief: true })` only: the spec was cut to 160 characters. */
  readonly spec_truncated?: boolean
}

/** One worker attempt at a Task. */
export interface TaskAttempt {
  readonly id: string
  readonly provider: Provider
  readonly accountId: string
  readonly repair?: RepairReason
  readonly review?: true
  readonly outcome?: Outcome
  readonly startedAt: string
  readonly endedAt?: string
  readonly waitingForApproval?: true
}

/** `tasks.get`: the Task with its attempts and the question it waits on, if any. */
export type TaskDetail = Omit<Task, 'spec_truncated'> & {
  readonly attempts: readonly TaskAttempt[]
  readonly openQuestionId?: string
}

/** A question for a person (a gate). */
export interface Question {
  readonly id: string
  readonly runId: string
  readonly taskId: string
  readonly question: string
  readonly options?: readonly string[]
  readonly kind?: GateKind
  readonly status: 'open' | 'resolved'
  readonly resolution?: string
  readonly createdAt: string
  readonly resolvedAt?: string
}

/** `questions.answer`: the resolved question; `retryOnceFailed` says why a "retry once" answer could not start. */
export type AnsweredQuestion = Question & { readonly retryOnceFailed?: string }

export type CompletionState =
  | 'not-started'
  | 'checking'
  | 'rechecking'
  | 'reviewing'
  | 'working'
  | 'fixing'
  | 'fixing-review'
  | 'waiting-for-user'
  | 'exhausted'
  | 'converged'
  | 'failed'

export interface CompletionCheckDetail {
  readonly configId: string
  readonly name: string
  readonly status: 'passed' | 'failed' | 'timed-out' | 'not-run' | 'error'
  readonly exitCode?: number
  readonly outputTail?: string
  readonly unstable?: true
  readonly summary?: string
  readonly diagnostics?: readonly CheckDiagnostic[]
  readonly diagnosticsTotal?: number
  readonly externalUrl?: string
  readonly skipped?: true
}

export interface CompletionDetail {
  readonly taskId: string
  readonly checks: readonly CompletionCheckDetail[]
  readonly blockingIssues: readonly ReviewIssue[]
  readonly otherIssueCount: number
  readonly suspiciousFiles: readonly string[]
  readonly policyChanged: boolean
}

export interface TaskCompletion {
  readonly taskId: string
  readonly title: string
  readonly state: CompletionState
  readonly attempt: number
  /** The policy's repair budget; null without convergence. */
  readonly maxAttempts: number | null
  readonly detail: CompletionDetail | null
  readonly failureSummary: string | null
  readonly lastFailure: string | null
}

/** `completion.get`: where each Task of a Run stands on its way to done. */
export interface RunCompletion {
  readonly runId: string
  readonly jobId: string
  readonly state: CompletionState
  readonly tasks: readonly TaskCompletion[]
}

export type RunEventKind =
  | 'run-created'
  | 'task-created'
  | 'dispatch-started'
  | 'message'
  | 'gate-opened'
  | 'gate-resolved'
  | 'limit-hit'
  | 'resumed'
  | 'runtime-lost'
  | 'recovery'
  // A GitHub lifecycle Run's GitHub steps, from the pull request to merge-ready
  | 'github-pr-bound'
  | 'github-pr-created'
  | 'github-pushed'
  | 'github-ci-started'
  | 'github-ci-failed'
  | 'github-ci-rerun'
  | 'github-ci-passed'
  | 'github-merge-ready'
  | 'github-invalidated'
  | 'github-source-changed'

/** One event of a Run's timeline, as `runs.follow` yields it. */
export interface RunEvent {
  readonly at: string
  readonly kind: RunEventKind
  /** Unique within `kind`. */
  readonly sourceId: string
  readonly taskId?: string
  readonly taskTitle?: string
  readonly messageType?: MessageType
  readonly summary: string
  readonly outcome?: Outcome
  readonly provider?: Provider
  readonly retry?: boolean
  readonly review?: boolean
  readonly repair?: RepairReason
}

interface WaitBase {
  readonly runId: string
  readonly jobId: string
  readonly progress: Progress
}

/** Where a wait ends: the work is done (`completed`, `failed`), or it needs a person (`waiting` on a question,
 *  `paused`), or every worker waits for a usage limit to reset (`limited`). Data, not an error. */
export type WaitEnding =
  | (WaitBase & { readonly state: 'waiting'; readonly questionId: string; readonly taskId: string })
  | (WaitBase & { readonly state: 'paused' })
  | (WaitBase & { readonly state: 'limited'; readonly resetsAt: string })
  | (WaitBase & { readonly state: 'completed' | 'failed' })

/** The Host's deadline passed first. `runId` is null when a Job had no Run yet; `jobId` is absent when a Run id named no
 *  Run. */
export interface WaitTimeout {
  readonly state: 'timeout'
  readonly jobId?: string
  readonly runId: string | null
  readonly progress: Progress
}

export type WaitResult = WaitEnding | WaitTimeout

/** `runs.stop`: workers released and the Run paused (`runs.resume` takes it back). */
export interface StopResult {
  readonly runId: string
  readonly stopped: number
  readonly paused: true
  readonly coordinatorStopped: boolean
}

/** A list. The Host answers whole lists today, so `nextCursor` is not set yet; the shape is ready for paging. */
export interface ListResult<T> {
  readonly items: readonly T[]
  readonly nextCursor?: string
}

/** What the Host's public event log records (SDK spec §6, the session events of plugin Phase 3, and the GitHub
 *  lifecycle's `github.*` from Astera 1.4.15). `run.cancelled` and `runtime.*` are not produced: there is no cancel (a
 *  stop pauses), and a Runtime's presence does not move the state. */
export type EventType =
  | 'job.created'
  | 'job.updated'
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'question.created'
  | 'question.answered'
  | 'completion.started'
  | 'completion.failed'
  | 'completion.repair_started'
  | 'completion.converged'
  | 'completion.exhausted'
  | 'session.input_needed'
  | 'session.limit_waiting'
  | 'session.account_switched'
  | 'github.pr_bound'
  | 'github.pr_created'
  | 'github.head_changed'
  | 'github.ci_passed'
  | 'github.ci_failed'
  | 'github.ci_rerun_requested'
  | 'github.source_changed'
  | 'github.merge_ready'
  | 'github.merge_ready_invalidated'

/** The session a session event is about: five of the fields `astera sessions list` shows for it. `title`, `provider`
 *  and `cwd` are absent when the Host does not know them. */
export interface EventSession {
  readonly id: string
  readonly kind: 'terminal' | 'chat'
  readonly title?: string
  readonly provider?: 'claude' | 'codex'
  readonly cwd?: string
}

/** `session.input_needed`: the session turned to waiting on a person, once per turn into it. `prompt` says for what:
 *  a permission, a question, or `null` when the Host cannot tell. */
export interface SessionInputNeeded {
  readonly session: EventSession
  readonly prompt: 'permission' | 'question' | null
}

/** `session.limit_waiting`: the session stopped at a usage limit and waits for it to reset; `scope` and `nextRetryAt`
 *  when the Host knows them. */
export interface SessionLimitWaiting {
  readonly session: EventSession
  readonly scope?: 'session' | 'weekly'
  readonly nextRetryAt?: string
}

/** `session.account_switched`: the session goes on under another account, named by its label. */
export interface SessionAccountSwitched {
  readonly session: EventSession
  readonly accountLabel: string
}

/** Each event's payload: the public DTO of the object it is about, as it stood right after the change. A Task is cut
 *  like `tasks.list({ brief: true })` and its checks carry no output; a plugin check, in a Task or a `TaskCompletion`,
 *  carries how many findings it has (`diagnosticsTotal`) and not the findings. `get` reads the whole object. A session
 *  event carries its session and what happened to it. */
export interface EventPayloads {
  readonly 'job.created': Job
  readonly 'job.updated': Job
  readonly 'run.started': Run
  readonly 'run.completed': Run
  readonly 'run.failed': Run
  readonly 'task.started': Task
  readonly 'task.completed': Task
  readonly 'task.failed': Task
  readonly 'question.created': Question
  readonly 'question.answered': Question
  readonly 'completion.started': TaskCompletion
  readonly 'completion.failed': TaskCompletion
  readonly 'completion.repair_started': TaskCompletion
  readonly 'completion.converged': TaskCompletion
  readonly 'completion.exhausted': TaskCompletion
  readonly 'session.input_needed': SessionInputNeeded
  readonly 'session.limit_waiting': SessionLimitWaiting
  readonly 'session.account_switched': SessionAccountSwitched
  readonly 'github.pr_bound': Run
  readonly 'github.pr_created': Run
  readonly 'github.head_changed': Run
  readonly 'github.ci_passed': Run
  readonly 'github.ci_failed': Run
  readonly 'github.ci_rerun_requested': Run
  readonly 'github.source_changed': Run
  readonly 'github.merge_ready': Run
  readonly 'github.merge_ready_invalidated': Run
}

/** One event. A notification, not the source of truth: read the object again when it matters. Delivered at least
 *  once; `id` never repeats, so a consumer drops one it has seen. `sequence` orders the events of one log. */
export type AsteraEvent<K extends EventType = EventType> = {
  readonly [P in K]: {
    readonly id: string
    readonly type: P
    readonly sequence: number
    readonly occurredAt: string
    readonly projectId?: string
    readonly jobId?: string
    readonly runId?: string
    readonly taskId?: string
    readonly sessionId?: string
    readonly payload: EventPayloads[P]
  }
}[K]

/** `events.subscribe` yields this when events between its cursor and the next one are gone (older than the Host
 *  keeps, or a cursor from a log this Host does not hold): read the state again. It names no object, so an event's
 *  ids read `undefined` on it and `event.runId` needs no narrowing first. */
export interface EventGap {
  readonly type: 'gap'
  readonly id?: undefined
  readonly projectId?: undefined
  readonly jobId?: undefined
  readonly runId?: undefined
  readonly taskId?: undefined
  readonly sessionId?: undefined
}

/** `events.list`: a page of events, the cursor to read on from, and whether events before the page were lost. Unlike
 *  `ListResult`, `nextCursor` is always set: an empty `items` means caught up. */
export interface EventList {
  readonly items: readonly AsteraEvent[]
  readonly nextCursor: string
  readonly gap: boolean
}
