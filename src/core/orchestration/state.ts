// Pure operations on OrchState. The server and CLI are thin shells over these functions.
// Every function returns a new state instead of mutating — so tests can assert on arrays directly.
import {
  DELIVERY_MAX,
  FAILURE_LIMIT,
  canTransition,
  newId,
  recomputeReady,
  type Delivery,
  type Dispatch,
  type Gate,
  type Message,
  type MessageType,
  type Outcome,
  type Run,
  type Task
} from './types'
import type { Provider } from '../providers/meta'

export interface OrchState {
  runs: Run[]
  tasks: Task[]
  dispatches: Dispatch[]
  messages: Message[]
  deliveries: Delivery[]
  gates: Gate[]
}

export const emptyState = (): OrchState => ({
  runs: [],
  tasks: [],
  dispatches: [],
  messages: [],
  deliveries: [],
  gates: []
})

export type Res<T> = { ok: true; state: OrchState; value: T } | { ok: false; error: string }

const ok = <T>(state: OrchState, value: T): Res<T> => ({ ok: true, state, value })
const err = <T>(error: string): Res<T> => ({ ok: false, error })

const replace = <T extends { id: string }>(xs: T[], next: T): T[] =>
  xs.map((x) => (x.id === next.id ? next : x))

/** Move a Task's status. null if the transition is not allowed (the caller turns it into an error) */
function moveTask(t: Task, to: Task['status'], now: string): Task | null {
  if (t.status === to) return t
  if (!canTransition(t.status, to)) return null
  return { ...t, status: to, updatedAt: now }
}

function pushMessage(
  s: OrchState,
  m: Omit<Message, 'id' | 'answered' | 'createdAt'> & { answered?: boolean },
  now: string
): { state: OrchState; message: Message } {
  const message: Message = {
    ...m,
    id: newId('msg'),
    answered: m.answered ?? false,
    createdAt: now
  }
  return { state: { ...s, messages: [...s.messages, message] }, message }
}

export function createRun(
  s: OrchState,
  a: { objective: string; cwd: string },
  now: string
): Res<Run> {
  if (!a.objective.trim()) return err('objective is required')
  const run: Run = {
    id: newId('run'),
    objective: a.objective,
    cwd: a.cwd,
    createdAt: now
  }
  return ok({ ...s, runs: [...s.runs, run] }, run)
}

export function createTask(
  s: OrchState,
  a: {
    runId: string
    title: string
    spec: string
    deps: string[]
    parentId?: string
    validateConfigId?: string
  },
  now: string
): Res<Task> {
  if (!s.runs.some((r) => r.id === a.runId)) return err(`unknown run: ${a.runId}`)
  if (!a.spec.trim()) return err('spec is required')
  const known = new Set(s.tasks.map((t) => t.id))
  const missing = a.deps.filter((d) => !known.has(d))
  if (missing.length) return err(`unknown deps: ${missing.join(',')}`)
  if (a.parentId && !known.has(a.parentId)) return err(`unknown parent: ${a.parentId}`)
  const task: Task = {
    id: newId('tsk'),
    runId: a.runId,
    title: a.title,
    spec: a.spec,
    deps: a.deps,
    parentId: a.parentId,
    ...(a.validateConfigId ? { validateConfigId: a.validateConfigId } : {}),
    status: 'pending',
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now
  }
  const tasks = recomputeReady([...s.tasks, task])
  return ok({ ...s, tasks }, tasks.find((t) => t.id === task.id)!)
}

