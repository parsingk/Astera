// Usage Limit 이후 새 워커에게 줄 재개 자료를, 앱이 이미 알고 있는 것만으로 조립한다. LLM 호출은
// 전혀 없다 — 한도에 걸린 provider 는 이미 부를 수 없고(DESIGN 문서 2절의 표), 다른 provider 에게
// 요약을 시키는 것도 이 기능이 피하려는 비용·정책 문제를 그대로 들여온다(SPEC 9.1). 그래서 이
// 파일은 순수하다: node:fs·node:path 를 임포트하지 않고, OrchState 에 이미 있는 것만 읽는다 — git
// 은 main(다음 단계)이 읽어 GitSummary 로 넣어 준다.
//
// 담는 범위는 SPEC 8.1 의 표 하나로 좁힌다. 그 표에 없는 것은 앱이 관측하지 않는 값이고(SPEC
// 7.2 — "execution.completedSteps 를 앱은 알 수 없다"), 없는 값을 지어내면 새 워커가 틀린 전제로
// 시작한다. jobId·projectId·sourceVendor·resume.attempt 같은 SPEC 7.1 모델의 필드는 여기 없다 —
// 7.2 가 그 자리를 Run.id·Run.cwd(경로)·기존 Provider 타입·Dispatch.retryOf 체인으로 고쳐 부르거나
// 아예 필요 없다고 지운 것들이다.
import type { Gate, Message, TaskStatus, WorkerState } from './types'
import type { OrchState } from './state'

/** git 요약. 이 모듈은 fs 를 만지지 않으므로 main 이 읽어서 인자로 넣어 준다. 읽기 자체가 실패하면
 *  (worktree 가 없다, git 이 아니다) null 을 넘긴다 — 그 경우 Checkpoint 의 git 관련 칸은 전부
 *  비워지고 나머지는 그대로 조립된다. */
export interface GitSummary {
  branch: string | null
  head: string | null
  changed: string[]
  diffstat: string | null
}

/** 선행 Task 하나의 이름과 상태 — 새 워커가 "무엇이 이미 끝났는가"를 판단하는 재료. */
export interface CheckpointDependency {
  id: string
  title: string
  status: TaskStatus
}

/** 사람이 이미 내린 결정, 또는 아직 열려 있는 질문 하나(Gate). */
export interface CheckpointDecision {
  question: string
  status: Gate['status']
  resolution?: string
}

/** 워커가 자기 입으로 남긴 보고 하나(worker_done/status 메시지의 subject/body).
 *
 *  **이 Phase 의 숨은 자산이다.** DESIGN §20 은 Semantic Handoff 를 "매 turn LLM summary 비용"
 *  때문에 V2 로 미뤘지만, Job 워커는 가이드가 의무화한 보고를 이미 하고 있고 그 body 는 에이전트가
 *  응답 가능할 때 자기 말로 쓴 서술이다 — 새 LLM 호출 없이 그 서술을 재사용한다. */
export interface CheckpointReport {
  subject: string
  body: string
}

export interface Checkpoint {
  version: 1
  createdAt: string

  runId: string
  objective: string

  taskId: string
  taskTitle: string
  taskSpec: string
  dependencies: CheckpointDependency[]

  /** 재개 보고가 가리켜야 하는 자리. Dispatch 는 재개 뒤에도 같은 id 로 남는다(rekeyDispatch 는
   *  sessionId·accountId 만 옮기고 Dispatch.id 는 바꾸지 않는다) — 그래서 이 id 로 만든 보고
   *  명령은 재개 뒤에도 그대로 유효하다. */
  dispatchId: string
  workerState: WorkerState
  /** ISO 문자열로 미리 바꿔 둔다. epoch ms 를 그대로 남기면 서식 쪽이 다시 Date 로 바꿔야 하고,
   *  그러면 "같은 Checkpoint 는 같은 문자열" 이 실행 시각(타임존 등)에 기대게 된다. */
  limitResetsAt?: string

  /** Task.filesModified + Message.filesModified + git 의 changed, 중복 없이 합친 것. */
  filesModified: string[]
  /** worker_done/status 메시지, 시간순(오래된 것 먼저). 결정론적 크기 상한은 여기서 건다 — 서식
   *  쪽(formatResumeSection)은 전체 Packet 크기 상한을 위해 여기서 한 번 더 자를 수 있다. */
  reports: CheckpointReport[]

  /** Task.validateConfigId 가 걸려 있고 그 결과 메시지(validation passed/failed)가 실제로 있을
   *  때만 채워진다. 둘 중 하나라도 없으면 비워 둔다 — 추측해 채우지 않는다. */
  validation?: { configId: string; summary: string }
  decisions: CheckpointDecision[]

