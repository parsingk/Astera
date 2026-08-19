// Pure data for cross-vendor orchestration. This file imports no values — it can end up in the
// renderer compilation target, so no fs/path dependency may leak in (the same rule as
// providers/meta.ts).
import type { Provider } from '../providers/meta'

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
  /** 이 Run 의 워커를 띄울 provider. 계정은 defaultAccountIdOf 가 고른다. */
  provider?: Provider
  /** 동시에 열어 둘 Dispatch 수. 없으면 DEFAULT_CONCURRENCY. */
  concurrency?: number
  /** 앱이 이 Run 을 스스로 돌리는가. **UI 가 만든 Run 에만 참이다** — 코디네이터가 만든 Run 을
   *  앱이 함께 돌리면 둘이 같은 ready Task 를 두고 경합하고, 진 쪽(대개 코디네이터)의
   *  worker-start 가 `dispatch already open` 을 받는다. 코디네이터 LLM 에게는 자기 명령이 이유
   *  없이 실패하기 시작하는 일이고, 그것을 어떻게 다룰지는 우리가 통제할 수 없다. */
  autoDispatch?: boolean
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
