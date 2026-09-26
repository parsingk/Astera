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
import type { CheckResult, Gate, Job, JobRun, Project, ReviewIssue, Task } from './types'
import type { RunChecks, TaskChecks, TaskReview, TaskValidation } from './runChecks'
import type { JobEvent } from '../types'
import type { HostSession, OrchAccount, OrchRunConfig } from './command'
import type { ChatPending, ChatPrompt, ChatTurn } from '../sessions/chatRead'
import type { SkillInstalled, SkillListed, SkillNotEnabled, SkillsAccount } from './skills'

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
  'paused',
  // Public like the Job's own: a script can read who places this Run (U1, JobRun.autoDispatch).
  'autoDispatch'
] as const
/** Held back like TASK_HIDDEN: the roll tap's bookkeeping of a stopped coordinator, the mark of a
 *  coordinator start in flight (I1), and the mark of a coordinator stop not confirmed yet (L1). What a script needs from the first, that the Run waits for a reset
 *  and until when, is the `limited` ending of `runs wait`. */
const RUN_HIDDEN = ['coordinatorStop', 'coordinatorStartingAt', 'coordinatorStopPending'] as const
type _run = NothingLeft<Unlisted<JobRun, typeof RUN_FIELDS, typeof RUN_HIDDEN>>
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

/** 계정은 앱이 이미 이 셋으로만 내보낸다(ipc.ts 의 listAccounts). 그래도 적는 이유는 이 파일의
 *  머리말 그대로다 — 앱 쪽이 칸을 하나 더하는 순간 그것이 공개 API 가 되지 않게 한다. */
const ACCOUNT = ['id', 'label', 'provider'] as const
type _account = NothingLeft<Unlisted<OrchAccount, typeof ACCOUNT, []>>

/** 구성의 명령·env·cwd 는 앱에 남는다 — env 값은 비밀일 수 있다. 앱도 Host 도 이미 셋으로 추려
 *  넘기지만(OrchRunConfig) 그래도 적는다 — ACCOUNT 와 같은 이유다. */
const RUN_CONFIG = ['id', 'name', 'type'] as const
type _runConfig = NothingLeft<Unlisted<OrchRunConfig, typeof RUN_CONFIG, []>>

/** 세션의 칸은 앱이 pty 에 남긴 note 에서 온다 — 앱이 자기에게 남긴 말이라 무엇이든 들 수 있고
 *  (재개 id, 롤링 계정, 우회 권한), 그것이 공개 API 가 되면 안 된다. Host 가 이미 여섯 칸으로
 *  추리지만(host/sessions.ts) 그래도 적는다 — ACCOUNT 와 같은 이유다. */
const SESSION = ['id', 'kind', 'title', 'accountId', 'cwd', 'alive', 'state'] as const
type _session = NothingLeft<Unlisted<HostSession, typeof SESSION, []>>
/** `sessions read` 는 두 모양이다(command.ts). 터미널은 SessionScreen 에 id·kind·alive 를 더한 것,
 *  대화는 id·kind·alive 에 턴과 열린 카드다. `sessions send` 는 명령 층이 짓는다. */
const SESSION_READ = ['id', 'kind', 'alive', 'cols', 'rows', 'screen', 'scrollback', 'turns', 'pending'] as const
const SESSION_SEND = ['id', 'sent', 'enter'] as const
/** `tasks dispatch`: the worker the Host's loop started for the Task. The spec file's path stays on the
 *  Host: it is where the worker reads its brief, not something a shell acts on. */
const TASK_DISPATCH = ['taskId', 'runId', 'dispatchId', 'sessionId', 'cwd'] as const
/** 대화의 턴과 카드 — 접혀 실린 것도 같은 규칙으로 가린다(`jobs get` 의 회차와 같다). */
const CHAT_TURN = ['role', 'text', 'tools'] as const
type _chatTurn = NothingLeft<Unlisted<ChatTurn, typeof CHAT_TURN, []>>
const CHAT_PENDING = ['kind', 'summary'] as const
type _chatPending = NothingLeft<Unlisted<ChatPending, typeof CHAT_PENDING, []>>
/** `chats pending` 의 한 줄(chat takeover §3.5). 목록은 `prompts` 에 접혀 실리고 같은 규칙으로 가린다.
 *  `chats answer` 의 답은 명령 층이 짓는다. */