  git: GitSummary | null
  /** stopSnapshot.headCommit 과 git.head 를 비교한 결과. 어느 한쪽이라도 없으면 null(모른다) —
   *  비교 대상이 없으면 판정 자체가 불가능하다(SPEC 13절). */
  worktreeMoved: boolean | null
}

/** spec §8.4: "마지막 user/assistant 의미 있는 4~6개 message". 우리 단위는 turn 이 아니라
 *  worker_done/status 메시지이므로 그 범위의 위쪽 끝을 쓴다. */
const REPORTS_MAX = 6
/** 메시지 하나의 body 상한(문자). 검증 실패 메시지는 출력 꼬리를 통째로 담을 수 있고(state.ts
 *  applyValidationResult), 그것을 그대로 옮기면 "diff 본문·소스 내용은 담지 않는다"는 제약과
 *  같은 문제(대량의 원본 텍스트)가 생긴다. */
const REPORT_BODY_MAX = 400
const VALIDATION_SUMMARY_MAX = 200

export function buildCheckpoint(
  s: OrchState,
  a: { dispatchId: string; git: GitSummary | null; now: string }
): Checkpoint | null {
  const dispatch = s.dispatches.find((d) => d.id === a.dispatchId)
  if (!dispatch) return null
  const task = s.tasks.find((t) => t.id === dispatch.taskId)
  if (!task) return null
  const run = s.runs.find((r) => r.id === task.runId)
  if (!run) return null

  const dependencies: CheckpointDependency[] = task.deps.flatMap((depId) => {
    const dep = s.tasks.find((t) => t.id === depId)
    return dep ? [{ id: dep.id, title: dep.title, status: dep.status }] : []
  })

  // "이 Task 의 Message(worker_done·status)" — 이 Task 가 거친 모든 Dispatch(재시도 포함)에 걸친
  // 메시지를 taskId 로 모은다. 한 Dispatch 로 좁히면 이전 시도의 보고가 사라진다.
  const taskMessages = s.messages.filter(
    (m) => m.taskId === task.id && (m.type === 'worker_done' || m.type === 'status')
  )

  const reports: CheckpointReport[] = taskMessages.slice(-REPORTS_MAX).map((m) => ({
    subject: sanitize(m.subject),
    body: truncate(sanitize(m.body), REPORT_BODY_MAX)
  }))

  const filesModified = dedupe([
    ...(task.filesModified ?? []),
    ...taskMessages.flatMap((m) => m.filesModified ?? []),
    ...(a.git?.changed ?? [])
  ])

  const validation = findValidation(taskMessages, task.validateConfigId)

  const decisions: CheckpointDecision[] = s.gates
    .filter((g) => g.taskId === task.id)
    .map((g) => ({
      question: sanitize(g.question),
      status: g.status,
      ...(g.resolution ? { resolution: sanitize(g.resolution) } : {})
    }))

  const headAtStop = dispatch.stopSnapshot?.headCommit ?? null
  const headNow = a.git?.head ?? null
  const worktreeMoved = headAtStop !== null && headNow !== null ? headAtStop !== headNow : null

  return {
    version: 1,
    createdAt: a.now,
    runId: run.id,
    objective: run.objective,
    taskId: task.id,
    taskTitle: task.title,
    taskSpec: task.spec,
    dependencies,
    dispatchId: dispatch.id,
    workerState: dispatch.workerState,
    ...(dispatch.limitResetsAt !== undefined
      ? { limitResetsAt: new Date(dispatch.limitResetsAt).toISOString() }
      : {}),
    filesModified,
    reports,
    ...(validation ? { validation } : {}),
    decisions,
    git: a.git,
    worktreeMoved
  }
}

/** 검증 결과 메시지(applyValidationResult 가 붙이는 'validation passed'/'validation failed')
 *  중 가장 최근 것에서 요약을 뽑는다. validateConfigId 가 없으면(검증이 걸려 있지 않으면) 애초에
 *  찾지 않는다 — 검증 없는 Task 에 "검증됨"과 구별 안 되는 빈 칸을 만들 이유가 없다. */
