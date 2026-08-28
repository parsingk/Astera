// Pure data for cross-vendor orchestration. This file imports no values — it can end up in the
// renderer compilation target, so no fs/path dependency may leak in (the same rule as
// providers/meta.ts).
import type { Provider } from '../providers/meta'
import type { ScheduleRule } from '../scheduler/rule'

export type TaskStatus = 'pending' | 'ready' | 'dispatched' | 'validating' | 'reviewing' | 'completed' | 'failed' | 'blocked'
export type Outcome = 'succeeded' | 'failed'
/** Observed state of the session a Dispatch owns. outcome_unknown = cannot be proven (section 7 of
 *  the orchestration guide) */
export type WorkerState = 'ready' | 'failed' | 'stopped' | 'outcome_unknown'
export type MessageType =
  | 'status'
  | 'worker_done'
  | 'question'
  | 'escalation'
  | 'heartbeat'
  | 'decision_gate'

/** 한 Run 이 동시에 열어 둘 Dispatch 수의 기본값. 사람이 Run 을 만들 때 바꾼다. */
export const DEFAULT_CONCURRENCY = 3

export interface Run {
  id: string
  objective: string
  cwd: string
  createdAt: string
  /** 동시에 열어 둘 Dispatch 수. 없으면 DEFAULT_CONCURRENCY. */
  concurrency?: number
  /** 이 Run 을 관리할 **코디네이터 세션**을 띄울 계정. 하나다.
   *
   *  **워커 계정과 층이 다르다.** 워커 계정은 Task 가 정하고(`Task.accountIds`), 이것은 그
   *  Task 들을 돌리는 세션의 것이다.
   *
   *  **Task 처럼 목록이 아닌 이유.** 목록은 "한도에 걸렸을 때 갈아탈 순서" 를 뜻하고, 그 값이
   *  있으면 롤링이 계정을 갈아타며 세션을 새로 띄운다. 관리자에게 그것을 주지 않기로 했다 —
   *  계정이 하나면 롤링은 갈아타지 않고 리셋까지 기다린 뒤 **같은 세션에서** 이어간다
   *  (RollCycle.onLimit 은 계정 수가 1이면 언제나 대기를 낸다). 관리 중이던 Run 의 맥락을 잃지
   *  않는 쪽이 이 자리에서는 더 중요하다.
   *
   *  **없으면 코디네이터 없이 앱이 돌린다.** 사이드바는 더 이상 그 상태를 만들지 않지만, 이 칸이
   *  생기기 전에 만든 Run 과 CLI 로 만든 Run 이 그 갈래다 — UI 가 만들지 못하는 것과 코드가 다루지
   *  못하는 것은 다르다. 그때 워커의 질문을 풀어 주는 것은 앱의 그물이다(inbox.ts). */
  coordinatorAccountId?: string
  /** 지금 이 Run 을 관리하고 있는 세션. **깨우기·되띄우기·안전망이 모두 이 칸의 유무로 판단한다** —
   *  "답할 사람이 있는가" 를 묻는 유일한 자리다. 세션이 사라지면 배선이 이 칸을 지운다. */
  coordinatorSessionId?: string
  /** 코디네이터가 **연속으로** 사라진 횟수. 되띄우기를 그치는 근거이고, `Task.consecutiveFailures`
   *  와 같은 꼴이다 — 무한히 되띄우면 로그인이 끊긴 계정으로 세션을 끝없이 만든다. 코디네이터가
   *  한 번이라도 붙으면 0 으로 돌아간다. */
  coordinatorFailures?: number
  /** 앱이 이 Run 을 스스로 돌리는가. **UI 가 만든 Run 에만 참이다** — 코디네이터가 만든 Run 을
   *  앱이 함께 돌리면 둘이 같은 ready Task 를 두고 경합하고, 진 쪽(대개 코디네이터)의
   *  worker-start 가 `dispatch already open` 을 받는다. 코디네이터 LLM 에게는 자기 명령이 이유
   *  없이 실패하기 시작하는 일이고, 그것을 어떻게 다룰지는 우리가 통제할 수 없다. */
  autoDispatch?: boolean
  /** 사용자가 아직 '실행' 을 누르지 않았다. **있으면 이 Run 은 돌지 않는다** — 사이드바로 만든
   *  Run 은 Task 를 다 짜고 사람이 실행을 눌러야 시작한다(그 전에는 Task 하나를 만드는 순간
   *  돌기 시작했다).
   *
   *  **autoDispatch 를 끄는 것으로는 이것을 표현할 수 없다.** 그러면 "아직 시작 안 한 UI Run" 과
   *  "코디네이터가 돌리는 Run" 이 구별되지 않고(둘 다 autoDispatch 가 없다), 실행 버튼이 코디네이터
   *  Run 에도 나타나 앱과 코디네이터가 같은 ready Task 를 두고 경합한다(autoDispatch 의 주석).
   *  그래서 게이트를 따로 둔다: autoDispatch 는 "누가 돌리는가", 이것은 "시작했는가" 다.
   *
   *  **예약은 이 칸을 쓰지 않는다.** 템플릿은 애초에 돌지 않고, 발화가 만든 회차는 예약 시각이
   *  곧 시작 신호이므로 즉시 돌아야 한다. */
  pendingStart?: boolean
  /** 발화 시각마다 이 Run 의 한 회차를 돌리는 규칙. **있으면 이 Run 은 템플릿이다** — 자신은
   *  한 번도 돌지 않고(run-create 가 autoDispatch 를 켜지 않는다), 발화마다 자식 Run 을 하나
   *  만든다. 세션 예약의 ScheduleConfig 가 아니라 그 규칙 부분만인 이유: ScheduleConfig 는
   *  command 를 필수로 요구하는데(isValidScheduleConfig) Job 에는 타이핑할 명령이 없다 —
   *  Task 가 곧 일이다. */
  schedule?: ScheduleRule
  /** 이 템플릿이 지금까지 발화한 횟수. **템플릿만 갖는다.**
   *
   *  자식 개수로 세지 않는 이유가 이 필드의 존재 이유다 — 회차 기록은 사람이 지우고 30일 TTL 도
   *  지우므로(store.ts), 개수로 세면 "N회차"가 뒤로 간다. 실제로 그렇게 보고됐다.
   *  없으면 0 으로 읽는다(이 필드가 생기기 전에 만들어진 템플릿). */
  fireCount?: number
  /** 이 회차가 몇 번째 발화인가. **자식만 갖는다.** 위 fireCount 를 발화 시점에 찍어 둔 값이라
   *  기록을 지워도 남은 회차의 번호가 바뀌지 않는다. */
  fireOrdinal?: number
  /** 이 Run 의 워커들이 일하는 워크트리. **없으면 아직 만들어지지 않았다** — 첫 워커를 띄우기
   *  직전에 배선이 만들고 `run-worktree-set` 으로 기록한다(src/main/ipc.ts). 예약 템플릿은 한 번도
   *  돌지 않으므로 끝까지 이 칸이 없다.
   *
   *  **`cwd` 를 덮어쓰지 않고 따로 두는 이유가 이 칸의 존재 이유다.** `cwd` 는 이 Run 이 어느
   *  프로젝트의 것인가를 정하고(runsForProject → repoPathOf, view.ts), 그 판정은 워크트리
   *  레지스트리 항목이 살아 있을 때만 워크트리를 저장소로 되돌린다. 예약 회차의 워크트리를 걷으면
   *  그 항목이 사라지므로, `cwd` 가 워크트리였다면 그 회차 Run 이 프로젝트 목록에서 사라진다 —
   *  지울 문까지 함께. 그래서 `cwd` 는 "속한 프로젝트이자 최종 병합 대상", 이 칸은 "일하는 자리" 다.
   *  둘을 함께 읽는 자리는 runRootOf(integrate.ts) 하나다. */
  worktree?: string
  /** 사람이 이 예약을 세워 뒀다. **있으면 발화하지 않고, 회차의 Task 도 배치되지 않는다.**
   *
   *  **pendingStart 와 다른 칸인 이유가 이 필드의 존재 이유다.** 둘 다 "돌지 않는다" 를 만들지만
   *  사람에게는 다른 상황이고 다른 버튼이다: pendingStart 는 "아직 시작하지 않았다"(초안이고,
   *  '실행' 이 한 번 걷는다), 이것은 "돌던 것을 세워 뒀다"('⏸' 와 '▶' 가 오간다). 한 칸으로
   *  겸하게 했더니 세운 뒤에 '실행' 버튼과 '▶' 가 **같은 일을 하는 두 버튼**으로 나란히 떴다.
   *
   *  회차에도 붙는다 — 세우는 순간 그 예약에 딸린 회차 전부에. Dispatch 를 닫는 것만으로는 그 회차가
   *  멈추지 않는다: 닫힌 자리에 그 회차의 다음 ready Task 가 곧바로 뜬다(회차는 autoDispatch 가
   *  켜져 있다). 재개는 템플릿의 것만 걷으므로 멈춘 회차는 이어지지 않는다. */
  paused?: boolean
  /** 이 Run 이 어느 템플릿의 한 회차인가. 있으면 실행 기록이다.
   *
   *  **schedule 과 배타적이다.** 자식에 schedule 을 복사하면 자식이 또 발화해 무한히 증식한다. */
  templateId?: string
}

