// 공개 표면이 내보내는 칸 (공개 CLI 설계 §11).
//
// **허용 목록이지 차단 목록이 아니다.** 차단 목록은 누군가 이미 떠올린 누수의 목록이고, 그 뒤에
// 더해지는 칸은 언제나 그 목록을 그냥 지나간다.
//
// **재 보니 가릴 비밀은 거의 없었다.** 명세 §38 이 찍지 말라는 것(계정 설정 폴더, 세션 인증
// 자료, 토큰)은 이 다섯 개체 어디에도 없다 — 계정 목록은 앱이 이미 `{id,label,provider}` 셋으로만
// 내보내고 있다(ipc.ts 의 listAccounts). 그래서 이 파일이 실제로 하는 일은 **공개 API 의 경계를
// 못 박는 것**이다. 이것이 없으면 OrchState 에 칸을 하나 더하는 순간 그것이 소리 없이 공개
// API 가 되고, 나중에 지우는 순간 남의 스크립트가 깨진다.
//
// **컴파일러가 빠짐을 잡는다.** 칸을 더하고 두 목록 중 어디에도 적지 않으면 타입 검사가 그
// 이름을 대며 깨진다. 허용 목록의 유일한 실패 방식이 "낡는 것" 이고, 막을 것은 그것뿐이다.
import type { Gate, Job, JobRun, Project, Task } from './types'

/** 두 목록이 그 타입의 칸을 전부 덮지 못하면 남은 이름이 여기 남는다. */
type Unlisted<
  T,
  Shown extends readonly PropertyKey[],
  Hidden extends readonly PropertyKey[]
> = Exclude<keyof T, Shown[number] | Hidden[number]>

/** 남은 이름이 있으면 이 자리에서 그 이름을 대며 컴파일이 깨진다. 쓰이지 않는 별칭인 것이
 *  맞다 — 하는 일이 값을 만드는 것이 아니라 타입 검사를 세우는 것이다. */
type NothingLeft<T extends never> = T

const PROJECT = ['id', 'path', 'name', 'addedAt'] as const
type _project = NothingLeft<Unlisted<Project, typeof PROJECT, []>>

/**
 * 계획과 회차가 **상태를 말하는 칸 셋**. 저장된 칸이 아니라 서버가 매번 파생시킨다
 * (server.ts 의 derivedFor) — Job 에도 JobRun 에도 상태 칸은 없고, 상태는 그것이 거느린 Task 에 있다.
 *
 * 그래서 `keyof Job` 에 없고, 아래 빠짐 검사에도 들지 않는다 — 검사가 지키는 것은 "개체의 칸을
 * 빠뜨리지 않았는가" 이고, 이것들은 개체의 칸이 아니다.
 */
const DERIVED = ['outcome', 'progress', 'questionsOpen'] as const

const JOB_FIELDS = [
  'id',
  'objective',
  'cwd',
  'projectId',
  'createdAt',
  'concurrency',
  'coordinatorAccountId',
  'autoDispatch',
  'schedule',
  'fireCount',
  'pendingStart',
  'paused',
  'convergence'
] as const
type _job = NothingLeft<Unlisted<Job, typeof JOB_FIELDS, []>>
const JOB = [...JOB_FIELDS, ...DERIVED]

const RUN_FIELDS = [
  'id',
  'jobId',
  'ordinal',
  'createdAt',
  'coordinatorSessionId',
  'worktree',
  'paused'
] as const
type _run = NothingLeft<Unlisted<JobRun, typeof RUN_FIELDS, []>>
const RUN = [...RUN_FIELDS, ...DERIVED]

const TASK_FIELDS = [
  'id',
  'runId',
  'jobId',
  'title',
  'spec',
  'deps',
  'parentId',
  'status',
  'result',
  'filesModified',
  'accountIds',
  'validateConfigId',
  'validateConfigIds',
  'checks',
  'reviewIssues',
  'completionOverride',
  'consecutiveFailures',
  'createdAt',
  'updatedAt'
] as const