const CHAT_PROMPT = ['sessionId', 'id', 'kind', 'tool', 'summary'] as const
type _chatPrompt = NothingLeft<Unlisted<ChatPrompt, typeof CHAT_PROMPT, []>>
const CHATS_PENDING = ['prompts', 'complete'] as const
const CHATS_ANSWER = ['sessionId', 'id', 'decision', 'answered'] as const

/** `astera skills` 의 답은 계정 목록 안에 스킬 목록이 접힌 모양이다(cli/skills.ts). 개체가 앱이
 *  아니라 CLI 가 지은 것이어도 적는다 — 계정 칸은 accounts.json 을 읽은 것이고, 거기엔 configDir 이
 *  있다. 두 겹 모두 이 목록으로 가린다(아래 `shapeSkills`). 타입이 core 에 있는 것은 core 가 cli 를
 *  가져오지 않게 하려는 것이다(./skills). */
const SKILLS_ACCOUNT = ['id', 'label', 'provider', 'skills'] as const
type _skillsAccount = NothingLeft<Unlisted<SkillsAccount, typeof SKILLS_ACCOUNT, []>>
const SKILL_LISTED = ['name', 'enabled', 'installed'] as const
type _skillListed = NothingLeft<Unlisted<SkillListed, typeof SKILL_LISTED, []>>
const SKILL_INSTALLED = ['name', 'result'] as const
type _skillInstalled = NothingLeft<Unlisted<SkillInstalled, typeof SKILL_INSTALLED, []>>
const SKILL_NOT_ENABLED = ['name', 'setting'] as const
type _skillNotEnabled = NothingLeft<Unlisted<SkillNotEnabled, typeof SKILL_NOT_ENABLED, []>>

/** 봉투의 `data` 칸과 그 안의 두 겹. 다른 명령과 달리 최상위가 목록 하나가 아니라서 SHAPE 표에
 *  넣지 않고 따로 편다 — `jobs get` 의 접힌 회차와 같은 처지다. */
function shapeSkills(cmd: 'skills-list' | 'skills-install', body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body
  const skill = cmd === 'skills-list' ? SKILL_LISTED : SKILL_INSTALLED
  const list = (v: unknown, f: (x: object) => unknown): unknown =>
    Array.isArray(v) ? v.map((x) => (x !== null && typeof x === 'object' ? f(x) : x)) : v
  const out = pick(cmd === 'skills-list' ? ['accounts'] : ['accounts', 'notEnabled', 'note'], body)
  if ('accounts' in out)
    out.accounts = list(out.accounts, (a) => {
      const row = pick(SKILLS_ACCOUNT, a)
      if ('skills' in row) row.skills = list(row.skills, (x) => pick(skill, x))
      return row
    })
  if ('notEnabled' in out) out.notEnabled = list(out.notEnabled, (x) => pick(SKILL_NOT_ENABLED, x))
  return out
}

/** `runs checks` (CLI spec §20). The answer is four layers deep, and each layer is held to its type
 *  by the compiler: the run, a Task's row, that row's validation and review, and the checks and the
 *  review findings inside them. `CheckResult` and `ReviewIssue` are the same fields `tasks list`
 *  already publishes in a Task's `checks` and `reviewIssues`. */
const RUN_CHECKS = ['runId', 'jobId', 'tasks'] as const
type _runChecks = NothingLeft<Unlisted<RunChecks, typeof RUN_CHECKS, []>>
const TASK_CHECKS = ['id', 'title', 'status', 'validation', 'review', 'failureSummary', 'completionOverride'] as const
type _taskChecks = NothingLeft<Unlisted<TaskChecks, typeof TASK_CHECKS, []>>
const VALIDATION = ['required', 'status', 'checks'] as const
type _validation = NothingLeft<Unlisted<TaskValidation, typeof VALIDATION, []>>
const REVIEW = ['required', 'status', 'verdict', 'issues'] as const
type _review = NothingLeft<Unlisted<TaskReview, typeof REVIEW, []>>
const CHECK = ['configId', 'name', 'status', 'exitCode', 'outputTail', 'startedAt', 'endedAt', 'unstable'] as const
type _check = NothingLeft<Unlisted<CheckResult, typeof CHECK, []>>
const REVIEW_ISSUE = ['id', 'severity', 'blocking', 'title', 'description', 'file', 'line', 'suggestedFix'] as const
type _reviewIssue = NothingLeft<Unlisted<ReviewIssue, typeof REVIEW_ISSUE, []>>