export interface Task {
  id: string
  runId: string
  title: string
  spec: string
  deps: string[]
  parentId?: string
  status: TaskStatus
  result?: string
  filesModified?: string[]
  /** 이 Task 의 워커를 띄울 계정들, **순서대로**.
   *
   *  **이 목록이 provider 의 유일한 출처다.** 예전에는 Run 이 provider 를 들고 있었고(`Run.provider`)
   *  이 칸은 비워 둘 수 있었다 — 비면 그 provider 의 기본 계정으로 갔다. 이제 Run 은 provider 를
   *  모르므로, 계정이 없으면 **어느 CLI 로 띄울지 알 방법이 없다.** 그래서 자동 디스패치는 계정 없는
   *  Task 를 고르지 않고(schedule.ts 의 slotsToFill), 만드는 두 자리가 모두 계정을 요구한다
   *  (server.ts 의 task-create, NewTaskModal).
   *
   *  **그래도 optional 인 이유:** orchestration.json 은 프로세스보다 오래 살고 Run 은 30일 남는다.
   *  이 규칙 전에 만들어진 Task 와 손으로 고친 파일에는 이 칸이 없다. 그런 Task 는 조용히 멈추는
   *  대신 디스패치 시점에 Gate 를 연다 — 사람이 계정을 넣으면 곧바로 돈다.
   *
   *  **목록 안의 계정은 서로 같은 provider 여야 한다.** 섞이면 첫 계정으로 띄운 CLI 가 한도에 걸렸을
   *  때 다른 CLI 계정으로 갈아타려 하고, 그것은 갈아타기가 아니라 다른 프로그램을 띄우는 일이다.
   *  task-create 가 그 목록을 거절하고, UI 는 첫 계정이 고른 provider 로 이후 칸을 좁힌다.
   *
   *  첫 계정으로 띄우고, 나머지는 **한도에 걸렸을 때 갈아탈 순서**다 — 배선이 이 목록을 그대로
   *  세션의 롤링 체인(rollAccountIds)으로 넘긴다. 계정이 하나면 갈아탈 곳이 없어 리셋까지 기다린다
   *  (RollCycle.onLimit 은 계정 수가 1이면 언제나 대기를 낸다).
   *
   *  못 쓰는 지정이 실제로 도달했을 때 무엇을 하는지는 accountToDispatchOn
   *  (core/accounts/dispatchAccount.ts)이 정한다 — **첫 계정**을 못 쓰면 뒤 계정을 올려세우지 않고
   *  그대로 실패해 Gate 를 열고, 첫 계정을 쓸 수 있으면 **뒤 계정** 중 못 쓰는 것만 순서를 지키며
   *  제자리에서 빠진다. */
  accountIds?: string[]
  /** 이 Task 를 완료로 판정할 실행 구성의 id. 없으면 worker_done 을 그대로 믿는다 —
   *  "문서를 고친다" 같은 Task 에 빌드를 거는 것은 틀린 판정이므로 검증 없음이 기본이다. */
  validateConfigId?: string
  /** 이 Task 를 **다른 provider** 가 읽어 "요구가 충족됐는가"를 판정할지. task-create --review 가
   *  켠다. 검증(validateConfigId)과 독립이고, 둘 다 걸리면 검증이 먼저다 — 컴파일도 안 되는 코드를
   *  읽으라고 에이전트 세션을 태우는 것은 낭비다. */
  reviewRequested?: boolean
  /** Consecutive failure count. 3 means circuit break */
  consecutiveFailures: number
  createdAt: string
  updatedAt: string
}