export function openDispatch(
  s: OrchState,
  a: {
    taskId: string
    provider: Provider
    accountId: string
    sessionId: string
    cwd: string
    specPath: string
    retryOf?: string
  },
  now: string
): Res<Dispatch> {
  const task = s.tasks.find((t) => t.id === a.taskId)
  if (!task) return err(`unknown task: ${a.taskId}`)
  if (task.status === 'blocked') return err('task is blocked by an open gate')
  if (task.consecutiveFailures >= FAILURE_LIMIT)
    return err(`circuit break: ${FAILURE_LIMIT} consecutive failures`)
  // An open dispatch is rejected unconditionally even with retryOf — retryOf has to mean "the
  // previous attempt already finished", and an open dispatch breaks that premise by itself. This
  // used to filter on `open && !a.retryOf`, so just attaching retryOf bypassed the whole check.
  const open = s.dispatches.find((d) => d.taskId === a.taskId && !d.outcome && !d.endedAt)
  if (open) return err(`dispatch already open: ${open.id}`)
  if (a.retryOf) {
    const prior = s.dispatches.find((d) => d.id === a.retryOf)
    if (!prior) return err(`unknown retryOf dispatch: ${a.retryOf}`)
    if (prior.taskId !== a.taskId)
      return err(`retryOf dispatch belongs to a different task: ${a.retryOf}`)
    // The unconditional open-dispatch guard above (line 132) catches an open dispatch on the same
    // Task first, so this is unreachable today. It stays because relaxing that guard would make
    // this check the only defence.
    if (!prior.outcome && !prior.endedAt)
      return err(`retryOf dispatch is still open: ${a.retryOf}`)
  }
  // sessionId is the basis for the caller's identity, the key that ties it to a tab — if another
  // open dispatch is using the same sessionId (even one belonging to a different Task), it becomes
  // unclear which of them closeDispatch would close, so it is rejected.
  const sessionOpen = s.dispatches.find(
    (d) => d.sessionId === a.sessionId && !d.outcome && !d.endedAt
  )
  if (sessionOpen) return err(`sessionId already in use by an open dispatch: ${sessionOpen.id}`)
  const moved = moveTask(task, 'dispatched', now)
  if (!moved) return err(`cannot dispatch from status: ${task.status}`)
  const dispatch: Dispatch = {
    id: newId('dsp'),
    taskId: a.taskId,
    provider: a.provider,
    accountId: a.accountId,
    sessionId: a.sessionId,
    cwd: a.cwd,
    specPath: a.specPath,
    retryOf: a.retryOf,
    startedAt: now,
    workerState: 'ready',
    retained: false
  }
  return ok(
    { ...s, tasks: replace(s.tasks, moved), dispatches: [...s.dispatches, dispatch] },
    dispatch
  )
}

export function applyWorkerDone(
  s: OrchState,
  a: {
    taskId: string
    dispatchId: string
    outcome: Outcome
    subject: string
    body: string
    filesModified?: string[]
  },
  now: string
): Res<'accepted' | 'alreadyReported'> {
  const dispatch = s.dispatches.find((d) => d.id === a.dispatchId)
  if (!dispatch) return err(`unknown dispatch: ${a.dispatchId}`)
  if (dispatch.taskId !== a.taskId) return err('taskId does not match dispatch')
  // Looking at outcome alone does not filter out a stale dispatch that closeDispatch closed (only
  // endedAt, no outcome) — that was the defect where a worker_done arriving late, after the session
  // had ended, hijacked the Task's terminal state.
  if (dispatch.outcome || dispatch.endedAt) return ok(s, 'alreadyReported')
  const task = s.tasks.find((t) => t.id === a.taskId)
  if (!task) return err(`unknown task: ${a.taskId}`)
  const run = s.runs.find((r) => r.id === task.runId)
  if (!run) return err(`unknown run for task: ${a.taskId}`)

  // 검증이 걸린 Task 는 성공 보고만으로 끝나지 않는다 — 실제로 돌려 본 결과가 정한다.
  // 워커가 실패를 보고했으면 검증하지 않는다. 워커 자신이 안 됐다고 하는데 확인할 이유가 없다.
  const validating = a.outcome === 'succeeded' && !!task.validateConfigId
  const to = validating ? 'validating' : a.outcome === 'succeeded' ? 'completed' : 'failed'
  const moved = moveTask(task, to, now)
  if (!moved) return err(`cannot move task ${task.status} -> ${to}`)
  const nextTask: Task = {
    ...moved,
    result: a.body,
    filesModified: a.filesModified,
    // **validating 으로 갈 때는 그대로 넘긴다.** 여기서 0 으로 되돌리면 이어진 검증 실패가 1 을
    // 만들고 다음 시도도 0 -> 1 이라 FAILURE_LIMIT 에 영원히 닿지 않는다 — 검증을 통과하지 못하는
    // Task 가 무한히 재시도된다. 초기화는 실제로 completed 에 도달할 때만 한다.
    consecutiveFailures: validating
      ? task.consecutiveFailures
      : a.outcome === 'succeeded'
        ? 0
        : task.consecutiveFailures + 1
  }
  const nextDispatch: Dispatch = {
    ...dispatch,
    outcome: a.outcome,
    endedAt: now,
    workerState: a.outcome === 'succeeded' ? 'stopped' : 'failed'
  }
  let state: OrchState = {
    ...s,
    tasks: recomputeReady(replace(s.tasks, nextTask)),
    dispatches: replace(s.dispatches, nextDispatch)
  }
  state = pushMessage(
    state,
    {
      runId: run.id,
      type: 'worker_done',
      taskId: a.taskId,
      dispatchId: a.dispatchId,
      subject: a.subject,
      body: a.body,
      outcome: a.outcome,
      filesModified: a.filesModified
    },
    now
  ).state
  // Settle unanswered questions without an answer — the worker is finished, so there is nobody
  // left to answer them. See the settlePendingQuestions comment for why they are not deleted.
  state = { ...state, messages: settlePendingQuestions(state.messages, a.dispatchId) }
  return ok(state, 'accepted')
}