function findValidation(
  messages: Message[],
  configId: string | undefined
): { configId: string; summary: string } | undefined {
  if (!configId) return undefined
  let last: Message | undefined
  for (const m of messages) {
    if (m.subject === 'validation passed' || m.subject === 'validation failed') last = m
  }
  if (!last) return undefined
  const firstLine = last.body.split('\n')[0] ?? ''
  return { configId, summary: truncate(sanitize(firstLine), VALIDATION_SUMMARY_MAX) }
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs))
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 코드베이스에 자격 증명 redaction 유틸이 따로 없어(찾아봤지만 slack/transcript.ts 의
 *  REDACTED_KEYS 는 도구 호출 인자용이라 이 문제와 다르다) 여기 최소 형태로 둔다 — SPEC 18절이
 *  "있으면 재사용, 없으면"까지는 말하지 않지만, 자격 증명을 담지 않는 것은 선택이 아니라 이
 *  기능의 하드 제약이다.
 *
 *  Message.body·Gate 의 question/resolution 처럼 사람이나 에이전트가 자유 형식으로 쓴 텍스트에만
 *  적용한다 — git 요약이나 파일 경로처럼 앱이 구조로 만든 값에는 자격 증명이 섞일 자리가 없다. */
/** 값이 자격 증명처럼 **보이는가**. 두 조건을 함께 요구한다: 공백 없는 16자 이상의 긴 런이고,
 *  영어 낱말과 구별되는 신호(숫자·구분자·대소문자 혼용) 중 하나가 있어야 한다.
 *
 *  **이 게이트가 없으면 redaction 이 워커의 산문을 망친다.** `key[:=]value` 규칙이 값 자리에
 *  `\S+` 를 받던 동안 "Fixed the token: it was being dropped by the interceptor." 가
 *  "Fixed the token=[REDACTED] was being dropped by the interceptor." 가 됐다 — 문장이 뭉개지는
 *  것보다 나쁜 것은, 없던 자격 증명이 있었던 것처럼 **보이게 만드는** 것이다(재개된 에이전트가
 *  존재하지 않는 유출을 쫓는다). 그리고 report body 는 이 Phase 의 중심 자산이다(DESIGN §20).
 *
 *  **대가를 적어 둔다:** `password: hunter2` 같은 짧은 사람 암호는 이제 가려지지 않는다. 그쪽을
 *  잡으려면 값 자리를 다시 넓혀야 하고, 그러면 위의 산문 훼손이 그대로 돌아온다 — 이 기능이 담는
 *  텍스트(워커가 쓴 보고 body)에서 실제로 마주치는 자격 증명은 API 키 모양이므로 그쪽을 택했다. */
function looksLikeSecret(value: string): boolean {
  if (value.length < 16) return false
  return /\d/.test(value) || /[-_+/=]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value))
}

function sanitize(text: string): string {
  // key=value / key: value 형태 — 키 이름에 token/key/secret/password/credential 이 있으면 값을
  // 가린다. 값이 실제로 시작하기 전까지("Credential in use:" 처럼 콜론 뒤에 다른 말이 이어지는
  // 경우) 매치되지 않도록 키 이름과 구분자 사이에는 공백만 허용하고, 값은 looksLikeSecret 을
  // 통과해야 한다 — 통과하지 못하면 매치 전체를 원문 그대로 되돌린다.
  let out = text.replace(
    /\b([\w.-]*(?:api[-_]?key|access[-_]?key|secret|token|password|credential)[\w.-]*)\s*[:=]\s*["']?([A-Za-z0-9_\-+/=.]{16,})["']?/gi,
    (m, key: string, value: string) => (looksLikeSecret(value) ? `${key}=[REDACTED]` : m)
  )
  // Bearer 도 같은 게이트를 쓴다 — 길이만 보면 "Bearer authentication" 이 걸린다.
  out = out.replace(/\bBearer\s+([A-Za-z0-9._\-+/=]{16,})\b/gi, (m, token: string) =>
    looksLikeSecret(token) ? '[REDACTED]' : m
  )
  // key=value 모양이 아니어도 알아볼 수 있는 벤더 토큰 접두어. **접두어만으로는 부족한 것이
  // `sk-` 하나다** — 그 모양은 소문자 Jira 브랜치 이름(`sk-1042-fix-login`)과 구별되지 않아서,
  // 실제 키 길이(sk-ant-…/sk-proj-… 는 40자를 넘는다)를 요구하는 쪽으로 좁혔다. 나머지 셋은
  // 접두어 자체가 산문에 나올 수 없는 모양이라 그대로 둔다.
  for (const re of [
    /\bsk-[A-Za-z0-9_-]{32,}\b/g,
    /\bgh[oprsu]_[A-Za-z0-9]{16,}\b/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    /\bAKIA[0-9A-Z]{12,}\b/g
  ]) {
    out = out.replace(re, '[REDACTED]')
  }
  return out
}