/** 한 번의 정지와 그 재개. **이 배열이 없으면 "몇 번 이어졌는가" 를 되살릴 방법이 아예 없다** —
 *  롤은 Dispatch 를 닫지 않고 `sessionId`·`accountId` 만 고쳐 쓰고(rollTap 의 rekeyDispatch),
 *  `stopSnapshot` 은 정지마다 덮어써서 직전 하나만 남는다.
 *
 *  **정지와 재개를 한 항목에 담는다.** 둘을 따로 두면 짝을 맞추는 규칙이 하나 더 생기고, 그 규칙이
 *  어긋나는 날 화면이 "세 번 멈추고 두 번 이어졌다" 를 그린다. **마지막** 항목의 `resumedAt` 부재가
 *  곧 "지금 기다리는 중" 이다 — 화면이 그것으로 판정한다. 앞쪽에 열린 채 남은 항목은 지금이 아니라
 *  **끝내 이어지지 않은 정지**를 말한다('stalled' 로 끝난 에피소드가 그 갈래다). */
export interface ResumeEntry {
  /** ISO. 정지가 감지된 시각 */
  stoppedAt: string
  /** 정지를 일으킨 롤 상태 그대로 — `stopSnapshot.reason` 과 같은 값이다 */
  reason: 'waiting' | 'switching'
  /** ISO. `'waiting'` 일 때만(`RollStateEvent.nextRetryAt`). 계정을 바꾸는 쪽은 기다리지 않는다 */
  resetsAt?: string
  /** 정지 시점의 계정 */
  fromAccountId: string
  /** ISO. 재개가 실제로 일어난 시각. **없으면 아직 기다리는 중이다** */
  resumedAt?: string
  /** 재개 후의 계정. 같은 계정에서 이어갔으면 `fromAccountId` 와 같다 — 제자리 재개가 그 갈래다 */
  toAccountId?: string
}