/** 검증 결과를 Task 에 반영한다. 종료 코드가 판정이다.
 *
 *  실패는 기존 재시도 흐름을 그대로 탄다 — consecutiveFailures 가 오르고 FAILURE_LIMIT 에서
 *  회로가 끊긴다. 출력 꼬리를 result 에 담는 이유는 재시도하는 워커가 무엇이 틀렸는지 읽어야
 *  하기 때문이다. */
export function applyValidationResult(
  s: OrchState,
  a: { taskId: string; exitCode: number; output: string },
  now: string
): Res<Task> {
  const task = s.tasks.find((t) => t.id === a.taskId)
  if (!task) return err(`unknown task: ${a.taskId}`)
  if (task.status !== 'validating') return err(`task is not validating: ${task.status}`)
  const passed = a.exitCode === 0
  const moved = moveTask(task, passed ? 'completed' : 'failed', now)
  if (!moved) return err(`cannot move task ${task.status} -> ${passed ? 'completed' : 'failed'}`)
  const next: Task = {
    ...moved,
    consecutiveFailures: passed ? 0 : task.consecutiveFailures + 1,
    ...(passed ? {} : { result: `validation failed (exit ${a.exitCode})\n${a.output}` })
  }
  return ok({ ...s, tasks: recomputeReady(replace(s.tasks, next)) }, next)
}

/** 검증을 아예 돌릴 수 없을 때. 조용히 통과시키면 "검증됨"과 "검증 못 함"이 화면에서 같아지고,
 *  인프라 문제로 실패시키면 멀쩡한 작업이 재시도 세 번 끝에 회로 차단까지 간다. 어느 쪽도 기계가
 *  정할 일이 아니므로 Gate 를 열어 사람에게 넘긴다. */
export function blockForValidation(
  s: OrchState,
  a: { taskId: string; reason: string },
  now: string
): Res<Gate> {
  return createGate(s, { taskId: a.taskId, question: `검증을 실행할 수 없습니다: ${a.reason}` }, now)
}

/** Settle unanswered questions without an answer — never delete them. An unacked Delivery's
 *  messageIds reference these message ids directly, so deleting a message means that when that
 *  Delivery is replayed the now-nonexistent id is silently filtered out and an empty batch comes
 *  back under the same delivery id — and if the coordinator mistakes that for "nothing new" and
 *  skips the ack, that Delivery stays open forever and no message after it is ever delivered. */
const settlePendingQuestions = (ms: Message[], dispatchId: string): Message[] =>
  ms.map((m) =>
    m.type === 'question' && m.dispatchId === dispatchId && !m.answered
      ? { ...m, answered: true, answerBody: '' }
      : m
  )

/** Close that Dispatch when the session is gone. The Task's **status is left alone** — an outcome
 *  that cannot be proven is not asserted. null if it was already closed.
 *
 *  `consecutiveFailures` is bumped, though, and that is deliberate. If a worker killed by session
 *  termination is not counted, the circuit breaker never opens, and with the Task left at
 *  `dispatched`, moveTask's `t.status === to` pass-through means `--retry-of` is accepted **any
 *  number of times** — the unbounded retry the circuit breaker exists to prevent. (A Dispatch
 *  killed by a usage limit counts toward the three as well — section 7 of the orchestration
 *  guide.) Leaving status as it is and bumping only this counter satisfies both rules at once.
 *  `updatedAt` is refreshed along with it — store's TTL derives the Run's last-activity time from
 *  it, so refreshing it is correct. No field other than those two is changed. */
