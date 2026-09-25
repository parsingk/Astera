// Pure operations on OrchState. The server and CLI are thin shells over these functions.
// Every function returns a new state instead of mutating — so tests can assert on arrays directly.
import {
  DELIVERY_MAX,
  FAILURE_LIMIT,
  canTransition,
  newId,
  placeholderSessionId,
  recomputeReady,
  type CheckResult,
  type ConvergencePolicy,
  type Delivery,
  type Dispatch,
  type Gate,
  type GateKind,
  type Message,
  type MessageType,
  type Outcome,
  type RepairReason,
  type Project,
  type Job,
  type JobRun,
  type Task
} from './types'
import type { Provider } from '../providers/meta'
import type { ScheduleRule } from '../scheduler/rule'
import { t, type Lang } from '../i18n'
import {
  appendHistory,
  checkConfigIdsOf,
  latestImplDispatch,
  policyOf,
  repairCountOf,
  timeBudgetExceeded,
  reviewRoundOf,
  unstableChecks,
  type ResolvedPolicy
} from './convergence'
import { normalizeIssues, type ReviewIssueInput } from './review'

export interface OrchState {
  /** 계획. 설계 §4 — 여기 있는 것이 "무엇을 시킬 것인가" 이고, 아래 runs 가 "실제로 돈 것" 이다. */
  jobs: Job[]
  runs: JobRun[]
  tasks: Task[]
  dispatches: Dispatch[]
  messages: Message[]
  deliveries: Delivery[]
  gates: Gate[]
  /** The registered repositories. Here rather than in a file of its own so one write, one recovery
   *  policy and one snapshot cover both a Job and the project it belongs to — the public CLI reads
   *  them together and must not see them disagree. Operations on it live in ./projects.ts, which
   *  compares paths and so cannot be in this web-safe module. */
  projects: Project[]
}

export const emptyState = (): OrchState => ({
  jobs: [],
  runs: [],
  tasks: [],
  dispatches: [],
  messages: [],
  deliveries: [],
  gates: [],
  projects: []
})

/** `missing` marks the refusal that means **the id the caller named is not there** — set where the
 *  refusal is made (`gone` below), so a caller can answer it 404 without reading it off the words.
 *  Only the refusals a command hands straight to its caller carry it; `commit()` in command.ts still
 *  decides the rest by their `unknown …` prefix. */
export type Res<T> =
  | { ok: true; state: OrchState; value: T }
  | { ok: false; error: string; missing?: true }

/**
 * 이 Task 가 속한 회차의 id.
 *
 * **정의 Task 는 이 함수가 불리는 자리에 오지 않는다.** 정의는 배치되지도, 검증되지도, 검토되지도,
 * 보고되지도 않는다 — startJobRun 이 회차를 시작할 때 베껴 가는 것이 정의가 쓰이는 전부다. 그래서
 * 아래의 모든 호출부는 이미 인스턴스를 들고 있다.
 *
 * 그래도 타입이 optional 인 것은 두 소유가 한 배열에 섞이기 때문이고(Task.runId 의 주석), 이 함수는
 * 그 간극을 한 자리에 모아 둔다. 없으면 빈 문자열을 준다 — **어떤 회차와도 매치되지 않는 값**이라,
 * 있어서는 안 될 정의가 여기까지 왔을 때 남의 회차에 붙는 대신 아무 데도 붙지 않는다.
 */
export const runIdOf = (t: Task): string => t.runId ?? ''

/** 이 회차가 실행하고 있는 계획. 회차를 들고 목표·cwd·동시 실행 수 같은 **계획의 값**을 물을 때
 *  쓴다 — 그 값들은 회차마다 달라지지 않으므로 회차에 복사해 두지 않는다(설계 §4). */
/** 이 Task 가 멈춘 것 아래에 있는가 — **회차가 세워졌거나, 그 계획이 세워졌거나.**
 *  일시 중지는 계획에 걸리고 그 순간 그 계획의 회차에도 붙는다(pauseSchedule). 둘 중 하나만 보면
 *  손으로 고친 파일이나 나중에 생긴 회차에서 판정이 갈린다. */
export function pausedForTask(s: OrchState, task: Pick<Task, 'runId'>): boolean {
  const run = s.runs.find((r) => r.id === task.runId)
  if (run === undefined) return false
  return run.paused === true || jobOf(s, run)?.paused === true
}

export const jobOf = (s: OrchState, run: JobRun): Job | undefined =>
  s.jobs.find((j) => j.id === run.jobId)

/**
 * **이 Task 의 회차에 앱이 지금 일을 새로 얹어도 되는가 — 아니면 `true`.**
 *
 * 세 소비자가 같은 물음을 묻는다: 복구 화해기의 `candidates`(잃어버린 워커를 다시 띄울까),
 * `interruptedResumes`(끊긴 검증·검토를 다시 돌릴까), 그리고 `startReview`(검토자를 띄울까).
 * 셋 다 "세션을 새로 띄운다" 는 같은 일을 하므로 답이 갈리면 안 된다 — 같은 조건이 세 벌로
 * 흩어져 있었고, 그중 하나만 고쳐지는 것이 이 함수가 존재하는 이유다.
 *
 * 네 갈래다. **회차나 계획을 찾을 수 없으면** 붙잡는다 — orchestration.json 은 프로세스보다 오래
 * 살고 손으로 고쳐지므로, 주인을 모르는 Task 에 워커를 띄우는 것은 아무도 책임지지 않는 지출이다.
 * 정의 Task 도 이 갈래로 걸린다: 그것은 `jobId` 만 들고 `runId` 가 없으므로(`task-create` 가 Job 을
 * 지목받았을 때) 위 조회가 회차를 찾지 못한다.
 * **`run.paused`·`job.paused`** 는 사람이 세운 것이고(`runs stop`·`pauseSchedule`), **`pendingStart`**
 * 는 아직 시작하지 않은 초안이다.
 *
 * **`job.schedule !== undefined` 가 실제로 거르는 것은 발화가 만든 자식 회차다**(ruling F65). 템플릿
 * 자신이 아니다 — 템플릿의 Task 는 바로 위 "회차를 찾을 수 없다" 에서 이미 걸린다. 자식 회차는
 * `jobId` 가 여전히 템플릿 Job 이므로 여기 `job` 이 그 템플릿이고, 이 줄이 그것을 붙잡는다.
 *
 * **오늘 그 줄은 아무것도 바꾸지 않는다.** `run-create` 가 예약이 있으면 `autoDispatch` 를 켜지
 * 않고(`command.ts`), `appDriven` 이 그것을 요구하므로 예약의 회차는 애초에 앱이 배치하지 않는다 —
 * 그래서 이 세 소비자에 닿는 예약 Task 가 없다. 의미를 바꾸지 않고 줄을 남겨 둔 이유는 그것이다:
 * 아무도 지나지 않는 길에서 방금 하나로 모은 셋을 다시 갈라 놓는 값이 더 크다.
 *
 * **예약 Job 이 언젠가 `autoDispatch` 를 갖게 되면 이 줄이 살아난다**, 그리고 그때 `refuseIfRunGated`
 * 가 여는 Gate 문구("paused, a schedule template, or not yet started")는 자식 회차에 대해 거짓이
 * 된다 — 그 회차는 템플릿이 아니라 템플릿이 만든 회차다. 그 변경을 하는 사람이 이 사실을 만나도록
 * `command.ts` 의 `autoDispatch` 를 켜는 자리에도 같은 말을 적어 두었다.
 *
 * **`schedule.ts` 의 `appDriven` 은 이것과 다른 물음이라 합치지 않았다.** 그쪽은 "이 회차를 누가
 * 운전하는가" 를 묻는다 — `autoDispatch` 를 요구하고(코디네이터가 끄는 회차는 앱이 배치하지
 * 않는다), `job.schedule` 은 **보지 않는다**. 두 조건이 겹치는 것은 우연이 아니라 둘 다 "사람이
 * 세운 것" 을 존중하기 때문이고, 다른 두 칸이 그 둘을 갈라 놓는다.
 */
export function runGatedForTask(s: OrchState, task: Pick<Task, 'runId'>): boolean {
  const run = s.runs.find((r) => r.id === task.runId)
  const job = run && jobOf(s, run)
  if (!run || !job) return true
  return (
    run.paused === true ||
    job.paused === true ||
    job.schedule !== undefined ||
    job.pendingStart === true
  )
}

/**
 * 화면이 건네는 id 를 **회차 id 로** 푼다.
 *
 * Jobs 목록의 Job 줄은 Job 의 id 를 싣고(view.ts 의 rowFor), 펼쳐진 회차 줄은 회차의 id 를 싣는다.
 * 그런데 상세(타임라인·그래프·완료 기록)는 언제나 한 회차의 것이다 — Job 을 지목받으면 그 계획의
 * **가장 최근 회차**를 뜻한다. 아직 한 번도 돌지 않은 Job 이면 답이 없다.
 */
export function resolveRunId(s: OrchState, id: string): string | undefined {
  if (s.runs.some((r) => r.id === id)) return id
  if (!s.jobs.some((j) => j.id === id)) return undefined
  return s.runs
    .filter((r) => r.jobId === id)
    .sort((a, b) => a.ordinal - b.ordinal)
    .at(-1)?.id
}

/** 같은 질문을 회차 id 로. 회차를 이미 찾아 둔 자리가 아니면 이쪽이 짧다. */
export function jobOfRunId(s: OrchState, runId: string): Job | undefined {
  const run = s.runs.find((r) => r.id === runId)
  return run ? jobOf(s, run) : undefined
}

const ok = <T>(state: OrchState, value: T): Res<T> => ({ ok: true, state, value })
const err = <T>(error: string): Res<T> => ({ ok: false, error })
/** A refusal because the id the caller named does not exist (Res's `missing`). */
const gone = <T>(error: string): Res<T> => ({ ok: false, error, missing: true })

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

/** 계획을 만든다. **회차는 만들지 않는다** — 회차가 없는 Job 이 "아직 실행을 안 눌렀다" 이고,
 *  그래서 pendingStart 라는 칸이 없어졌다(설계 §4). 부르는 쪽이 이어서 startJobRun 을 부르면
 *  1회차가 생긴다. */
