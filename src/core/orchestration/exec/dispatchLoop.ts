// 배치 루프 — 앱(src/main/ipc.ts 의 bootOrch)과 Host 가 **같은 것을** 짓는다(설계 §4.1, §5.1).
//
// 자동 진행의 네 조각을 한 자리에 둔다: ready Task 를 자리마다 띄우는 루프(runScheduler, 그 재진입
// 가드와 attempted 집합과 finally 까지), 그 루프가 못 띄운 자리를 사람에게 넘기는 gateSlot, 예약
// 템플릿의 발화(orchFireTick, 그 무장 Map 과 함께), 잠든 코디네이터 깨우기. 이 본문은 예전에
// ipc.ts 안에 인라인으로 있었고 그 자리에는 테스트가 닿지 않았다 — 이제 dispatchLoop.test.ts 가
// 진짜 handleCommand 위에서 돌린다. 옮긴 본문은 줄 단위로 같다: 상태를 읽는 자리, await 의 순서,
// 늦은 바인딩이 그대로다. 달라진 것은 둘이고 둘 다 운전자의 규칙이다:
//
// - **운전자에게 묻는다**(§4.3). 진입할 때(예전의 `if (!orch) return` 자리)와 **슬롯마다** 다시
//   `c.mayStart()` 를 묻는다. 활성화 하나는 await 를 여럿 지나므로 그 사이 운전이 넘어갈 수 있다.
// - **떠나는 Host 의 거절에는 Gate 를 열지 않는다**(R15). `retry` 를 실은 409 는 활성화를 멈춘다.
//
// **worker-start 가 2xx 로 답한 뒤에는 그 Task 에 아무것도 하지 않는다**(R14): 그 뒤의 로그는 전부
// 아래 `log` 를 지나고, 그것은 던지지 않는다.
//
// **electron·src/main·src/renderer 를 import 하지 않는다.** 두 프로세스가 서로 다른 것은 전부
// DispatchLoopContext 로 주입받고, 모듈은 `c.*` 를 **부를 때마다** 읽는다 — 짓는 순간의 사본을 쥐지
// 않는다(C5): 앱과 테스트가 지은 뒤에 칸을 갈아 끼운다.
import type { Lang } from '../../i18n'
import { t } from '../../i18n'
import { accountToDispatchOn } from '../../accounts/dispatchAccount'
import { providerOf } from '../../providers/meta'
import type { Account } from '../../types'
import { nameForRun, nameForTask } from '../../worktrees/naming'
import { firesDue } from '../fire'
import { NO_COORDINATOR_ANSWER, unattendedQuestions, unreadUpwardMail } from '../inbox'
import {
  buildIntegrationSpec,
  integrationTaskFor,
  isIntegrationTask,
  pendingMerges,
  runRootOf,
  workingInRunRoot,
  worktreeDepsOf
} from '../integrate'
import { reapableChildRuns } from '../reap'
import { lostAttemptOf } from '../../recovery/candidates'
import { slotsToFill, tasksMissingAccounts, type Slot } from '../schedule'
import { coordinatorStarting, jobOf, type OrchState } from '../state'
import { DEFAULT_CONCURRENCY, FAILURE_LIMIT } from '../types'
import { outcomeOf } from '../view'
import type { Integration } from './integrateGit'

/** 15초 — 세션 스케줄러의 TICK_MS 와 같은 값이다 */
export const ORCH_FIRE_TICK_MS = 15_000
/** 코디네이터를 깨우기 전에 기다리는 시간.
 *
 *  **짧으면** `check --wait` 안에서 정상적으로 기다리는 코디네이터를 찌른다 — 그 호출은 서버에서
 *  막혀 있고 도는 동안 토큰을 안 쓰므로, 헛된 찌르기는 그 공짜 기다림을 유료 턴으로 바꾼다.
 *  **길면** 잠든 코디네이터 밑에서 Run 이 그만큼 서 있다.
 *
 *  90초로 둔 근거: `check` 의 기본 대기가 그보다 짧고(DEFAULT_CHECK_TIMEOUT_MS), 정상 코디네이터는
 *  타임아웃마다 다시 `check` 를 불러 그 배치를 ack 하므로 이 시각까지 미확인으로 남지 않는다.
 *  즉 이 문턱을 넘는 것은 "루프를 놓았다" 의 신호에 가깝다. 틱이 15초이므로 실제 깨우기는
 *  90~105초 사이에 일어난다. */
export const COORDINATOR_NUDGE_MS = 90_000
/** The first wait before a coordinator stop is sent again (limits pass L1). Longer than the exit
 *  release's window (EXIT_DEFER_MS) by far, so a stop that landed has emptied the slot before it; each
 *  further try waits twice as long, up to `COORDINATOR_STOP_RETRY_MAX_MS`. */
export const COORDINATOR_STOP_RETRY_MS = 30_000
export const COORDINATOR_STOP_RETRY_MAX_MS = 10 * 60_000
/** How many stops are sent at the `COORDINATOR_STOP_RETRY_MAX_MS` interval before the loop gives up on a
 *  session (LP-1/2): about an hour at the cap. A stop the session keeps refusing for good (a finished Run
 *  that `runMoves` still counts as moving) was otherwise asked every 10 minutes forever, with a log line
 *  each time. Giving up is logged once and is in memory only: the slot and its pending mark stay, so a
 *  restart or a new driver asks again, and a session later known to be gone is still released. */
export const COORDINATOR_STOP_RETRY_CAP_TRIES = 6

export interface DispatchLoopContext {
  /** handleCommand under this process's own caller id (the app's UI_CALLER, the Host's HOST_CALLER). */
  handle(cmd: string, args: Record<string, unknown>): Promise<{ status: number; body: unknown }>
  getState(): OrchState
  accounts(): Account[] | Promise<Account[]>
  loginStatus(accountId: string): Promise<boolean>
  lang(): Lang
  forkRunWorktree(a: { repoPath: string; name: string }): Promise<string>
  integrate(runRoot: string, merges: string[]): Promise<Integration>
  reap(worktreePath: string): Promise<boolean>
  isRegisteredWorktree(p: string): boolean
  sessionAlive(sessionId: string): boolean
  /** True only when this process **knows** the session has ended for real (limits pass L1): the Host's
   *  registry holds an ended pty for it, or the app's session list holds it exited with a real exit code
   *  (not PTY_LOST_SIGHT_EXIT_CODE, which is a Host-held session still running). False for a live
   *  session and for one this process cannot tell about (never held here), so a stop is never taken as
   *  confirmed on a guess. Optional: without it a pending stop is only retried. */
  sessionGone?(sessionId: string): boolean
  /** true busy, false idle, null cannot tell. */
  sessionBusy(sessionId: string): boolean | null
  typeInto(sessionId: string, text: string): void
  /** Asked on entry and again before each slot (§4.3). */
  mayStart(): boolean
  log(m: string): void
  nowMs(): number
}

/** How one placed slot ended (`placeSlot`). `gate` is a slot that cannot start until a person acts,
 *  `wait` one that starts later on its own (an integration step first), `refused` a `worker-start` that
 *  answered 400 or more, `leaving` a Host that is retiring, `started` a worker that is up. */
type SlotEnd =
  | { kind: 'started'; reply: { status: number; body: unknown } }
  | { kind: 'refused'; reply: { status: number; body: unknown } }
  | { kind: 'leaving'; reply: { status: number; body: unknown } }
  | { kind: 'gate'; reason: string; why: string }
  | { kind: 'wait'; why: string }

export interface DispatchLoop {
  run(): Promise<void>
  /**
   * **One ready Task, placed now, on a person's request** (`tasks dispatch`, CLI spec §18). The same
   * slot the loop would place (`placeSlot`: the account, the run worktree, the integration step, the
   * placement, `worker-start`), for a Task the loop's own pass may not reach: one of a Run no loop
   * places, or one the pass already tried in this activation. It runs alone, never beside a pass, so the
   * two cannot fork one run worktree twice. It opens **no Gate**: what would have been a Gate is the
   * answer, 409 with the reason, and the person decides. The caller (the command layer) has already
   * refused a Run that is paused, not running or coordinator-driven.
   */
  dispatchOne(taskId: string): Promise<{ status: number; body: unknown }>
  fireTick(): Promise<void>
  nudge(): Promise<void>
  /** Drops the schedule arming, so the next fireTick only arms (D2, R17). */
  forgetArming(): void
  /** firesDue's arm half only: re-arms every template and fires nothing (N3). The app calls it on its
   *  timer in front of a driving Host, so the sidebar's next-fire time stays right. */
  armOnly(): void
  /** The armed next fire of a schedule template, or null: what orchSnapshotOf shows as nextFireAt (N3). */
  nextFireOf(runId: string): number | null
}

