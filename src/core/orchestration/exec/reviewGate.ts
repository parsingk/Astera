// What `startReview` (review.ts's `createReviewStarter`, which the app and the Host both build) does
// when it could not put a reviewer on a Task: hand the Task to a person through a Gate, and drop the
// review Dispatch it may already have committed.
//
// **Moved out of `ipc.ts` (where startReview then lived) unchanged, because a judgement was added to it and that judgement can only
// be checked against a state.** `openReviewDispatch` refuses for two different kinds of reason — a
// real failure, and a race — and only one of them is a question for a person. "The race does not tear
// the live review down" is a sentence about dispatches and task status, so the test that says it has
// to be able to hold one. That is the same reason `validator.ts` and `repair.ts` are their own files,
// and the direction `ipcConvergenceWiring.test.ts`'s header names as the real answer to its own
// scaffolding.
import {
  blockForReview,
  isAlreadyOpenError,
  runGatedForTask,
  type OrchState
} from '../state'

export interface ReviewGate {
  /** Every way `startReview` can fail ends here: the Task becomes `blocked` with `reason` as its
   *  question, and any review Dispatch already committed for it is dropped first. */
  gate(a: { taskId: string; reason: string }): Promise<void>
  /** The one caller that does not always gate — `openReviewDispatch`'s refusal. See below. */
  onOpenRefused(a: { taskId: string; error: string }): Promise<void>
  /** The Run gates, asked before a reviewer is started, with the refusal already routed through
   *  `gate`. Answers whether it refused, so `startReview` can return on `true`. */
  refuseIfRunGated(a: { taskId: string }): Promise<boolean>
}

export function createReviewGate(deps: {
  getState(): OrchState
  setState(next: OrchState): Promise<void>
  now(): string
  log(message: string): void
}): ReviewGate {
  /** **먼저 이 Task 의 열린 검토 Dispatch 를 지운다.** createGate 는 열린 Dispatch 가 있는 Task 를
   *  거절하므로(state.ts), 이미 커밋한 검토 Dispatch 를 그대로 두고 Gate 를 열려 하면 그것도 실패하고
   *  Task 는 reviewing 에 열린 Dispatch 와 함께 갇힌다 — 꺼내 줄 것이 아무것도 없다. worker-start 의
   *  실패 롤백이 같은 일을 한다(server.ts): Dispatch 를 배열에서 아예 지운다. 다만 Task 의 상태는
   *  되돌리지 않는다 — openReviewDispatch 는 상태를 옮기지 않았으므로 reviewing 그대로가 맞고, 그
   *  자리에서 Gate 가 blocked 로 데려간다.
   *
   *  정리가 세션 시작 실패 자리가 아니라 여기 있는 이유: 커밋 뒤에 던지는 경로는 그 하나가 아니다
   *  (뒤의 setState, 그리고 밖의 catch 로 오는 모든 것). 두 자리에 같은 코드를 두면 한쪽만 고쳐지고,
   *  "실패하는 모든 경로가 Gate 로 간다"는 문장이 거짓이 된다.
   *
   *  조건을 id 가 아니라 "이 Task 의 열려 있는 검토 Dispatch"로 쓴 것도 그래서다 — 아직 아무것도 열지
   *  않은 경로는 지울 것이 없어 그대로 지나가고(그래서 두 번 불러도 같다), 구현 Dispatch 는 정당하게
   *  남아 있는 닫힌 Dispatch 이므로 건드리지 않고, 이미 보고를 마친 검토 Dispatch 도 대상이 아니다. */
  const gate: ReviewGate['gate'] = async ({ taskId, reason }) => {
    const before = deps.getState()
    const kept = before.dispatches.filter(
      (d) => !(d.taskId === taskId && d.review && !d.outcome && !d.endedAt)
    )
    if (kept.length !== before.dispatches.length)
      await deps.setState({ ...before, dispatches: kept })
    // 방금 쓴 것을 다시 읽는다 — 위 커밋이 메모리의 상태를 바꿨으므로 before 로 Gate 를 열면 지운
    // Dispatch 가 되살아난다.
    const r = blockForReview(deps.getState(), { taskId, reason }, deps.now())
    if (!r.ok) {
      deps.log(`could not block task=${taskId} for review: ${r.error}`)
      return
    }
    await deps.setState(r.state)
  }

  return {
    gate,
    /**
     * **A reviewer is a session, so it asks the same question everything else that starts one asks**
     * (ruling F63). `runGatedForTask` is that question, shared with the recovery reconciler's
     * `candidates` and with `interruptedResumes`: is this Task's Run one the app may put work on
     * right now, or has a person stopped it (`runs stop`, `pauseSchedule`), or is it a template or a
     * draft. Without this a Run someone paused went on spending their accounts on reviewers, which
     * contradicts what `docs/cli.md` says `runs stop` does.
     *
     * **It opens a Gate rather than returning quietly, and that is the difference from
     * `candidates`.** A Task that `candidates` skips stays `dispatched` and is simply looked at again
     * by the next sweep — nothing is lost. A Task here is already `reviewing`, and nothing re-drives
     * `reviewing` except a restart: returning quietly would leave it in a state with nothing behind
     * it, which is the exact shape of defect this branch has already paid to fix twice. The Gate puts
     * it in `blocked` with the reason written where a person reads it, so resuming the Run leaves
     * something visible to pick up.
     *
     * **A Task whose Run cannot be found is refused too** — `runGatedForTask` answers `true` for it.
     * `orchestration.json` outlives the process and is hand-edited, and a reviewer nobody can account
     * for is the one thing worse than a Gate.
     */
    refuseIfRunGated: async ({ taskId }) => {
      const task = deps.getState().tasks.find((t) => t.id === taskId)
      if (!task || !runGatedForTask(deps.getState(), task)) return false
      await gate({
        taskId,
        // Only what can be true of a Task that reaches a review (R1): its Run is paused, or its Job is
        // paused or not yet started. A schedule's definition is not one of them; its Tasks have no Run
        // and never reach a review, and a Run a schedule fired runs like any other.
        reason:
          "this task's run is not one the app starts work on right now: the run or its job is paused, " +
          'or the job has not been started yet. Resume or start it to have this task reviewed.'
      })
      return true
    },
    /**
     * **`dispatch already open` is not a failure, and sending it to the Gate destroys a live review**
     * (ruling F37).
     *
     * `openReviewDispatch` refuses for several reasons and they are not the same kind of thing. "No
     * account", "this Task is not reviewing", "unknown task" are failures: nothing is running, and a
     * person has to decide what happens next. `dispatch already open` says the opposite — somebody
     * else got there first and a reviewer is already on this Task. Routing it through `gate` deletes
     * that reviewer's Dispatch and blocks the Task, so the second drive undoes the first.
     *
     * The window is narrow and real: `applyWorkerDone` commits `reviewing` and then calls
     * `startReview` synchronously, while the resume sweep runs off an independent promise chain (the
     * `orch-state` refill after a handshake). A sweep queued between those two reads a Task that is
     * `reviewing` with no Dispatch yet, and drives it a second time.
     *
     * **This is the counterpart of the validator runner's `'skip'`** — the quiet exit that exists so a
     * queued validation cannot undo a person's rescue. The review path had no such exit, which is why
     * every guard above it had to be exact. Logged rather than silent, because a race that happens
     * often enough to matter should be countable from the log.
     */
    onOpenRefused: async ({ taskId, error }) => {
      if (isAlreadyOpenError(error)) {
        deps.log(`review was already under way task=${taskId} — ${error}; leaving it alone`)
        return
      }
      await gate({ taskId, reason: error })
    }
  }
}