export interface Dispatch {
  id: string
  taskId: string
  provider: Provider
  accountId: string
  /** App session id. The key that ties this to a tab, and the basis for the caller's identity */
  sessionId: string
  cwd: string
  specPath: string
  retryOf?: string
  startedAt: string
  workerState: WorkerState
  outcome?: Outcome
  endedAt?: string
  /**
   * The reset time (epoch ms) for when this Dispatch was judged to have ended at a usage limit.
   * The app derives it from transcript/rollout signals and fills it in — the orchestrator does not
   * write it (read-only). Absent means "either it was not a limit, or it could not be determined",
   * and the two are not distinguished (section 7 of the orchestration guide).
   */
  limitResetsAt?: number
  /** 정지 시점에만 잡을 수 있는 값들. **나머지 Checkpoint 재료는 여기 담지 않는다** — Job 상태·git·
   *  검증 결과는 대기가 몇 시간이어도 디스크에 그대로 있고, 재개 직전에 읽는 것이 더 정확하다
   *  (그 사이 브랜치와 파일이 움직인다). 여기 있는 것은 그때 읽으면 **이미 늦은** 것뿐이다:
   *  - headCommit: 기다리는 동안 워크트리가 바뀌었는지 판정할 기준점. 비교 대상이 없으면 판정 자체가
   *    불가능하다(spec §13).
   *  - reason·resetsAt: 이 정지를 일으킨 `RollStateEvent` 가 들고 있던 값. **`workerState` 와
   *    `limitResetsAt` 이 이것을 대신하지 못한다** — 롤된 Dispatch 는 닫히지 않으므로
   *    (rollTap.ts 의 `rekeyDispatch`) `workerState` 는 'ready' 로 남고, `limitResetsAt` 은
   *    `closeDispatch` 와 실패 보고 probe 만 쓴다. 즉 롤 경로에서는 둘 다 비어 있고, 그 상태로
   *    조립한 브리핑은 "왜 여기 있는가" 를 말해야 하는 절에서 "아직 기록된 정지가 없다" 를 낸다.
   *    리셋 시각은 그 이벤트(`RollStateEvent.nextRetryAt`)에만 있어서, 여기 옮겨 두지 않으면
   *    그대로 사라진다.
   *
   *  transcript 끝 위치는 **한동안 여기 있었고 지웠다** — 조립기(checkpoint.ts)가 순수 모듈이라
   *  transcript 파일을 열 방법이 없어 그 값을 읽는 코드가 아예 없었다(SPEC §8, DESIGN §22). */
  stopSnapshot?: {
    headCommit: string | null
    /** 정지를 일으킨 롤 상태 그대로 — 'waiting'(같은 계정의 리셋을 기다린다) 또는
     *  'switching'(다른 계정으로 넘어간다). */
    reason: 'waiting' | 'switching'
    /** ISO. 'waiting' 일 때만 있다(`RollStateEvent.nextRetryAt`) — 계정을 바꾸는 쪽은 기다리지
     *  않으므로 리셋 시각이라는 값 자체가 없다. */
    resetsAt?: string
  }
  /** 이 Dispatch 가 멈추고 이어진 이력. 화면의 "기다리는 중" 과 "N 번 이어졌다" 가 이것을 읽는다
   *  (`core/orchestration/view.ts`). 항목이 없으면 이 칸 자체가 없다. */
  resumes?: ResumeEntry[]
  /** Cleanup held back at the user's request (worker-retain) */
  retained: boolean
  /** 이 Dispatch 가 구현이 아니라 검토인가. 한 Task 에 구현 Dispatch 와 검토 Dispatch 가 함께
   *  붙으므로, worker_done 이 도착했을 때 어느 쪽인지 아는 유일한 방법이다. */
  review?: boolean
}

