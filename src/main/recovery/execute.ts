// Carries out one RecoveryDecision (core/recovery/decide.ts decides; this only executes). Nothing
// here decides a strategy — it just runs the one it is handed, the same split the orchestration
// guide draws between "what to do" and "doing it".
import { randomBytes } from 'node:crypto'
import { openDispatch, beginValidation, createGate, type OrchState } from '../../core/orchestration/state'
import { buildCheckpoint, type GitSummary } from '../../core/orchestration/checkpoint'
import { formatResumeSection } from '../../core/orchestration/resumeSection'
import type { LostAttempt, RecoveryDecision } from '../../core/recovery/types'
import type { Provider } from '../../core/providers/meta'

export type ExecuteResult = { ok: true; newDispatchId?: string } | { ok: false; error: string }

export interface ExecuteDeps {
  getState(): OrchState
  setState(next: OrchState): Promise<void>
  /** Same shape as OrchCoordinator.startWorker (main/orchestration/coordinator.ts) — a subset of its
   *  fields, the ones a recovered attempt needs. Never touches OrchState; throws on failure. */
  startWorker(a: {
    dispatchId: string
    taskId: string
    title: string
    spec: string
    provider: Provider
    accountId: string
    rollAccountIds: string[]
    runCwd: string
    worktree: string
    /** Present for resume-native and smart-resume only; absent for a plain redispatch. */
    resume?: { nativeSessionId?: string; briefing?: string }
  }): Promise<{ sessionId: string; cwd: string; specPath: string }>
  /** Not injected = recheck cannot start a check; the Task still moves to `validating` and waits. */
  startValidation?(a: { taskId: string; cwd: string }): void
  /** Not injected = the smart-resume briefing is built with `git: null` (buildCheckpoint accepts that). */
  readGitSummary?(cwd: string): Promise<GitSummary | null>
  log(m: string): void
}

interface ExecuteInput {
  attempt: LostAttempt
  decision: RecoveryDecision
  state: OrchState
  now: string
}

export async function executeRecovery(a: ExecuteInput, deps: ExecuteDeps): Promise<ExecuteResult> {
  const { decision } = a
  switch (decision.strategy) {
    case 'resume-native':
    case 'redispatch':
    case 'smart-resume':
      return startAttempt(a, deps)
    case 'recheck':
      return recheck(a, deps)
    case 'review':
      return review(a, deps, decision.reason)
  }
}

/** The shared body of the three strategies that start an agent. */
async function startAttempt(a: ExecuteInput, deps: ExecuteDeps): Promise<ExecuteResult> {
  const { attempt, decision, now } = a
  const strategy = decision.strategy

  // The briefing is built before anything is committed, from the LOST dispatch id — buildCheckpoint
  // finds a Dispatch by id without requiring it to be open, which is what lets it describe an
  // attempt that may never get a new Dispatch (openDispatch or startWorker can still fail below).
  let briefing: string | undefined
  if (strategy === 'smart-resume') {
    const git = (await deps.readGitSummary?.(attempt.cwd)) ?? null
    const cp = buildCheckpoint(deps.getState(), { dispatchId: attempt.dispatchId, git, now })
    briefing = cp ? formatResumeSection(cp) : undefined
  }

  const state = deps.getState()
  const task = state.tasks.find((t) => t.id === attempt.taskId)
  if (!task) return { ok: false, error: `unknown task: ${attempt.taskId}` }
  const run = state.runs.find((r) => r.id === task.runId)
  if (!run) return { ok: false, error: `unknown run: ${task.runId}` }

  // Committed before the coordinator is called — the same pending-then-patch order worker-start
  // uses, so a crash between this commit and the spawn leaves a record rather than an invisible
  // process. openDispatch returns a Res, not a throw: when it refuses (the circuit breaker has
  // tripped, the Task is blocked, a Dispatch is somehow open) this falls straight through to the
  // review path with its error as the reason.
  const opened = openDispatch(
    state,
    {
      taskId: attempt.taskId,
      provider: attempt.provider,
      accountId: attempt.accountId,
      sessionId: `pending:${randomBytes(4).toString('hex')}`,
      cwd: run.cwd,
      specPath: '',
      retryOf: attempt.dispatchId
    },
    now
  )
  if (!opened.ok) {
    deps.log(`recovery: openDispatch refused for task ${attempt.taskId}: ${opened.error}`)
    return review(a, deps, opened.error, opened.error)
  }
  await deps.setState(opened.state)
  const dispatchId = opened.value.id

  const resume: { nativeSessionId?: string; briefing?: string } | undefined =
    strategy === 'resume-native'
      ? { nativeSessionId: attempt.nativeSessionId }
      : strategy === 'smart-resume'
        ? { briefing }
        : undefined

  let started: { sessionId: string; cwd: string; specPath: string }
  try {
    started = await deps.startWorker({
      dispatchId,
      taskId: attempt.taskId,
      title: task.title,
      spec: task.spec,
      provider: attempt.provider,
      accountId: attempt.accountId,
      rollAccountIds: task.accountIds ?? [attempt.accountId],
      runCwd: run.cwd,
      worktree: attempt.cwd,
      ...(resume ? { resume } : {})
    })
  } catch (e) {
    // A worker that could not be (re)started must not leave an orphaned open Dispatch behind, and
    // createGate below refuses outright while one is open — so the new Dispatch is removed and that
    // removal is committed before the Gate is opened. A lost worker that could not be restarted is a
    // question for a person, not a silently stuck Task.
    const message = e instanceof Error ? e.message : String(e)
    const latest = deps.getState()
    await deps.setState({
      ...latest,
      dispatches: latest.dispatches.filter((d) => d.id !== dispatchId)
    })
    deps.log(`recovery: startWorker failed for task ${attempt.taskId}: ${message}`)
    return review(a, deps, message, message)
  }

  // Read the latest state again before patching — a concurrent change (another worker's
  // worker_done, say) may have landed while startWorker awaited, and the patch must not clobber it;
  // only the three placeholder fields are carried over, the same discipline worker-start uses.
  const latest = deps.getState()
  await deps.setState({
    ...latest,
    dispatches: latest.dispatches.map((d) =>
      d.id === dispatchId
        ? { ...d, sessionId: started.sessionId, cwd: started.cwd, specPath: started.specPath }
        : d
    )
  })
  return { ok: true, newDispatchId: dispatchId }
}

