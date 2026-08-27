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
import type { ScheduleRule } from '../scheduler/rule'

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
  a: {
    objective: string
    cwd: string
    provider?: Provider
    concurrency?: number
    autoDispatch?: boolean
    /** 사용자가 '실행' 을 누르기 전까지 돌지 않게 한다 — Run.pendingStart 의 주석을 보라 */
    pendingStart?: boolean
    /** 있으면 이 Run 은 템플릿이다 — Run.schedule 의 주석을 보라. 규칙의 유효성은 부르는
     *  쪽(server.ts 의 run-create)이 isValidRule 로 본다, provider·accountId 와 같은 관례다 */
    schedule?: ScheduleRule
  },
  now: string
): Res<Run> {
  if (!a.objective.trim()) return err('objective is required')
  const run: Run = {
    id: newId('run'),
    objective: a.objective,
    cwd: a.cwd,
    createdAt: now,
    ...(a.provider ? { provider: a.provider } : {}),
    ...(a.concurrency !== undefined ? { concurrency: a.concurrency } : {}),
    ...(a.autoDispatch ? { autoDispatch: true } : {}),
    ...(a.schedule ? { schedule: a.schedule } : {}),
    ...(a.pendingStart ? { pendingStart: true } : {})
  }
  return ok({ ...s, runs: [...s.runs, run] }, run)
}

/**
 * 템플릿의 한 회차를 만든다 — 자식 Run 하나와 그 Task 사본들.
 *
 * **정의는 옮기고 결과는 옮기지 않는다.** result·filesModified·consecutiveFailures 를 물려주면
 * 지난 회차의 결과가 새 회차의 진행률과 회로 차단에 섞인다.
 *
 * **deps 와 parentId 는 새 id 로 다시 매핑한다.** 옛 id 를 그대로 두면 자식의 의존이 템플릿의
 * Task 를 가리키는데, 템플릿의 Task 는 배치되지 않으므로 영원히 completed 가 되지 않는다 — 자식의
 * Task 전부가 pending 에 갇히고, graph.ts 는 그 의존을 Run 밖의 id 로 보게 된다. 표에 없는
 * id(템플릿 밖을 가리키는, 손으로 고친 값)는 떨어뜨린다: 자식이 무엇을 기다리는지 모르는 채로
 * 두는 것보다 낫다.
 *
 * status 는 createTask 와 **같은 방식**으로 정한다 — 전부 pending 으로 만든 뒤 recomputeReady 에
 * 맡긴다. 그래야 "deps 없는 Task 가 ready" 라는 규칙이 한 곳에만 있다. 템플릿의 Task 는 이 호출로
 * 바뀌지 않는다: 이미 recomputeReady 를 지난 상태라 다시 통과시켜도 같은 값이다.
 */
