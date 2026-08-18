// orchestration.json persistence. The RunConfigStore pattern —
// type guard → atomic tmp+rename write → on a parse failure, back up to .bak and start empty.
//
// Why the corruption policy is whole-file recovery: entries reference each other
// (Task→Run, Dispatch→Task, Message→Delivery, Gate→Task). Dropping a single entry leaves
// dangling references behind, which is a worse state than starting over. That is why this policy
// differs from SchedulerConfigStore, which recovers per entry.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { emptyState, type OrchState } from '../../core/orchestration/state'

/** Cutoff for discarding a finished Run. The same 30 days as SchedulerConfigStore's ENTRY_TTL_MS */
export const RUN_TTL_MS = 30 * 24 * 60 * 60 * 1000

const isArr = (v: unknown): v is unknown[] => Array.isArray(v)

function isValidState(v: unknown): v is OrchState {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return (
    isArr(o.runs) &&
    isArr(o.tasks) &&
    isArr(o.dispatches) &&
    isArr(o.messages) &&
    isArr(o.deliveries) &&
    isArr(o.gates)
  )
}

export class OrchestrationStore {
  private state: OrchState = emptyState()
  /** Serialization queue for disk writes (see save) */
  private queue: Promise<void> = Promise.resolve()

  constructor(private filePath: string) {}

  async load(): Promise<{ recovered: boolean; unknownOutcomes: number; pruned: number }> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = emptyState()
        return { recovered: false, unknownOutcomes: 0, pruned: 0 }
      }
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.state = emptyState()
      return { recovered: true, unknownOutcomes: 0, pruned: 0 }
    }
    if (!isValidState(parsed)) {
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.state = emptyState()
      return { recovered: true, unknownOutcomes: 0, pruned: 0 }
    }

    // isValidState only checks that the arrays exist, so the elements of parsed's arrays are
    // unknown. Why there is no per-element schema validation: this is log-like data the app writes
    // itself, and if the shape is off, whole-file recovery is the right answer. The policy differs
    // from files such as accounts.json, where a bad shape risks corrupting an account.
    const st = parsed as OrchState

    const now = new Date().toISOString()
    // Restart cleanup: for an open Dispatch, the session died along with the app. The outcome
    // cannot be proven, so leave it as outcome_unknown and do not touch the Task (section 7 of the
    // orchestration guide).
    let unknownOutcomes = 0
    const dispatches = st.dispatches.map((d) => {
      if (d.endedAt) return d
      unknownOutcomes++
      return { ...d, endedAt: now, workerState: 'outcome_unknown' as const }
    })

    // TTL cleanup: once a finished Run (every Task terminal) is 30 days old, every entry belonging
    // to that Run is discarded.
    const cutoff = Date.now() - RUN_TTL_MS
    const terminal = new Set(['completed', 'failed'])
    const doomed = new Set(
      st.runs
        .filter((r) => {
          const own = st.tasks.filter((t) => t.runId === r.id)
          // Compute the Run's effective end time. Use the most recent of the Tasks' updatedAt and
          // the Messages' createdAt, and fall back to Run.createdAt when there is neither.
          // Why: it keeps a Run that took more than 30 days from being deleted right after it ends.
          const ownMessages = st.messages.filter((m) => m.runId === r.id)
          const terminalTimes = [
            Date.parse(r.createdAt),
            ...own.map((t) => Date.parse(t.updatedAt)),
            ...ownMessages.map((m) => Date.parse(m.createdAt))
          ]
          const endTime = Math.max(...terminalTimes)
          if (endTime > cutoff) return false
          return own.length > 0 && own.every((t) => terminal.has(t.status))
        })
        .map((r) => r.id)
    )
    const keptTasks = st.tasks.filter((t) => !doomed.has(t.runId))
    const keptTaskIds = new Set(keptTasks.map((t) => t.id))

    this.state = {
      runs: st.runs.filter((r) => !doomed.has(r.id)),
      tasks: keptTasks,
      dispatches: dispatches.filter((d) => keptTaskIds.has(d.taskId)),
      messages: st.messages.filter((m) => !doomed.has(m.runId)),
      deliveries: st.deliveries.filter((d) => !doomed.has(d.runId)),
      gates: st.gates.filter((g) => !doomed.has(g.runId))
    }

    if (unknownOutcomes > 0 || doomed.size > 0) {
      if (doomed.size > 0) await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      // Unguarded save — the same rewrite convention as RunConfigStore and SchedulerConfigStore
      await this.save(this.state).catch(() => {})
    }
    return { recovered: false, unknownOutcomes, pruned: doomed.size }
  }

  get(): OrchState {
    return this.state
  }

  /**
   * Save the state. Memory is updated immediately and the disk write is **serialized**.
   *
   * Why the queue is needed: even when every call site honours "re-read, then await", that only
   * prevents inversion within a single flow. With two flows it still happens — if the worker's
   * `send` arrives while worker-start has yielded to the `fs.mkdir` inside `await deps.setState`,
   * two save() calls are in flight at once, and the libuv thread pool does not guarantee the order
   * in which the two renames land. Then disk=S1 and memory=S2, and because memory is always
   * correct there is no symptom during real use — it only shows up on the next app restart.
   */
  async save(next: OrchState): Promise<void> {
    this.state = next
    const run = (): Promise<void> => this.writeNow(next)
    // The two arguments to then(run, run) are the same — a later write has to proceed even if an
    // earlier one failed. Without onRejected, a failed queue passes every subsequent save through
    // as rejected and the disk freezes from that point on.
    this.queue = this.queue.then(run, run)
    return this.queue
  }

  /**
   * Copy the current file to `.bak`. `reset` calls this right before its destructive operation
   * (section 4.5 of the orchestration guide documents this as the only safety net; it was
   * unimplemented). The path convention is the single `.bak` that load's corruption recovery and
   * the TTL prune also use.
   *
   * It goes through the write queue — overtaking a save that has not landed yet would put the old
   * state in the backup.
   * Why it does not throw on failure: it follows the same best-effort convention as load's `.bak`
   * copy, and blocking the recovery command itself because the backup failed would leave the user
   * no way to discard the state. If the file does not exist yet (first run) there is nothing to
   * copy, so it passes straight through.
   */
  async backup(): Promise<void> {
    const run = (): Promise<void> =>
      fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
    this.queue = this.queue.then(run, run)
    return this.queue
  }

  /** The queue means no concurrency inside here — this is the atomic tmp+rename write itself. */
  private async writeNow(next: OrchState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
