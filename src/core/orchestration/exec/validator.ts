import { stripAnsi } from '../../rolling/detect'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../../sessions/pty'
import { CHECK_TIMEOUT_MS, type CheckResult } from '../types'

// Validation run sequencing. Knows neither RunManager nor OrchState — only a runner and two callbacks,
// which is what lets tests reach it (inside ipc.ts they could not).
//
// One at a time per cwd. RunManager runs any number of things in one project, so this is not a seat
// that has to be waited for — it is a policy: two validations in the same working tree share a build
// directory and compete for ports. Workers in their own worktrees do not collide; --worktree current
// workers share the project root, and those are the ones this queue keeps apart. The user's own runs
// are not part of it: a validation starts beside whatever they have running.
//
// **한 항목은 check 목록이다**(설계 §7). 순서대로 돌리고 첫 실패에서 멈춘다 — typecheck 가 깨졌는데 테스트를
// 돌리는 것은 분 단위 낭비이고 진단도 흐려진다. 뒤의 check 는 not-run 으로 기록한다. check 마다 타이머가
// 있고, 첫 timeout 은 그 check 를 한 번 다시 띄우며 두 번째는 onCannotRun 이다 — timeout 은 코드 실패가
// 아니다(명세 §19).

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
  start(a: { cwd: string; taskId: string; configId: string }): Promise<{ runId: string; name: string } | 'skip'>
  /** That run's recent output */
  output(runId: string): string
  /** timeout 이 부른다. 이어 오는 exit 는 timed-out 으로 읽힌다 */
  stop(runId: string): void
}

interface Pending {
  taskId: string
  cwd: string
  configIds: string[]
  /** 지금 도는(또는 다음에 띄울) check 의 자리 */
  index: number
  results: CheckResult[]
  /** The run this entry started, once it has. Exits are matched against it — an exit naming no head is
   *  somebody else's run and is ignored. */
  runId: string | null
  /** 지금 도는 check 의 RunConfig.name — 결과와 사유 문구에 쓴다 */
  name: string | null
  startedAt: string | null
  /** Whether this entry's exit is already being settled. The same head's exit can arrive twice —
   *  settling is an await, and a second exit landing inside it still finds the head at the front. This
   *  flag is what makes that second exit a no-op; advance's identity check below is the layer beneath. */
  settling: boolean
  /** The user stopped this validation run (markStopped). Its exit is then not a result but "could not
   *  prove it", and goes to onCannotRun rather than onSettled. */
  stopped: boolean
  /** timeout 이 stop 을 불렀다. 다음 exit 는 결과가 아니라 timed-out 이다 */
  timedOut: boolean
  /** 한 번 timeout 을 낸 configId 들. 두 번째면 onCannotRun */
  timedOutOnce: Set<string>
  timer: ReturnType<typeof setTimeout> | null
}

/** How many early exits (see TaskValidator.earlyExits) are kept at most. Only exits that land while a
 *  start is in flight are kept, and the map is emptied as soon as no start is, so this is a backstop
 *  against a burst of other runs' exits, not the working bound. */
const EARLY_EXIT_LIMIT = 64

/** The reason a stopped validation leaves in the Gate. blockForValidation prefixes it with a sentence */
const STOPPED_REASON = '사용자가 검증 실행을 정지했습니다'

export class TaskValidator {
  /** cwd -> queue. The head is the one running now */
  private queues = new Map<string, Pending[]>()
  /** **Exits that arrived before their run's id was known** (review I1). startCheck learns the runId only
   *  in the continuation after `await runner.start(...)`, but an exit can be queued as a microtask
   *  *inside* that start — the app's Host pty factory does exactly that when it spawns while the socket
   *  is down (src/main/host/ptyFactory.ts, startDead) — and so reach onRunExit first, naming no head.
   *  Dropping it was a stall: the timeout's stop is then a no-op on a run that has already gone, no
   *  second exit ever comes, and that cwd's queue waits until the app restarts.
   *
   *  So an exit naming no head is kept here, **but only while some start is in flight**
   *  (startsInFlight), and startCheck takes its own run's exit out as it records the runId and replays
   *  it. When the last in-flight start finishes the map is emptied — anything left was some other run's
   *  exit (the user's own, a settled validation's duplicate), which onRunExit ignores anyway. runIds are
   *  unique, so a kept exit can only ever be applied to the run that produced it. */
  private earlyExits = new Map<string, number>()
  /** runner.start calls not yet returned — the window in which earlyExits collects. */
  private startsInFlight = 0
  private readonly timeoutMs: number

