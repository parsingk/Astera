import { stripAnsi } from '../../core/rolling/detect'

// Validation run sequencing. Knows neither RunManager nor OrchState — only a runner and two callbacks,
// which is what lets tests reach it (inside ipc.ts they could not).
//
// One at a time per cwd. RunManager runs any number of things in one project, so this is not a seat
// that has to be waited for — it is a policy: two validations in the same working tree share a build
// directory and compete for ports. Workers in their own worktrees do not collide; --worktree current
// workers share the project root, and those are the ones this queue keeps apart. The user's own runs
// are not part of it: a validation starts beside whatever they have running.

export interface ValidatorRunner {
  /** Starts the run and returns its id. Throws when it cannot start — that reason becomes the Gate's
   *  question.
   *
   *  **'skip' is not a failure.** It means the entry is no longer work to do — while it waited in the
   *  queue the Task left validating (a person rescued it by hand through task-update) and there is no
   *  longer a place for the result. Throwing would open a Gate and undo the person's decision
   *  (ready/failed -> blocked is allowed by the transition table), so a quiet exit from the queue has
   *  to exist. The judgement sits on this interface because the runner is a closure in ipc.ts that tests
   *  do not reach — it reports the fact, and this class decides what to do with it. */
  start(a: { cwd: string; taskId: string }): Promise<{ runId: string } | 'skip'>
  /** That run's recent output */
  output(runId: string): string
}

interface Pending {
  taskId: string
  cwd: string
  /** The run this entry started, once it has. Exits are matched against it — an exit naming no head is
   *  somebody else's run and is ignored. */
  runId: string | null
  /** Whether this entry's exit is already being settled. The same head's exit can arrive twice; the
   *  second settle would be refused by applyValidationResult, but it would still call runner.output for
   *  nothing and leave a rejection in the log. advance's identity check is what prevents loss; this
   *  flag prevents the wasted work. */
  settling: boolean
  /** The user stopped this validation run (markStopped). Its exit is then not a result but "could not
   *  prove it", and goes to onCannotRun rather than onSettled. */
  stopped: boolean
}

/** The reason a stopped validation leaves in the Gate. blockForValidation prefixes it with a sentence */
const STOPPED_REASON = '사용자가 검증 실행을 정지했습니다'

export class TaskValidator {
  /** cwd -> queue. The head is the one running now */
  private queues = new Map<string, Pending[]>()

  constructor(
    private deps: {
      runner: ValidatorRunner
      onSettled: (a: { taskId: string; exitCode: number; output: string }) => Promise<void>
      onCannotRun: (a: { taskId: string; reason: string }) => Promise<void>
      log?: (message: string) => void
    }
  ) {}

  enqueue(a: { taskId: string; cwd: string }): void {
    const entry: Pending = { ...a, runId: null, settling: false, stopped: false }
    const q = this.queues.get(a.cwd)
    if (q) {
      q.push(entry)
      return
    }
    this.queues.set(a.cwd, [entry])
    void this.startHead(a.cwd)
  }

  /** Fed from RunManager's onStatus. Every run's exit comes through — the user's own, a validation that
   *  already settled — so anything that is not a queue head is ignored. */
  onRunExit(a: { runId: string; exitCode: number }): void {
    const found = this.headFor(a.runId)
    if (!found) return
    const { cwd, head } = found
    // The same head's exit can arrive twice — settling is an await, and a second exit landing inside it
    // still finds the head at the front. Settle once.
    if (head.settling) return
    head.settling = true
    // A stopped validation's exit code is non-zero, but that is "could not prove it", not "the work is
    // wrong". Counting it as a failure lets a user clearing someone else's build fail the Task, and
    // three of those trip the breaker — so it goes to the Gate (see markStopped).
    if (head.stopped) {
      head.stopped = false // the mark is consumed
      void this.deps
        .onCannotRun({ taskId: head.taskId, reason: STOPPED_REASON })
        .catch((e) => this.deps.log?.(`onCannotRun failed task=${head.taskId}: ${String(e)}`))
        .finally(() => this.advance(cwd, head))
      return
    }
    // **Stripped here, not at display time.** This value's readers are not only the screen — it goes
    // into Task.result and the status message body, which the coordinator LLM reads to decide on a
    // retry. Stripping only on screen leaves the deciding side reading control characters. RunPanel's
    // xterm is untouched — that is a terminal and escapes do their job there.
    const output = stripAnsi(this.deps.runner.output(a.runId))
    void this.deps
      .onSettled({ taskId: head.taskId, exitCode: a.exitCode, output })
      .catch((e) => this.deps.log?.(`validation settle failed task=${head.taskId}: ${String(e)}`))
      .finally(() => this.advance(cwd, head))
  }

  /** The user stopped this validation run (run.stop). Only the mark is left here; the judgement is made
   *  by the exit that follows — a stop cannot be told apart by exit code alone. A run that is not a head
   *  is not a validation, so nothing happens. */
  markStopped(runId: string): void {
    const found = this.headFor(runId)
    if (found) found.head.stopped = true
  }

  private headFor(runId: string): { cwd: string; head: Pending } | null {
    for (const [cwd, q] of this.queues) {
      const head = q[0]
      if (head && head.runId === runId) return { cwd, head }
    }
    return null
  }

  private async startHead(cwd: string): Promise<void> {
    const head = this.queues.get(cwd)?.[0]
    if (!head) return
    // Carried out of the try so advance is called after it, not inside
    let brokenReason: string | null = null
    let skipped = false
    try {
      const outcome = await this.deps.runner.start({ cwd, taskId: head.taskId })
      if (outcome === 'skip') skipped = true
      // The exit cannot beat this assignment: RunManager.start returns synchronously and node-pty's
      // exit is delivered from the event loop, after this continuation's microtask.
      else head.runId = outcome.runId
    } catch (e) {
      // It never started, so no exit will come. Not advancing here would block that cwd for ever.
      this.deps.log?.(`validation could not start task=${head.taskId}: ${String(e)}`)
      brokenReason = String(e)
    }
    // An entry that is no longer work leaves quietly — no onCannotRun, no failure record. The queue has to
    // keep moving, so advance is called (its identity check drops exactly this entry). The point is that a
    // stale validation must not undo a person's rescue; the purpose of the check itself — not running a
    // build for minutes over a Task that has already moved on — stays.
    if (skipped) {
      this.deps.log?.(`validation no longer needed task=${head.taskId} cwd=${cwd}`)
      this.advance(cwd, head)
      return
    }
    if (brokenReason !== null) {
      await this.deps
        .onCannotRun({ taskId: head.taskId, reason: brokenReason })
        .catch((err) => this.deps.log?.(`onCannotRun failed task=${head.taskId}: ${String(err)}`))
      this.advance(cwd, head)
    }
  }

  /** Moves past the head to the next entry.
   *
   *  **`entry` is the identity check.** The same head's exit can arrive twice (the window `settling`
   *  narrows above), and an unconditional shift would then remove the *next* entry — one that never
   *  started, so no exit will ever come for it: its Task stays validating for ever, recomputeReady only
   *  promotes completed, and its whole dependent subtree stalls in pending with no recovery short of a
   *  restart. That is exactly the failure this class exists to prevent. */
  private advance(cwd: string, entry: Pending): void {
    const q = this.queues.get(cwd)
    if (!q || q[0] !== entry) return
    q.shift()
    if (q.length === 0) {
      this.queues.delete(cwd)
      return
    }
    void this.startHead(cwd)
  }
}