export function createJob(
  s: OrchState,
  a: {
    objective: string
    cwd: string
    /** 이 Job 이 속한 프로젝트. **여기서 확인하지 않는다** — 등록은 앱의 것이고(ipc.ts 의
     *  orch.list 가 활성 탭의 폴더를 저장소로 되돌려 등록한다), 부르는 쪽이 그 id 를 준다.
     *  coordinatorAccountId 와 같은 관례다. */
    projectId?: string
    concurrency?: number
    /** 이 Run 의 코디네이터 세션을 띄울 계정. **여기서 확인하지 않는다** — 계정 목록은 앱이
     *  아는 것이고, 부르는 쪽(server.ts 의 run-create)이 실재하는 계정인지 본다.
     *  Task.accountIds 와 같은 관례다. */
    coordinatorAccountId?: string
    autoDispatch?: boolean
    /** 사용자가 '실행' 을 누르기 전까지 아무것도 시작하지 않게 한다 — Job.pendingStart 의 주석 */
    pendingStart?: boolean
    /** 있으면 이 Job 은 예약이다 — Job.schedule 의 주석을 보라. 규칙의 유효성은 부르는
     *  쪽(server.ts 의 run-create)이 isValidRule 로 본다, 계정 목록과 같은 관례다 */
    schedule?: ScheduleRule
    /** 완료 수렴 정책. 있으면 이 Job 의 검증·검토 실패는 앱이 repair 로 되돌린다(설계 D2·D12) */
    convergence?: ConvergencePolicy
  },
  now: string
): Res<Job> {
  if (!a.objective.trim()) return err('objective is required')
  const job: Job = {
    id: newId('job'),
    objective: a.objective,
    cwd: a.cwd,
    // 빈 문자열은 싣지 않는다 — coordinatorAccountId 아래 줄과 같은 이유다: 없는 것과 값이
    // 갈라져야 runsForProject 가 옛 Job 에만 경로 유도를 쓴다
    ...(a.projectId ? { projectId: a.projectId } : {}),
    createdAt: now,
    ...(a.concurrency !== undefined ? { concurrency: a.concurrency } : {}),
    // 빈 문자열은 싣지 않는다 — "지정 없음" 과 값이 갈라지고, 그 구분으로 코디네이터를 띄울지
    // 정하기 때문이다
    ...(a.coordinatorAccountId ? { coordinatorAccountId: a.coordinatorAccountId } : {}),
    ...(a.autoDispatch ? { autoDispatch: true } : {}),
    ...(a.schedule ? { schedule: a.schedule } : {}),
    ...(a.pendingStart ? { pendingStart: true } : {}),
    ...(a.convergence ? { convergence: a.convergence } : {})
  }
  return ok({ ...s, jobs: [...s.jobs, job] }, job)
}

/**
 * 사람이 '실행' 을 눌렀다 — pendingStart 를 걷는다. 회차를 만드는 것은 부르는 쪽이 이어서 부르는
 * startJobRun 이고(예약 Job 은 부르지 않는다: 회차는 발화가 만든다), 이 함수는 게이트만 연다.
 *
 * **이미 걷힌 Job 에 다시 불러도 성공이다.** 버튼이 사라지기 전에 두 번 눌릴 수 있고, 그때 사람이
 * 손쓸 수 없는 실패 문구를 띄우는 것은 이 명령이 하려는 일과 무관하다 — 요청한 끝 상태는 이미
 * 그것이다.
 */
export function releaseJob(s: OrchState, jobId: string): Res<Job> {
  const job = s.jobs.find((j) => j.id === jobId)
  if (!job) return gone(`unknown job: ${jobId}`)
  if (!job.pendingStart) return ok(s, job)
  // pendingStart 를 **지운다** — false 로 두면 JSON 비교에서 "없음" 과 다른 값이 되고, 이 코드베이스는
  // 해당 없는 칸을 아예 두지 않는 관례다
  const { pendingStart: _drop, ...released } = job
  return ok({ ...s, jobs: s.jobs.map((j) => (j.id === jobId ? released : j)) }, released)
}

/**
 * 이 Job 의 다음 회차를 만든다 — JobRun 하나와 그 Task 사본들.
 *
 * **세 자리가 이 함수 하나를 부른다**: 사람이 '실행' 을 누를 때, 예약이 발화할 때, 끝난 Job 을
 * 다시 돌릴 때. 셋이 같은 일이라는 것이 이 분리로 얻은 것이다 — 예전에는 앞의 둘이 서로 다른
 * 함수였고(startRun 은 칸 하나를 걷었고 spawnScheduledRun 은 Run 을 복제했다) 셋째는 아예 없었다.
 *
 * **Task 를 어디서 베끼는가.** Job 에 정의가 있으면 그것을, 없으면 마지막 회차의 것을 베낀다.
 * 정의는 사람이 화면에서 짠 Task 이고(아직 회차가 없을 때 만든 것), 정의가 없는 Job 은 코디네이터가
 * 만든 것이다 — 그쪽은 회차 안에서 Task 를 만들어 가므로 베낄 것이 마지막 회차에 있다.
 *
 * **정의는 옮기고 결과는 옮기지 않는다.** result·filesModified·consecutiveFailures 를 물려주면
 * 지난 회차의 결과가 새 회차의 진행률과 회로 차단에 섞인다.
 *
 * **deps 와 parentId 는 새 id 로 다시 매핑한다.** 옛 id 를 그대로 두면 새 회차의 의존이 베껴 온
 * 자리의 Task 를 가리키는데, 그쪽은 이 회차에서 돌지 않으므로 영원히 completed 가 되지 않는다 —
 * 새 회차의 Task 전부가 pending 에 갇히고, graph.ts 는 그 의존을 회차 밖의 id 로 보게 된다. 표에
 * 없는 id(손으로 고친 값)는 떨어뜨린다: 무엇을 기다리는지 모르는 채로 두는 것보다 낫다.
 *
 * status 는 createTask 와 **같은 방식**으로 정한다 — 전부 pending 으로 만든 뒤 recomputeReady 에
 * 맡긴다. 그래야 "deps 없는 Task 가 ready" 라는 규칙이 한 곳에만 있다.
 */
export function startJobRun(s: OrchState, jobId: string, now: string): Res<JobRun> {
  const job = s.jobs.find((j) => j.id === jobId)
  if (!job) return gone(`unknown job: ${jobId}`)
  // 몇 번째 회차인가. **회차 개수가 아니라 Job 에 새긴 카운터에서 온다** — 개수로 세면 회차를
  // 지우거나 TTL 이 정리할 때 번호가 뒤로 간다(Job.fireCount 의 주석).
  const ordinal = (job.fireCount ?? 0) + 1
  const run: JobRun = {
    id: newId('run'),
    jobId,
    ordinal,
    createdAt: now
  }
  // createdAt 오름차순 — snapshotFor 가 쓰는 순서이고, 의존 사슬을 읽는 순서다
  const byCreated = (a: Task, b: Task): number => a.createdAt.localeCompare(b.createdAt)
  const defs = s.tasks.filter((t) => t.jobId === jobId).sort(byCreated)
  const previous = s.runs
    .filter((r) => r.jobId === jobId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1)
  const source =
    defs.length > 0
      ? defs
      : previous
        ? s.tasks.filter((t) => t.runId === previous.id).sort(byCreated)
        : []
  const idMap = new Map(source.map((t) => [t.id, newId('tsk')]))
  const copies: Task[] = source.map((t) => ({
    id: idMap.get(t.id)!,
    runId: run.id,
    title: t.title,
    spec: t.spec,
    deps: t.deps.map((d) => idMap.get(d)).filter((d): d is string => d !== undefined),
    ...(t.parentId !== undefined && idMap.has(t.parentId)
      ? { parentId: idMap.get(t.parentId)! }
      : {}),
    ...(t.accountIds !== undefined ? { accountIds: [...t.accountIds] } : {}),
    ...(t.validateConfigId !== undefined ? { validateConfigId: t.validateConfigId } : {}),
    ...(t.validateConfigIds?.length ? { validateConfigIds: [...t.validateConfigIds] } : {}),
    ...(t.reviewRequested ? { reviewRequested: true } : {}),
    status: 'pending',
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now
  }))
  return ok(
    {
      ...s,
      // Job 에서 움직이는 것은 이 카운터 하나다 — 정의 Task 는 계획이므로 손대면 다음 회차가 달라진다
      jobs: s.jobs.map((j) => (j.id === jobId ? { ...j, fireCount: ordinal } : j)),
      runs: [...s.runs, run],
      tasks: recomputeReady([...s.tasks, ...copies])
    },
    run
  )
}

/**
 * 인자로 아무것도 지목하지 않은 명령이 뜻하는 "지금 그 회차" — 가장 나중에 만들어진 JobRun.
 * 없으면 undefined 이고, 그때 부르는 쪽은 자기 "Run 이 없다" 오류를 낸다.
 *
 * **예전의 latestOrdinaryRun 이 하던 걸러내기가 없어졌다.** 그 함수는 한 배열에 섞인 템플릿·회차·
 * 보통 Run 중에서 "템플릿도 회차도 아닌 것" 을 골라야 했다. 이제 계획은 jobs 에 있고 이 배열에는
 * 회차만 있으므로, 고를 것이 없다 — 그 섞임이 코디네이터의 `check --wait` 를 방금 생긴 회차 앞에
 * 세워 두던 버그의 원인이었다.
 */