/** Moves the Task to `validating` (skipped if it is already there) and starts the check. Starts no
 *  agent — the whole point of a recheck is that the previous attempt may have already finished the
 *  work, so nothing new needs to run. */
async function recheck(a: ExecuteInput, deps: ExecuteDeps): Promise<ExecuteResult> {
  const { attempt, now } = a
  const state = deps.getState()
  const task = state.tasks.find((t) => t.id === attempt.taskId)
  if (task && task.status === 'dispatched') {
    const res = beginValidation(state, { taskId: attempt.taskId }, now)
    if (res.ok) await deps.setState(res.state)
    else deps.log(`recovery: could not begin validation for task ${attempt.taskId}: ${res.error}`)
  }
  deps.startValidation?.({ taskId: attempt.taskId, cwd: attempt.cwd })
  return { ok: true }
}

const reviewQuestion = (decision: RecoveryDecision): string =>
  `The worker for this Task was lost and could not be continued automatically: ${decision.reason}.` +
  (decision.class === 'unsafe' ? ' Nothing in the worktree has been touched.' : '') +
  ' Review the worktree before answering.'

/** One option, not two. Resolving a Gate always unblocks the Task to `pending -> ready`, and for a
 *  Run the app drives that is exactly what starts a fresh worker — so a second button saying "leave
 *  it" would restart the work it promises to leave alone. Leaving it alone is not answering: the
 *  Gate stays open and the Task stays blocked until the person decides. */
const REVIEW_OPTIONS = ['restart with a new worker']

/** Opens the Gate that asks a person to decide. `reason` is the text that goes in the question — for
 *  the `review` strategy itself that is `decision.reason`; for the fallback out of `startAttempt` it
 *  is the operational failure (openDispatch's error, or startWorker's thrown message) instead, which
 *  is why it is a separate parameter rather than always reading `decision.reason`.
 *
 *  `failure`, when given, forces the return to `{ ok: false, error: failure }` even though the Gate
 *  itself was opened successfully — the review strategy chosen on purpose is not a failure (a Gate
 *  is its whole intended outcome), but falling into review because a strategy could not be carried
 *  out is, and the reconciler needs to see that. */
async function review(
  a: ExecuteInput,
  deps: ExecuteDeps,
  reason: string,
  failure?: string
): Promise<ExecuteResult> {
  const { attempt, decision, now } = a
  const question = reviewQuestion({ ...decision, reason })
  const res = createGate(
    deps.getState(),
    { taskId: attempt.taskId, question, options: REVIEW_OPTIONS },
    now
  )
  if (!res.ok) {
    deps.log(`recovery: could not open a gate for task ${attempt.taskId}: ${res.error}`)
    return { ok: false, error: failure ?? res.error }
  }
  await deps.setState(res.state)
  return failure !== undefined ? { ok: false, error: failure } : { ok: true }
}