export interface Message {
  id: string
  runId: string
  type: MessageType
  taskId?: string
  dispatchId?: string
  subject: string
  body: string
  outcome?: Outcome
  filesModified?: string[]
  options?: string[]
  answered: boolean
  answerBody?: string
  replyTo?: string
  createdAt: string
  deliveryId?: string
  ackedAt?: string
}

/** The batch check returns. The same batch replays until --ack (section 5 of the orchestration guide) */
export interface Delivery {
  id: string
  runId: string
  messageIds: string[]
  createdAt: string
  ackedAt?: string
}

export interface Gate {
  id: string
  runId: string
  taskId: string
  question: string
  options?: string[]
  status: 'open' | 'resolved'
  resolution?: string
  createdAt: string
  resolvedAt?: string
}

/** Maximum messages in one Delivery batch */
export const DELIVERY_MAX = 50
/** Consecutive failure ceiling. On reaching it, the Task is left in the failed terminal state */
export const FAILURE_LIMIT = 3

/** Default long-poll deadline for ask --wait. server.ts and the CLI (src/cli/run.ts) both take it
 *  from here — split into two copies, the client hangs up before the server does and the contract
 *  that a timeout is information rather than an error (section 4.7 of the orchestration guide)
 *  breaks. */
export const DEFAULT_ASK_TIMEOUT_MS = 600_000
/** Default long-poll deadline for check --wait. server.ts and the CLI share it for the same reason. */
export const DEFAULT_CHECK_TIMEOUT_MS = 300_000