export function closeDispatch(
  s: OrchState,
  a: { sessionId: string; exitCode: number; limitResetsAt?: number },
  now: string
): Res<Dispatch | null> {
  const dispatch = s.dispatches.find((d) => d.sessionId === a.sessionId && !d.endedAt)
  if (!dispatch) return ok(s, null)
  const task = s.tasks.find((t) => t.id === dispatch.taskId)
  if (!task) return err(`unknown task for dispatch: ${dispatch.id}`)
  const next: Dispatch = {
    ...dispatch,
    endedAt: now,
    workerState: a.exitCode === 0 ? 'stopped' : 'failed',
    ...(a.limitResetsAt !== undefined ? { limitResetsAt: a.limitResetsAt } : {})
  }
  const nextTask: Task = {
    ...task,
    consecutiveFailures: task.consecutiveFailures + 1,
    updatedAt: now
  }
  let state: OrchState = {
    ...s,
    tasks: replace(s.tasks, nextTask),
    dispatches: replace(s.dispatches, next)
  }
  state = pushMessage(
    state,
    a.limitResetsAt !== undefined
      ? {
          runId: task.runId,
          type: 'status',
          taskId: task.id,
          dispatchId: dispatch.id,
          subject: 'session ended at a usage limit',
          body: `exitCode=${a.exitCode}. limitResetsAt=${new Date(a.limitResetsAt).toISOString()}. After that time, a --retry-of on the same account can proceed.`
        }
      : {
          runId: task.runId,
          type: 'status',
          taskId: task.id,
          dispatchId: dispatch.id,
          subject: 'session ended without reporting',
          body: `exitCode=${a.exitCode}. No worker_done was received.`
        },
    now
  ).state
  state = { ...state, messages: settlePendingQuestions(state.messages, dispatch.id) }
  return ok(state, next)
}

/** Returns the oldest unacknowledged Delivery. If there is none, builds a new batch from the
 *  undelivered messages. types only decides the "wake condition"; the batch content is always
 *  everything. */
export function nextDelivery(
  s: OrchState,
  a: { runId: string; types?: MessageType[] },
  now: string
): Res<{ delivery: Delivery; messages: Message[] } | null> {
  const open = s.deliveries.find((d) => d.runId === a.runId && !d.ackedAt)
  if (open) {
    const messages = open.messageIds
      .map((id) => s.messages.find((m) => m.id === id))
      .filter((m): m is Message => m !== undefined)
    return ok(s, { delivery: open, messages })
  }
  const undelivered = s.messages.filter((m) => m.runId === a.runId && !m.deliveryId)
  if (undelivered.length === 0) return ok(s, null)
  if (a.types && a.types.length > 0 && !undelivered.some((m) => a.types!.includes(m.type)))
    return ok(s, null) // the wake condition is not met — no batch is created
  const batch = undelivered.slice(0, DELIVERY_MAX)
  const delivery: Delivery = {
    id: newId('dlv'),
    runId: a.runId,
    messageIds: batch.map((m) => m.id),
    createdAt: now
  }
  const ids = new Set(delivery.messageIds)
  const messages = s.messages.map((m) => (ids.has(m.id) ? { ...m, deliveryId: delivery.id } : m))
  return ok(
    { ...s, messages, deliveries: [...s.deliveries, delivery] },
    { delivery, messages: messages.filter((m) => ids.has(m.id)) }
  )
}

export function ackDelivery(
  s: OrchState,
  a: { deliveryId: string },
  now: string
): Res<Delivery> {
  const d = s.deliveries.find((x) => x.id === a.deliveryId)
  if (!d) return err(`unknown delivery: ${a.deliveryId}`)
  if (d.ackedAt) return ok(s, d)
  const next: Delivery = { ...d, ackedAt: now }
  const ids = new Set(d.messageIds)
  return ok(
    {
      ...s,
      deliveries: replace(s.deliveries, next),
      messages: s.messages.map((m) => (ids.has(m.id) ? { ...m, ackedAt: now } : m))
    },
    next
  )
}

export function createQuestion(
  s: OrchState,
  a: { taskId: string; dispatchId: string; question: string; options?: string[] },
  now: string
): Res<Message> {
  const dispatch = s.dispatches.find((d) => d.id === a.dispatchId)
  if (!dispatch) return err(`unknown dispatch: ${a.dispatchId}`)
  if (dispatch.taskId !== a.taskId) return err('taskId does not match dispatch')
  // endedAt counts as terminal here for the same reason as in applyWorkerDone — a new question
  // cannot be attached to a dispatch that closeDispatch closed.
  if (dispatch.outcome || dispatch.endedAt) return err('dispatch already settled')
  const pending = s.messages.some(
    (m) => m.type === 'question' && m.dispatchId === a.dispatchId && !m.answered
  )
  if (pending) return err('a pending question already exists for this dispatch')
  const task = s.tasks.find((t) => t.id === a.taskId)
  if (!task) return err(`unknown task: ${a.taskId}`)
  const { state, message } = pushMessage(
    s,
    {
      runId: task.runId,
      type: 'question',
      taskId: a.taskId,
      dispatchId: a.dispatchId,
      subject: a.question.split('\n')[0].slice(0, 120),
      body: a.question,
      options: a.options
    },
    now
  )
  return ok(state, message)
}

