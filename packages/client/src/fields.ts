// The fields the public surface publishes (public CLI design §11): the CLI, its MCP server and the SDK print these
// and nothing else.
//
// **An allowlist, never a blocklist.** A blocklist is the list of leaks someone already thought of, and every field
// added after it walks straight past. What these lists really do is pin the edge of the public API: without them, a
// field added to the app's state would silently become public, and removing it later would break someone's script.
//
// The app checks at compile time that every field of its internal objects is either here or on its own list of
// fields it deliberately keeps back (src/core/orchestration/cliPublic.ts), so a list cannot fall behind unnoticed.
import type { EventType } from './types.js'

export const PROJECT_FIELDS = Object.freeze(['id', 'path', 'name', 'addedAt'] as const)

/**
 * The three fields that say how a Job or a Run stands. They are not stored: the Host derives them on every read
 * (a Job and a Run have no status of their own; the status is in their Tasks). Not being fields of the objects, they
 * are outside the app's completeness check, which asks only whether every field of an object is listed.
 */
export const DERIVED_FIELDS = Object.freeze(['outcome', 'progress', 'questionsOpen'] as const)

export const JOB_FIELDS = Object.freeze([
  'id',
  'objective',
  'cwd',
  'projectId',
  'createdAt',
  'concurrency',
  'coordinatorAccountId',
  'autoDispatch',
  'schedule',
  'fireCount',
  'pendingStart',
  'paused',
  'convergence',
  'source',
  'github'
] as const)

export const RUN_FIELDS = Object.freeze([
  'id',
  'jobId',
  'ordinal',
  'createdAt',
  'coordinatorSessionId',
  'worktree',
  // The git range its changed files are read over.
  'git',
  'paused',
  // Public like the Job's own: a script can read who places this Run.
  'autoDispatch'
] as const)

export const TASK_FIELDS = Object.freeze([
  'id',
  'runId',
  'jobId',
  'title',
  'spec',
  'deps',
  'parentId',
  'status',
  'result',
  'filesModified',
  'accountIds',
  'validateConfigId',
  'validateConfigIds',
  'checks',
  'reviewIssues',
  // Not bookkeeping but a decision a person made: where a watcher asks "why did this pass".
  'completionOverride',
  'consecutiveFailures',
  'createdAt',
  'updatedAt'
] as const)

/** A question for a person (a gate). */
export const QUESTION_FIELDS = Object.freeze([
  'id',
  'runId',
  'taskId',
  'question',
  'options',
  'kind',
  'status',
  'resolution',
  'createdAt',
  'resolvedAt'
] as const)

/** `default` is there only on its provider's default account; `signedIn` says whether the account can run now. */
export const ACCOUNT_FIELDS = Object.freeze(['id', 'label', 'provider', 'default', 'signedIn'] as const)

/** A run configuration's command, env and cwd stay in the app: an env value can be a secret. */
export const RUN_CONFIG_FIELDS = Object.freeze(['id', 'name', 'type'] as const)

/** A session's fields come from the note the app left on its pty, which can hold anything (resume ids, rolling
 *  accounts, permission bypass); only these are public. */
export const SESSION_FIELDS = Object.freeze(['id', 'kind', 'title', 'accountId', 'cwd', 'alive', 'state', 'provider', 'rolledFrom', 'sources'] as const)

export const CHAT_TURN_FIELDS = Object.freeze(['role', 'text', 'tools'] as const)
export const CHAT_PENDING_FIELDS = Object.freeze(['kind', 'summary'] as const)
/** One line of `chats pending`. */
export const CHAT_PROMPT_FIELDS = Object.freeze(['sessionId', 'id', 'kind', 'tool', 'summary'] as const)

/** `astera skills`: accounts with their skills folded in. The account rows come from accounts.json, which also has
 *  each account's config folder, so both layers are shaped. */
export const SKILLS_ACCOUNT_FIELDS = Object.freeze(['id', 'label', 'provider', 'skills'] as const)
export const SKILL_LISTED_FIELDS = Object.freeze(['name', 'enabled', 'installed'] as const)
export const SKILL_INSTALLED_FIELDS = Object.freeze(['name', 'result'] as const)
export const SKILL_NOT_ENABLED_FIELDS = Object.freeze(['name', 'setting'] as const)

/** `runs checks`: four layers, the run, a Task's row, that row's validation and review, and the checks and review
 *  findings inside them. `CHECK_FIELDS` and `REVIEW_ISSUE_FIELDS` are the same fields a Task's `checks` and
 *  `reviewIssues` carry. */
