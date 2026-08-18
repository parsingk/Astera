// Pure data for cross-vendor orchestration. This file imports no values — it can end up in the
// renderer compilation target, so no fs/path dependency may leak in (the same rule as
// providers/meta.ts).
import type { Provider } from '../providers/meta'

export type TaskStatus = 'pending' | 'ready' | 'dispatched' | 'validating' | 'completed' | 'failed' | 'blocked'
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

export interface Run {
  id: string
  objective: string
  cwd: string
  createdAt: string
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
  dispatched: ['completed', 'failed', 'validating'],
  // validating -> blocked 는 검증을 아예 돌릴 수 없을 때다(구성이 없다, cwd 가 사라졌다). 그 판단은
  // 사람의 것이므로 Gate 를 연다. validating -> dispatched 는 없다 — 검증 결과가 도착할 자리가
  // 사라지기 때문이다.
  validating: ['completed', 'failed', 'blocked'],
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