const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  pending: ['ready', 'dispatched', 'blocked'],
  ready: ['dispatched', 'blocked'],
  // There is no dispatched -> blocked: a Task with an open dispatch is not blocked by a Gate. A
  // Gate is for deciding the task DAG the coordinator manages; it is not a device for halting a
  // worker that is already running — that is worker-stop.
  // dispatched -> validating: 워커가 성공을 보고했지만 그 Task 에 검증이 걸려 있는 경우.
  // 검증이 없으면 지금처럼 곧바로 completed 로 간다.
  // dispatched -> reviewing: 검증이 걸리지 않고 검토만 걸린 Task 의 성공 보고.
  dispatched: ['completed', 'failed', 'validating', 'reviewing'],
  // validating -> blocked 는 검증을 아예 돌릴 수 없을 때다(구성이 없다, cwd 가 사라졌다). 그 판단은
  // 사람의 것이므로 Gate 를 연다. validating -> dispatched 는 없다 — 검증 결과가 도착할 자리가
  // 사라지기 때문이다.
  // validating -> reviewing: 검증이 통과했고 검토가 걸려 있다. 순서는 검증 -> 검토다.
  validating: ['completed', 'failed', 'blocked', 'reviewing'],
  // reviewing -> blocked 는 검토를 아예 돌릴 수 없을 때다(쓸 수 있는 다른 provider 계정이 없다,
  // 검토자가 보고 없이 죽었다). 그 판단은 사람의 것이므로 Gate 를 연다. reviewing -> dispatched 는
  // 없다 — 검토 결과가 도착할 자리가 사라진다(validating 과 같은 이유).
  reviewing: ['completed', 'failed', 'blocked'],
  completed: [],
  // failed -> blocked is allowed: failed is by definition a state with no open dispatch
  // (applyWorkerDone sets outcome and endedAt together) — so there is no reason to block the flow
  // of "put a Gate on a failed Task to ask a human whether to retry or give up".
  failed: ['dispatched', 'blocked'],
  blocked: ['ready', 'pending']
}

export const canTransition = (from: TaskStatus, to: TaskStatus): boolean =>
  ALLOWED[from].includes(to)

/** Promote pending Tasks whose deps are all completed to ready. blocked is left alone —
 *  that state is owned by a Gate and only gate-resolve can release it. */
export function recomputeReady(tasks: Task[]): Task[] {
  const done = new Set(tasks.filter((t) => t.status === 'completed').map((t) => t.id))
  return tasks.map((t) =>
    t.status === 'pending' && t.deps.every((d) => done.has(d)) ? { ...t, status: 'ready' } : t
  )
}

/** The 'tsk_1a2b3c4d5e6f7a8b' shape (16 hex). Why not the leading digits of crypto.randomUUID: this
 *  file is committed to importing no values, so node:crypto cannot be pulled in. Four Math.random
 *  calls make the 16 characters — an id is an identifier inside a single local process and
 *  unguessability is not required.
 *
 *  Widened from 8 hex (32 bits): at 10,000 messages the birthday problem puts the collision
 *  probability at ≈1.2%, and on a collision `s.messages.find(m => m.id === id)` returns a different
 *  message so a reply answers the wrong question — silently wrong. The prefixes (`msg_`, `dsp_`,
 *  `tsk_`, …) and the format are unchanged (only the length grew). */
export function newId(prefix: string): string {
  const quarter = (): string =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, '0')
  return `${prefix}_${quarter()}${quarter()}${quarter()}${quarter()}`
}