/** One timeline event as `runs follow` prints it (CLI spec §22). **Held back:** `body`, the whole of a
 *  message (a worker's report can be pages long, and `tasks list` already carries the result that
 *  matters), and `sessionId`, the app's link from an event to a tab, which means nothing in a shell. */
const FOLLOW_EVENT = [
  'at',
  'kind',
  'sourceId',
  'taskId',
  'taskTitle',
  'messageType',
  'summary',
  'outcome',
  'provider',
  'retry',
  'review',
  'repair'
] as const
const FOLLOW_EVENT_HIDDEN = ['body', 'sessionId'] as const
type _followEvent = NothingLeft<Unlisted<JobEvent, typeof FOLLOW_EVENT, typeof FOLLOW_EVENT_HIDDEN>>

/** The public fields of one followed event. Not in `SHAPE`: `runs follow` answers a stream of these
 *  and then one ending, and the ending is `runs wait`'s body, which no table shapes either. */
export function publicEvent(e: unknown): unknown {
  return e !== null && typeof e === 'object' ? pick(FOLLOW_EVENT, e) : e
}

function shapeRunChecks(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body
  const obj = (v: unknown, fields: readonly string[]): unknown =>
    v !== null && typeof v === 'object' ? pick(fields, v) : v
  const list = (v: unknown, fields: readonly string[]): unknown =>
    Array.isArray(v) ? v.map((x) => obj(x, fields)) : v
  const out = pick(RUN_CHECKS, body)
  if (Array.isArray(out.tasks))
    out.tasks = out.tasks.map((t: unknown) => {
      if (t === null || typeof t !== 'object') return t
      const row = pick(TASK_CHECKS, t)
      const validation = obj(row.validation, VALIDATION)
      if (validation !== null && typeof validation === 'object' && 'checks' in validation)
        (validation as Record<string, unknown>).checks = list((validation as { checks: unknown }).checks, CHECK)
      if ('validation' in row) row.validation = validation
      const review = obj(row.review, REVIEW)
      if (review !== null && typeof review === 'object' && 'issues' in review)
        (review as Record<string, unknown>).issues = list((review as { issues: unknown }).issues, REVIEW_ISSUE)
      if ('review' in row) row.review = review
      return row
    })
  return out
}

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
  'jobs-create': JOB,
  'runs-list': RUN,
  'runs-get': RUN,
  'tasks-list': TASK,
  'tasks-add': TASK,
  'tasks-dispatch': TASK_DISPATCH,
  'questions-list': QUESTION,
  'questions-get': QUESTION,
  'accounts-list': ACCOUNT,
  'run-configs-list': RUN_CONFIG,
  'sessions-list': SESSION,
  'sessions-read': SESSION_READ,
  'sessions-send': SESSION_SEND,
  'sessions-create': SESSION,
  'chats-pending': CHATS_PENDING,
  'chats-answer': CHATS_ANSWER
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
  if (cmd === 'sessions-read') {
    if (Array.isArray(picked.turns))
      picked.turns = picked.turns.map((t: unknown) => (t !== null && typeof t === 'object' ? pick(CHAT_TURN, t) : t))
    // null 은 "앱이 보니 카드가 없다" 이고 그대로 싣는다 — 칸이 없는 것(앱이 없어 모른다)과 다르다.
    if (picked.pending !== null && typeof picked.pending === 'object') picked.pending = pick(CHAT_PENDING, picked.pending)
  }
  if (cmd === 'chats-pending' && Array.isArray(picked.prompts))
    picked.prompts = picked.prompts.map((p: unknown) => (p !== null && typeof p === 'object' ? pick(CHAT_PROMPT, p) : p))
  return picked
}

/** 앱이 돌려준 것을 공개 표면의 모양으로. 표에 없는 명령은 그대로 지나간다. */
export function publicFor(cmd: string, body: unknown): unknown {
  if (cmd === 'skills-list' || cmd === 'skills-install') return shapeSkills(cmd, body)
  if (cmd === 'runs-checks') return shapeRunChecks(body)
  const fields = SHAPE[cmd]
  if (fields === undefined) return body
  if (Array.isArray(body)) return body.map((x) => shapeOne(cmd, fields, x))
  return shapeOne(cmd, fields, body)
}