export function latestRun(s: OrchState): JobRun | undefined {
  return s.runs.at(-1)
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
export function pauseSchedule(s: OrchState, jobId: string, now: string): Res<Job> {
  const job = s.jobs.find((j) => j.id === jobId)
  if (!job) return err(`unknown job: ${jobId}`)
  if (!job.schedule) return err(`job is not scheduled: ${jobId}`)
  const runIds = new Set(s.runs.filter((r) => r.jobId === jobId).map((r) => r.id))
  const taskIds = new Set(
    s.tasks.filter((t) => t.runId !== undefined && runIds.has(t.runId)).map((t) => t.id)
  )
  const held: Job = { ...job, paused: true }
  return ok(
    {
      ...s,
      jobs: s.jobs.map((j) => (j.id === jobId ? held : j)),
      runs: s.runs.map((r) => (runIds.has(r.id) ? { ...r, paused: true } : r)),
      // 닫는 방식은 worker-stop 과 같다 — workerState 를 stopped 로, endedAt 을 찍는다. outcome 은
      // 넣지 않는다: 이 워커는 결과를 보고하지 않았고, 보고하지 않은 것을 성공이나 실패로 적으면
      // 그래프가 거짓말을 한다(재시작 정리가 그런 Dispatch 를 outcome_unknown 으로 읽는다).
      dispatches: s.dispatches.map((d) =>
        taskIds.has(d.taskId) && !d.outcome && !d.endedAt
          ? { ...d, workerState: 'stopped' as const, endedAt: now, closedBy: 'pause' as const }
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
export function resumeSchedule(s: OrchState, jobId: string): Res<Job> {
  const job = s.jobs.find((j) => j.id === jobId)
  if (!job) return err(`unknown job: ${jobId}`)
  if (!job.schedule) return err(`job is not scheduled: ${jobId}`)
  if (!job.paused) return ok(s, job)
  // paused 를 **지운다** — false 로 두면 JSON 비교에서 "없음" 과 다른 값이 되고, 이 코드베이스는
  // 해당 없는 칸을 아예 두지 않는 관례다
  const { paused: _drop, ...resumed } = job
  return ok({ ...s, jobs: s.jobs.map((j) => (j.id === jobId ? resumed : j)) }, resumed)
}

/**
 * 세워 둔 회차를 다시 돌게 한다 — `runs stop` 이 세운 것을 푼다.
 *
 * **`resumeSchedule` 과 다른 층이다.** 그쪽은 예약(계획)의 `paused` 를 걷고 예약이 아닌 Job 을
 * 거절한다. 이쪽은 회차 하나의 `paused` 를 걷으며, 예약이든 아니든 회차에는 다 있다. 둘을
 * 한 함수로 겸하게 하면 "예약이 아니다" 라는 거절이 보통 Job 의 회차를 푸는 길까지 막는다.
 *
 * paused 를 **지운다** — false 로 두면 JSON 비교에서 "없음" 과 다른 값이 되고, 이 코드베이스는
 * 해당 없는 칸을 아예 두지 않는 관례다(resumeSchedule 과 같다).
 */
export function resumeRun(s: OrchState, runId: string): Res<JobRun> {
  const run = s.runs.find((r) => r.id === runId)
  if (!run) return err(`unknown run: ${runId}`)
  if (!run.paused) return ok(s, run)
  const { paused: _drop, ...resumed } = run
  return ok({ ...s, runs: s.runs.map((r) => (r.id === runId ? resumed : r)) }, resumed)
}

export function setRunWorktree(s: OrchState, id: string, worktree: string): Res<JobRun> {
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
    /** 어느 회차의 Task 인가. **jobId 와 둘 중 하나만 준다** — 회차에 붙으면 인스턴스, 계획에
     *  붙으면 정의다(설계 §4.1). */
    runId?: string
    /** 어느 계획의 정의인가. 정의는 배치되지 않는다 — 회차가 시작될 때 베껴질 뿐이다. */
    jobId?: string
    title: string
    spec: string
    deps: string[]
    parentId?: string
    /** 이 Task 를 띄울 계정들, 순서대로. **여기서 확인하지 않는다** — 계정 목록은 core 가 아니라
     *  앱이 아는 것이고(schedule.ts 머리말과 같은 이유), 부르는 쪽(server.ts 의 task-create)이
     *  존재하는 계정인지, 서로 같은 provider 인지 보고 거절한다. validateConfigId 도 같은 관례다.
     *
     *  **비었는지도 여기서 보지 않는다.** 이 목록이 provider 의 출처이므로 만드는 두 자리가 모두
     *  하나 이상을 요구하지만(task-create, NewTaskModal), 그 요구도 계정을 아는 쪽의 몫이다 —
     *  core 는 계정 목록을 못 보므로 "하나 이상" 만 확인해도 그 하나가 실재하는지는 알 수 없고,
     *  반쪽 검사는 어느 쪽이 정본인지 흐린다. */
    accountIds?: string[]
    validateConfigId?: string
    validateConfigIds?: string[]
    reviewRequested?: boolean
  },
  now: string
): Res<Task> {
  // **둘 중 하나여야 한다.** 둘 다 주면 어느 쪽이 소유자인지 코드마다 달라지고, 그 모호함이 이
  // 분리가 없애려던 바로 그것이다.
  if ((a.runId === undefined) === (a.jobId === undefined))
    return err('exactly one of runId or jobId is required')
  if (a.runId !== undefined && !s.runs.some((r) => r.id === a.runId))
    return err(`unknown run: ${a.runId}`)
  if (a.jobId !== undefined && !s.jobs.some((j) => j.id === a.jobId))
    return err(`unknown job: ${a.jobId}`)
  if (!a.spec.trim()) return err('spec is required')
  const known = new Set(s.tasks.map((t) => t.id))
  const missing = a.deps.filter((d) => !known.has(d))
  if (missing.length) return err(`unknown deps: ${missing.join(',')}`)
  if (a.parentId && !known.has(a.parentId)) return err(`unknown parent: ${a.parentId}`)
  const task: Task = {
    id: newId('tsk'),
    // 없는 칸은 싣지 않는다 — 소유가 둘 중 하나라는 것이 값으로도 보여야 한다
    ...(a.runId !== undefined ? { runId: a.runId } : {}),
    ...(a.jobId !== undefined ? { jobId: a.jobId } : {}),
    title: a.title,
    spec: a.spec,
    deps: a.deps,
    parentId: a.parentId,
    // 빈 배열은 **지정 없음**이다 — 그것도 실으면 Task 를 값으로 비교하는 자리에서 지정이 없는
    // Task 와 갈라진다(조건부 전개를 쓰는 이유 그대로).
    ...(a.accountIds?.length ? { accountIds: a.accountIds } : {}),
    ...(a.validateConfigId ? { validateConfigId: a.validateConfigId } : {}),
    ...(a.validateConfigIds?.length ? { validateConfigIds: a.validateConfigIds } : {}),
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
    repair?: RepairReason
    /** 소진 Gate 의 retry-once 만 쓴다 — 사람이 "한 번 더" 라고 말한 자리이고, 그 한 번은
     *  예산 밖이다(설계 §5.2). 그 밖의 모든 호출은 회로를 그대로 본다. */
    ignoreCircuit?: boolean
  },
  now: string
): Res<Dispatch> {
  const task = s.tasks.find((t) => t.id === a.taskId)
  if (!task) return gone(`unknown task: ${a.taskId}`)
  if (task.status === 'blocked') return err('task is blocked by an open gate')
  // validating·reviewing 은 판정을 기다리는 중이다 — moveTask/canTransition 만으로는 이제 이것을
  // 막지 못한다: ALLOWED.validating·ALLOWED.reviewing 이 'dispatched' 를 허용하는 것은
  // openRepairDispatch(그 판정이 도착한 뒤에만 여는 문) 하나를 위해서이지, 이 문(worker-start 가
  // 쓰는 바로 그 openDispatch) 을 위해서가 아니다. 여기서 명시적으로 거절하지 않으면 코디네이터가
  // 앱이 검사하는 중인 Task 에 두 번째 워커를 얹을 수 있다 — 설계의 코디네이터-격리 논거 전체가
  // 이 거절 하나에 서 있다. convergence 가 없는 Run 도 예외가 아니다: validating·reviewing 은 그
  // Run 에도 있고(검증·검토 기능 자체는 D12 이전부터 있었다), 그 Run 에서도 판정을 기다리는 동안
  // 두 번째 워커가 뜨면 안 된다.
  if (task.status === 'validating' || task.status === 'reviewing')
    return err(`task is awaiting a verdict: ${task.status}`)
  if (!a.ignoreCircuit && task.consecutiveFailures >= FAILURE_LIMIT)
    return err(`circuit break: ${FAILURE_LIMIT} consecutive failures`)
  // An open dispatch is rejected unconditionally even with retryOf — retryOf has to mean "the
  // previous attempt already finished", and an open dispatch breaks that premise by itself. This
  // used to filter on `open && !a.retryOf`, so just attaching retryOf bypassed the whole check.
  const open = s.dispatches.find((d) => d.taskId === a.taskId && !d.outcome && !d.endedAt)
  if (open) return err(`dispatch already open: ${open.id}`)
  if (a.retryOf) {
    const prior = s.dispatches.find((d) => d.id === a.retryOf)
    if (!prior) return gone(`unknown retryOf dispatch: ${a.retryOf}`)
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
    retained: false,
    ...(a.repair ? { repair: a.repair } : {}),
    // 열 때 한 번만 적는다 — 나중에 카운트로 되짚지 않는다(Dispatch.grantedExtra 의 주석, 전체 브랜치
    // 리뷰 Finding 3).
    ...(a.ignoreCircuit ? { grantedExtra: true } : {})
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
  if (!dispatch) return gone(`unknown dispatch: ${a.dispatchId}`)
  if (dispatch.taskId !== a.taskId) return err('taskId does not match dispatch')
  // Looking at outcome alone does not filter out a stale dispatch that closeDispatch closed (only
  // endedAt, no outcome) — that was the defect where a worker_done arriving late, after the session
  // had ended, hijacked the Task's terminal state.
  if (dispatch.outcome || dispatch.endedAt) return ok(s, 'alreadyReported')
  const task = s.tasks.find((t) => t.id === a.taskId)
  if (!task) return gone(`unknown task: ${a.taskId}`)
  const run = s.runs.find((r) => r.id === task.runId)
  if (!run) return err(`unknown run for task: ${a.taskId}`)

  // 검증이 걸린 Task 는 성공 보고만으로 끝나지 않는다 — 실제로 돌려 본 결과가 정한다.
  // 워커가 실패를 보고했으면 검증하지 않는다. 워커 자신이 안 됐다고 하는데 확인할 이유가 없다.
  // canValidate === false 는 검증기가 없는 배선이다 — 그때는 검증이 없는 Task 와 똑같이 다룬다.
  // checkConfigIdsOf 는 옛 validateConfigId 와 새 validateConfigIds 를 함께 본다 — 둘 중 하나만
  // 있어도 검증이 걸린 Task 다.
  const validating =
    a.outcome === 'succeeded' && checkConfigIdsOf(task).length > 0 && a.canValidate !== false
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
    // 처음 validating 이 되는 순간이 시간 예산의 시작이다(설계 G2). 여기와 beginValidation 둘이
    // validating 으로 가는 전부다.
    ...(validating ? withConvergenceClock(moved, now) : moved),
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

/** 검증 결과를 Task 에 반영한다. check 별 결과가 판정이다.
 *
 *  **convergence 가 없는 Run 도 문구는 지금까지와 같다**(설계 §5.3): 실패는 failed 가 되고 consecutiveFailures
 *  가 오르며 status 메시지가 코디네이터에게 --retry-of 를 말한다. 그 문구가 결과를 전하는 유일한 길인
 *  이유는 코디네이터를 깨우는 수단이 메시지뿐이고, 재시도 워커의 spec 파일은 결과를 싣지 않기 때문이다.
 *
 *  **모든 Run 이 `Task.checks`·`checkHistory` 를 기록한다 — convergence 가 없어도**(UI 설계 U2; 이 브랜치의
 *  첫 커밋이 Plan 1 설계 §18 의 "수렴 Run 에만 기록" 판정을 뒤집은 자리다). `--validate` 만 쓰는 기존 Run 의
 *  화면도 어느 검사가 깨졌는지 이름을 대야 하고, 그 정보가 상태에 없으면 노드도 사이드바도 그릴 수 없다.
 *  이 자리에서 실제로 지키는 호환은 둘뿐이다 — status 메시지의 문구(위 문단), 그리고 통과한 검사의
 *  `outputTail` 을 싣지 않는 것(툴팁에 쓸모없고 용량의 대부분이다 — recorded 를 만드는 아래 자리의 주석).
 *
 *  **convergence 가 있는 Run 에서는 실패가 repair 를 연다**(설계 §5.1): 같은 쓰기에서 Task 가 dispatched 로
 *  가고 repair Dispatch 가 열린다. failed 를 경유하지 않는다 — Task 하나인 Run 이 순간 failed 가 되어
 *  JOB_RUN_FAILED 가 Journal 에 박히기 때문이다(D5). 예산이 다했거나 사람이 멈췼으면 Gate 다. */
export function applyValidationResult(
  s: OrchState,
  a: {
    taskId: string
    /** 순서대로. 첫 실패 뒤의 것은 not-run 이다(validator.ts) */
    results: CheckResult[]
    /** applyWorkerDone 의 canReview 와 같은 판정이다 — 배선이 검토기를 주입하지 않았으면 서버가 false 로 넘긴다 */
    canReview?: boolean
    /** convergence Run 에서 필수. 없으면 거절한다 — 조용히 옛 경로로 떨어지지 않는다 */
    repair?: RepairTarget
    /** Gate 질문의 언어. 배선이 앱 언어를 넘긴다; 순수 호출자는 생략하면 영어다 */
    lang?: Lang
  },
  now: string
): Res<Task> {
  const task = s.tasks.find((x) => x.id === a.taskId)
  if (!task) return err(`unknown task: ${a.taskId}`)
  if (task.status !== 'validating') return err(`task is not validating: ${task.status}`)
  const lang: Lang = a.lang ?? 'en'
  const passed = a.results.every((r) => r.status === 'passed')
  const policy = policyOf(s, task)
  const total = a.results.length
  const ran = a.results.filter((r) => r.status !== 'not-run').length
  const failedNames = a.results.filter((r) => r.status !== 'passed' && r.status !== 'not-run').map((r) => r.name)
  const firstFailed = a.results.find((r) => r.status !== 'passed' && r.status !== 'not-run')
  const exitCode = firstFailed?.exitCode ?? (passed ? 0 : 1)
  const output = firstFailed?.outputTail ?? a.results.map((r) => r.outputTail ?? '').join('\n')

  // 검증이 통과했어도 검토가 걸려 있으면 아직 끝난 것이 아니다. applyWorkerDone 과 같은 판단이고,
  // 여기에 없으면 검증이 걸린 Task 만 검토를 건너뛴다.
  const reviewing = passed && !!task.reviewRequested && a.canReview !== false

  // ---- 기록 — 정책이 있든 없든 ---- 화면이 어느 검사가 깨졌는지 그리려면 상태에 있어야 한다(UI 설계 U2; Plan 1
  // 설계 §18-11 이 "수렴 Run 에만 기록" 을 뒤집은 자리다). 통과한 검사의 outputTail 은 싣지 않는다: 툴팁에 쓸모없고
  // 용량의 대부분이다. **여기서 벗긴다, validator 가 아니라** — 아래 status 메시지의 body 는 a.results 에서 앞서
  // 계산한 output 을 그대로 실어 코디네이터가 읽던 문구가 바뀌지 않는다. checkHistory 는 판정('passed'|'failed')만
  // 들고 있어 손댈 것이 없다. 키를 아예 빼는 이유: undefined 값은 JSON 에 안 남지만 메모리의 Task 비교에 남는다.
  const history = appendHistory(task.checkHistory, a.results)
  const unstable = new Set(unstableChecks(history))
  const checks: CheckResult[] = a.results.map((r) => {
    const { outputTail, ...rest } = r
    const kept: CheckResult =
      r.status === 'passed' ? rest : { ...rest, ...(outputTail !== undefined ? { outputTail } : {}) }
    return unstable.has(r.configId) ? { ...kept, unstable: true } : kept
  })
  const recorded: Task = { ...task, checks, checkHistory: history }

  if (policy === null) {
    // ---- 지금까지의 경로. 문구까지 그대로다 ---- 달라진 것은 task 가 아니라 recorded 를 옮긴다는 것 하나다.
    const to = reviewing ? 'reviewing' : passed ? 'completed' : 'failed'
    const moved = moveTask(recorded, to, now)
    if (!moved) return err(`cannot move task ${task.status} -> ${to}`)
    const next: Task = {
      ...moved,
      consecutiveFailures: reviewing ? task.consecutiveFailures : passed ? 0 : task.consecutiveFailures + 1,
      ...(passed ? {} : { result: `validation failed (exit ${exitCode})\n${output}` })
    }
    let state: OrchState = { ...s, tasks: recomputeReady(replace(s.tasks, next)) }
    state = pushMessage(
      state,
      {
        runId: runIdOf(task),
        type: 'status',
        taskId: task.id,
        subject: passed ? 'validation passed' : 'validation failed',
        body: passed
          ? `exitCode=0. ${reviewing ? 'The Task moved to reviewing — a reviewer on another provider now reads it.' : 'The Task moved to completed.'}\n${output}`
          : `exitCode=${exitCode}. The Task moved to failed (consecutiveFailures=${next.consecutiveFailures}). Retry with worker-start --retry-of. The output tail below is the only record of what went wrong — a retry worker's spec file does not carry it, so pass on whatever it needs.\n${output}`
      },
      now
    ).state
    return ok(state, next)
  }

  // ---- convergence Run ---- 실패는 failed 를 거치지 않고 repair 로 간다(설계 §5.1).
  if (passed) {
    const to = reviewing ? 'reviewing' : 'completed'
    const moved = moveTask(recorded, to, now)
    if (!moved) return err(`cannot move task ${task.status} -> ${to}`)
    const next: Task = { ...moved, consecutiveFailures: reviewing ? task.consecutiveFailures : 0 }
    let state: OrchState = { ...s, tasks: recomputeReady(replace(s.tasks, next)) }
    state = pushMessage(
      state,
      {
        runId: runIdOf(task),
        type: 'status',
        taskId: task.id,
        subject: `All ${total} checks passed`,
        body: `exitCode=0. ${reviewing ? 'The Task moved to reviewing — a reviewer on another provider now reads it.' : 'The Task moved to completed.'}`
      },
      now
    ).state
    return ok(state, next)
  }
  // repair 후보로 넘길 Task — 절대 'failed' 상태를 거치지 않는다(그것이 이 브랜치의 계약이다), 그래서
  // 이름도 그 상태를 닮지 않게 짓는다.
  const pendingRepair: Task = {
    ...recorded,
    consecutiveFailures: task.consecutiveFailures + 1,
    result: `validation failed (exit ${exitCode})\n${output}`
  }
  return routeFailure(
    s,
    {
      task: pendingRepair,
      policy,
      reason: 'check-failure',
      repair: a.repair,
      lang,
      message: {
        // failedNames 가 비면(예: 결과 전부가 not-run) 콜론 뒤에 구멍이 남지 않게 문구를 가른다 —
        // 오늘의 validator 로는 닿지 않지만 CheckResult[] 를 직접 짜는 다른 호출자는 닿을 수 있다.
        subject:
          failedNames.length > 0
            ? `Checks failed: ${failedNames.join(', ')} (${ran} of ${total} ran)`
            : `Checks failed (${ran} of ${total} ran)`,
        detail: `exitCode=${exitCode}.`
      }
    },
    now
  )
}

/** 배선이 판정 직전에 정해 넘기는 "repair 를 어디에 열 것인가". **할지**는 순수 층이 정한다(정책·예산·
 *  멈춤), **어디에**는 배선이 안다(세션이 살아 있는가). same-session 은 그 세션에 fix 요청을 써넣고,
 *  fresh 는 새 워커를 띄운다 — 설계 D3·§6.2. */
export type RepairTarget =
  | { kind: 'same-session'; sessionId: string; cwd: string; provider: Provider; accountId: string }
  | { kind: 'fresh'; cwd: string; provider: Provider; accountId: string }

/** validating·reviewing 에서 repair Dispatch 를 여는 **유일한** 자리(설계 §5.1). openDispatch 와 다른 점:
 *  - Task 가 validating 또는 reviewing 이어야 한다 — 판정이 도착한 뒤다.
 *  - 예산을 보지 않는다. 예산은 부르는 판정 함수가 consecutiveFailures 로 이미 정했고, 규칙이 두 곳에
 *    있으면 갈라진다. FAILURE_LIMIT 회로도 보지 않는다 — 그것은 코디네이터 재시도의 예산이다.
 *  - retryOf 는 마지막 구현·수리 Dispatch 다. 같은 sessionId 검사는 그대로다: 이전 Dispatch 는 닫혀 있으니
 *    통과하고, 닫히지 않았다면 거절이 맞다. */
export function openRepairDispatch(
  s: OrchState,
  a: { taskId: string; reason: RepairReason; target: RepairTarget },
  now: string
): Res<Dispatch> {
  const task = s.tasks.find((x) => x.id === a.taskId)
  if (!task) return err(`unknown task: ${a.taskId}`)
  if (task.status !== 'validating' && task.status !== 'reviewing')
    return err(`task is not awaiting a verdict: ${task.status}`)
  const open = s.dispatches.find((d) => d.taskId === a.taskId && !d.outcome && !d.endedAt)
  if (open) return err(`dispatch already open: ${open.id}`)
  const prior = latestImplDispatch(s, a.taskId)
  if (!prior) return err(`no implementation dispatch for task ${a.taskId}`)
  const sessionId = a.target.kind === 'same-session' ? a.target.sessionId : placeholderSessionId()
  const sessionOpen = s.dispatches.find((d) => d.sessionId === sessionId && !d.outcome && !d.endedAt)
  if (sessionOpen) return err(`sessionId already in use by an open dispatch: ${sessionOpen.id}`)
  const moved = moveTask(task, 'dispatched', now)
  if (!moved) return err(`cannot dispatch from status: ${task.status}`)
  const dispatch: Dispatch = {
    id: newId('dsp'),
    taskId: a.taskId,
    provider: a.target.provider,
    accountId: a.target.accountId,
    sessionId,
    cwd: a.target.cwd,
    specPath: '',
    retryOf: prior.id,
    startedAt: now,
    workerState: 'ready',
    retained: false,
    repair: a.reason
  }
  return ok({ ...s, tasks: replace(s.tasks, moved), dispatches: [...s.dispatches, dispatch] }, dispatch)
}

/** 소진·멈춤 Gate 의 "아직 실패" 요약 — check 이름과 blocking 이슈 제목을 한 줄로 */
function failureSummary(task: Task): string {
  const checks = (task.checks ?? []).filter((c) => c.status === 'failed' || c.status === 'timed-out').map((c) => c.name)
  const issues = (task.reviewIssues ?? []).filter((i) => i.blocking).map((i) => `${i.severity.toUpperCase()} ${i.title}`)
  return [...checks, ...issues].join(', ') || '(no record)'
}

/** 판정이 repair 대신 사람에게 가는 네 갈래를 한 함수로 — 소진, 멈춘 Task, 멈춘 Run, repair 를 열 수
 *  없음(세션 충돌 등, routeFailure 참고). consecutiveFailures 는 부르는 쪽이 이미 올렸다.
 *
 *  질문의 모양이 갈래마다 다르다 — 세 갈래는 "몇 번 고쳤고 무엇이 아직 실패하는가"({repairs},
 *  {failures}), 나머지 하나(repairFailed)는 "왜 못 열었는가"({reason})다. 그래서 `key` 로 그 둘을
 *  판별식 유니언으로 가른다: 쓰는 쪽이 엉뚱한 파라미터를 건네면 여기서 타입 오류가 난다. */
function gateOnFailure(
  s: OrchState,
  a: { task: Task; kind: GateKind; lang: Lang } & (
    | {
        key: 'jobs.convergence.gate.exhausted' | 'jobs.convergence.gate.stopped' | 'jobs.convergence.gate.paused'
        repairs: number
      }
    // 시간 소진만 분(minutes)을 더 쓴다 — "무엇을 넘겼나" 가 이 갈래의 이유 자체라서다
    | { key: 'jobs.convergence.gate.timeExhausted'; repairs: number; minutes: number }
    | { key: 'jobs.convergence.gate.repairFailed'; reason: string }
  ),
  now: string
): Res<Task> {
  const question =
    a.key === 'jobs.convergence.gate.repairFailed'
      ? t(a.lang, a.key, { reason: a.reason })
      : a.key === 'jobs.convergence.gate.timeExhausted'
        ? t(a.lang, a.key, { minutes: a.minutes, repairs: a.repairs, failures: failureSummary(a.task) })
        : t(a.lang, a.key, { repairs: a.repairs, failures: failureSummary(a.task) })
  const withTask: OrchState = { ...s, tasks: replace(s.tasks, a.task) }
  const g = createGate(
    withTask,
    { taskId: a.task.id, question, kind: a.kind, ...(a.kind === 'convergence-exhausted' ? { options: ['retry-once', 'mark-failed'] } : {}) },
    now
  )
  if (!g.ok) return err(g.error)
  return ok(g.state, g.state.tasks.find((x) => x.id === a.task.id)!)
}

/** 실패한 판정이 갈 길(설계 §5.1의 표). 위에서부터 첫 행이 이긴다. 통과가 아닌 결과를 받았을 때만 부른다.
 *  `task` 는 checks·history·consecutiveFailures(+1) 가 이미 반영된 것이다.
 *
 *  **repair Dispatch 를 열지 못해도, 열 대상 자체가 없어도 이 판정을 버리지 않는다.** 세션이 다른
 *  Task 에 재사용되는 경우(`--terminal`) 등으로 `openRepairDispatch` 가 거절하거나, 배선이 `repair`
 *  자체를 넘기지 않았을 때도(오늘의 배선은 항상 넘긴다 — §18(4)) checks·history·+1 이 실린 `task`
 *  를 그대로 Gate(convergence-blocked, jobs.convergence.gate.repairFailed)에 넘긴다 — 조용히
 *  버리면(err) Task 가 validating 에 갇힌 채 아무도 다시 보러 오지 않는다(전체 브랜치 리뷰,
 *  Finding 4). */
function routeFailure(
  s: OrchState,
  a: { task: Task; policy: ResolvedPolicy; reason: RepairReason; repair: RepairTarget | undefined; lang: Lang; message: { subject: string; detail: string } },
  now: string
): Res<Task> {
  const repairs = a.task.consecutiveFailures // k 번째 연속 실패 = k 번째 repair 후보
  if (a.task.convergenceOff)
    return gateOnFailure(s, { task: a.task, kind: 'convergence-blocked', key: 'jobs.convergence.gate.stopped', repairs, lang: a.lang }, now)
  if (pausedForTask(s, a.task))
    return gateOnFailure(s, { task: a.task, kind: 'convergence-blocked', key: 'jobs.convergence.gate.paused', repairs, lang: a.lang }, now)
  // **시간이 횟수보다 앞이다**(설계 G2). 둘 다 소진이지만 사람에게 보여 줄 이유가 다르고, 시간이
  // 넘었으면 횟수가 남아 있어도 새 수리를 열지 않는다. Gate 의 종류는 같다 — 사람이 고를 것("한 번
  // 더 수정" / "실패로 표시")이 같으므로 갈래를 하나 더 만들지 않는다.
  if (timeBudgetExceeded(a.task, a.policy, Date.parse(now)))
    return gateOnFailure(
      s,
      {
        task: a.task,
        kind: 'convergence-exhausted',
        key: 'jobs.convergence.gate.timeExhausted',
        repairs: repairCountOf(s, a.task.id),
        minutes: a.policy.maxTotalMinutes ?? 0,
        lang: a.lang
      },
      now
    )
  if (repairs > a.policy.maxFixAttempts)
    // repairs 는 이 실패까지의 "k 번째 연속 실패" 이고, k-1 개의 repair 만 실제로 열렸다(이번 것은
    // 예산 밖이라 열리지 않는다) — repairCountOf 로 실제로 연 repair 수를 센다. a.policy.maxFixAttempts
    // 를 그대로 쓰면 check 경로에서는 우연히 같은 값이지만 review 경로에서는 거짓말이 된다(라운드
    // 상한과 repair 예산이 서로 다른 수를 세기 때문).
    return gateOnFailure(s, { task: a.task, kind: 'convergence-exhausted', key: 'jobs.convergence.gate.exhausted', repairs: repairCountOf(s, a.task.id), lang: a.lang }, now)
  // **err 로 조용히 버리지 않는다(전체 브랜치 리뷰, Finding 4).** 이 위의 세 갈래와 아래
  // openRepairDispatch 실패 갈래가 전부 Gate 를 여는데, 여기만 err 를 돌려주면 그 값을 부르는 쪽이
  // 로그만 남기고 마는(server.ts) 이 파일 유일의 자리가 되어 Task 가 validating 에 갇힌 채 아무도
  // 다시 보러 오지 않는다 — 오늘의 배선은 항상 repair 를 채워 넘겨 닿지 않지만, §18(4)가 닫으려 한
  // 것과 똑같은 구멍을 새로 열어 두는 것은 다음 사람이 이 자리를 믿게 만든다.
  if (!a.repair)
    return gateOnFailure(
      s,
      { task: a.task, kind: 'convergence-blocked', key: 'jobs.convergence.gate.repairFailed', reason: 'no repair target was supplied', lang: a.lang },
      now
    )
  const withTask: OrchState = { ...s, tasks: replace(s.tasks, a.task) }
  const opened = openRepairDispatch(withTask, { taskId: a.task.id, reason: a.reason, target: a.repair }, now)
  if (!opened.ok)
    return gateOnFailure(
      s,
      { task: a.task, kind: 'convergence-blocked', key: 'jobs.convergence.gate.repairFailed', reason: opened.error, lang: a.lang },
      now
    )
  const state = pushMessage(
    opened.state,
    {
      runId: runIdOf(a.task),
      type: 'status',
      taskId: a.task.id,
      subject: a.message.subject,
      // 코디네이터가 읽는 문구다(설계 §9). --retry-of 를 말하지 않는다 — 이 Task 의 재시도는 앱의 일이다.
      body:
        `${a.message.detail} repair ${repairs} of ${a.policy.maxFixAttempts}. The app is repairing this Task. ` +
        `Do not start a worker for it — you will be told when it converges, or asked through a Gate when it cannot.`
    },
    now
  ).state
  return ok(state, state.tasks.find((x) => x.id === a.task.id)!)
}

/** Sends a Task that already produced output into its check without a worker report (P1 design §6).
 *
 *  Recovery uses it for the one case where the work survived but the report did not: the worker
 *  committed and was then lost, so the check is what can judge the result (spec §16 Example E).
 *  Deliberately not `applyWorkerDone`: that records a report this app never received. */
/** 시간 예산의 시계를 켠다 (설계 G2, 명세 §40) — **처음 validating 이 될 때 한 번만.**
 *
 *  이미 찍혀 있으면 덮지 않는다. 라운드마다 다시 찍으면 예산이 라운드마다 리셋되어 상한이 아니게
 *  된다. 정책에 시간 예산이 없어도 찍는다: 예산은 Run 의 칸이라 도중에 켤 수 있고, 그때 시계가
 *  없으면 그 Task 만 영원히 예산 밖에 남는다. */
const withConvergenceClock = (task: Task, now: string): Task =>
  task.convergenceStartedAt === undefined ? { ...task, convergenceStartedAt: now } : task

/** 완료 정책의 지문을 찍거나, 달라졌으면 표시한다 (설계 G3, 명세 §37·§36).
 *
 *  라운드가 시작될 때마다 부른다. 처음이면 찍고, 이미 있는데 값이 다르면 `policyChanged` 를 세운다 —
 *  **막지 않는다**(B7): 사람이 라운드 사이에 검사를 정당하게 고쳤을 수 있고, 그 판단은 리뷰어와
 *  사람의 몫이다. 앱이 할 일은 그 사실이 눈에 띄게 하는 것이다.
 *
 *  한 번 세운 표시는 내리지 않는다. 되돌려 놓아도 "그 사이에 바뀌어 있었다" 는 사실은 남는다.
 *
 *  지문 계산은 부르는 쪽이 한다 — 검사 구성은 main 의 저장소에 있고 core 는 그것을 모른다. */
export function stampPolicySnapshot(s: OrchState, a: { taskId: string; key: string }, now: string): OrchState {
  const task = s.tasks.find((t) => t.id === a.taskId)
  if (!task) return s
  if (task.policySnapshot === undefined)
    return { ...s, tasks: replace(s.tasks, { ...task, policySnapshot: { key: a.key, capturedAt: now } }) }
  if (task.policySnapshot.key === a.key || task.policyChanged === true) return s
  return { ...s, tasks: replace(s.tasks, { ...task, policyChanged: true as const }) }
}

export function beginValidation(s: OrchState, a: { taskId: string }, now: string): Res<Task> {
  const task = s.tasks.find((t) => t.id === a.taskId)
  if (!task) return err(`unknown task: ${a.taskId}`)
  const moved = moveTask(task, 'validating', now)
  if (!moved) return err(`cannot begin validation from status: ${task.status}`)
  const stamped = withConvergenceClock(moved, now)
  return ok({ ...s, tasks: replace(s.tasks, stamped) }, stamped)
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

/** `openReviewDispatch` 가 "이 Task 에는 이미 열린 Dispatch 가 있다" 를 말할 때의 머리말.
 *
 *  **읽는 쪽이 생겨서 이름이 붙었다.** `startReview` 의 실패 처리는 이 거절 하나만 다르게 다뤄야
 *  한다(ruling F37, main/orchestration/reviewGate.ts) — 나머지는 사람에게 넘길 실패이고 이것은 남이
 *  먼저 시작했다는 뜻이다. 그쪽이 문자열을 다시 적으면 이 문장을 고치는 날 조용히 갈라지고, 갈라진
 *  결과는 "살아 있는 검토를 지운다" 이다. */
const ALREADY_OPEN = 'dispatch already open'
/** 위 머리말로 시작하는 거절인가. **다른 함수의 같은 문장까지 받아 주지는 않는다** — `openDispatch`
 *  와 worker-start 도 같은 말을 하지만 그쪽 거절을 읽는 자리는 없고, 있다면 그 자리가 자기 판정을
 *  가져야 한다. */
export const isAlreadyOpenError = (error: string): boolean => error.startsWith(`${ALREADY_OPEN}: `)

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
  if (open) return err(`${ALREADY_OPEN}: ${open.id}`)
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
 *  **convergence 가 없는 Run 은 지금까지와 문구까지 같다**(설계 §5.3과 같은 호환 규칙): 실패는
 *  기존 재시도 흐름을 그대로 탄다 — Gate 를 열지 않는다. 검토가 "부족하다"고 판정한 것은 **정상
 *  결과**이고, 정상 결과를 사람에게 넘기면 자동화가 아니다. Gate 는 검토를 **돌릴 수 없을** 때만
 *  쓴다(blockForReview). 그 호환에는 `Task.reviewIssues` 가 자라지 않는 것도 들어간다 — 이 기능을
 *  쓰지 않는 Run 의 `orchestration.json` 이 이 변경으로 커지면 안 된다.
 *
 *  **convergence 가 있는 Run 에서는 blocking 이슈가 판정한다**(설계 §8) — 보고된 outcome 이 아니라.
 *  승인(outcome: succeeded)이라도 파싱된 이슈 중 blocking 이 있으면 repair 로 간다: 승인이 자기
 *  발견을 덮지 못한다(normalizeIssues 의 규칙). 깨진 판정 파일(`issues === 'malformed'`)은 "이슈
 *  없음" 으로 읽지 않는다 — Gate 를 연다.
 *
 *  **결과는 반드시 메시지가 된다** — applyValidationResult 와 같은 이유다. 코디네이터를 깨우는
 *  수단은 메시지뿐이고(check 는 nextDelivery 를 통해 s.messages 만 읽는다), 통과도 알려야 한다:
 *  의존 Task 가 풀린 것을 모르면 다음 Task 를 띄우지 않는다.
 *
 *  worker_done 이 아니라 status 인 이유: 코디네이터 쪽에서 보면 이것은 **앱이 얻어 온 판정을 앱이
 *  보고하는 것**이고 검증 결과와 같은 성격이다. worker_done 은 "내가 띄운 워커가 보고했다"로 남긴다. */
export function applyReviewResult(
  s: OrchState,
  a: {
    taskId: string
    dispatchId: string
    outcome: Outcome
    subject: string
    body: string
    /** `<specPath>.review.json` 에서 읽은 이슈. 파일이 없으면 undefined, 깨졌으면 'malformed'
     *  (설계 §8.2). convergence 가 없는 Run 에서는 읽지 않는다 — 넘겨도 무시한다 */
    issues?: ReviewIssueInput[] | 'malformed'
    repair?: RepairTarget
    lang?: Lang
  },
  now: string
): Res<'accepted' | 'alreadyReported'> {
  const dispatch = s.dispatches.find((d) => d.id === a.dispatchId)
  if (!dispatch) return gone(`unknown dispatch: ${a.dispatchId}`)
  if (!dispatch.review) return err(`not a review dispatch: ${a.dispatchId}`)
  if (dispatch.taskId !== a.taskId) return err('taskId does not match dispatch')
  // applyWorkerDone 과 같은 판정 — outcome 만 보면 closeDispatch 가 닫아 둔(endedAt 만 있고
  // outcome 은 없는) Dispatch 가 걸러지지 않아, 늦게 도착한 보고가 Task 의 종료 상태를 가로챈다.
  if (dispatch.outcome || dispatch.endedAt) return ok(s, 'alreadyReported')
  const task = s.tasks.find((t) => t.id === a.taskId)
  if (!task) return gone(`unknown task: ${a.taskId}`)
  if (task.status !== 'reviewing') return err(`task is not reviewing: ${task.status}`)
  const lang: Lang = a.lang ?? 'en'
  const nextDispatch: Dispatch = {
    ...dispatch,
    outcome: a.outcome,
    endedAt: now,
    workerState: a.outcome === 'succeeded' ? 'stopped' : 'failed'
  }
  const closed: OrchState = { ...s, dispatches: replace(s.dispatches, nextDispatch) }
  const policy = policyOf(s, task)

  if (policy === null) {
    // ---- 지금까지의 경로. 문구까지 그대로다 ----
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
    let state: OrchState = { ...closed, tasks: recomputeReady(replace(closed.tasks, next)) }
    state = pushMessage(
      state,
      {
        runId: runIdOf(task),
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

  // ---- convergence Run ----
  if (a.issues === 'malformed') {
    // 검토 Dispatch 는 닫혔으므로 createGate 의 "열린 Dispatch" 검사를 지난다. 조용히 통과시키지
    // 않는다 — 깨진 판정을 "이슈 없음" 으로 읽으면 검토가 통과한 것이 된다(설계 §8.2).
    const g = blockForReview(closed, { taskId: task.id, reason: 'reviewer output could not be parsed (review.json)' }, now)
    if (!g.ok) return err(g.error)
    return ok(g.state, 'accepted')
  }
  const issues = normalizeIssues({
    outcome: a.outcome,
    subject: a.subject,
    body: a.body,
    issues: a.issues,
    policy,
    newId
  })
  const blocking = issues.filter((i) => i.blocking)
  const recorded: Task = { ...task, reviewIssues: issues }
  if (blocking.length === 0) {
    const moved = moveTask(recorded, 'completed', now)
    if (!moved) return err(`cannot move task ${task.status} -> completed`)
    const next: Task = { ...moved, consecutiveFailures: 0 }
    let state: OrchState = { ...closed, tasks: recomputeReady(replace(closed.tasks, next)) }
    const notes = issues.length
    state = pushMessage(
      state,
      {
        runId: runIdOf(task),
        type: 'status',
        taskId: task.id,
        dispatchId: dispatch.id,
        subject: notes === 0 ? 'Review approved' : `Review approved (${notes} non-blocking note${notes === 1 ? '' : 's'})`,
        body: `The reviewer accepted the work. The Task moved to completed.\n${a.body}`
      },
      now
    ).state
    return ok(state, 'accepted')
  }
  const failed: Task = { ...recorded, consecutiveFailures: task.consecutiveFailures + 1, result: a.body }
  // 라운드 상한(설계 §8.4). 지금 닫은 검토가 이미 outcome 을 가지므로 reviewRoundOf 가 그것을 센다.
  // repairs 는 실제로 연 repair 수다(repairCountOf) — maxFixAttempts 는 다른 예산(§5.1)이고, 라운드
  // 상한에 닿았다고 그 값과 같지 않다.
  //
  // **convergenceOff·paused 가 이 상한보다 위다**(설계 §5.1의 표: 멈춤 > 소진). 그래서 그 둘이면
  // 여기서 소진 Gate 를 내지 않고 routeFailure 에 넘긴다 — routeFailure 가 그 표의 나머지를 그대로
  // 본다(convergenceOff -> stopped, run.paused -> paused, 그다음에야 maxFixAttempts 소진).
  if (!failed.convergenceOff && !pausedForTask(s, task) && reviewRoundOf(closed, task.id) >= policy.maxReviewRounds) {
    const g = gateOnFailure(closed, { task: failed, kind: 'convergence-exhausted', key: 'jobs.convergence.gate.exhausted', repairs: repairCountOf(closed, task.id), lang }, now)
    if (!g.ok) return err(g.error)
    return ok(g.state, 'accepted')
  }
  const list = blocking.map((i, n) => `${n + 1}. ${i.severity.toUpperCase()} — ${i.title}${i.file ? ` — ${i.file}${i.line !== undefined ? `:${i.line}` : ''}` : ''}`).join('\n')
  const routed = routeFailure(
    closed,
    {
      task: failed,
      policy,
      reason: 'review-failure',
      repair: a.repair,
      lang,
      message: {
        subject: `${dispatch.provider} review found ${blocking.length} blocking issue${blocking.length === 1 ? '' : 's'}`,
        detail: `Blocking issues:\n${list}\n`
      }
    },
    now
  )
  if (!routed.ok) return err(routed.error)
  return ok(routed.state, 'accepted')
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
          runId: runIdOf(task),
          type: 'status',
          taskId: task.id,
          dispatchId: dispatch.id,
          subject: 'session ended at a usage limit',
          body: `exitCode=${a.exitCode}. limitResetsAt=${new Date(a.limitResetsAt).toISOString()}. After that time, a --retry-of on the same account can proceed.`
        }
      : {
          runId: runIdOf(task),
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

/** An open Dispatch nobody can say anything more about, ended.
 *
 *  `outcome` stays absent on purpose: that is what tells recovery's `isLost` this attempt was lost
 *  rather than reported, and `closedBy` stays absent because no person closed it. The two fields
 *  travel together, which is why this is a function and not a spread at each call site — the
 *  restart cleanup (`OrchestrationStore.load`) and the pending-report drain both write it, and a
 *  second copy is a second thing to remember when either field moves. */
export const endedUnproven = (d: Dispatch, now: string): Dispatch => ({
  ...d,
  endedAt: now,
  workerState: 'outcome_unknown'
})

/** What a Task that was mid-validation or mid-review is owed once the thing running it is gone.
 *
 *  Both callers reach here from the same fact — the process that was validating or reviewing died
 *  with the app, and nobody will ever bring its answer back — so the rule lives in one place:
 *  `OrchestrationStore.load`'s restart cleanup for every such Task at boot, and
 *  `writeOffDispatch` for the one Task under a Dispatch the pending-report drain had to write off.
 *
 *  Three answers, and they are three because the caller has to be able to say which happened.
 *  `interrupted` names the Gate that was opened; `stuck` is a Task the transition refused, left
 *  exactly as it was; both null and false is a Task that was owed nothing.
 *
 *  Anything else about the Task is left alone, `consecutiveFailures` included — a restart is not
 *  evidence that the work was wrong. */
export function interruptStalledTask(
  s: OrchState,
  a: { taskId: string },
  now: string
): {
  state: OrchState
  interrupted: 'validation' | 'review' | null
  /** convergence Run 의 validating/reviewing Task 에게, Gate 대신 "다시 돌려라" 를 말한다(설계
   *  §10). 그때 `interrupted` 는 null 이고 state 는 그대로다 — 실제로 다시 돌리는 것은 부르는 쪽의
   *  일이다(이 함수는 판정만 한다). */
  resume: 'validation' | 'review' | null
  stuck: boolean
} {
  const task = s.tasks.find((t) => t.id === a.taskId)
  if (!task) return { state: s, interrupted: null, resume: null, stuck: false }
  if (task.status !== 'validating' && task.status !== 'reviewing')
    return { state: s, interrupted: null, resume: null, stuck: false }
  // convergence Run 은 묻지 않고 다시 돌린다(설계 §10) — check 는 멱등이고, 검토는 새 세션이면
  // 된다. Gate 는 사람의 결정이 필요할 때의 것이고 여기에는 결정할 것이 없다. Task 와 state 는
  // 건드리지 않는다 — 다시 돌리는 것은 이 함수를 부른 쪽의 일이다.
  if (policyOf(s, task) !== null)
    return { state: s, interrupted: null, resume: task.status === 'validating' ? 'validation' : 'review', stuck: false }
  // 검토는 질문을 손으로 쓰지 않고 blockForReview 에 맡긴다 — 그 질문에는 "끝난 일을 버리지 않고
  // 이 Task 를 닫으려면 task-update --status completed" 라는 탈출구가 붙어 있고, reviewing Task
  // 에는 그것이 꼭 필요하다: 구현이 끝나고 검증까지 통과했을 수 있는 일인데 resolveGate 는 Task 를
  // pending 으로 돌려보내 그 일을 버린다. 문장을 여기 옮겨 적으면 같은 안내가 두 곳에 생겨
  // 갈라진다. 검증 쪽 질문은 그대로 둔다.
  const r =
    task.status === 'validating'
      ? createGate(
          s,
          { taskId: task.id, question: '앱이 재시작되어 검증이 중단되었습니다. 다시 검증할까요?' },
          now
        )
      : blockForReview(s, { taskId: task.id, reason: '앱이 재시작되어 검토가 중단되었습니다' }, now)
  // 전이가 막히면 그 Task 는 그대로 둔다 — 잃는 것보다 낫다
  if (!r.ok) return { state: s, interrupted: null, resume: null, stuck: true }
  return {
    state: r.state,
    interrupted: task.status === 'validating' ? 'validation' : 'review',
    resume: null,
    stuck: false
  }
}

/** The restart cleanup's whole rule, applied to one Dispatch.
 *
 *  **The caller must already have decided this Dispatch may be written off, and this function
 *  cannot check that for it.** It knows nothing about the Host, so it will end a Dispatch whose
 *  session is still running there — and a Dispatch ended with no outcome is what recovery's
 *  `isLost` reads as a lost worker, which starts a second agent in the worktree the first one is
 *  still in. That is the failure the Host handshake exists to prevent, and it is reachable from
 *  here in one line. The only caller today is the pending-report drain's wiring, which passes ids
 *  from `dispatchesHeldOnlyByReport` (core/orchestration/pendingReports.ts) — that function holds
 *  the evidence rule, and a second caller needs one at least as strong before it may call this.
 *
 *  A parameter cannot carry that: the mistake worth preventing is not "called without filtering"
 *  but "filtered on evidence that does not rule out a live session", and no signature can tell one
 *  set of ids from another. Naming the requirement is the honest guard.
 *
 *  **Why one Dispatch has its own entry point.** The pending-report drain ends up holding a
 *  Dispatch that the boot cleanup left open only because a queued report spoke for it, and then
 *  finds it cannot apply that report — the app refuses it, or applying it throws until the drain
 *  gives up. Nothing speaks for the Dispatch after that, and leaving it open costs the Task a whole
 *  start: `candidates` in main/recovery/reconciler.ts skips a Task with any open Dispatch, so
 *  recovery cannot take it until the next boot's cleanup writes it off. Closing it here lets the
 *  same boot's recovery sweep, which runs after the drain, do that work now.
 *
 *  **It is the cleanup's rule and not a second one.** `endedUnproven` and `interruptStalledTask`
 *  are the same two pieces `OrchestrationStore.load` uses, in the same order — the Dispatch first,
 *  because `createGate` refuses to gate a Task with an open Dispatch.
 *
 *  `closed` is false, with the state untouched, for a Dispatch that is already ended or not there:
 *  an earlier report in the same drain may have closed it, and a hand-written report may name a
 *  Dispatch that never existed. */
export function writeOffDispatch(
  s: OrchState,
  a: { dispatchId: string },
  now: string
): {
  state: OrchState
  closed: boolean
  interrupted: 'validation' | 'review' | null
  /** interruptStalledTask 의 resume 을 그대로 들려 보낸다 — convergence Run 의 Task 라면 이 자리가
   *  "Gate 대신 다시 돌려라" 를 부르는 쪽에 전하는 유일한 신호다. */
  resume: 'validation' | 'review' | null
  stuck: boolean
} {
  const dispatch = s.dispatches.find((d) => d.id === a.dispatchId && !d.endedAt)
  if (!dispatch) return { state: s, closed: false, interrupted: null, resume: null, stuck: false }
  const ended: OrchState = {
    ...s,
    dispatches: replace(s.dispatches, endedUnproven(dispatch, now))
  }
  const r = interruptStalledTask(ended, { taskId: dispatch.taskId }, now)
  return { state: r.state, closed: true, interrupted: r.interrupted, resume: r.resume, stuck: r.stuck }
}

/** 롤링이 세션을 갈아탈 때 열린 Dispatch 를 새 세션 id·계정으로 옮긴다.
 *
 *  **왜 필요한가.** `Dispatch.sessionId` 는 worker_done 을 되돌려 묶는 **유일한** 키다 —
 *  closeDispatch 가 그것으로 Dispatch 를 찾고, handleCommand 의 호출자 식별과 사이드바가 탭을 여는
 *  값(JobTask.sessionId)도 같은 값에 걸려 있다. 롤은 세션을 죽이고 새 id 로 다시 띄우므로
 *  (claudeCoordinator.ts 의 liveId: "changes on every roll"), 옮겨 주지 않으면 살아 있는 워커의 보고가 갈 곳을
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

/** Records the provider's own session id on an open Dispatch (Job Continuity P0 design §8). The same
 *  value again is a no-op that returns the input state; a different value replaces it — a roll
 *  respawns the process and the new one has a new id. A closed Dispatch is refused: nothing will
 *  resume it, and binding would make the record claim a session that is not this attempt's. */
export function bindNativeSession(
  s: OrchState,
  a: { dispatchId: string; nativeSessionId: string }
): Res<Dispatch> {
  const dispatch = s.dispatches.find((d) => d.id === a.dispatchId)
  if (!dispatch) return err(`unknown dispatch: ${a.dispatchId}`)
  if (dispatch.endedAt) return err(`dispatch is closed: ${a.dispatchId}`)
  if (dispatch.nativeSessionId === a.nativeSessionId) return ok(s, dispatch)
  const next: Dispatch = { ...dispatch, nativeSessionId: a.nativeSessionId }
  return ok({ ...s, dispatches: replace(s.dispatches, next) }, next)
}

/** 정지 시점 스냅샷을 열린 Dispatch 에 남긴다. **Task 도 Dispatch 의 종료 상태도 건드리지 않는다** —
 *  이것은 관측 기록이고, 무엇이 일어났는지에 대한 주장이 아니다.
 *
 *  열린 Dispatch 가 없으면 `ok(state, null)` 이다(`closeDispatch`·`rekeyDispatch` 와 같은 관례).
 *  두 번째 정지는 덮어쓴다 — Checkpoint 가 필요한 기준점은 **마지막** 정지의 것이다. 무엇이
 *  "두 번째 정지" 인지 가르는 것은 이 함수가 아니라 부르는 쪽이다(core/orchestration/exec/rollTap.ts):
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
  // (core/orchestration/exec/rollTap.ts 의 세션별 표식), 가드가 만든 해악이 더 컸다: 재개 없이 끝난
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
 *  (core/orchestration/exec/rollTap.ts 의 recordStop): HEAD 를 읽는 것은 프로세스 하나를 띄우는 일이고,
 *  그것을 기다리는 사이에 롤이 Dispatch 의 세션 id 를 바꿔 치운다.
 *
 *  **세션 id 가 아니라 Dispatch id 로 찾는 이유가 바로 그것이다.** 재키잉을 지나도 Dispatch id 는
 *  같다(`rekeyDispatch` 는 sessionId·accountId 만 고쳐 쓴다).
 *
 *  **비워 둔 칸만 메운다 — 정확히는, 지금 그 칸이 null 일 때만 메운다.** 이것이 "다른 에피소드의
 *  스냅샷에는 못 쓴다" 는 것까지 보장하지는 않는다: 새 스냅샷도 매번 `headCommit: null` 로
 *  시작하기 때문이다(core/orchestration/exec/rollTap.ts 의 recordStop, ~286행). 이 함수를 부르게 한 git
 *  읽기가 다음 정지가 이미 커밋되고도 그 정지 자신의 git 읽기가 아직 답하기 전인 순간까지 늦게
 *  걸리면, 그 늦은 답은 다음 에피소드의(아직 비어 있는) 스냅샷에 옛 HEAD 를 써 넣는다 — git 이 한
 *  에피소드 전체를 건너뛸 만큼 멈춰 서야 하는 드문 경합이다. 방향은 안전한 쪽이다: 기준점이 실제보다
 *  오래된 커밋이 되므로 worktreeMoved 는 "바뀌었다" 쪽으로만 틀릴 수 있다 — "바뀌지 않았다" 를
 *  확인하지 않은 채 단정하는, 스냅샷이 막으려는 결말은 여전히 일어나지 않는다. Task 의 updatedAt 도
 *  올리지 않는다: 이 값은 화면에 그리는 것이 아니라 Checkpoint 조립기만 읽고(checkpoint.ts 의
 *  worktreeMoved), 정지 자체는 이미 앞 걸음이 알렸다. */
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

/** A later `'waiting'` publication inside a stop episode already on record carries a fresher retry
 *  time than the one on file — the retry loop that follows an aborted roll (claudeCoordinator.ts,
 *  codexCoordinator.ts) republishes `'waiting'` every round, each with its own `nextRetryAt`. The
 *  episode itself is deduped by the caller (core/orchestration/exec/rollTap.ts's `stopped`), so this only
 *  ever runs for a dispatch that already has an open entry — dropping the new time instead of
 *  recording it left the Jobs row and Checkpoint quoting the very first retry forever.
 *
 *  **Patches the open entry in place; does not open a second one.** The episode is still one stop —
 *  `resumes` keeps its length and its resume count, and `headCommit`/`reason`/`stoppedAt`/
 *  `fromAccountId` are untouched (same convention as `recordStopHead`, which patches one field of an
 *  existing record rather than writing a new one). No open entry — already resumed, or no stop on
 *  record at all — is a no-op. */
export function updateStopReset(
  s: OrchState,
  a: { sessionId: string; resetsAt: string }
): Res<Dispatch | null> {
  const dispatch = s.dispatches.find((d) => d.sessionId === a.sessionId && !d.endedAt)
  if (!dispatch?.stopSnapshot) return ok(s, null)
  const resumes = dispatch.resumes ?? []
  const last = resumes[resumes.length - 1]
  if (!last || last.resumedAt !== undefined) return ok(s, null)
  const next: Dispatch = {
    ...dispatch,
    stopSnapshot: { ...dispatch.stopSnapshot, resetsAt: a.resetsAt },
    resumes: [...resumes.slice(0, -1), { ...last, resetsAt: a.resetsAt }]
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
  if (!d) return gone(`unknown delivery: ${a.deliveryId}`)
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
  if (!dispatch) return gone(`unknown dispatch: ${a.dispatchId}`)
  if (dispatch.taskId !== a.taskId) return err('taskId does not match dispatch')
  // endedAt counts as terminal here for the same reason as in applyWorkerDone — a new question
  // cannot be attached to a dispatch that closeDispatch closed.
  if (dispatch.outcome || dispatch.endedAt) return err('dispatch already settled')
  const pending = s.messages.some(
    (m) => m.type === 'question' && m.dispatchId === a.dispatchId && !m.answered
  )
  if (pending) return err('a pending question already exists for this dispatch')
  const task = s.tasks.find((t) => t.id === a.taskId)
  if (!task) return gone(`unknown task: ${a.taskId}`)
  const { state, message } = pushMessage(
    s,
    {
      runId: runIdOf(task),
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
  a: { taskId: string; question: string; options?: string[]; kind?: GateKind },
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
    runId: runIdOf(task),
    taskId: a.taskId,
    question: a.question,
    options: a.options,
    ...(a.kind ? { kind: a.kind } : {}),
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
      runId: runIdOf(task),
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
  if (!gate) return gone(`unknown gate: ${a.gateId}`)
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
  // 정의 Task(runId 가 없는 것)는 회차를 지워도 남는다 — 그것은 계획이고, 계획은 Job 과 함께
  // 지워진다(deleteJobs). 여기서 함께 지우면 회차 하나를 버린 Job 이 다음 회차에 베낄 것을 잃는다.
  const tasks = s.tasks.filter((t) => t.runId === undefined || !runIds.has(t.runId))
  const keptTaskIds = new Set(tasks.map((t) => t.id))
  return {
    jobs: s.jobs,
    runs: s.runs.filter((r) => !runIds.has(r.id)),
    tasks,
    dispatches: s.dispatches.filter((d) => keptTaskIds.has(d.taskId)),
    messages: s.messages.filter((m) => !runIds.has(m.runId)),
    deliveries: s.deliveries.filter((d) => !runIds.has(d.runId)),
    gates: s.gates.filter((g) => !runIds.has(g.runId)),
    // 프로젝트는 Run 을 지워도 남는다 — Job 이 하나도 없는 저장소도 프로젝트다. 칸을 열거하는
    // 이 모양을 유지하는 것은 위 주석의 이유와 같다: 새 칸이 생기면 타입이 여기서 걸려, 지울지
    // 남길지 사람이 정하게 된다(스프레드로 덮으면 조용히 남는다).
    projects: s.projects
  }
}

/**
 * Job 들과 그에 딸린 모든 것을 지운다 — 회차, 정의 Task, 그 아래 Dispatch·Message·Delivery·Gate.
 *
 * **계획을 지우는 것과 기록 하나를 버리는 것은 다르다.** 회차 하나만 지우는 것은 deleteRuns 이고
 * 그쪽은 정의를 남긴다(그래야 다음 회차가 베낄 것이 있다). 이 함수는 계획째 버린다.
 */
export function deleteJobs(s: OrchState, jobIds: ReadonlySet<string>): OrchState {
  if (jobIds.size === 0) return s
  const runIds = new Set(s.runs.filter((r) => jobIds.has(r.jobId)).map((r) => r.id))
  const afterRuns = deleteRuns(s, runIds)
  return {
    ...afterRuns,
    jobs: afterRuns.jobs.filter((j) => !jobIds.has(j.id)),
    // 정의 Task 는 deleteRuns 가 일부러 남긴다 — 여기서 걷는다
    tasks: afterRuns.tasks.filter((t) => t.jobId === undefined || !jobIds.has(t.jobId))
  }
}

/** 이 Run 을 관리하는 코디네이터 세션을 붙인다. */
export function attachCoordinator(
  s: OrchState,
  a: { runId: string; sessionId: string }
): Res<JobRun> {
  const run = s.runs.find((r) => r.id === a.runId)
  if (!run) return err(`unknown run: ${a.runId}`)
  // A new coordinator starts with no stop on record: a stop belonged to the session that had it.
  const { coordinatorStop: _stop, ...rest } = run
  const next: JobRun = { ...rest, coordinatorSessionId: a.sessionId }
  return ok({ ...s, runs: replace(s.runs, next) }, next)
}

/** A roll respawned the session a Run's coordinator slot names: the slot follows it (S6 R14). */
export function rekeyCoordinator(
  s: OrchState,
  a: { oldSessionId: string; newSessionId: string }
): Res<JobRun | null> {
  const run = s.runs.find((r) => r.coordinatorSessionId === a.oldSessionId)
  if (!run) return ok(s, null)
  // The spread carries `coordinatorStop` on purpose: the stop is the episode's, and the episode goes on
  // in the new session. The roll tap clears it once the rekey is committed (OrchRollTap.onRolled).
  const next: JobRun = { ...run, coordinatorSessionId: a.newSessionId }
  return ok({ ...s, runs: replace(s.runs, next) }, next)
}

/** 코디네이터 세션을 뗀다. **왜 사라졌는지 묻지 않는다** — 사람이 닫았는지 크래시인지 구별할
 *  방법이 없고(`SessionManager.kill` 은 표시를 남기지 않는다), 어느 쪽이든 앱이 하는 일은 같다:
 *  이 칸을 지우고 사람이 다시 띄울 버튼을 내보인다(Run.coordinatorSessionId 의 주석). */
export function detachCoordinator(s: OrchState, a: { runId: string }): Res<JobRun> {
  const run = s.runs.find((r) => r.id === a.runId)
  if (!run) return err(`unknown run: ${a.runId}`)
  const next: JobRun = { ...run }
  delete next.coordinatorSessionId
  // With no coordinator there is nobody stopped: a stop left behind would make `runs wait` end
  // `limited` on a Run whose coordinator is gone (S6 limits D2).
  delete next.coordinatorStop
  return ok({ ...s, runs: replace(s.runs, next) }, next)
}

/** The coordinator of a Run stopped at a usage limit (S6 limits D1). The Run is found by `runId`, or by
 *  the session its slot names. **Sets the stop when there is none, and otherwise only patches its
 *  `resetsAt`** (when one is given): a repeat 'waiting' in the same episode carries a fresher reset, and
 *  the episode is still one stop, so `since` stays the first one. The same rule as `updateStopReset`
 *  for a worker's stop. Null when no Run matches or nothing changes. */
export function recordCoordinatorStop(
  s: OrchState,
  a: ({ runId: string; sessionId?: undefined } | { sessionId: string; runId?: undefined }) & { resetsAt?: string },
  now: string
): Res<JobRun | null> {
  const run =
    a.runId !== undefined
      ? s.runs.find((r) => r.id === a.runId && r.coordinatorSessionId !== undefined)
      : s.runs.find((r) => r.coordinatorSessionId === a.sessionId)
  if (!run) return ok(s, null)
  const prev = run.coordinatorStop
  if (prev && (a.resetsAt === undefined || prev.resetsAt === a.resetsAt)) return ok(s, null)
  const stop = prev
    ? { ...prev, resetsAt: a.resetsAt! }
    : { since: now, ...(a.resetsAt !== undefined ? { resetsAt: a.resetsAt } : {}) }
  const next: JobRun = { ...run, coordinatorStop: stop }
  return ok({ ...s, runs: replace(s.runs, next) }, next)
}

/** The coordinator on `sessionId` is working again, or its chain let go (S6 limits D1). Null when that
 *  session is no Run's coordinator or has no stop on record, so a caller commits nothing. */
export function clearCoordinatorStop(s: OrchState, a: { sessionId: string }): Res<JobRun | null> {
  const run = s.runs.find((r) => r.coordinatorSessionId === a.sessionId && r.coordinatorStop !== undefined)
  if (!run) return ok(s, null)
  const next: JobRun = { ...run }
  delete next.coordinatorStop
  return ok({ ...s, runs: replace(s.runs, next) }, next)
}