/**
 * 일부러 안 내보내는 Task 의 칸 — 전부 **앱이 수렴을 굴리려고 적어 두는 장부**다.
 *
 * 가이드가 코디네이터에게 읽으라고 말하는 칸은 `checks`·`consecutiveFailures`·`parentId` 이고
 * (resources/skills/orchestration-guide.md), 아래 일곱은 한 번도 나오지 않는다. 내보내면 앱이
 * 수렴을 어떻게 굴리는지가 그대로 공개 API 가 되어, 정책을 바꿀 때마다 남의 스크립트를 깨뜨린다.
 *
 * `completionOverride` 는 여기 없다 — 그것은 장부가 아니라 **사람이 내린 결정**이고, 지켜보는
 * 쪽이 "왜 통과했는가" 를 묻는 자리다.
 */
const TASK_HIDDEN = [
  'checkHistory',
  'policySnapshot',
  'policyChanged',
  'convergenceStartedAt',
  'convergenceOff',
  'suspiciousFiles',
  'reviewRequested'
] as const
type _task = NothingLeft<Unlisted<Task, typeof TASK_FIELDS, typeof TASK_HIDDEN>>

/** `tasks list --brief` 가 덧붙이는 칸. Task 에는 없다 — 어디서 잘렸는지 알리려고 그 명령이
 *  만든다(server.ts). 목록에 넣지 않으면 --brief 가 그 표시를 조용히 잃는다. */
const TASK = [...TASK_FIELDS, 'spec_truncated']

const QUESTION = [
  'id',
  'runId',
  'taskId',
  'question',
  'options',
  'kind',
  'status',
  'resolution',
  'createdAt',
  'resolvedAt'
] as const
type _question = NothingLeft<Unlisted<Gate, typeof QUESTION, []>>

/**
 * 어느 명령이 무엇을 내보내는가.
 *
 * **여기 없는 명령은 손대지 않는다.** 코디네이터 전용 명령(dispatch-show, worker-read, inbox,
 * ask, check…)은 공개 표면이 아니고 이 계약의 약속 밖이다 — 가리려 들면 가이드가 시키는 것을
 * 못 읽게 만들 뿐이다.
 */
const SHAPE: Record<string, readonly string[]> = {
  'projects-list': PROJECT,
  'projects-get': PROJECT,
  'projects-find': PROJECT,
  'jobs-list': JOB,
  'jobs-get': JOB,
  'runs-list': RUN,
  'runs-get': RUN,
  'tasks-list': TASK,
  'questions-list': QUESTION,
  'questions-get': QUESTION
}

/** 허용된 칸만 남긴다. **없는 칸은 만들지 않는다** — 없는 것을 `undefined` 로 찍으면 JSON 에서
 *  사라져 결과는 같지만, 있는데 비어 있는 것과 아예 없는 것이 한 모양이 된다. */
function pick(fields: readonly string[], obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) if (f in obj) out[f] = (obj as Record<string, unknown>)[f]
  return out
}

function shapeOne(cmd: string, fields: readonly string[], x: unknown): unknown {
  if (x === null || typeof x !== 'object') return x
  const picked = pick(fields, x)
  // `jobs get` 은 회차를 `run` 에 접어 싣는다(설계 §5 의 접기). 접힌 것도 같은 규칙으로 가린다 —
  // 한 겹 안이라고 새면 가림막이 아니다.
  const run = (x as { run?: unknown }).run
  if (cmd === 'jobs-get' && run !== null && typeof run === 'object') picked.run = pick(RUN, run)
  return picked
}

/** 앱이 돌려준 것을 공개 표면의 모양으로. 표에 없는 명령은 그대로 지나간다. */
export function publicFor(cmd: string, body: unknown): unknown {
  const fields = SHAPE[cmd]
  if (fields === undefined) return body
  if (Array.isArray(body)) return body.map((x) => shapeOne(cmd, fields, x))
  return shapeOne(cmd, fields, body)
}