export function applyReply(
  s: OrchState,
  a: { messageId: string; body: string },
  now: string
): Res<'accepted' | 'alreadyAnswered'> {
  const q = s.messages.find((m) => m.id === a.messageId)
  if (!q || q.type !== 'question') return err(`unknown question: ${a.messageId}`)
  if (q.answered) return ok(s, 'alreadyAnswered')
  const next: Message = { ...q, answered: true, answerBody: a.body }
  let state: OrchState = { ...s, messages: replace(s.messages, next) }
  state = pushMessage(
    state,
    {
      runId: q.runId,
      type: 'status',
      taskId: q.taskId,
      dispatchId: q.dispatchId,
      subject: 'the question was answered',
      body: a.body,
      replyTo: q.id,
      answered: true
    },
    now
  ).state
  return ok(state, 'accepted')
}

export function createGate(
  s: OrchState,
  a: { taskId: string; question: string; options?: string[] },
  now: string
): Res<Gate> {
  const task = s.tasks.find((t) => t.id === a.taskId)
  if (!task) return err(`unknown task: ${a.taskId}`)
  // A Gate is for deciding the task DAG — it is not a device for stopping a worker that is already
  // running (that is worker-stop). Creating a Gate at all is rejected when a dispatch is open.
  const openDisp = s.dispatches.find((d) => d.taskId === a.taskId && !d.outcome && !d.endedAt)
  if (openDisp) return err(`cannot gate a task with an open dispatch: ${openDisp.id}`)
  const moved = moveTask(task, 'blocked', now)
  if (!moved) return err(`cannot block from status: ${task.status}`)
  const gate: Gate = {
    id: newId('gat'),
    runId: task.runId,
    taskId: a.taskId,
    question: a.question,
    options: a.options,
    status: 'open',
    createdAt: now
  }
  let state: OrchState = {
    ...s,
    tasks: replace(s.tasks, moved),
    gates: [...s.gates, gate]
  }
  state = pushMessage(
    state,
    {
      runId: task.runId,
      type: 'decision_gate',
      taskId: a.taskId,
      subject: a.question.split('\n')[0].slice(0, 120),
      body: a.question,
      options: a.options
    },
    now
  ).state
  return ok(state, gate)
}

export function resolveGate(
  s: OrchState,
  a: { gateId: string; resolution: string },
  now: string
): Res<Gate> {
  const gate = s.gates.find((g) => g.id === a.gateId)
  if (!gate) return err(`unknown gate: ${a.gateId}`)
  if (gate.status === 'resolved') return ok(s, gate)
  const next: Gate = { ...gate, status: 'resolved', resolution: a.resolution, resolvedAt: now }
  const task = s.tasks.find((t) => t.id === gate.taskId)
  if (!task) return err(`unknown task for gate: ${a.gateId}`)
  const stillBlocked = s.gates.some(
    (g) => g.taskId === gate.taskId && g.status === 'open' && g.id !== gate.id
  )
  // **Unblock to pending, not ready, and leave the decision to recomputeReady.** Moving
  // unconditionally to ready would make a Task ready even when its deps are not completed yet, and
  // DAG ordering would stop being enforced:
  // B (deps:[A], A is pending) → gate-create B → blocked → gate-resolve → B ready →
  // task-list --ready shows B → worker-start passes → the worker works without A's output.
  // blocked → pending is already in the transition table (ALLOWED.blocked in types.ts), and
  // recomputeReady only promotes pending Tasks whose deps are satisfied, so a Task with no deps
  // still unblocks to ready exactly as before.
  const moved = stillBlocked ? task : moveTask(task, 'pending', now)
  if (!moved) return err(`cannot unblock from status: ${task.status}`)
  return ok(
    {
      ...s,
      gates: replace(s.gates, next),
      tasks: stillBlocked ? s.tasks : recomputeReady(replace(s.tasks, moved))
    },
    next
  )
}