export const RUN_CHECKS_FIELDS = Object.freeze(['runId', 'jobId', 'tasks'] as const)
export const TASK_CHECKS_FIELDS = Object.freeze(['id', 'title', 'status', 'validation', 'review', 'failureSummary', 'completionOverride'] as const)
export const VALIDATION_FIELDS = Object.freeze(['required', 'status', 'checks'] as const)
export const REVIEW_FIELDS = Object.freeze(['required', 'status', 'verdict', 'issues'] as const)
export const CHECK_FIELDS = Object.freeze([
  'configId',
  'name',
  'status',
  'exitCode',
  'outputTail',
  'startedAt',
  'endedAt',
  'unstable',
  'summary',
  'diagnostics',
  'diagnosticsTotal',
  'externalUrl',
  'skipped'
] as const)
export const REVIEW_ISSUE_FIELDS = Object.freeze(['id', 'severity', 'blocking', 'title', 'description', 'file', 'line', 'suggestedFix'] as const)

/** One timeline event as `runs follow` prints it. A message's whole body (a worker's report can be pages long) and
 *  the app's link from an event to a tab are not public. */
export const FOLLOW_EVENT_FIELDS = Object.freeze([
  'at',
  'kind',
  'sourceId',
  'taskId',
  'taskTitle',
  'messageType',
  'summary',
  'outcome',
  'provider',
  'retry',
  'review',
  'repair'
] as const)

/** `runs-completion`: where each Task of a Run stands on its way to done (the completion read model). It publishes a
 *  Task's last failure, suspicious files and policy change on purpose: those explain the state. */
export const COMPLETION_FIELDS = Object.freeze(['runId', 'jobId', 'state', 'tasks'] as const)
export const TASK_COMPLETION_FIELDS = Object.freeze(['taskId', 'title', 'state', 'attempt', 'maxAttempts', 'detail', 'failureSummary', 'lastFailure'] as const)
export const COMPLETION_DETAIL_FIELDS = Object.freeze(['taskId', 'checks', 'blockingIssues', 'otherIssueCount', 'suspiciousFiles', 'policyChanged'] as const)
export const COMPLETION_CHECK_FIELDS = Object.freeze([
  'configId',
  'name',
  'status',
  'exitCode',
  'outputTail',
  'unstable',
  'summary',
  'diagnostics',
  'diagnosticsTotal',
  'externalUrl',
  'skipped'
] as const)

/** One public event's envelope (SDK spec §6); its payload is shaped by its type (shape.ts shapeEvent). */
export const EVENT_FIELDS = Object.freeze(['id', 'type', 'sequence', 'occurredAt', 'projectId', 'jobId', 'runId', 'taskId', 'sessionId', 'payload'] as const)

/** Built from a record of every EventType, so a type added to the union and not here fails the typecheck. */
const EVENT_TYPE_SET = {
  'job.created': true,
  'job.updated': true,
  'run.started': true,
  'run.completed': true,
  'run.failed': true,
  'task.started': true,
  'task.completed': true,
  'task.failed': true,
  'question.created': true,
  'question.answered': true,
  'completion.started': true,
  'completion.failed': true,
  'completion.repair_started': true,
  'completion.converged': true,
  'completion.exhausted': true,
  'session.input_needed': true,
  'session.limit_waiting': true,
  'session.account_switched': true,
  'github.pr_bound': true,
  'github.head_changed': true,
  'github.ci_passed': true,
  'github.ci_failed': true,
  'github.source_changed': true
} as const satisfies Record<EventType, true>
/** The event types the Host produces, in the order of the spec's list. */
export const EVENT_TYPES: readonly EventType[] = Object.freeze(Object.keys(EVENT_TYPE_SET) as EventType[])
/** The session a session event names (types.ts EventSession): five of `sessions list`'s fields. */
export const EVENT_SESSION_FIELDS = Object.freeze(['id', 'kind', 'title', 'provider', 'cwd'] as const)
/** Each session event's payload fields (types.ts SessionInputNeeded and the two after it). */
export const SESSION_EVENT_FIELDS = Object.freeze({
  'session.input_needed': Object.freeze(['session', 'prompt'] as const),
  'session.limit_waiting': Object.freeze(['session', 'scope', 'nextRetryAt'] as const),
  'session.account_switched': Object.freeze(['session', 'accountLabel'] as const)
} as const satisfies Record<Extract<EventType, `session.${string}`>, readonly string[]>)