/** The module reads every `c.*` at each call, never a copy taken at construction (C5): the app and the
 *  tests replace members after building it. */
export function createDispatchLoop(c: DispatchLoopContext): DispatchLoop {
  /** 로그 한 줄. **던지지 않는다**(R14) — worker-start 가 2xx 로 답한 뒤의 로그가 던지면 그 예외가
   *  슬롯의 catch 로 가서 이미 뜬 Task 에 Gate 를 청한다. 로그는 알림이지 일의 일부가 아니다. */
  const log = (m: string): void => {
    try {
      c.log(m)
    } catch {
      // 로그를 남길 자리가 없다 — 남길 곳이 없으므로 삼킨다.
    }
  }

  /** 예약 템플릿의 다음 발화 시각. **상태에 저장하지 않는다** — 재시작하면 비어 있고, 그때
   *  firesDue 가 nextFireAt(rule, now) 으로 다시 무장한다. 그것이 곧 "앱이 꺼져 있던 동안의
   *  발화는 버린다"는 규칙의 구현이다(main/scheduler.ts 가 같은 이유로 같은 선택을 했다). */
  let armed = new Map<string, number>()

  /** 이 자리를 지금 띄울 수 없다고 **사람에게** 알린다. 로그가 아니라 Gate 인 이유: 이 층의 실패는
   *  "일이 실패했다"가 아니라 **"앱이 일을 시작하지 못했다"** 이고, 그 판단은 사람의 것이다.
   *  Reviewer 슬라이스가 정한 규칙("Gate 는 돌릴 수 없을 때만 쓴다")이 정확히 이 경우다 — 계정이
   *  없을 때가 이미 그렇게 처리되고 있으므로 같은 부류인 worker-start 실패를 다르게 다루지 않는다.
   *
   *  **되풀이를 멈추는 장치이기도 하다.** Gate 가 열리면 Task 가 blocked 로 가고 slotsToFill 은
   *  ready 만 고르므로 그 자리는 더 이상 후보가 아니다. 그것이 없으면 진짜로 매번 실패하는 자리
   *  (userData 경로에 & 가 들어가 launch 프롬프트가 깨지는 경우가 그렇다 — 위의 LAUNCH_FORBIDDEN
   *  경고는 경고일 뿐 startup 을 막지 않는다)가 **바깥의 상태 변경마다 한 번씩 영원히** 다시 시도된다.
   *  실패 롤백은 consecutiveFailures 를 올리지 않으므로 회로 차단이 대신 걸리는 일도 없다.
   *
   *  이 함수는 실패를 **알리는** 자리이지 실패를 만드는 자리가 아니므로 던지지 않는다. gate-create
   *  도 setState 를 지나므로 같은 이유로 거부될 수 있고, 그것을 그대로 흘려보내면 이 함수를 부르게
   *  만든 원래의 실패까지 함께 지워진다. */
  const gateSlot = async (taskId: string, reason: string): Promise<void> => {
    // Gate 와 별개로 로그를 남긴다 — Gate 는 사용자가 읽는 것이고, 이 줄은 왜 그 Gate 가 열렸는지
    // 나중에 되짚을 때 읽는 것이다.
    log(`scheduler: cannot start task=${taskId} — ${reason}`)
    try {
      const gated = await c.handle('gate-create', {
        task: taskId,
        question: reason
      })
      // Gate 마저 거절되는 경우가 있다: gate-create 는 열린 Dispatch 가 있는 Task 를 거절하고
      // (state.ts), dispatched 에서 blocked 로 가는 전이도 없다(types.ts 의 ALLOWED). 그 상태로
      // 남는 자리는 ready 가 아니라서 slotsToFill 이 더는 고르지 않으므로 되풀이로는 이어지지
      // 않지만, 사용자에게 남는 신호가 사라지므로 그 자리를 로그로 메운다.
      if (gated.status >= 400)
        log(`scheduler: gate-create rejected task=${taskId} — ${JSON.stringify(gated.body)}`)
    } catch (e) {
      log(`scheduler: gate-create failed task=${taskId} — ${String(e)}`)
    }
  }

  /** When each coordinator session may be asked to stop again (limits pass L1), by session id. A stop
   *  is not remembered as done: until the exit release empties the slot, the Run keeps it (marked
   *  `coordinatorStopPending` once the command ran) and the stop is sent again, first after
   *  `COORDINATOR_STOP_RETRY_MS`, then twice as long each time up to `COORDINATOR_STOP_RETRY_MAX_MS`.
   *  A refusal and a throw are retried the same way, until `COORDINATOR_STOP_RETRY_CAP_TRIES` stops at
   *  the cap have gone unanswered, then it gives up with one log line (LP-1/2). **In memory on purpose**: the pending mark is what
   *  survives a restart or a change of driver, and a new driver's first pass sends the stop at once. */
  const stopRetry = new Map<string, { tries: number; nextAt: number; capped: number; gaveUp: boolean }>()

  /**
   * **A scheduled Job's Run that has finished gets its coordinator stopped** (the user's U4 of
   * 2026-09-25). Otherwise every fire leaves one more coordinator looping on `check --wait` for good.
   * A finished Run is one whose outcome is no longer `running` (every Task done, view.ts). Only a Job
   * with a schedule: a manual `jobs run` Run keeps its coordinator, since a person may be reading its
   * tab (the controller's ruling on U4's scope). **A slot marked `coordinatorStopPending` is sent
   * again too** (L1), whatever its Run's outcome: a fire's replacement leaves that Run paused and
   * unfinished.
   *
   * **Only the process that drives does it.** The caller has asked `mayStart` just before, and this
   * asks again before each stop, so the app and the Host never both stop one coordinator. The stop and
   * the pending mark are `run-coordinator-stop`'s, through the command layer like every other thing
   * this loop does. A failure is logged and never thrown (R14).
   */
  const stopFinishedCoordinators = async (): Promise<void> => {
    const s = c.getState()
    const slots = new Set<string>()
    for (const run of s.runs) if (run.coordinatorSessionId !== undefined) slots.add(run.coordinatorSessionId)
    // A session no slot names any more is gone (the exit release emptied it): its backoff goes with it.
    for (const id of [...stopRetry.keys()]) if (!slots.has(id)) stopRetry.delete(id)
    for (const run of s.runs) {
      const sessionId = run.coordinatorSessionId
      if (sessionId === undefined) continue
      const pending = run.coordinatorStopPending !== undefined
      if (!pending) {
        if (jobOf(s, run)?.schedule === undefined) continue
        if (outcomeOf(s, run.id) === 'running') continue
      }
      // **A session this process knows has ended is the stop confirmed** (L1): its exit was never heard
      // (no exit release came), so nothing else would ever empty the slot, and a stop sent to it goes
      // nowhere for good. The command empties the slot the way the exit release does.
      if (c.sessionGone?.(sessionId) === true) {
        if (!c.mayStart()) return
        try {
          const r = await c.handle('run-coordinator-stop', { run: run.id, gone: sessionId })
          if (r.status >= 400) log(`run=${run.id}: releasing the slot of its ended coordinator ${sessionId} was refused: ${JSON.stringify(r.body)}`)
          else stopRetry.delete(sessionId)
        } catch (e) {
          log(`run=${run.id}: releasing the slot of its ended coordinator ${sessionId} failed: ${String(e)}`)
        }
        continue
      }
      const nowMs = c.nowMs()
      const retry = stopRetry.get(sessionId)
      if (retry && (retry.gaveUp || nowMs < retry.nextAt)) continue
      if (!c.mayStart()) return
      // LP-1/2: after COORDINATOR_STOP_RETRY_CAP_TRIES stops at the cap, one log line and no more stops.
      if (retry && retry.capped >= COORDINATOR_STOP_RETRY_CAP_TRIES) {
        retry.gaveUp = true
        log(
          `run=${run.id}: gave up stopping its coordinator ${sessionId} after ${retry.tries} attempts; ` +
            `the slot stays pending until the session exits, a restart or a new driver asks again`
        )
        continue
      }
      const tries = (retry?.tries ?? 0) + 1
      const wait = Math.min(COORDINATOR_STOP_RETRY_MS * 2 ** (tries - 1), COORDINATOR_STOP_RETRY_MAX_MS)
      const capped = (retry?.capped ?? 0) + (wait === COORDINATOR_STOP_RETRY_MAX_MS ? 1 : 0)
      stopRetry.set(sessionId, { tries, nextAt: nowMs + wait, capped, gaveUp: false })
      const again = `; asked again in ${Math.round(wait / 1000)}s unless the session is gone by then`
      const what = tries === 1 ? `scheduled run=${run.id} finished` : `run=${run.id} (stop attempt ${tries})`
      try {
        const r = await c.handle('run-coordinator-stop', { run: run.id })
        log(
          r.status >= 400
            ? `${what}, and stopping its coordinator ${sessionId} was refused: ${JSON.stringify(r.body)}${again}`
            : `${what}: its coordinator ${sessionId} was asked to stop${again}`
        )
      } catch (e) {
        log(`${what}, and stopping its coordinator ${sessionId} failed: ${String(e)}${again}`)
      }
    }
  }

  /** **Drops the stale coordinator start marks** (limits pass L2): a `coordinatorStartingAt` past its
   *  window is a start that died with its process. It already counts for nothing, but the view the app
   *  last got was computed while it held, and keeps hiding the ▶ until a commit. The command
   *  (`run-start-marks-clear`) does the dropping on the state as it is then. Driving process only. */
  const clearStaleStartMarks = async (): Promise<void> => {
    const nowMs = c.nowMs()
    if (!c.getState().runs.some((r) => r.coordinatorStartingAt !== undefined && !coordinatorStarting(r, nowMs))) return
    if (!c.mayStart()) return
    try {
      const r = await c.handle('run-start-marks-clear', {})
      const cleared = (r.body as { cleared?: unknown } | null)?.cleared
      if (r.status >= 400) log(`stale coordinator start marks were not cleared: ${JSON.stringify(r.body)}`)
      else if (Array.isArray(cleared) && cleared.length > 0)
        log(`stale coordinator start marks cleared on ${cleared.join(', ')}`)
    } catch (e) {
      log(`stale coordinator start marks were not cleared: ${String(e)}`)
    }
  }

  /** The coordinator housekeeping: the stale start marks (L2), then the stops due (U4, L1). Run from the
   *  pass and from the timer's `nudge`, since the app runs the pass only on commits and a stop to retry
   *  or a mark to drop comes due with nothing committed. One at a time: a second call while one is under
   *  way does nothing, and the backoff keeps the next one from repeating a stop just sent. */
  let tidying = false
  const tidyCoordinators = async (): Promise<void> => {
    if (tidying) return
    tidying = true
    try {
      if (!c.mayStart()) return
      await clearStaleStartMarks()
      if (!c.mayStart()) return
      await stopFinishedCoordinators()
    } finally {
      tidying = false
    }
  }

  /**
   * **One slot, placed: the account, the run worktree, the integration step, the placement, then
   * `worker-start`.** The body of the loop's slot, moved here unchanged so that `dispatchOne` (a
   * person's `tasks dispatch`) places a Task through exactly the path the loop does. What the loop
   * does with each ending stays in the loop (a Gate, a log line, the end of the activation), and what a
   * person's call does with it stays in `dispatchOne` (an answer). `why` is the same fact as `reason`,
   * in English, for that answer: some reasons are Gate questions in the app's language.
   */
  const placeSlot = async (slot: Slot, accounts: Account[], loggedIn: Set<string>): Promise<SlotEnd> => {
    // 사람이 이 Task 에 계정을 지정했으면 그 목록의 첫 계정, 아니면 그 provider 의 기본
    // 계정. 판정은 core 에 있다(accountToDispatchOn) — 이 파일에는 테스트가 닿지 않는다.
    // **갈아탈 순서(체인)는 여기서 넘기지 않는다** — worker-start 를 거쳐 가므로 그 체인은
    // deps.startWorker 래퍼가 다시 계산한다(그래야 CLI 로 띄운 워커도 같은 체인을 받는다).
    // **provider 는 이 Task 의 첫 계정이 정한다.** Slot 에는 그 칸이 없다 — 계정 id 를
    // provider 로 옮기려면 계정 목록을 봐야 하고 그것은 core 가 볼 수 없는 것이라
    // (schedule.ts 의 Slot 주석), 그 한 걸음이 여기 있다. 첫 id 가 목록에 없으면 판정에
    // 넘길 provider 자체가 없으므로 곧바로 Gate 다 — accountToDispatchOn 이 같은 id 를
    // 'assigned-unusable' 로 답할 자리이고, 사람이 할 일도 같다(지정을 고친다).
    const firstAccount = accounts.find((x) => x.id === slot.accountIds[0])
    if (!firstAccount)
      return {
        kind: 'gate',
        reason: t(c.lang(), 'jobs.gate.assignedAccountUnusable'),
        why: `the first account task ${slot.taskId} names (${slot.accountIds[0]}) is not one Astera holds`
      }
    const slotProvider = providerOf(firstAccount)
    const picked = accountToDispatchOn({
      assigned: slot.accountIds,
      provider: slotProvider,
      accounts,
      loggedInIds: loggedIn
    })
    if (!picked.ok) {
      // 조용히 넘기면 Run 이 이유 없이 서 있다 — 이 슬라이스가 없애려는 증상 그대로다.
      // Reviewer 슬라이스가 "쓸 수 있는 다른 provider 계정이 없다"에 내린 것과 같은 판단이다.
      // **지정한 계정을 못 쓰는 경우도 여기로 온다** — 목록의 첫 칸을 못 쓰는 것과 목록에
      // 쓸 것이 아예 없는 것, 둘 다다. 기본 계정으로도 뒤 칸으로도 갈아타지 않는 이유는
      // accountToDispatchOn 의 주석에 있다: 그가 아끼려던 계정에 일이 간다. 그러니 이
      // Gate 가 사람이 그 사실을 아는 유일한 자리다.
      return {
        kind: 'gate',
        reason:
          picked.reason === 'assigned-unusable'
            ? t(c.lang(), 'jobs.gate.assignedAccountUnusable')
            : t(c.lang(), 'jobs.gate.noAccount', { provider: slotProvider }),
        why:
          picked.reason === 'assigned-unusable'
            ? `the account task ${slot.taskId} is assigned (${slot.accountIds[0]}) cannot be used now: it is not logged in, or is not a ${slotProvider} account`
            : `no ${slotProvider} account is logged in to run task ${slot.taskId} on`
      }
    }
    const accountId = picked.accountId
    // **한 Run 은 두 방식 중 하나로만 돈다.** 섞지 않는 이유는 병합 대상이다 — 병합은
    // 깨끗한 작업 트리에만 적용되고, 워커 하나를 합칠 자리에 띄우면 그 폴더에 커밋 안 된
    // 변경이 남아 나머지 워크트리를 합칠 자리가 없어진다. 그래서 동시 실행 손잡이 하나가
    // 두 가지를 정한다: 1 이면 **Run 워크트리**에서 차례대로, 2 이상이면 전부 자기
    // 워크트리에서. 병렬인데 한 폴더는 고를 수 있어서는 안 되는 조합이다 — 서로를 덮어쓴다.
    //
    // **프로젝트 폴더에서 도는 워커는 없다.** 한때 1 이하가 그 뜻이었다(그리고 사용자가
    // 보고 있는 체크아웃에 에이전트가 썼다). 이제 Run 이 자기 워크트리를 갖고, 프로젝트
    // 폴더로 합치는 것은 사람이 상세 창에서 누른다.
    //
    // run 은 slotsToFill 이 만든 스냅숏이 **아니라** 여기서 새로 읽은 상태에서 찾는다 —
    // 그 사이(위) 계정 로그인 조회가 await 를 하나 두었고, 이 for 문의 앞선 슬롯이 이미
    // gateSlot 이나(아래) c.handle(worker-start) 로 실제 쓰기를 했을 수 있어,
    // 이 시점의 상태를 slotsToFill 이 봤던 것과 같다고 가정할 수 없다. run 과 task 가
    // 그래도 반드시 있는 것은 스냅숏이 같아서가 아니라, 이 활성화 동안 Run 이나 Task 를
    // 지우는 명령이 없기 때문이다(slotsToFill 이 이미 run.id === task.runId 인 run 이
    // 있는 Task 만 후보로 냈으므로 — schedule.ts). **이 루프의 동시성 논증은 모두 이
    // 전제(스냅숏이 아니라 슬롯마다 새로 읽는다) 위에 서 있다** — 여기를 "같은 스냅숏"
    // 이라고 잘못 적으면 다음에 이 루프의 레이스를 따지는 사람이 틀린 전제에서 시작한다.
    let state = c.getState()

    // **Run 워크트리를 여기서 만든다 — 게으르게.** Run 을 만들 때가 아닌 이유가 둘이다:
    // 예약 템플릿은 한 번도 돌지 않으므로 워크트리가 필요 없고, pendingStart Run 은
    // 사람이 '실행' 을 누르기 전까지 디스크에 아무것도 남기지 않아야 한다. 이 자리는
    // 둘 다 이미 지난 곳이다(slotsToFill 이 그 둘을 슬롯으로 내지 않는다).
    //
    // 병합 블록보다 앞에 두는 이유: 통합 병합의 대상이 Run 뿌리이므로(아래
    // integrateWorktrees) 그때 이미 있어야 한다. 동시 실행 2 이상인 Run 은 첫 Task 들이
    // 자기 워크트리로 가므로 Run 워크트리를 아무도 만들지 않는데, 그 Run 의 통합 Task 는
    // Run 워크트리에서 돌아야 한다.
    let run = state.runs.find((r) => r.id === slot.runId)!
    if (run.worktree === undefined) {
      try {
        // c.forkRunWorktree(앱과 Host 모두 integrateGit.ts 의 forkWorktree)가 프로젝트가 **서 있는
        // 브랜치**에서 갈라 준다. raw createWorktree 를 부르면 origin/HEAD 에서 갈라져 최종 병합이
        // 엉뚱한 조상을 끌고 온다 — 그 판단은 한 곳에만 있어야 한다.
        const runJob = jobOf(state, run)
        const created = await c.forkRunWorktree({
          repoPath: runJob?.cwd ?? '',
          name: nameForRun({ id: run.jobId, objective: runJob?.objective ?? '' })
        })
        const set = await c.handle('run-worktree-set', { run: run.id, worktree: created })
        if (set.status >= 400)
          return {
            kind: 'gate',
            reason: `Run 워크트리를 기록하지 못했습니다: ${JSON.stringify(set.body)}`,
            why: `the run worktree could not be recorded: ${JSON.stringify(set.body)}`
          }
        log(`scheduler: run=${run.id} works in ${created}`)
        // **상태를 다시 읽는다 — run 만이 아니라 state 도.** run 은 아래 runRoot 와 limit
        // 이 그것에서 나오기 때문이다: 방금 기록한 워크트리가 없는 run 을 들고 가면 배치와
        // 통합 병합의 대상이 프로젝트 폴더가 되어, 이 블록이 막으려던 바로 그 결과가 된다.
        //
        // state 는 병합 판정(pendingMerges·workingInRunRoot) 때문이다. 이 자리에서 낡은
        // 스냅숏은 병합을 **덜** 센다 — 그 스냅숏의 뿌리는 프로젝트 폴더이므로 프로젝트
        // 폴더에서 돈 Dispatch 를 "뿌리에서 돌았다"고 보아 건너뛴다. 중간에 워크트리를
        // 갖게 된 Run 은 그런 Dispatch 를 그대로 들고 있고(이 배선 전에 뜬 워커들이다),
        // 그것들은 이제 합쳐야 하는 재료다. 낡은 스냅숏으로 물으면 그 일이 조용히 빠진다.
        state = c.getState()
        run = state.runs.find((r) => r.id === slot.runId)!
      } catch (e) {
        // 저장소에 닿을 수 없으면 `NO_REPO:`, HEAD 가 분리됐으면 `NO_BASE:` 다 —
        // workerBaseFailure 가 그 문장을 만들고 forkWorktree 가 던진다. **저장소가 아닌
        // 폴더도 `NO_REPO:` 다** — forkWorktree 의 `rev-parse --git-dir` 탐침이 먼저
        // 실패하므로 createWorktree 까지 가지 않는다. 그쪽의 `NOT_GIT_REPO:`
        // (create.ts 의 createWorktree, repoRoot 가 null)는 git 은 돌지만 작업 트리가 없는
        // 저장소 — bare 저장소 — 만 남는다. 셋 다
        // 읽을 수 있는 접두사가 붙어 오므로 그대로 Gate 에 싣는다. 다음 상태 변경에 다시
        // 시도한다(사람이 저장소를 고치는 것 자체가 상태 변경은 아니지만, 그 Gate 를 푸는
        // 것이 상태 변경이다).
        return {
          kind: 'gate',
          reason: `Run 워크트리를 만들지 못했습니다: ${String(e)}`,
          why: `the run worktree could not be made: ${String(e)}`
        }
      }
    }
    // Task 는 **워크트리 확보 블록 뒤에** 읽는다. 반드시 있는 것은 run 과 같은 이유이고
    // (slotsToFill 이 상태에서 골라낸 id 다), 여기까지 내려온 것은 이 루프의 "슬롯마다
    // 새로 읽는다" 전제를 그대로 지키기 위해서다 — 위 블록이 run-worktree-set 으로 쓰기를
    // 하므로, 그보다 앞에서 읽은 값은 그 쓰기를 못 본 스냅숏이 된다. 지금 읽는 필드가
    // 바뀌지 않는 것들(title·deps)이라 오늘은 무해하지만, 그 논증이 필요 없는 자리로
    // 옮기는 것이 전제를 지키는 값싼 방법이다.
    const task = state.tasks.find((t) => t.id === slot.taskId)!
    const runRoot = runRootOf(run, jobOf(state, run))

    // **통합 단계 — worker-start 앞이다.** 의존이 자기 워크트리에서 돌았다면 그 브랜치의
    // 커밋을 Run 뿌리로 먼저 합친다. 앱이 직접 합치고 **충돌할 때만 에이전트에게**
    // 넘기는 것이 이 기능의 결정이다: 사람을 부르는 것은 모든 작업이 끝났을 때로 미룬다.
    //
    // 통합 Task 자신은 이 단계를 지나지 않는다. 지나면 그 Task 의 deps(= 그 워크트리 Task
    // 들)를 보고 통합 Task 를 위한 통합 Task 를 만들고, 그것이 끝없이 이어진다 — 새 Task 는
    // 매번 새 id 라서 아래의 attempted 가 막지 못한다(integrate.ts 에 자세히 적었다).
    const merges = isIntegrationTask(task) ? [] : pendingMerges(state, slot.taskId)
    if (merges.length > 0) {
      // **이미 통합 Task 가 있으면 새로 만들지 않는다.** 아직 끝나지 않았으면 그것을
      // 기다린다. 실패했어도 만들지 않는다 — 즉시 실패하는 통합은 상태 변경마다 Task 를
      // 하나씩 늘리게 되고 그것은 경계가 없다. 보이는 정지가 조용한 쌓임보다 낫다(실패한
      // Task 는 그래프에 그대로 남고, 거기서 다시 띄우는 것이 사람의 길이다).
      const existing = integrationTaskFor(state, slot.taskId)
      if (existing && existing.status !== 'completed') {
        log(
          `scheduler: task=${slot.taskId} waits for integration task=${existing.id} (${existing.status})`
        )
        return { kind: 'wait', why: `it waits for its integration task ${existing.id} (${existing.status}) to finish` }
      }
      // Run 뿌리에서 도는 워커가 있으면 합치지 않는다 — 그 워커가 읽은 트리를 그
      // 아래에서 갈아치우는 일이고, 그 실패는 조용하다(integrate.ts 에 이유가 있다).
      // 다음 상태 변경에 다시 본다. 그 워커가 끝나는 것 자체가 상태 변경이다.
      if (workingInRunRoot(state, slot.runId)) {
        log(`scheduler: task=${slot.taskId} waits — a worker is still working in ${runRoot}`)
        return {
          kind: 'wait',
          why: `the worktrees it depends on must be merged into ${runRoot} first, and a worker is still working there`
        }
      }
      // **여기서부터 git 이 돈다.** 위까지는 상태만 본다 — runScheduler 는 모든 저장마다
      // 불리고 그 대부분은 합칠 것이 없는 저장이므로, 그 바퀴에 git 프로세스를 띄우지 않는다
      // (슬롯이 없을 때 계정 조회 앞에서 빠지는 것과 같은 성격이다).
      const integration = await c.integrate(runRoot, merges)
      if (integration.kind === 'human') {
        return { kind: 'gate', reason: integration.reason, why: integration.reason }
      }
      if (integration.kind === 'agent') {
        // 통합 Task 가 이미 completed 인데 아직 깨끗하지 않다면 넘길 곳이 없다 — 두 번째
        // 통합 Task 를 만들지 않기로 했으므로 사람에게 간다. 조용히 넘기면 사용자에게
        // 남는 것은 '완료된 통합 Task 와 이유 없이 서 있는 Task' 뿐이어서 문제가 보이지
        // 않는다(실패한 통합 Task 는 그래프에서 스스로 보이므로 그쪽은 Gate 가 아니다).
        if (existing) {
          return {
            kind: 'gate',
            reason: `통합 Task 가 끝났는데도 워크트리를 합칠 수 없습니다: ${integration.reason}`,
            why: `the worktrees it depends on still cannot be merged although the integration task finished: ${integration.reason}`
          }
        }
        // 통합 Task 도 **task-create 로** 만든다 — 앱이 createTask 를 직접 부르지 않는다.
        // 문은 하나다. `runId` 도 명시한다: 그 인자가 없으면 task-create 는 '가장 마지막에
        // 만들어진 Run' 을 쓰고(server.ts), 그것은 이 슬롯의 Run 이 아닐 수 있다.
        const created = await c.handle('task-create', {
          runId: slot.runId,
          // parentId 가 "이 Task 의 통합 Task" 라는 표식이다 — 다음 바퀴에 그것을 보고
          // 두 번 만들지 않는다(integrate.ts 의 integrationTaskFor).
          parent: slot.taskId,
          deps: worktreeDepsOf(state, slot.taskId),
          // 제목은 그래프에 뜨므로 사람의 말(한국어)이고 — 같은 파일의 Gate 질문이
          // 그렇다 — spec 본문은 에이전트가 읽으므로 영어다(buildSpecFile 의 의무 절과
          // 같은 이유). 둘 다 i18n 카탈로그에 넣지 않는다: 그 카탈로그는 렌더러의 문구를
          // 위한 것이고 이 문구는 main 에서 조립된다. 80자로 자르는 것은 title 을 주지
          // 않았을 때 task-create 가 하는 것과 같은 길이다.
          title: `워크트리 병합: ${task.title}`.slice(0, 80),
          spec: buildIntegrationSpec({
            mergeInto: runRoot,
            reason: integration.reason,
            worktrees: integration.worktrees
          })
        })
        if (created.status >= 400) {
          return {
            kind: 'gate',
            reason: `워크트리를 합칠 통합 Task 를 만들지 못했습니다: ${JSON.stringify(created.body)}`,
            why: `the integration task that merges the worktrees it depends on could not be made: ${JSON.stringify(created.body)}`
          }
        }
        log(`scheduler: integration task created for task=${slot.taskId} — ${integration.reason}`)
        // 이번 회차에서 이 Task 는 띄우지 않는다. 통합 Task 는 방금의 setState 로 스케줄러가
        // 한 바퀴 더 돌 때 스스로 슬롯이 된다(deps 가 이미 전부 completed 이므로 ready 다).
        return {
          kind: 'wait',
          why: `the worktrees it depends on must be merged first, so an integration task was made for that (${String((created.body as { id?: unknown } | null)?.id ?? '')}); it runs first`
        }
      }
    }

    // 통합 Task 는 동시 실행 손잡이와 상관없이 Run 뿌리에 놓이므로(아래 배치 예외), 그
    // 자리에 이미 도는 워커와 **겹치지 않게 한다.** 접합점이 둘이면 통합 Task 도 둘이
    // 만들어질 수 있고, 그 둘을 같은 폴더에 함께 띄우면 서로의 index.lock 과 서로가 만든
    // 병합을 밟는다 — 한 폴더에 병렬 워커를 두지 않는다는 Task 배치 규칙의 이유가 그대로
    // 여기에도 있다. 뒤의 것은 다음 상태 변경에 다시 본다(앞의 것이 끝나는 것 자체가 상태
    // 변경이다).
    if (isIntegrationTask(task) && workingInRunRoot(state, slot.runId)) {
      log(
        `scheduler: integration task=${slot.taskId} waits — a worker is still working in ${runRoot}`
      )
      return { kind: 'wait', why: `it merges into ${runRoot}, and a worker is still working there` }
    }

    const limit = jobOf(state, run)?.concurrency ?? DEFAULT_CONCURRENCY
    // **통합 Task 는 Run 워크트리에서 돈다 — Task 별 워크트리 규칙의 예외다.** 예외인
    // 이유는 그 Task 의 일 자체가 "이 뿌리로 합치는 것" 이라서다: 자기 워크트리에서 돌면
    // origin 기준으로 갈라진 다른 브랜치에 합치게 되어 아무 값이 없고, buildSpecFile 이
    // 붙이는 커밋 의무("이 워크트리에 커밋하라")가 spec 본문("이 폴더에 합치고 커밋하라")과
    // 정면으로 부딪힌다(코디네이터가 검토 spec 을 구현자 템플릿으로 감싸지 않는 것과 같은
    // 부류의 충돌이다). 섞지 않는 원래 이유(합칠 폴더에 커밋 안 된 변경이 남으면 합칠
    // 자리가 없어진다)는 여기서도 지켜진다: 그 spec 이 끝에 작업 트리를 깨끗하게 두라고
    // 요구하고, 그 Dispatch 가 열려 있는 동안은 workingInRunRoot 가 앱의 병합을 막는다.
    //
    // **스케줄러의 배치는 'current' 를 더 이상 보내지 않는다.** 명시 경로 분기
    // (coordinator.ts)로 보내는 이유는 그쪽이 fs.stat 으로 존재를 확인해 주기 때문이다.
    // 'current' 를 보내는 곳은 **둘뿐이다**: 검토 Dispatch 는 구현자의 트리를 runCwd 로 넘겨
    // 검토자를 정확히 그 트리에, 커밋 의무 없이 세우고(startReview), CLI 에서는 사람이
    // `--worktree current` 를 직접 쓸 수 있다. 상세 창의 수동 띄우기 버튼은 셋째였는데
    // 이제 아무 배치도 보내지 않는다 — 그 결정은 worker-start 의 기본값이 Run 에게 묻는다
    // (server.ts).
    const placement =
      isIntegrationTask(task) || limit <= 1
        ? { worktree: runRoot }
        : {
            // nameForTask 는 이미 slugify 를 거친 값(또는 그것이 던질 때의 Task id)을 낸다 —
            // 여기서 이미 유일성을 보장하지는 않지만, createWorktree 가 받는 이름에 slugify 를
            // 한 번 더 걸어도(naming.ts, 멱등이다) 값이 바뀌지 않고, 충돌(같은 이름의
            // 브랜치·경로)도 candidateName 접미사 루프로 스스로 피한다(create.ts) — 그래서
            // 여기서 접미사를 더 붙이지 않는다.
            worktree: 'new',
            name: nameForTask(task)
          }
    // **잃은 워커를 되살리는 시작이면 retryOf 로 잇는다**(P1 이월 5). 복구 Gate(재조정기의 review,
    // Host 의 잃은 워커 Gate)에 사람이 답하면 Task 가 ready 로 돌아와 이 자리로 온다 — 그 새 시도는
    // 재조정기의 re-dispatch(execute.ts)와 같은 재시도이므로 Timeline 이 재시도 칩을 보이게 같은 칸을
    // 채운다. 판정은 candidates 와 같은 규칙(가장 최근 Dispatch 가 잃은 것인가)이고, 사람이 멈춘
    // 시도(closedBy)나 결과를 보고한 시도는 잃은 것이 아니므로 잇지 않는다.
    const lost = lostAttemptOf(c.getState(), slot.taskId)
    const reply = await c.handle('worker-start', {
      task: slot.taskId,
      agent: slotProvider,
      account: accountId,
      ...placement,
      ...(lost ? { retryOf: lost.id } : {})
    })
    // **떠나는 Host 의 거절은 Gate 가 아니다**(R15). 물러나는 Host 는 retire 가 온 순간부터 모든
    // 시작을 거절하고, worker-start 는 그것을 `retry` 를 실은 409 로 답한다 — "이 Task 를 못
    // 띄운다" 가 아니라 "나중에, 다음 운전자에게 같은 명령을" 이다. 그 자리에 Gate 를 열면 사람이
    // 고칠 것이 없는 Task 가 blocked 로 선다. **이 활성화를 통째로 멈춘다**(break 가 아니라
    // return): 거절된 시작도 openDispatch 와 그 롤백을 커밋하므로 scheduleAgain 이 서 있고, break
    // 로는 다음 바퀴가 남은 슬롯마다 한 번씩 더 떠나는 Host 에게 시작을 청한다. 뒤의 회수도
    // 건너뛴다 — 떠나는 Host 가 세션을 닫고 git 을 돌리지 않는다. 다음 운전자의 첫 바퀴가 둘 다 본다.
    if (reply.status === 409 && typeof (reply.body as { retry?: unknown })?.retry === 'string')
      return { kind: 'leaving', reply }
    return reply.status >= 400 ? { kind: 'refused', reply } : { kind: 'started', reply }
  }

  // 자동 진행. **setState 뒤에 매단다** — 새 Task 가 ready 가 되거나 자리가 비는 경로가 일곱이고
  // (task-create, worker_done, 검증 결과, 검토 결과, gate-resolve, worker-stop, task-update),
  // 명령마다 훅을 달면 하나를 빠뜨린다. 빠뜨렸을 때의 증상은 "Task 가 이유 없이 안 돈다"이고,
  // 그것은 이 기능 계열이 없애려는 바로 그 증상이다. setState 는 상태가 저장되는 유일한 문이다.
  //
  // 띄우는 길은 c.handle(handleCommand) 하나뿐이다 — openDispatch 나 deps.startWorker 를 직접 부르면
  // CLI 가 지나는 검사(회로 차단, 열린 Dispatch, 실패 롤백)를 앱만 건너뛰는 두 번째 문이 생긴다.
  let scheduling = false
  let scheduleAgain = false
  /** Who waits for `scheduling` to drop: a `dispatchOne` that arrived during a pass. */
  let idleWaiters: Array<() => void> = []
  const wakeIdle = (): void => {
    const waiting = idleWaiters
    idleWaiters = []
    for (const w of waiting) w()
  }
  const runScheduler = async (): Promise<void> => {
    // 재진입 가드 — 띄우기가 openDispatch 를 커밋하면 그것이 다시 setState 를 부른다. 도는 중이면
    // 표시만 남기고 빠지고, 끝난 뒤 한 번 더 돈다. 8cce9c2 의 startHead 재진입 방어와 같은 모양이다.
    if (scheduling) {
      scheduleAgain = true
      return
    }
    scheduling = true
    try {
      // 이 활성화에서 이미 한 번 손댄 Task. **없으면 아래 do-while 이 영원히 돈다.** worker-start 가
      // 세션을 띄우다 실패하면 server.ts 의 롤백이 Dispatch 를 배열에서 지우고 Task 를 ready 로
      // 되돌리는데, 그 롤백 자체가 setState 라서 scheduleAgain 이 서고, 다음 바퀴의 slotsToFill 은
      // 같은 자리를 그대로 다시 준다 — 롤백 경로는 consecutiveFailures 를 올리지 않으므로 회로
      // 차단도 걸리지 않는다(그것을 올리는 것은 closeDispatch 이고, 그 경로는 세션이 실제로 떴을
      // 때만 지난다). 그래서 실패 → 롤백 → 같은 실패가 CLI 를 무한히 다시 띄운다. 한 활성화 안에서
      // 한 Task 는 한 번만 건드린다: 다음 기회는 다음 상태 변경이 주고, 그때는 정말로 달라진 것이
      // 있다.
      //
      // **아래 gateSlot 이 생겼다고 이것이 남아돌지는 않는다.** Gate 가 열리면 Task 가 blocked 로
      // 가서 그 자리가 후보에서 빠지지만, gate-create 자체가 거절되거나 던지는 경우(그 이유는
      // gateSlot 에 적었다)에는 Task 가 ready 그대로 남는다. 그 경우에 회전을 막는 것은 이것뿐이다.
      const attempted = new Set<string>()
      do {
        scheduleAgain = false
        // **운전자에게 먼저 묻는다**(설계 §4.3) — 앱에서는 서버가 서 있는가(예전의 `if (!orch) return`),
        // Host 에서는 지금 Host 가 모는가다. 바퀴마다 묻는 이유는 아래 슬롯마다 묻는 것과 같다.
        if (!c.mayStart()) return
        // **계정이 없어 띄울 수 없는 Task 에 Gate 를 연다.** slotsToFill 이 그것들을 건너뛰므로
        // 아래 루프는 보지 못하고, 그냥 두면 Run 이 이유 없이 서 있는다 — 이 하위 시스템이
        // 없애려는 증상 그대로다(gateSlot 의 주석). Gate 는 Task 를 blocked 로 보내므로 판정이
        // 다음 바퀴에 같은 Task 를 다시 내지 않는다(tasksMissingAccounts 의 주석).
        for (const m of tasksMissingAccounts(c.getState())) {
          if (attempted.has(m.taskId)) continue
          attempted.add(m.taskId)
          await gateSlot(m.taskId, t(c.lang(), 'jobs.gate.noAccountAssigned'))
        }
        // **답할 사람이 없는 질문을 풀어 준다.** `ask` 는 부드리기라 워커가 답이 올 때까지 멈춰
        // 서 있는데, 그 답을 줄 코디네이터가 앱이 만든 Run 에는 없다(inbox.ts 의 머리말 —
        // 실측으로 잡힌 정지다). 사람에게 올리지 않는 이유도 거기 있다.
        //
        // **Gate 로 올릴 수 없다는 것도 이유의 하나다.** createGate 는 열린 Dispatch 를 가진
        // Task 를 거절하고(state.ts), `dispatched -> blocked` 전이 자체가 없다(types.ts 의
        // ALLOWED). 즉 기다리는 워커가 있는 동안 Gate 는 존재할 수 없다.
        //
        // `UI_CALLER` 는 열린 Dispatch 를 갖지 않으므로 COORDINATOR_ONLY 가드를 지난다
        // (server.ts 의 isWorker 판정). 실패는 로그로만 남긴다 — 이 자리에서 할 수 있는 것이
        // 없고, 다음 바퀴에 같은 질문이 다시 후보로 올라온다.
        for (const id of unattendedQuestions(c.getState())) {
          const answered = await c.handle('reply', { id, body: NO_COORDINATOR_ANSWER })
          log(
            answered.status >= 400
              ? `inbox: reply rejected message=${id} — ${JSON.stringify(answered.body)}`
              : `inbox: answered an unattended question message=${id} — no coordinator on this run`
          )
        }
        const slots = slotsToFill(c.getState()).filter((s) => !attempted.has(s.taskId))
        // 띄울 자리가 없으면 계정 조회까지 가지 않는다. 이 함수는 **모든 저장마다** 불리고 그
        // 대부분은 띄울 것이 없는 저장이다 — 아래 조회에 계정마다 파일(macOS 에서는 Keychain)
        // 읽기가 하나씩 붙으므로, 빈 바퀴에 그것을 치르면 상태를 쓰는 모든 명령이 그만큼 느려진다.
        if (slots.length === 0) continue
        // 계정 조회는 **바퀴마다 한 번**이다. 슬롯마다 부르면 같은 파일 읽기가 슬롯 수만큼 되풀이되고,
        // 활성화 전체에 한 번만 부르면 do-while 이 여러 바퀴 도는 동안(그 사이 워커가 실제로 뜬다)
        // 로그인 상태가 낡는다. "한 바퀴 = 한 스냅숏"이 그 둘의 가운데다.
        //
        // 얻는 방식은 startReview 와 같다(core.ts 의 defaultAccountIdFor 도 같은 모양이다) — 로그인
        // 조회를 순차로 돌리면 계정 수만큼 늘어나므로 병렬로 편다.
        const accounts = await c.accounts()
        const loggedInIds = await Promise.all(
          accounts.map(async (a) => ((await c.loginStatus(a.id)) ? a.id : null))
        )
        const loggedIn = new Set(loggedInIds.filter((id): id is string => id !== null))
        for (const slot of slots) {
          // **슬롯마다 운전자를 다시 묻는다**(설계 §4.3). 이 for 는 await 를 여럿 지나고(계정 조회, 앞 슬롯의
          // worker-start), 그 사이 운전이 다른 프로세스로 넘어갈 수 있다 — 넘어간 뒤에 띄우는 자리는 두
          // 운전자가 같은 ready Task 를 두고 다투는 자리다. 멈추면 새 운전자의 다음 바퀴가 남은 자리를 본다.
          if (!c.mayStart()) break
          attempted.add(slot.taskId)
          // 슬롯 하나의 실패는 **그 슬롯에서 멈춘다.** 거절(status >= 400)과 예외는 여기서 같은
          // 뜻이다 — "이 자리는 지금 못 뜬다" — 이므로 같은 곳으로 보낸다. handleCommand 는 실제로
          // 던진다: 그 안의 setState 가 store.save 의 tmp+rename 을 지나고, 디스크가 찼거나
          // Windows 에서 rename 이 잠기면 거부된다. 잡지 않으면 그 예외가 이 for 를 뚫고 나가
          // **남은 슬롯이 통째로 버려진다** — 상관없는 다른 프로젝트의 Run 이 남의 실패 때문에
          // 서 있게 되고, 하나의 문제가 전부를 세우지 않는다는 이 루프의 전제가 거짓이 된다.
          try {
            const end = await placeSlot(slot, accounts, loggedIn)
            // **떠나는 Host 의 거절은 Gate 가 아니다**(R15). 물러나는 Host 는 retire 가 온 순간부터 모든
            // 시작을 거절하고, worker-start 는 그것을 `retry` 를 실은 409 로 답한다 — "이 Task 를 못
            // 띄운다" 가 아니라 "나중에, 다음 운전자에게 같은 명령을" 이다. **이 활성화를 통째로 멈춘다**
            // (break 가 아니라 return). 이유는 placeSlot 의 그 자리 주석에 있다.
            if (end.kind === 'leaving') {
              log('scheduler: the Host is leaving — no further slot this activation')
              return
            }
            if (end.kind === 'gate') await gateSlot(slot.taskId, end.reason)
            else if (end.kind === 'refused')
              await gateSlot(slot.taskId, `이 Task 를 시작하지 못했습니다: ${JSON.stringify(end.reply.body)}`)
          } catch (e) {
            await gateSlot(slot.taskId, `이 Task 를 시작하지 못했습니다: ${String(e)}`)
          }
        }
      } while (scheduleAgain)

      // **끝난 예약 회차의 워크트리를 걷는다.** 발화마다 폴더가 하나씩 쌓이던 것을 막는다.
      // 판정은 순수 함수가 하고(reapableChildRuns) 여기서는 그 목록을 지운다 — 합치지 않고
      // 지우지만 회차의 커밋은 브랜치에 남는다(removeWorktree 의 `branch -d` 가 합쳐지지 않은
      // 브랜치를 거부한다). 그 브랜치가 남았다는 사실은 reapWorktree 가 `branch deleted=false` 로
      // 로그에 남긴다.
      //
      // 슬롯 루프 뒤인 이유: 회차가 끝나는 순간은 마지막 Task 가 completed 되는 저장이고 그 저장
      // 에는 띄울 슬롯이 없다.
      //
      // **순차로 지운다.** reapWorktree 는 세션을 닫고 그 세션이 실제로 사라질 때까지 조건 폴링을
      // 하므로, 병렬로 부르면 같은 저장소의 git 을 여럿이 동시에 밟는다(run-delete 의
      // removeWorktrees 가 같은 이유로 순차다).
      //
      // **try/catch 를 두지 않는다.** reapWorktree 는 던지지 않는다 — boolean 을 돌려주고 실패는
      // 스스로 로그에 남긴다(reapWorktree 안의 catch 가 로그를 부른다; c.reap 이 그것이다). 감싸면 절대 실행되지
      // 않는 catch 가 하나 생기고, 다음에 읽는 사람은 그것을 "여기서 던질 수 있다"는 신호로 읽는다.
      // **운전자에게 한 번 더 묻는다.** 슬롯마다의 확인이 이 활성화를 break 로 끝냈다면 운전은 이미 다른
      // 프로세스로 넘어갔고, 그 새 운전자의 첫 바퀴가 같은 회차를 걷는다 — 두 프로세스가 같은 워크트리의
      // 세션을 닫고 `git worktree remove` 를 함께 돌리게 된다. 운전하지 않는 프로세스는 일을 하지 않는다.
      // 앱에서는 mayStart 가 언제나 참이므로(orch 는 한 번 서면 내려가지 않는다) 앱의 동작은 그대로다.
      if (!c.mayStart()) return
      // U4: 끝난 예약 회차의 코디네이터를 세우고(L1: 확인될 때까지 다시), 낡은 기동 표시를 걷는다(L2).
      // 회수보다 앞이다.
      await tidyCoordinators()
      if (!c.mayStart()) return
      // 앱이 등록한 워크트리인가 — 앱에서는 core.worktrees, Host 에서는 자기 레지스트리다(c.isRegisteredWorktree).
      for (const r of reapableChildRuns(c.getState(), (p) => c.isRegisteredWorktree(p)))
        for (const w of r.worktrees) await c.reap(w)
    } finally {
      // finally 여야 한다 — 위의 `if (!c.mayStart()) return` 도, handleCommand 안에서 올라오는 예외(디스크가
      // 찬 store.save 가 그것이다)도 이 자리를 지나간다. 한 번이라도 놓치면 scheduling 이 true 로
      // 남아 스케줄러가 앱이 사는 내내 다시는 돌지 않는다.
      scheduling = false
      wakeIdle()
    }
  }

  const dispatchOne = async (taskId: string): Promise<{ status: number; body: unknown }> => {
    const refuse = (error: string): { status: number; body: unknown } => ({ status: 409, body: { error } })
    while (scheduling) await new Promise<void>((resolve) => idleWaiters.push(resolve))
    scheduling = true
    try {
      if (!c.mayStart()) return refuse('this process does not place Jobs right now')
      const s = c.getState()
      const task = s.tasks.find((x) => x.id === taskId)
      if (!task) return { status: 404, body: { error: `unknown task: ${taskId}` } }
      // slotsToFill's candidate test, less `appDriven`: the person has named this Task.
      if (task.runId === undefined) return refuse(`task ${taskId} belongs to a Job's plan, not to a run`)
      if (task.status !== 'ready') return refuse(`task ${taskId} is ${task.status}, not ready`)
      if (task.consecutiveFailures >= FAILURE_LIMIT)
        return refuse(`task ${taskId} has failed ${task.consecutiveFailures} times in a row (circuit break)`)
      if ((task.accountIds?.length ?? 0) === 0)
        return refuse(`task ${taskId} names no account to run on; give it one with tasks add --account`)
      if (s.dispatches.some((d) => d.taskId === taskId && !d.outcome && !d.endedAt))
        return refuse(`task ${taskId} already has a worker`)
      // **The run is judged here, after the wait, not only by the command layer** (review 3, M1): the
      // command read a state from before a pass it may have waited through, and `worker-start` checks
      // neither a pause nor a coordinator. A run paused, handed to a coordinator or finished meanwhile
      // gets no worker.
      const run = s.runs.find((r) => r.id === task.runId)
      const job = run ? jobOf(s, run) : undefined
      if (!run) return refuse(`task ${taskId} names a run that is gone`)
      if (run.coordinatorSessionId !== undefined || coordinatorStarting(run, c.nowMs()))
        return refuse(`run ${run.id} is driven by its coordinator, which places its tasks`)
      if (run.paused === true || job?.paused === true) return refuse(`run ${run.id} is paused`)
      if (job?.pendingStart === true || outcomeOf(s, run.id) !== 'running')
        return refuse(`run ${run.id} is not running`)
      const limit = job?.concurrency ?? DEFAULT_CONCURRENCY
      const mine = new Set(s.tasks.filter((t) => t.runId === run.id).map((t) => t.id))
      const openHere = s.dispatches.filter((d) => mine.has(d.taskId) && !d.outcome && !d.endedAt).length
      if (openHere >= limit) return refuse(`run ${run.id} is at its concurrency limit: ${openHere} of ${limit} workers are open`)
      const accounts = await c.accounts()
      const loggedIn = new Set(
        (await Promise.all(accounts.map(async (a) => ((await c.loginStatus(a.id)) ? a.id : null)))).filter(
          (id): id is string => id !== null
        )
      )
      if (!c.mayStart()) return refuse('this process stopped placing Jobs while the task was being placed')
      const slot: Slot = { runId: task.runId, taskId, accountIds: task.accountIds as string[] }
      const end = await placeSlot(slot, accounts, loggedIn)
      if (end.kind === 'started') {
        log(`scheduler: task=${taskId} placed on request`)
        const body = (end.reply.body ?? {}) as Record<string, unknown>
        return { status: end.reply.status, body: { ...body, taskId, runId: task.runId } }
      }
      if (end.kind === 'refused' || end.kind === 'leaving') return end.reply
      log(`scheduler: task=${taskId} was asked for and not placed — ${end.why}`)
      return refuse(`task ${taskId} was not placed: ${end.why}`)
    } finally {
      scheduling = false
      wakeIdle()
      // A pass that arrived while this one held the loop ran nothing; it runs now.
      if (scheduleAgain) void runScheduler().catch((e) => log(`scheduler: the pass after a placement on request failed: ${String(e)}`))
    }
  }

  /** 예약 템플릿의 발화. 판정은 core 의 firesDue 가 하고(그쪽에 테스트가 있다) 여기는 그 답대로
   *  명령을 부른다. */
  const orchFireTick = async (): Promise<void> => {
    const { fire, arm } = firesDue(c.getState(), armed, c.nowMs())
    // **아래 await 들보다 먼저 갈아 끼운다.** 회차를 만드는 데 15초가 넘게 걸리면 다음 tick 이
    // 겹쳐 도는데, 그때 무장이 아직 옛 값이면 같은 템플릿이 한 번 더 발화한다.
    armed = arm
    // **순차로 부른다.** 병렬로 띄우면 각 run-spawn 이 자기 진입 시점의 상태에 커밋해서 나중
    // 것이 앞선 것의 자식 Run 을 덮는다 — run-create 가 await 뒤에 getState() 를 다시 읽는 것과
    // 같은 위험이고, 그쪽은 한 명령 안의 await 를 다루지만 이쪽은 명령 사이의 await 다.
    for (const runId of fire) {
      // **발화마다 운전자를 다시 묻는다**(fix round 1, M1). 앞 발화의 run-spawn 은 코디네이터 기동까지
      // 기다리므로 그 사이 운전이 다른 프로세스로 넘어갈 수 있다. 넘어간 뒤의 발화는 버린다: 새 운전자의
      // 무장이 그 시각을 이미 지났을 수 있고, 두 프로세스가 같은 시각을 함께 발화하는 것보다 한 번 잃는
      // 편이 낫다(놓친 발화는 버린다는 규칙과 같은 쪽이다).
      if (!c.mayStart()) {
        log(`scheduled fire dropped job=${runId} — this process no longer drives`)
        continue
      }
      // 템플릿 하나의 실패가 나머지를 막아서는 안 된다 — 무장은 이미 다음 시각으로 넘어갔으므로,
      // 여기서 멈추면 뒤의 템플릿들은 이번 tick 에서 조용히 건너뛰어진다(재시도가 아니라 누락이다).
      try {
        // **Skipped while the Job's latest Run still runs**, as `jobs run` refuses then (the user's ruling
        // of 2026-09-25 on U1). The fire is consumed: `armed` already holds the next fire time, so this
        // one is neither retried on the next tick nor fired late, and the skip is logged once.
        const reply = await c.handle('run-spawn', {
          run: runId,
          unlessRunning: true
        })
        const running = reply.status === 409 ? (reply.body as { running?: unknown } | null)?.running : undefined
        if (typeof running === 'string') {
          log(`scheduled fire skipped job=${runId} — its run ${running} is still running`)
          continue
        }
        // run-spawn 은 `jobs run` 이 회차를 시작하는 그대로 시작한다(U1): 코디네이터 계정이 있으면 그
        // 회차의 코디네이터를 띄운다. **그것만 실패했다면 회차는 이미 있다**(N7) — 답이 그 회차를
        // `runId` 로 싣는다. 잃은 발화가 아니므로 다르게 적는다: 사람이 그 회차 줄의 ▶ 로 다시 띄운다.
        const child = (reply.body as { runId?: unknown } | null)?.runId
        if (reply.status >= 400 && typeof child === 'string')
          log(
            `scheduled run=${child} of job=${runId} has no coordinator — ${JSON.stringify(reply.body)}; ` +
              'restart it from the Jobs list'
          )
        // 실패한 발화는 잃는다 — 무장은 이미 다음 시각으로 옮겨졌으므로 다음 시각에 다시 시도한다.
        // 디스크가 찼거나 win32 에서 rename 이 잠긴 경우가 이 갈래다.
        else if (reply.status >= 400) log(`scheduled spawn failed run=${runId} status=${reply.status}`)
        else log(`scheduled spawn run=${runId} child=${JSON.stringify(reply.body)}`)
      } catch (e) {
        log(`scheduled spawn failed run=${runId}: ${String(e)}`)
      }
    }
  }

  /** 잠든 코디네이터를 깨운다. **판정은 core 에 있다**(unreadUpwardMail) — 이 파일에는 테스트가
   *  닿지 않으므로 규칙을 여기 두면 다음 편집을 막아 줄 것이 없다. 여기 남는 것은 순수 함수가
   *  가질 수 없는 것뿐이다: 세션에 타이핑하고, 바쁜지 보고, 로그를 남긴다.
   *
   *  **바쁜 세션은 건드리지 않는다.** 두 가지를 함께 막는다: (1) 턴 중인 코디네이터는 이미 일하고
   *  있어 깨울 것이 없고, (2) 권한 요청 대화상자는 턴 중에 뜨므로 그때 타이핑하면 Enter 가 화면의
   *  선택지를 승인해 버린다 — 롤링이 같은 위험을 훅 알림으로 막는다(claudeCoordinator.ts 의 onHookEvent).
   *  훅이 아니라 바쁨으로 막는 것은 더 거친 근사다: 대화상자가 떴는데 바쁨이 풀리는 런타임이
   *  있으면 이 가드는 새어 나간다. 그 경우를 실측한 적은 없다. */
  const nudgeSleepingCoordinators = async (): Promise<void> => {
    if (!c.mayStart()) return
    // 타이머 쪽의 정리(L1, L2) — 앱은 커밋 때만 pass 를 돌리므로, 커밋 없이 때가 온 재시도와 낡은
    // 표시는 이 틱이 맡는다. tidyCoordinators 는 던지지 않는다.
    await tidyCoordinators()
    if (!c.mayStart()) return
    for (const m of unreadUpwardMail(c.getState(), {
      nowMs: c.nowMs(),
      staleMs: COORDINATOR_NUDGE_MS
    })) {
      if (c.sessionBusy(m.sessionId) === true) continue
      // 세션이 없으면(사용자가 닫았다) 깨울 것이 없다 — 그 자리는 되띄우기가 맡는다.
      if (!c.sessionAlive(m.sessionId)) continue
      // **영어다.** 코디네이터는 영어로 인계받았다(handover.ts) — 롤링이 워커의 재개 문구를
      // 앱의 UI 언어로 타이핑하다 같은 어긋남을 겪었고, 그 주석이 이유를 적어 두었다.
      c.typeInto(
        m.sessionId,
        `Your Run has ${m.messageIds.length} unread message(s). Run \`astera check --json\`, ` +
          'handle them, ack the batch, then go back to `astera check --wait`.'
      )
      c.typeInto(m.sessionId, '\r')
      log(`coordinator nudged run=${m.runId} session=${m.sessionId} unread=${m.messageIds.length}`)
    }
  }

  return {
    run: runScheduler,
    dispatchOne,
    fireTick: orchFireTick,
    nudge: nudgeSleepingCoordinators,
    /** 운전하지 않는 동안에는 **무장을 들고 있지 않고 버린다.** 들고 있으면 서 있지 않던 동안 지나간
     *  시각이 그대로 남아, 다시 서는 순간 그 시각들이 한꺼번에 발화한다 — 09:00 예약이 15:00 에 도는
     *  것이고, 아무도 그 시각을 잡지 않았다. 놓친 발화는 버리는 것이 이 기능의 결정이므로(설계 2·5절)
     *  다시 서는 것이 재시작과 같아야 한다: 재시작하면 이 Map 은 비어 있고, firesDue 의 첫 바퀴가
     *  nextFireAt(rule, now) 으로 다시 무장하기만 한다. */
    forgetArming: () => {
      armed = new Map()
    },
    armOnly: () => {
      armed = firesDue(c.getState(), armed, c.nowMs()).arm
    },
    nextFireOf: (runId) => armed.get(runId) ?? null
  }
}
