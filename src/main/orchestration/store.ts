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
import {
  deleteRuns,
  emptyState,
  endedUnproven,
  interruptStalledTask,
  type OrchState
} from '../../core/orchestration/state'

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

  async load(a?: {
    /** What the caller could learn about the sessions that outlived the app, in three answers — and
     *  they are three answers, not two, because reading the third as the first is what starts a
     *  second agent in a worktree the first is still working in.
     *
     *  - **A set**: the Host answered, and these are the sessions it is still running. A Dispatch
     *    whose session is among them did not die with the app, so closing it as outcome_unknown would
     *    be a lie — and P1's reconciler reads a closed Dispatch with no outcome as a lost worker and
     *    starts another agent for that Task. An empty set is a real answer: the Host had nothing.
     *  - **`'unknown'`**: there is a Host, and it could not be asked — it never answered the list, or
     *    never finished the handshake, or the sweep that reads it failed. Nothing here is evidence
     *    that any worker died, so no open Dispatch is closed. The cost is a Job that stalls until a
     *    person or the next restart looks; the alternative costs two agents in one worktree.
     *  - **Absent**: there is no Host, so nothing could have survived. This is what was always true
     *    before the Host owned the terminals, and it is what this does with no argument at all.
     *
     *  **This is a deliberate departure from slice 2 design §8**, whose risk table has the cleanup
     *  close every Dispatch it cannot prove alive. That table was written before the app could tell
     *  "no Host" from "no answer"; now that it can, the two are not the same evidence. */
    aliveSessionIds?: ReadonlySet<string> | 'unknown'
    /** Dispatches an undelivered `worker_done` in the pending-reports queue already speaks for
     *  (`reportedDispatchIdsOf` in core/orchestration/pendingReports.ts).
     *
     *  **A third reason to leave a Dispatch open, and the queue would be inert without it.** A
     *  worker that finished while the app was closed wrote its report to a file; that report is
     *  applied a moment later in the same boot. Closing the Dispatch here first would throw it away
     *  — `applyWorkerDone` answers the idempotent `alreadyReported` for a Dispatch that already has
     *  `endedAt` — and would hand P1's reconciler a Dispatch its `isLost` reads as a lost worker, so
     *  a second agent would start in the worktree the first one just committed in. That is the whole
     *  failure the queue exists to prevent, and it is not covered by `aliveSessionIds`: the case
     *  that matters most is precisely the one where nothing survived to be alive — the machine
     *  rebooted, or the Host was killed, after the worker had already finished and reported.
     *
     *  Only a completion report is evidence; an escalation is a worker saying it is stuck and still
     *  there, which is why the pure helper leaves those out. */
    reportedDispatchIds?: ReadonlySet<string>
  }): Promise<{
    recovered: boolean
    unknownOutcomes: number
    pruned: number
    staleValidations: number
    /** 재시작에 끊긴 검토. staleValidations 와 따로 센다 — 배선이 이 숫자를 시작 로그에 적으므로
     *  한데 묶으면 검토가 끊긴 재시작이 "검증이 끊겼다"고 기록된다. */
    staleReviews: number
    /** Tasks the cleanup wanted to interrupt and could not, because the Dispatch under them stayed
     *  open — `createGate` refuses to gate a Task with an open Dispatch, and `blockForReview` refuses
     *  for its own reasons. They are left exactly as they were, which for a validating or reviewing
     *  Task means it stays that way until something else moves it. Counted so the wiring can say so:
     *  a person looking at a Task stuck in validating has no other way to find out why. */
    stuckInterruptions: number
    /** The file as read — after the field migrations, before the restart cleanup — or null when
     *  there was nothing to read. Job Continuity diffs this against get() so every worker the
     *  restart lost is journaled (P0 design §5). */
    before: OrchState | null
  }> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = emptyState()
        return { recovered: false, unknownOutcomes: 0, pruned: 0, staleValidations: 0, staleReviews: 0, stuckInterruptions: 0, before: null }
      }
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.state = emptyState()
      return { recovered: true, unknownOutcomes: 0, pruned: 0, staleValidations: 0, staleReviews: 0, stuckInterruptions: 0, before: null }
    }
    if (!isValidState(parsed)) {
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.state = emptyState()
      return { recovered: true, unknownOutcomes: 0, pruned: 0, staleValidations: 0, staleReviews: 0, stuckInterruptions: 0, before: null }
    }

    // isValidState only checks that the arrays exist, so the elements of parsed's arrays are
    // unknown. Why there is no per-element schema validation: this is log-like data the app writes
    // itself, and if the shape is off, whole-file recovery is the right answer. The policy differs
    // from files such as accounts.json, where a bad shape risks corrupting an account.
    const st = parsed as OrchState

    // **이 칸이 목록이 되기 전에 만든 Task 를 옮긴다.** 이 파일은 프로세스보다 오래 살고, Run 은
    // 30일(RUN_TTL_MS)까지 남는다 — 옮기지 않으면 앱을 올리는 순간 그 Task 들의 계정 지정이 조용히
    // 사라지고, 사람이 아끼려던 계정에 일이 간다(dispatchAccount.ts 가 막으려는 바로 그것이다).
    // 옛 칸은 지운다: 두 칸을 함께 두면 어느 쪽이 정본인지 코드마다 달라진다.
    for (const t of st.tasks as unknown as Record<string, unknown>[]) {
      const legacy = t.accountId
      // **조건은 "새 칸이 없다"가 아니라 "새 칸이 비어 있다"다.** 손으로 고치다 만 파일에는 두 칸이
      // 함께 있다(`{"accountId":"a","accountIds":[]}`) — 이 이행이 있는 이유가 바로 그런 편집이다.
      // `undefined` 만 보면 그 파일은 빈 목록 그대로 돌아오고 옛 칸은 아래에서 지워져 지정이 통째로
      // 사라진다. 빈 배열이 "지정 없음"이라는 것은 이 브랜치가 곳곳에서 못박은 규칙이므로
      // (Task.accountIds 의 JSDoc, createTask, rollChainFor) 여기서도 그 규칙으로 읽는다.
      if (!(t.accountIds as unknown[] | undefined)?.length) {
        if (typeof legacy === 'string' && legacy !== '') t.accountIds = [legacy]
        // **옛 이름 아래 목록이 들어 있으면 그것도 받는다** — 값은 맞고 이름만 옛것인, 있을 수 있는
        // 손질이다(이 파일은 손으로 고쳐진다). 버리면 사람이 적어 둔 순서가 조용히 사라진다.
        // **읽을 수 없는 원소는 그 원소만 버린다.** 전부 아니면 전무로 보면 `["a", 3]` 이 읽히는 "a"
        // 까지 함께 버리는데, 그것도 사람이 아끼려던 계정을 지우는 일이다. 남는 것이 하나도 없으면
        // (빈 배열, 숫자만, 빈 문자열만) 지정으로 읽을 수 없으므로 칸을 만들지 않는다 — 빈 배열을
        // 실으면 "지정 없음"과 값이 갈라지고, 그것을 체인으로 넘기면 롤링이 계정 아닌 것으로
        // 갈아타려 한다.
        else if (Array.isArray(legacy)) {
          const ids = legacy.filter((x): x is string => typeof x === 'string' && x !== '')
          if (ids.length > 0) t.accountIds = ids
        }
      }
      delete t.accountId
    }

    // **provider 가 Run 에서 Task 로 내려간 뒤 남는 칸을 지운다.** 이제 provider 는 Task 의 계정이
    // 정하고(orchestration/types.ts 의 Task.accountIds), 한 Run 에 두 provider 의 Task 가 섞일 수
    // 있다 — Run 에 그 값이 남아 있으면 어느 쪽이 정본인지 코드마다 달라진다. 위 accountId 이행이
    // 옛 칸을 지우는 것과 같은 이유다.
    //
    // **계정을 대신 채워 넣지는 않는다.** 옛 Run 의 provider 로 기본 계정을 찾아 넣을 수도 있지만,
    // 그 기본 계정은 지금 무엇인지 이 자리에서 알 수 없고(계정 목록은 core 도 store 도 보지 않는다)
    // 사람이 아끼려던 계정에 일을 보내는 쪽으로 틀릴 수 있다. 계정 없는 Task 는 자동 배치에서
    // 빠지고 디스패치 시점에 Gate 를 연다 — 조용히 멈추지 않으므로 사람이 계정을 넣으면 곧바로 돈다.
    for (const r of st.runs as unknown as Record<string, unknown>[]) delete r.provider

    // Captured here: the migrations above are in place, the cleanup below builds new objects
    const before: OrchState = st

    const now = new Date().toISOString()
    // Restart cleanup: for an open Dispatch, the session died along with the app. The outcome
    // cannot be proven, so leave it as outcome_unknown and do not touch the Task (section 7 of the
    // orchestration guide).
    //
    // That sentence is still true for every Dispatch the Host does not have — but the Host now keeps
    // ptys running across an app restart, so it is no longer true for all of them. A session the
    // caller names in `aliveSessionIds` was taken back by reattachSessions and is still working, so
    // its Dispatch stays open: closing it would be read by the recovery reconciler as a lost worker
    // (its `isLost`), and a second agent would start on the same Task in the same worktree while the
    // first is still in it. `'unknown'` says the caller could not find out, which is not evidence
    // that anything died — see the argument's own doc for why that is its own answer.
    const alive = a?.aliveSessionIds
    const reported = a?.reportedDispatchIds
    let unknownOutcomes = 0
    const dispatches = st.dispatches.map((d) => {
      if (d.endedAt) return d
      if (alive === 'unknown') return d
      if (alive?.has(d.sessionId)) return d
      // A report for this Dispatch is waiting on disk, so its worker did not die unreported — see
      // the `reportedDispatchIds` argument's own note for what closing it here would cost.
      if (reported?.has(d.id)) return d
      unknownOutcomes++
      return endedUnproven(d, now)
    })

    // 같은 이유로 Task 도 정리한다. validating 은 어딘가에서 검증 프로세스가 돌고 있다는 뜻인데,
    // 앱이 죽으면 그것도 죽었다 — 아무도 결과를 가져다주지 않으므로 그대로 두면 영원히 validating 이다.
    // failed 로 보내지 않는 이유: 재시도 흐름이 워커를 다시 띄우는데 그 작업은 이미 끝났고 잃어버린
    // 것은 검증뿐이다. 다시 검증할지 손으로 통과시킬지는 사람이 정한다.
    // 이 시점에서 Dispatch 는 위에서 endedAt 이 채워졌으므로 createGate 의 "열린 dispatch" 검사에
    // 걸리지 않는다. consecutiveFailures 는 건드리지 않는다 — 작업이 틀렸다는 증거가 아니다.
    //
    // **reviewing 도 같이 본다.** 검토자는 별도의 세션이므로 앱과 함께 죽었고, 사정은 validating 보다
    // 나쁘다: 검증에는 앱 쪽 큐가 있어 사람이 다시 돌릴 수 있지만, 검토를 다시 띄우는 명령은
    // 코디네이터에게 없고 reviewing -> dispatched 전이가 없어 --retry-of 도 거절된다. 그대로 두면
    // Task 는 영원히 reviewing 이고 그 아래 의존 서브트리 전체가 pending 에 멈춘다.
    //
    // **The paragraph above no longer holds for every Dispatch, so the outcome here is no longer the
    // same for every Task.** A Dispatch the map above kept open — its session survived in the Host,
    // or the caller could not find out — is exactly what `createGate` refuses to gate ("cannot gate a
    // task with an open dispatch"), so `r.ok` is false and the `continue` below leaves that Task
    // validating or reviewing. That is the right outcome: its worker may well still be running, and
    // gating it would move a Task out from under a live agent. But it is silent, which is why those
    // Tasks are counted into `stuckInterruptions` and the wiring logs the number.
    let staleValidations = 0
    let staleReviews = 0
    let stuckInterruptions = 0
    let withGates: OrchState = { ...st, dispatches }
    //
    // **What is owed to one such Task lives in `interruptStalledTask`.** The pending-report drain
    // writes off a Dispatch of its own when it could not deliver the report that was holding it
    // open, and the Task under it is owed exactly this — the same Gate, with the same question,
    // and the same silence when the transition refuses. Two copies of that rule would be two
    // things to change the next time either half moves. What stays here is which Tasks to ask
    // about and what to count, which is this boot's business and not the rule's.
    for (const t of st.tasks) {
      const r = interruptStalledTask(withGates, { taskId: t.id }, now)
      if (r.stuck) {
        stuckInterruptions++
        continue
      }
      if (!r.interrupted) continue
      withGates = r.state
      if (r.interrupted === 'validation') staleValidations++
      else staleReviews++
    }

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
    // **지우는 방법은 deleteRuns(core/orchestration/state.ts)가 안다.** 여기가 정하는 것은 어느 Run
    // 인가뿐이다 — 사람이 사이드바에서 물러나게 하는 run-delete 가 같은 함수를 쓰고, 규칙이 두 벌로
    // 자라면 한쪽만 고쳐지는 날 한쪽 경로가 잔해를 남긴다. 이 로직이 이 파일 안에만 있던 동안은
    // 테스트도 닿지 않았다.
    // **withGates 를 바탕으로 쓴다, st 가 아니다.** 위 복구 단계가 validating·reviewing 이던 Task 를
    // blocked 로 옮기고 Gate 를 열어 둔 결과가 그쪽에 있다 — st 를 펼치면 그 복구가 조용히 덮인다
    // (실제로 그렇게 썼다가 store.test.ts 의 복구 테스트 셋이 잡았다). dispatches 만 따로 넘기는
    // 것은 그것이 outcome 정규화를 거친 별도 배열이기 때문이다.
    this.state = deleteRuns({ ...withGates, dispatches }, doomed)

    if (unknownOutcomes > 0 || doomed.size > 0 || staleValidations > 0 || staleReviews > 0) {
      if (doomed.size > 0) await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      // Unguarded save — the same rewrite convention as RunConfigStore and SchedulerConfigStore
      await this.save(this.state).catch(() => {})
    }
    // stuckInterruptions is deliberately not in the save condition above: a stuck Task is one nothing
    // changed, so there is nothing new to write for it.
    return {
      recovered: false,
      unknownOutcomes,
      pruned: doomed.size,
      staleValidations,
      staleReviews,
      stuckInterruptions,
      before
    }
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