export function spawnScheduledRun(s: OrchState, templateId: string, now: string): Res<Run> {
  const template = s.runs.find((r) => r.id === templateId)
  if (!template) return err(`unknown run: ${templateId}`)
  if (!template.schedule) return err(`run is not scheduled: ${templateId}`)
  // 몇 번째 발화인가. **자식 개수가 아니라 템플릿에 새긴 카운터에서 온다** — 개수로 세면 회차를
  // 지우거나 TTL 이 정리할 때 번호가 뒤로 간다(Run.fireCount 의 주석).
  const ordinal = (template.fireCount ?? 0) + 1
  const child: Run = {
    id: newId('run'),
    objective: template.objective,
    cwd: template.cwd,
    createdAt: now,
    ...(template.provider ? { provider: template.provider } : {}),
    ...(template.concurrency !== undefined ? { concurrency: template.concurrency } : {}),
    autoDispatch: true,
    templateId,
    fireOrdinal: ordinal
  }
  // createdAt 오름차순 — snapshotFor 가 쓰는 순서이고, 의존 사슬을 읽는 순서다
  const source = s.tasks
    .filter((t) => t.runId === templateId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const idMap = new Map(source.map((t) => [t.id, newId('tsk')]))
  const copies: Task[] = source.map((t) => ({
    id: idMap.get(t.id)!,
    runId: child.id,
    title: t.title,
    spec: t.spec,
    deps: t.deps.map((d) => idMap.get(d)).filter((d): d is string => d !== undefined),
    ...(t.parentId !== undefined && idMap.has(t.parentId)
      ? { parentId: idMap.get(t.parentId)! }
      : {}),
    ...(t.accountIds !== undefined ? { accountIds: [...t.accountIds] } : {}),
    ...(t.validateConfigId !== undefined ? { validateConfigId: t.validateConfigId } : {}),
    ...(t.reviewRequested ? { reviewRequested: true } : {}),
    status: 'pending',
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now
  }))
  return ok(
    {
      ...s,
      // 템플릿에서 움직이는 것은 이 카운터 하나다 — Task 는 정의이므로 손대면 다음 회차가 달라진다
      runs: [...s.runs.map((r) => (r.id === templateId ? { ...r, fireCount: ordinal } : r)), child],
      tasks: recomputeReady([...s.tasks, ...copies])
    },
    child
  )
}

/**
 * 인자로 Run 을 지목하지 않은 명령이 뜻하는 "가장 최근 Run" — **템플릿도 회차도 아닌 것 중에서**
 * 가장 나중에 만들어진 것. 없으면 undefined 이고, 그때 부르는 쪽은 자기 "Run 이 없다" 오류를 낸다.
 *
 * 이 함수가 필요한 이유는 위의 두 함수다. `s.runs[s.runs.length - 1]` 은 **사람의 동작 없이도
 * 움직이는 값**이 되었다 — createRun 이 만든 템플릿과 spawnScheduledRun 이 15초 ticker 에서 만드는
 * 회차가 둘 다 이 배열의 끝에 붙는다. 그러면 Run A 를 몰던 코디네이터의 `check --wait` 가 조용히
 * 방금 생긴 회차의 배달을 기다리며 영원히 서고, `--run` 없는 task-create 는 템플릿에 떨어져 그 뒤
 * 모든 회차로 복사된다.
 *
 * 템플릿을 빼는 것은 "템플릿은 정의를 담는 그릇이고 그 편집은 명시적이어야 한다"이고, 회차를 빼는
 * 것은 "회차는 읽기 전용 실행 기록"이다(설계 2절). 둘 다 지목해서만 닿게 한다 — `--run` 을 주면
 * 그대로 된다.
 */
export function latestOrdinaryRun(s: OrchState): Run | undefined {
  return [...s.runs].reverse().find((r) => r.schedule === undefined && r.templateId === undefined)
}

/**
 * 사람이 '실행' 을 눌렀다 — pendingStart 를 걷는다. 이 커밋의 setState 가 자동 배치 펌프를 깨우고
 * (src/main/ipc.ts) 그때부터 이 Run 의 ready Task 가 돈다.
 *
 * **이미 걷힌 Run 에 다시 불러도 성공이다.** 버튼이 사라지기 전에 두 번 눌릴 수 있고, 그때 사람이
 * 손쓸 수 없는 실패 문구를 띄우는 것은 이 명령이 하려는 일과 무관하다 — 요청한 끝 상태는 이미
 * 그것이다. 예약 템플릿에는 이 칸이 없으므로 여기서 따로 거절하지 않아도 아무 일도 일어나지 않는다.
 */
export function startRun(s: OrchState, id: string): Res<Run> {
  const run = s.runs.find((r) => r.id === id)
  if (!run) return err(`unknown run: ${id}`)
  if (!run.pendingStart) return ok(s, run)
  // pendingStart 를 **지운다** — false 로 두면 JSON 비교에서 "없음" 과 다른 값이 되고, 이 코드베이스는
  // 해당 없는 칸을 아예 두지 않는 관례다
  const { pendingStart: _drop, ...started } = run
  return ok({ ...s, runs: s.runs.map((r) => (r.id === id ? started : r)) }, started)
}

/**
 * 배선이 만든 Run 워크트리를 기록한다. 만드는 것은 배선이고(디스크 작업) 여기는 그 사실만 받는다 —
 * 명령 안에서 git 을 부르면 상태 전이가 디스크 실패로 절반만 일어날 수 있다.
 *
 * **이미 있으면 거절한다.** 두 번 불리는 것은 배선이 워크트리를 두 개 만들었다는 뜻이고, 조용히
 * 덮어쓰면 그중 하나가 아무도 기억하지 못하는 폴더로 디스크에 남는다. 실패가 로그에 남는 것이
 * 낫다(startRun 이 두 번 불려도 성공인 것과 반대인 이유: 그쪽은 버튼이 두 번 눌린 것이고 요청한
 * 끝 상태가 이미 그것이지만, 이쪽은 두 번째 호출이 다른 경로를 들고 온다).
 */
/**
 * 예약을 일시 중지한다 — 이 템플릿과 그 회차들을 **모두** 세운다.
 *
 * 두 가지를 함께 한다. **열린 Dispatch 를 닫고**(세션을 죽이는 것은 배선이 이 함수 앞에서 한다 —
 * worker-stop 과 같은 순서다), 템플릿과 회차들에 **pendingStart 를 세운다.**
 *
 * **회차까지 세우는 것이 요점이다.** Dispatch 를 닫는 것만으로는 그 회차가 멈추지 않는다 — 닫힌
 * 자리에 그 회차의 다음 ready Task 가 곧바로 뜬다(회차는 autoDispatch 가 켜져 있다). 게이트가
 * 없으면 "일시 중지" 가 "지금 도는 Task 하나만 멈춤" 이 된다.
 *
 * **pendingStart 를 쓰지 않고 paused 를 쓴다.** 둘 다 "돌지 않는다" 를 만들지만 사람에게는 다른
 * 상황이고 다른 버튼이다(Run.paused 의 주석) — 한 칸으로 겸하게 했더니 세운 뒤에 '실행' 버튼과
 * '▶' 가 같은 일을 하는 두 버튼으로 나란히 떴다.
 *
 * **멈춘 회차는 이어지지 않는다.** resumeSchedule 은 부른 템플릿의 칸만 걷으므로 그 회차의 남은
 * Task 는 다시 돌지 않는다. 재개가 만드는 것은 다음 예약 시각의 **새 회차**다.
 */
export function pauseSchedule(s: OrchState, templateId: string, now: string): Res<Run> {
  const template = s.runs.find((r) => r.id === templateId)
  if (!template) return err(`unknown run: ${templateId}`)
  if (!template.schedule) return err(`run is not scheduled: ${templateId}`)
  const family = new Set([templateId, ...s.runs.filter((r) => r.templateId === templateId).map((r) => r.id)])
  const taskIds = new Set(s.tasks.filter((t) => family.has(t.runId)).map((t) => t.id))
  const held = { ...template, paused: true as const }
  return ok(
    {
      ...s,
      runs: s.runs.map((r) => (family.has(r.id) ? { ...r, paused: true } : r)),
      // 닫는 방식은 worker-stop 과 같다 — workerState 를 stopped 로, endedAt 을 찍는다. outcome 은
      // 넣지 않는다: 이 워커는 결과를 보고하지 않았고, 보고하지 않은 것을 성공이나 실패로 적으면
      // 그래프가 거짓말을 한다(재시작 정리가 그런 Dispatch 를 outcome_unknown 으로 읽는다).
      dispatches: s.dispatches.map((d) =>
        taskIds.has(d.taskId) && !d.outcome && !d.endedAt
          ? { ...d, workerState: 'stopped' as const, endedAt: now }
          : d
      )
    },
    held
  )
}

/**
 * 세워 둔 예약을 다시 돌린다 — **템플릿의 칸만 걷는다.**
 *
 * 회차의 칸은 그대로 둔다. 중단된 회차를 이어 받으면 그 회차는 자기가 멈춘 자리에서 다시 시작하는데,
 * 사람이 세워 둔 사이에 그 일의 전제가 달라졌을 수 있다. 재개가 뜻하는 것은 **다음 예약 시각의 새
 * 회차**이고, 그것이 '다시 실행 시 다음 예약 시간부터' 라고 적어 둔 그 약속이다.
 *
 * **세워 두지 않은 Run 에 불러도 성공이다.** 버튼이 사라지기 전에 두 번 눌릴 수 있고, 요청한 끝
 * 상태는 이미 그것이다(startRun 이 같은 이유로 같은 선택을 한다).
 */
export function resumeSchedule(s: OrchState, templateId: string): Res<Run> {
  const template = s.runs.find((r) => r.id === templateId)
  if (!template) return err(`unknown run: ${templateId}`)
  if (!template.schedule) return err(`run is not scheduled: ${templateId}`)
  if (!template.paused) return ok(s, template)
  // paused 를 **지운다** — false 로 두면 JSON 비교에서 "없음" 과 다른 값이 되고, 이 코드베이스는
  // 해당 없는 칸을 아예 두지 않는 관례다(startRun 과 같다)
  const { paused: _drop, ...resumed } = template
  return ok({ ...s, runs: s.runs.map((r) => (r.id === templateId ? resumed : r)) }, resumed)
}

export function setRunWorktree(s: OrchState, id: string, worktree: string): Res<Run> {
  const run = s.runs.find((r) => r.id === id)
  if (!run) return err(`unknown run: ${id}`)
  if (run.worktree !== undefined)
    return err(`run ${id} already has a worktree: ${run.worktree}`)
  const next = { ...run, worktree }
  return ok({ ...s, runs: s.runs.map((r) => (r.id === id ? next : r)) }, next)
}

export function createTask(
  s: OrchState,
  a: {
    runId: string
    title: string
    spec: string
    deps: string[]
    parentId?: string
    /** 이 Task 를 띄울 계정들, 순서대로. **여기서 확인하지 않는다** — 계정 목록은 core 가 아니라
     *  앱이 아는 것이고(schedule.ts 머리말과 같은 이유), 부르는 쪽(server.ts 의 task-create)이 그
     *  Run 의 provider 계정인지 보고 거절한다. validateConfigId 도 같은 관례다. */
    accountIds?: string[]
    validateConfigId?: string
    reviewRequested?: boolean
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
    // 빈 배열은 **지정 없음**이다 — 그것도 실으면 Task 를 값으로 비교하는 자리에서 지정이 없는
    // Task 와 갈라진다(조건부 전개를 쓰는 이유 그대로).
    ...(a.accountIds?.length ? { accountIds: a.accountIds } : {}),
    ...(a.validateConfigId ? { validateConfigId: a.validateConfigId } : {}),
    ...(a.reviewRequested ? { reviewRequested: a.reviewRequested } : {}),
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
    /** 검증을 실제로 돌릴 수 있는가. 배선이 검증기를 주입하지 않았으면 서버가 false 로 넘긴다 —
     *  그 경우 validateConfigId 가 걸려 있어도 validating 으로 보내지 않는다. 보내면 결과를
     *  가져다줄 것이 아무것도 없어 Task 가 영원히 validating 이고, recomputeReady 는 completed 만
     *  승격시키므로 그 의존 서브트리 전체가 pending 에 멈춘다 — 선택적 의존성이 무해하게 저하하는
     *  대신 Task 를 고립시키는 것이다. 스펙 5절이 정한 동작은 "주입되지 않으면 검증이 없는 것으로
     *  동작한다(worker_done 을 그대로 믿는다)"다.
     *  기본값은 true — 이 인자를 모르는 순수 계층의 호출자에게는 지금까지의 동작이 유지된다. */
    canValidate?: boolean
    /** 검토를 실제로 돌릴 수 있는가. 배선이 검토기를 주입하지 않았으면 서버가 false 로 넘긴다 —
     *  canValidate 와 완전히 같은 이유다: 보내면 결과를 가져다줄 것이 없어 Task 가 영원히
     *  reviewing 이고, recomputeReady 는 completed 만 승격시키므로 그 의존 서브트리 전체가
     *  pending 에 멈춘다. 기본값 true — 이 인자를 모르는 호출자에게는 지금까지의 동작이 유지된다. */
    canReview?: boolean
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
  // canValidate === false 는 검증기가 없는 배선이다 — 그때는 검증이 없는 Task 와 똑같이 다룬다.
  const validating =
    a.outcome === 'succeeded' && !!task.validateConfigId && a.canValidate !== false
  // 검증이 먼저다 — !validating 이 그것을 강제한다. 검증이 통과한 뒤의 검토는
  // applyValidationResult 가 같은 판단으로 넘긴다.
  const reviewing =
    a.outcome === 'succeeded' && !validating && !!task.reviewRequested && a.canReview !== false
  const to = validating
    ? 'validating'
    : reviewing
      ? 'reviewing'
      : a.outcome === 'succeeded'
        ? 'completed'
        : 'failed'
  const moved = moveTask(task, to, now)
  if (!moved) return err(`cannot move task ${task.status} -> ${to}`)
  const nextTask: Task = {
    ...moved,
    result: a.body,
    filesModified: a.filesModified,
    // **validating 이나 reviewing 으로 갈 때는 그대로 넘긴다.** 여기서 0 으로 되돌리면 이어진
    // 검증/검토 실패가 1 을 만들고 다음 시도도 0 -> 1 이라 FAILURE_LIMIT 에 영원히 닿지 않는다 —
    // 통과하지 못하는 Task 가 무한히 재시도된다. 초기화는 실제로 completed 에 도달할 때만 한다.
    consecutiveFailures:
      validating || reviewing
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
 *  회로가 끊긴다. 출력 꼬리는 result 와 아래 status 메시지 양쪽에 담는다. 재시도하는 워커가
 *  그것을 읽지는 못한다 — coordinator.ts 의 buildSpecFile 은 spec 파일에 title 과 spec 만
 *  싣는다 — 그래서 무엇이 틀렸는지 다음 시도에 전달하는 것은 이 메시지를 읽은 코디네이터의 일이다.
 *
 *  **결과는 반드시 메시지가 된다.** 코디네이터를 깨우는 수단은 메시지뿐이다(check 는
 *  nextDelivery 를 통해 s.messages 만 읽는다). 여기서 메시지를 붙이지 않으면 워커의 "성공했다"가
 *  코디네이터가 받은 마지막 소식으로 남고, 검증이 실패해 Task 가 failed 가 되어도 재시도 흐름을
 *  타는 사람이 아무도 없다 — check --wait 는 영원히 타임아웃만 돌려주고, 가이드는 타임아웃을
 *  실패의 신호로 보지 말라고 못박아 두었다. 통과도 알려야 한다: 의존 Task 가 풀린 것을 알지
 *  못하면 코디네이터는 다음 Task 를 띄우지 않는다. */
export function applyValidationResult(
  s: OrchState,
  a: {
    taskId: string
    exitCode: number
    output: string
    /** applyWorkerDone 의 canReview 와 같은 판정이다 — 배선이 검토기를 주입하지 않았으면 서버가
     *  false 로 넘긴다. */
    canReview?: boolean
  },
  now: string
): Res<Task> {
  const task = s.tasks.find((t) => t.id === a.taskId)
  if (!task) return err(`unknown task: ${a.taskId}`)
  if (task.status !== 'validating') return err(`task is not validating: ${task.status}`)
  const passed = a.exitCode === 0
  // 검증이 통과했어도 검토가 걸려 있으면 아직 끝난 것이 아니다. applyWorkerDone 과 같은 판단이고,
  // 여기에 없으면 검증이 걸린 Task 만 검토를 건너뛴다.
  const reviewing = passed && !!task.reviewRequested && a.canReview !== false
  const to = reviewing ? 'reviewing' : passed ? 'completed' : 'failed'
  const moved = moveTask(task, to, now)
  if (!moved) return err(`cannot move task ${task.status} -> ${to}`)
  const next: Task = {
    ...moved,
    // reviewing 으로 갈 때 0 으로 되돌리지 않는다 — 위 applyWorkerDone 의 주석과 같은 이유이고,
    // 이쪽이 더 잡기 어렵다: 검증은 통과하고 검토는 실패하는 Task 가 매 시도마다 0 -> 1 을
    // 반복해 회로가 영원히 끊기지 않는다.
    consecutiveFailures: reviewing
      ? task.consecutiveFailures
      : passed
        ? 0
        : task.consecutiveFailures + 1,
    ...(passed ? {} : { result: `validation failed (exit ${a.exitCode})\n${a.output}` })
  }
  let state: OrchState = { ...s, tasks: recomputeReady(replace(s.tasks, next)) }
  // closeDispatch 의 한도 감지 메시지와 같은 모양이다 — type: 'status', 제목이 결과를 말하고
  // 본문이 종료 코드와 출력 꼬리를 담는다. dispatchId 는 붙이지 않는다: 검증은 Dispatch 가 끝난
  // 뒤에 도는 것이므로 어떤 Dispatch 의 소식도 아니다. 앱이 만드는 오케스트레이션 문자열이라 영어다.
  state = pushMessage(
    state,
    {
      runId: task.runId,
      type: 'status',
      taskId: task.id,
      subject: passed ? 'validation passed' : 'validation failed',
      body: passed
        ? `exitCode=0. ${reviewing ? 'The Task moved to reviewing — a reviewer on another provider now reads it.' : 'The Task moved to completed.'}\n${a.output}`
        : `exitCode=${a.exitCode}. The Task moved to failed (consecutiveFailures=${next.consecutiveFailures}). Retry with worker-start --retry-of. The output tail below is the only record of what went wrong — a retry worker's spec file does not carry it, so pass on whatever it needs.\n${a.output}`
    },
    now
  ).state
  return ok(state, next)
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

/** 검토 Dispatch 를 연다. openDispatch 와 다른 점 셋:
 *
 *  - **Task 를 dispatched 로 옮기지 않는다.** 이미 reviewing 이고, 그 상태가 의존 Task 를 막는
 *    장치다 — 옮기면 recomputeReady 가 다음 Task 를 풀어 준다.
 *  - retryOf 가 없다. 검토를 다시 띄우는 것은 앱이 하지 않는다(보고 없이 죽으면 Gate 다).
 *  - review: true 를 찍는다. worker_done 이 도착했을 때 어느 쪽 Dispatch 인지 아는 유일한 방법이다.
 *
 *  회로 차단 검사는 두지 않는다 — 이 Task 는 reviewing 에 도달했으므로 연속 실패가 한도 아래다. */
export function openReviewDispatch(
  s: OrchState,
  a: {
    taskId: string
    provider: Provider
    accountId: string
    sessionId: string
    cwd: string
    specPath: string
  },
  now: string
): Res<Dispatch> {
  const task = s.tasks.find((t) => t.id === a.taskId)
  if (!task) return err(`unknown task: ${a.taskId}`)
  if (task.status !== 'reviewing') return err(`task is not reviewing: ${task.status}`)
  const open = s.dispatches.find((d) => d.taskId === a.taskId && !d.outcome && !d.endedAt)
  if (open) return err(`dispatch already open: ${open.id}`)
  // openDispatch 와 같은 이유 — 같은 sessionId 를 쓰는 열린 Dispatch 가 둘이면 closeDispatch 가
  // 어느 것을 닫을지 알 수 없다
  const sessionOpen = s.dispatches.find(
    (d) => d.sessionId === a.sessionId && !d.outcome && !d.endedAt
  )
  if (sessionOpen) return err(`sessionId already in use by an open dispatch: ${sessionOpen.id}`)
  const dispatch: Dispatch = {
    id: newId('dsp'),
    taskId: a.taskId,
    provider: a.provider,
    accountId: a.accountId,
    sessionId: a.sessionId,
    cwd: a.cwd,
    specPath: a.specPath,
    review: true,
    startedAt: now,
    workerState: 'ready',
    retained: false
  }
  return ok({ ...s, dispatches: [...s.dispatches, dispatch] }, dispatch)
}

/** 검토자의 판정을 Task 에 반영한다.
 *
 *  실패는 기존 재시도 흐름을 그대로 탄다 — Gate 를 열지 않는다. 검토가 "부족하다"고 판정한 것은
 *  **정상 결과**이고, 정상 결과를 사람에게 넘기면 자동화가 아니다. Gate 는 검토를 **돌릴 수 없을**
 *  때만 쓴다(blockForReview).
 *
 *  **결과는 반드시 메시지가 된다** — applyValidationResult 와 같은 이유다. 코디네이터를 깨우는
 *  수단은 메시지뿐이고(check 는 nextDelivery 를 통해 s.messages 만 읽는다), 통과도 알려야 한다:
 *  의존 Task 가 풀린 것을 모르면 다음 Task 를 띄우지 않는다.
 *
 *  worker_done 이 아니라 status 인 이유: 코디네이터 쪽에서 보면 이것은 **앱이 얻어 온 판정을 앱이
 *  보고하는 것**이고 검증 결과와 같은 성격이다. worker_done 은 "내가 띄운 워커가 보고했다"로 남긴다. */
export function applyReviewResult(
  s: OrchState,
  a: { taskId: string; dispatchId: string; outcome: Outcome; subject: string; body: string },
  now: string
): Res<'accepted' | 'alreadyReported'> {
  const dispatch = s.dispatches.find((d) => d.id === a.dispatchId)
  if (!dispatch) return err(`unknown dispatch: ${a.dispatchId}`)
  if (!dispatch.review) return err(`not a review dispatch: ${a.dispatchId}`)
  if (dispatch.taskId !== a.taskId) return err('taskId does not match dispatch')
  // applyWorkerDone 과 같은 판정 — outcome 만 보면 closeDispatch 가 닫아 둔(endedAt 만 있고
  // outcome 은 없는) Dispatch 가 걸러지지 않아, 늦게 도착한 보고가 Task 의 종료 상태를 가로챈다.
  if (dispatch.outcome || dispatch.endedAt) return ok(s, 'alreadyReported')
  const task = s.tasks.find((t) => t.id === a.taskId)
  if (!task) return err(`unknown task: ${a.taskId}`)
  if (task.status !== 'reviewing') return err(`task is not reviewing: ${task.status}`)
  const passed = a.outcome === 'succeeded'
  const moved = moveTask(task, passed ? 'completed' : 'failed', now)
  if (!moved) return err(`cannot move task ${task.status} -> ${passed ? 'completed' : 'failed'}`)
  const next: Task = {
    ...moved,
    // 무엇이 부족했는지를 Task 에 남긴다. 재시도 워커가 이것을 읽지는 못한다 — buildSpecFile 은
    // spec 파일에 title 과 spec 만 싣는다 — 그래서 전달은 아래 메시지를 읽은 코디네이터의 일이다.
    ...(passed ? {} : { result: a.body }),
    consecutiveFailures: passed ? 0 : task.consecutiveFailures + 1
  }
  const nextDispatch: Dispatch = {
    ...dispatch,
    outcome: a.outcome,
    endedAt: now,
    workerState: passed ? 'stopped' : 'failed'
  }
  let state: OrchState = {
    ...s,
    tasks: recomputeReady(replace(s.tasks, next)),
    dispatches: replace(s.dispatches, nextDispatch)
  }
  state = pushMessage(
    state,
    {
      runId: task.runId,
      type: 'status',
      taskId: task.id,
      dispatchId: dispatch.id,
      subject: passed ? 'review passed' : 'review failed',
      body: passed
        ? `The reviewer accepted the work. The Task moved to completed.\n${a.body}`
        : `The reviewer rejected the work (consecutiveFailures=${next.consecutiveFailures}). Retry with worker-start --retry-of. The reason below is the only record of what was missing — a retry worker's spec file does not carry it, so pass on whatever it needs.\n${a.body}`
    },
    now
  ).state
  return ok(state, 'accepted')
}

/** 검토를 아예 돌릴 수 없을 때. blockForValidation 과 같은 판단이다 — 조용히 통과시키면 "검토됨"과
 *  "검토 못 함"이 화면에서 같아지고, 실패시키면 인프라 문제로 멀쩡한 작업이 재시도 세 번 끝에 회로
 *  차단까지 간다.
 *
 *  **질문이 빠져나갈 길을 말한다.** resolveGate 는 Task 를 pending 으로 돌리므로, 그것으로 풀면
 *  이미 끝나고 검증까지 통과한 일이 버려질 수 있다(코디네이터가 구현 워커를 새로 띄운다).
 *  task-update 는 전이표를 일부러 우회하므로 그 일을 버리지 않고 Task 를 닫는다.
 *
 *  문장이 한국어인 것은 blockForValidation 과 같다 — Gate 질문의 하드코딩된 언어는 그 슬라이스가
 *  남긴 후속이고 여기서 새로 풀지 않는다. */
export function blockForReview(
  s: OrchState,
  a: { taskId: string; reason: string },
  now: string
): Res<Gate> {
  return createGate(
    s,
    {
      taskId: a.taskId,
      question: `검토를 실행할 수 없습니다: ${a.reason}\n끝난 일을 버리지 않고 이 Task 를 닫으려면 task-update --status completed 를 쓰세요.`
    },
    now
  )
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

/** 롤링이 세션을 갈아탈 때 열린 Dispatch 를 새 세션 id·계정으로 옮긴다.
 *
 *  **왜 필요한가.** `Dispatch.sessionId` 는 worker_done 을 되돌려 묶는 **유일한** 키다 —
 *  closeDispatch 가 그것으로 Dispatch 를 찾고, handleCommand 의 호출자 식별과 사이드바가 탭을 여는
 *  값(JobTask.sessionId)도 같은 값에 걸려 있다. 롤은 세션을 죽이고 새 id 로 다시 띄우므로
 *  (rolling.ts 의 liveId: "changes on every roll"), 옮겨 주지 않으면 살아 있는 워커의 보고가 갈 곳을
 *  잃는다.
 *
 *  **Task 는 건드리지 않는다.** 상태도 consecutiveFailures 도 그대로다 — 세션이 죽은 것이 아니라
 *  계정만 갈린 것이고, 그것은 실패가 아니다. updatedAt 만 새로 찍는다: 롤은 활동이고, store 의 TTL 이
 *  Run 의 마지막 활동 시각을 그 값에서 끌어온다(closeDispatch 가 같은 이유로 같은 선택을 한다).
 *
 *  **Dispatch 를 닫지 않는다.** 이 함수의 존재 이유가 그것이다 — 롤의 kill 이 만든 exit 가
 *  closeDispatch 에 도달해 살아 있는 워커의 Dispatch 를 닫는 것을 막으려고, 그 전에 키를 옮긴다.
 *
 *  열린 Dispatch 가 없으면 `ok(state, null)` 이다. 롤된 세션이 워커가 아닌 것은 흔한 경우이고
 *  (사용자 탭 세션이 그렇다), closeDispatch 가 같은 상황에 같은 답을 낸다. */
export function rekeyDispatch(
  s: OrchState,
  a: { oldSessionId: string; newSessionId: string; accountId: string },
  now: string
): Res<Dispatch | null> {
  const dispatch = s.dispatches.find((d) => d.sessionId === a.oldSessionId && !d.endedAt)
  if (!dispatch) return ok(s, null)
  // openDispatch 의 sessionId 검사와 같은 것이다 — 같은 세션 id 를 쓰는 열린 Dispatch 가 둘이면
  // closeDispatch 가 어느 것을 닫을지 알 수 없게 된다. 자기 자신은 뺀다(두 id 가 같게 불린 경우).
  const taken = s.dispatches.find(
    (d) => d.sessionId === a.newSessionId && !d.outcome && !d.endedAt && d.id !== dispatch.id
  )
  if (taken) return err(`sessionId already in use by an open dispatch: ${taken.id}`)
  const next: Dispatch = { ...dispatch, sessionId: a.newSessionId, accountId: a.accountId }
  const task = s.tasks.find((t) => t.id === dispatch.taskId)
  return ok(
    {
      ...s,
      dispatches: replace(s.dispatches, next),
      // Task 가 없는 Dispatch 는 손으로 고친 orchestration.json 에서만 나올 수 있다. 그 경우
      // 재키잉 자체는 성공시킨다 — 워커의 보고 경로를 지키는 것이 이 함수의 일이고, 그것은 Task
      // 없이도 유효하다.
      tasks: task ? replace(s.tasks, { ...task, updatedAt: now }) : s.tasks
    },
    next
  )
}

/** 정지 시점 스냅샷을 열린 Dispatch 에 남긴다. **Task 도 Dispatch 의 종료 상태도 건드리지 않는다** —
 *  이것은 관측 기록이고, 무엇이 일어났는지에 대한 주장이 아니다.
 *
 *  열린 Dispatch 가 없으면 `ok(state, null)` 이다(`closeDispatch`·`rekeyDispatch` 와 같은 관례).
 *  두 번째 정지는 덮어쓴다 — Checkpoint 가 필요한 기준점은 **마지막** 정지의 것이다. 무엇이
 *  "두 번째 정지" 인지 가르는 것은 이 함수가 아니라 부르는 쪽이다(main/orchestration/rollTap.ts):
 *  한 번의 정지는 롤 상태를 여러 번 게시하므로, 그 안에서 이 함수를 다시 부르면 기준점이 정지
 *  시점에서 재개 직전으로 밀려 worktreeMoved 가 아무것도 판정하지 못한다. */
export function recordStopSnapshot(
  s: OrchState,
  a: {
    sessionId: string
    headCommit: string | null
    reason: 'waiting' | 'switching'
    resetsAt?: string
  },
  now: string
): Res<Dispatch | null> {
  const dispatch = s.dispatches.find((d) => d.sessionId === a.sessionId && !d.endedAt)
  if (!dispatch) return ok(s, null)
  // 스냅샷은 덮어쓰고(조립기가 직전 정지만 읽는다) 이력은 쌓는다 — 두 값이 답하는 질문이 다르다.
  //
  // **마지막 항목이 아직 열려 있어도 새 항목을 쌓는다.** 한동안은 그 경우 쌓지 않았다. 그 가드가
  // 막으려던 것(한 번의 정지가 롤 상태를 여러 번 게시하는 것)은 부르는 쪽에서 이미 걸러지고
  // (main/orchestration/rollTap.ts 의 세션별 표식), 가드가 만든 해악이 더 컸다: 재개 없이 끝난
  // 에피소드가 하나라도 있으면 **그 뒤의 진짜 정지가 아무것도 남기지 못하고** — 리셋 시각이 화면까지
  // 오지 못한다 — 다음 재개가 몇 시간 전의 항목을 닫아, 타임라인이 그 사이의 실제 작업 시간을 통째로
  // 한 번의 정지 구간으로 그리고 횟수도 둘이 아니라 하나로 읽힌다. 열린 항목을 그대로 두고 새로
  // 쌓는 것이 정직한 모양이다 — 그러면 타임라인은 "끝내 이어지지 않은 정지" 를 그리고, 그것이 실제로
  // 일어난 일이다. 투영은 **마지막** 항목만 살아 있는 것으로 보고 횟수는 닫힌 항목만 센다
  // (core/orchestration/view.ts 의 jobTaskOf).
  const resumes = [
    ...(dispatch.resumes ?? []),
    {
      stoppedAt: now,
      reason: a.reason,
      ...(a.resetsAt !== undefined ? { resetsAt: a.resetsAt } : {}),
      fromAccountId: dispatch.accountId
    }
  ]
  const next: Dispatch = {
    ...dispatch,
    stopSnapshot: {
      headCommit: a.headCommit,
      reason: a.reason,
      ...(a.resetsAt !== undefined ? { resetsAt: a.resetsAt } : {})
    },
    resumes
  }
  const task = s.tasks.find((t) => t.id === dispatch.taskId)
  return ok(
    {
      ...s,
      dispatches: replace(s.dispatches, next),
      tasks: task ? replace(s.tasks, { ...task, updatedAt: now }) : s.tasks
    },
    next
  )
}

/** 정지 스냅샷의 `headCommit` 을 뒤늦게 채운다. **정지 자체는 이미 기록돼 있다** — 이 함수는 그때
 *  비워 둔 칸 하나만 메운다. 왜 두 걸음으로 나눠 기록하는지는 부르는 쪽에 적었다
 *  (main/orchestration/rollTap.ts 의 recordStop): HEAD 를 읽는 것은 프로세스 하나를 띄우는 일이고,
 *  그것을 기다리는 사이에 롤이 Dispatch 의 세션 id 를 바꿔 치운다.
 *
 *  **세션 id 가 아니라 Dispatch id 로 찾는 이유가 바로 그것이다.** 재키잉을 지나도 Dispatch id 는
 *  같다(`rekeyDispatch` 는 sessionId·accountId 만 고쳐 쓴다).
 *
 *  **비워 둔 칸만 메운다.** 이미 값이 있으면 그 사이 다음 정지가 스냅샷을 덮어썼다는 뜻이고, 그
 *  자리에 옛 HEAD 를 써 넣으면 기준점이 거짓이 된다 — worktreeMoved 가 "바뀌지 않았다" 를 확인하지
 *  않은 채 단정하는, 스냅샷이 막으려는 바로 그 결말이다. Task 의 updatedAt 도 올리지 않는다: 이 값은
 *  화면에 그리는 것이 아니라 Checkpoint 조립기만 읽고(checkpoint.ts 의 worktreeMoved), 정지 자체는
 *  이미 앞 걸음이 알렸다. */
export function recordStopHead(
  s: OrchState,
  a: { dispatchId: string; headCommit: string }
): Res<Dispatch | null> {
  const dispatch = s.dispatches.find((d) => d.id === a.dispatchId && !d.endedAt)
  if (!dispatch?.stopSnapshot || dispatch.stopSnapshot.headCommit !== null) return ok(s, null)
  const next: Dispatch = {
    ...dispatch,
    stopSnapshot: { ...dispatch.stopSnapshot, headCommit: a.headCommit }
  }
  return ok({ ...s, dispatches: replace(s.dispatches, next) }, next)
}

/** 재개가 일어났다고 이력의 마지막 항목을 닫는다.
 *
 *  **정지가 기록돼 있지 않으면 아무것도 하지 않는다.** 항목을 지어내면 화면이 "0 번 멈추고 1 번
 *  이어졌다" 를 그린다. 사용자 탭 세션(열린 Dispatch 가 없다)도 같은 이유로 조용히 넘어간다 —
 *  `recordStopSnapshot` 과 같은 관례다.
 *
 *  **계정이 같아도 재개다.** claude 의 계정 하나짜리와 codex 의 제자리 재개는 세션 id 가 바뀌지 않아
 *  `rekeyDispatch` 를 타지 않으므로, 그 경로는 `'nudged'` 로 여기 온다(rollTap.ts). */
export function recordResume(
  s: OrchState,
  a: { sessionId: string; accountId: string },
  now: string
): Res<Dispatch | null> {
  const dispatch = s.dispatches.find((d) => d.sessionId === a.sessionId && !d.endedAt)
  if (!dispatch) return ok(s, null)
  const held = dispatch.resumes ?? []
  const last = held[held.length - 1]
  if (!last || last.resumedAt !== undefined) return ok(s, null)
  const next: Dispatch = {
    ...dispatch,
    resumes: [...held.slice(0, -1), { ...last, resumedAt: now, toAccountId: a.accountId }]
  }
  const task = s.tasks.find((t) => t.id === dispatch.taskId)
  return ok(
    {
      ...s,
      dispatches: replace(s.dispatches, next),
      tasks: task ? replace(s.tasks, { ...task, updatedAt: now }) : s.tasks
    },
    next
  )
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

/** 그 Run 들과 그것에 딸린 모든 것을 지운다. 되돌릴 수 없다.
 *
 *  **두 곳이 이 함수를 쓴다** — 사람이 사이드바에서 물러나게 하는 `run-delete`, 그리고 store 의 TTL
 *  prune(끝난 Run 이 30일 지나면 버린다). 그 규칙은 store.ts 안에만 있어서 테스트가 닿지 않았고,
 *  두 벌로 자라면 한쪽만 고쳐지는 날 사람이 지운 Run 의 잔해가 남거나 그 반대가 된다.
 *
 *  **Dispatch 만 간접적이다.** Dispatch 는 runId 를 들고 있지 않고 taskId 로만 그 Run 에 매이므로,
 *  남은 Task 로 걸러야 한다. 이것을 놓치면 지워진 Task 를 가리키는 고아 Dispatch 가 남고, 그것은
 *  view.ts 의 jobTaskOf 가 절대 찾지 못하는(그래서 화면에 안 나오는) 채로 상태 파일에 산다.
 *
 *  **도는 워커가 있는지는 여기서 보지 않는다.** 그 판정은 부르는 쪽의 것이다 — server.ts 의
 *  `run-delete` 가 열린 Dispatch 를 세어 거절하고(reset 이 같은 판정을 한다), TTL prune 은 애초에
 *  모든 Task 가 terminal 인 Run 만 고른다. 순수 층에 그 검사를 두면 TTL 쪽이 두 번 검사하게 된다. */
export function deleteRuns(s: OrchState, runIds: ReadonlySet<string>): OrchState {
  if (runIds.size === 0) return s
  const tasks = s.tasks.filter((t) => !runIds.has(t.runId))
  const keptTaskIds = new Set(tasks.map((t) => t.id))
  return {
    runs: s.runs.filter((r) => !runIds.has(r.id)),
    tasks,
    dispatches: s.dispatches.filter((d) => keptTaskIds.has(d.taskId)),
    messages: s.messages.filter((m) => !runIds.has(m.runId)),
    deliveries: s.deliveries.filter((d) => !runIds.has(d.runId)),
    gates: s.gates.filter((g) => !runIds.has(g.runId))
  }
}