  constructor(
    private deps: {
      runner: ValidatorRunner
      onSettled: (a: { taskId: string; results: CheckResult[] }) => Promise<void>
      onCannotRun: (a: { taskId: string; reason: string }) => Promise<void>
      log?: (message: string) => void
      /** 테스트 주입용. 배선은 넘기지 않는다 */
      timeoutMs?: number
    }
  ) {
    this.timeoutMs = deps.timeoutMs ?? CHECK_TIMEOUT_MS
  }

  enqueue(a: { taskId: string; cwd: string; configIds: string[] }): void {
    // 중복 configId 를 지운다(첫 자리만 남긴다) — timedOutOnce 는 configId 로 키를 잡으므로, 같은
    // id 가 두 번 있으면 둘째 자리의 *첫* timeout 이 이미 "두 번째"로 읽혀 곧장 onCannotRun 으로 간다.
    const configIds = [...new Set(a.configIds)]
    const entry: Pending = {
      taskId: a.taskId, cwd: a.cwd, configIds, index: 0, results: [],
      runId: null, name: null, startedAt: null, settling: false, stopped: false,
      timedOut: false, timedOutOnce: new Set(), timer: null
    }
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
    if (!found) {
      this.rememberEarlyExit(a)
      return
    }
    const { cwd, head } = found
    // **An exit that only says the app lost sight of the run is not a result.** The socket to the Host
    // dropped; the build is still running there and the reconnect re-adopts it under the same runId, so
    // the real exit reaches this same head afterwards and settles it. Read as a result it is a failed
    // validation, and three of those trip that Task's breaker over a network hiccup — the same
    // reasoning `markStopped` already applies to a stopped run, one step further: this is not even
    // "could not prove it", it is "the app has not been told yet".
    //
    // Nothing is settled and nothing advances, so the head keeps the queue for its cwd. If the run
    // really did die with its Host, no exit ever arrives and that cwd's queue waits until the app is
    // restarted — the stall side of the same asymmetry the Dispatch and the coordinator slot take.
    if (a.exitCode === PTY_LOST_SIGHT_EXIT_CODE) {
      this.deps.log?.(`validation run=${a.runId} task=${head.taskId} was lost sight of, not settled`)
      return
    }
    // The same head's exit can arrive twice — settling is an await, and a second exit landing inside it
    // still finds the head at the front. Settle once.
    if (head.settling) return
    head.settling = true
    this.clearTimer(head)
    const configId = head.configIds[head.index]
    const name = head.name ?? configId
    const now = new Date().toISOString()
    // 사용자 정지가 timeout 보다 먼저다 — 둘 다 "증명하지 못했다" 지만 정지는 사람의 결정이고, 그 뒤에 이
    // check 를 다시 띄우는 것은 그 결정을 무시하는 것이다.
    if (head.stopped) {
      head.stopped = false // the mark is consumed
      void this.deps
        .onCannotRun({ taskId: head.taskId, reason: STOPPED_REASON })
        .catch((e) => this.deps.log?.(`onCannotRun failed task=${head.taskId}: ${String(e)}`))
        .finally(() => this.advance(cwd, head))
      return
    }
    if (head.timedOut) {
      head.timedOut = false
      if (!head.timedOutOnce.has(configId)) {
        // 첫 timeout: 같은 check 를 한 번 다시(명세 §19). 결과는 기록하지 않는다 — 이 라운드의 판정이 아니다.
        // runId·name 을 먼저 지운다 — settling 을 내리기 전에 지우지 않으면, startCheck 의
        // await runner.start(...) 가 끝나기 전에(실제 배선에서는 파일시스템 I/O 다) 방금 끝난 run 의
        // 중복 exit 가 도착했을 때 headFor 가 옛 runId 로 이 head 를 다시 찾아 settling=false 를
        // 통과하고, timedOut 도 이미 꺼져 있으니 이 exit 를 코드 실패로 정산해 버린다 — timeout 이
        // 명세가 금지하는 코드 실패로 워커에게 가는 경로다.
        head.runId = null
        head.name = null
        head.timedOutOnce.add(configId)
        head.settling = false
        this.deps.log?.(`check "${name}" timed out once task=${head.taskId} — retrying it`)
        void this.startCheck(cwd, head)
        return
      }
      // 'timed-out' 은 여기서 기록되지만 onCannotRun 은 {taskId, reason} 만 나른다 — 이 결과와 그
      // 앞에 이미 통과한 check 들의 결과는 지금 onCannotRun 을 처리하는 쪽(Gate)에는 닿지 않는다.
      // CheckResult.status 의 주석이 말하는 "화면과 Journal" 은 아직 이 값을 읽는 자리가 없다 —
      // Gate 가 열릴 때 head.results 를 함께 넘기는 자리가 생기면 그때 쓴다.
      head.results.push({ configId, name, status: 'timed-out', startedAt: head.startedAt ?? undefined, endedAt: now })
      void this.deps
        .onCannotRun({ taskId: head.taskId, reason: `check "${name}" timed out twice (${this.timeoutMs}ms each)` })
        .catch((e) => this.deps.log?.(`onCannotRun failed task=${head.taskId}: ${String(e)}`))
        .finally(() => this.advance(cwd, head))
      return
    }
    // **Stripped here, not at display time.** This value's readers are not only the screen — it goes
    // into Task.result and the status message body, which the coordinator LLM reads to decide on a
    // retry. Stripping only on screen leaves the deciding side reading control characters. RunPanel's
    // xterm is untouched — that is a terminal and escapes do their job there.
    const output = stripAnsi(this.deps.runner.output(a.runId))
    const passed = a.exitCode === 0
    head.results.push({
      configId, name, status: passed ? 'passed' : 'failed', exitCode: a.exitCode, outputTail: output,
      startedAt: head.startedAt ?? undefined, endedAt: now
    })
    if (passed && head.index + 1 < head.configIds.length) {
      // 같은 이유로 runId·name 을 먼저 지운다(위 첫 timeout 자리와 같은 창) — 지우지 않으면 다음
      // check 의 시작이 끝나기 전에 이 check 의 중복 exit 가 도착했을 때 그것이 다음 check 의 결과로
      // (틀린 configId·이름으로) 기록되고, 0 exit 면 index 가 다시 올라 그 다음 check 를 통째로
      // 건너뛴다. advance 가 이 entry 를 큐에서 내보낸 뒤에도 늦게 끝나는 startCheck 가 runId·timer
      // 를 그 entry 에 얹으면, 이미 다음 entry 가 돌기 시작한 그 cwd 에 PTY 가 하나 더 도는 것과
      // 같다 — 이 클래스가 막으려는 바로 그 것.
      head.runId = null
      head.name = null
      head.index += 1
      head.settling = false
      void this.startCheck(cwd, head)
      return
    }
    if (!passed)
      // RunConfig 를 다시 조회하지 않으므로 이름을 모른다 — configId 를 이름 대신 쓴다. 화면에는
      // 아이디가 이름 대신 보인다는 뜻이고, 조회를 들이는 비용을 아직 치르지 않았다.
      for (const rest of head.configIds.slice(head.index + 1))
        head.results.push({ configId: rest, name: rest, status: 'not-run' })
    void this.deps
      .onSettled({ taskId: head.taskId, results: head.results })
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

  /** Keeps an exit that names no head, while a start is in flight (earlyExits). A lost-sight exit is not
   *  kept: it is not a result (onRunExit), and the real exit follows under the same runId. */
  private rememberEarlyExit(a: { runId: string; exitCode: number }): void {
    if (this.startsInFlight === 0 || a.exitCode === PTY_LOST_SIGHT_EXIT_CODE) return
    this.earlyExits.set(a.runId, a.exitCode)
    if (this.earlyExits.size > EARLY_EXIT_LIMIT) {
      const oldest = this.earlyExits.keys().next().value
      if (oldest !== undefined) this.earlyExits.delete(oldest)
    }
  }

  private clearTimer(head: Pending): void {
    if (head.timer) clearTimeout(head.timer)
    head.timer = null
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
    await this.startCheck(cwd, head)
  }

  /** head 의 index 번째 check 를 띄운다. skip·시작 실패의 처리는 옛 startHead 그대로다 */
  private async startCheck(cwd: string, head: Pending): Promise<void> {
    const configId = head.configIds[head.index]
    if (configId === undefined) {
      // 빈 목록은 onSettled 로 보내지 않는다 — results: [] 는 위쪽에서 [].every(...) 로 통과로
      // 읽혀 "검증할 것이 없다"가 "검증 통과"가 된다. 이것은 그 자체로 배선 결함이다: 배선은
      // checkConfigIdsOf 가 비면 아예 enqueue 하지 않아야 하므로, 여기 닿았다는 것은 그 규칙이
      // 깨졌다는 뜻이고 onCannotRun 이 그 신호를 사람에게(Gate) 넘기는 자리다.
      void this.deps
        .onCannotRun({ taskId: head.taskId, reason: '검증할 check 목록이 비어 있습니다' })
        .catch((e) => this.deps.log?.(`onCannotRun failed task=${head.taskId}: ${String(e)}`))
        .finally(() => this.advance(cwd, head))
      return
    }
    // Carried out of the try so advance is called after it, not inside
    let brokenReason: string | null = null
    let skipped = false
    /** This run's exit, if it arrived before the runId below was recorded (earlyExits). */
    let early: { runId: string; exitCode: number } | null = null
    this.startsInFlight++
    try {
      const outcome = await this.deps.runner.start({ cwd, taskId: head.taskId, configId })
      if (outcome === 'skip') skipped = true
      // **The exit can beat this assignment.** node-pty delivers its exit from the event loop, after this
      // continuation — but a runner may queue it as a microtask inside start (the app's Host pty factory
      // does, for a spawn that never reached the Host), and that microtask runs before this continuation.
      // onRunExit then finds no head and keeps the exit in earlyExits; it is taken out and replayed below,
      // once the runId and the timer are in place (review I1).
      else {
        head.runId = outcome.runId
        head.name = outcome.name
        head.startedAt = new Date().toISOString()
        head.timer = setTimeout(() => {
          if (head.runId !== outcome.runId || head.settling) return
          head.timedOut = true
          this.deps.log?.(`check "${outcome.name}" task=${head.taskId} exceeded ${this.timeoutMs}ms — stopping it`)
          this.deps.runner.stop(outcome.runId)
        }, this.timeoutMs)
        const code = this.earlyExits.get(outcome.runId)
        if (code !== undefined) {
          this.earlyExits.delete(outcome.runId)
          early = { runId: outcome.runId, exitCode: code }
        }
      }
    } catch (e) {
      // It never started, so no exit will come. Not advancing here would block that cwd for ever.
      this.deps.log?.(`validation could not start task=${head.taskId}: ${String(e)}`)
      brokenReason = String(e)
    } finally {
      this.startsInFlight--
      if (this.startsInFlight === 0) this.earlyExits.clear()
    }
    // Replayed outside the try: onRunExit's own failures are not "could not start". Caught all the same —
    // this runs inside an async method nobody awaits, so a throw here would be an unhandled rejection,
    // and in the Host that ends the process (Task 6 re-review m5).
    if (early) {
      try {
        this.onRunExit(early)
      } catch (e) {
        this.deps.log?.(`early exit replay failed run=${early.runId} task=${head.taskId}: ${String(e)}`)
      }
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
   *  **`entry` is the identity check.** `settling` already keeps a second exit of the same head from
   *  reaching here; this is the layer beneath it, so that no caller can ever shift the *next* entry by
   *  mistake — one that never started, so no exit will ever come for it: its Task stays validating for
   *  ever, recomputeReady only promotes completed, and its whole dependent subtree stalls in pending
   *  with no recovery short of a restart. That is exactly the failure this class exists to prevent. */
  private advance(cwd: string, entry: Pending): void {
    this.clearTimer(entry)
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
