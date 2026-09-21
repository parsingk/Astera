// 완료 수렴의 순수 판별들. state.ts 의 판정 함수와 main 의 배선이 함께 쓴다 — 규칙을 한 곳에 두어
// "몇 번째 repair 인가" 를 두 곳에서 다르게 세는 일이 없게 한다. 저장하지 않고 센다: Dispatch 가
// durable 하므로 카운트도 durable 하다(명세 §55-5).
import type { OrchState } from './state'
import {
  FAILURE_LIMIT,
  HISTORY_MAX,
  MAX_REVIEW_ROUNDS,
  type CheckResult,
  type Dispatch,
  type ReviewSeverity,
  type Task
} from './types'

export interface ResolvedPolicy {
  maxFixAttempts: number
  maxReviewRounds: number
  blockingSeverity: 'high' | 'medium'
  /** 없으면 시간 예산이 없다. 기본값을 두지 않는 유일한 칸 — 나머지 셋은 정책이 말하지 않아도
   *  앱의 기본이 있지만, 시간 상한은 "말하지 않았으면 없다" 가 맞다(명세 §40 은 optional 이다). */
  maxTotalMinutes?: number
}

/** 정책이 심각도를 정하지 않았을 때의 기본 — policyOf 와 새 Run 모달의 기본값 표시가 같은 값을 읽는다.
 *  리터럴 'high' 를 두 곳에 박으면 상수가 바뀌는 날 화면이 거짓말한다. */
export const DEFAULT_BLOCKING_SEVERITY: ResolvedPolicy['blockingSeverity'] = 'high'

/** 옛 Task 의 validateConfigId 까지 합친 check 목록. 없으면 빈 배열 */
export function checkConfigIdsOf(task: Pick<Task, 'validateConfigIds' | 'validateConfigId'>): string[] {
  if (task.validateConfigIds?.length) return task.validateConfigIds
  return task.validateConfigId ? [task.validateConfigId] : []
}

/** 이 Task 의 Run 에 걸린 정책, 기본값을 채워서. Run 에 없으면 null — null 이면 지금 동작이다.
 *  **Task.convergenceOff 는 여기서 보지 않는다**: 그것은 "정책이 없다" 가 아니라 "사람이 멈췼다" 이고,
 *  판정 함수가 따로 읽어 Gate 로 보낸다(설계 §5.1). */
export function policyOf(s: OrchState, task: Pick<Task, 'runId'>): ResolvedPolicy | null {
  const run = s.runs.find((r) => r.id === task.runId)
  if (!run?.convergence) return null
  return {
    maxFixAttempts: run.convergence.maxFixAttempts ?? FAILURE_LIMIT,
    maxReviewRounds: run.convergence.maxReviewRounds ?? MAX_REVIEW_ROUNDS,
    blockingSeverity: run.convergence.blockingSeverity ?? DEFAULT_BLOCKING_SEVERITY,
    ...(run.convergence.maxTotalMinutes !== undefined ? { maxTotalMinutes: run.convergence.maxTotalMinutes } : {})
  }
}

/** 예산을 먹은 repair 수 — **판정을 냈거나 아직 도는 것만** (설계 G1, 명세 §47·§22).
 *
 *  바로 아래 `reviewRoundOf` 가 이미 이 규칙이다("유실된 검토는 라운드를 먹지 않는다"). 이 함수만
 *  그것을 어기고 있었다: 일시정지가 닫은 수리도(`closedBy: 'pause'`), 사람이 멈춘 수리도(`'stop'`),
 *  앱이 죽어 판정 없이 끝난 수리도 예산을 한 칸씩 먹었다. 그 시도들은 **판정을 낼 기회를 받지
 *  못했다** — 고칠 수 있었는지 없었는지를 아무도 모르는데 "고쳐 봤다" 로 세는 것은 거짓이고, 소진
 *  Gate 의 "N 번 고쳤습니다" 도 같이 거짓이 된다.
 *
 *  **아직 도는 수리는 판정이 없어도 센다.** 빼면 앱이 그 옆에 두 번째 수리를 연다 — 이 수가 "지금
 *  열어도 되는가" 를 정하는 데 쓰이기 때문이다(`routeFailure`). */
export const repairCountOf = (s: OrchState, taskId: string): number =>
  s.dispatches.filter(
    (d) => d.taskId === taskId && d.repair !== undefined && (d.outcome !== undefined || d.endedAt === undefined)
  ).length

/** 보고를 낸(outcome 있는) 검토 Dispatch 수. 유실된 검토는 라운드를 먹지 않는다 */
export const reviewRoundOf = (s: OrchState, taskId: string): number =>
  s.dispatches.filter((d) => d.taskId === taskId && d.review === true && d.outcome !== undefined).length

/** 검토가 아닌 것 중 가장 늦게 시작한 Dispatch — repair 가 이어받을 세션과 retryOf 의 출처 */
export const latestImplDispatch = (s: OrchState, taskId: string): Dispatch | undefined =>
  s.dispatches
    .filter((d) => d.taskId === taskId && !d.review)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1)

const RANK: Record<ReviewSeverity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 }

export const isBlocking = (severity: ReviewSeverity, policy: ResolvedPolicy): boolean =>
  RANK[severity] >= RANK[policy.blockingSeverity]

/** 라운드 결과를 이력에 붙인다. passed·failed 만 판정이다 — not-run 과 timed-out 은 그 check 에 대해
 *  아무것도 말하지 않는다. 길이는 HISTORY_MAX 를 넘지 않는다. */
export function appendHistory(
  history: Record<string, ('passed' | 'failed')[]> | undefined,
  results: CheckResult[]
): Record<string, ('passed' | 'failed')[]> {
  const next: Record<string, ('passed' | 'failed')[]> = { ...(history ?? {}) }
  for (const r of results) {
    if (r.status !== 'passed' && r.status !== 'failed') continue
    next[r.configId] = [...(next[r.configId] ?? []), r.status].slice(-HISTORY_MAX)
  }
  return next
}

/** fail→pass→fail 또는 pass→fail→pass 가 한 번이라도 보이는 check 들(명세 §18). 자동으로 무시하지 않는다 */
export function unstableChecks(history: Record<string, ('passed' | 'failed')[]>): string[] {
  return Object.entries(history)
    .filter(([, h]) => h.some((v, i) => i >= 2 && h[i - 2] === v && h[i - 1] !== v))
    .map(([id]) => id)
}

/** check 의 동작을 바꿀 수 있는 파일들(명세 §38). 실패 사유가 아니라 리뷰어와 화면에 보내는 표시다 */
const SUSPICIOUS: RegExp[] = [
  /(^|\/)package\.json$/,
  /(^|\/)vitest\.config\.[cm]?[jt]s$/,
  /(^|\/)jest\.config\.[cm]?[jt]s$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)\.?eslint[^/]*$/,
  /(^|\/)biome\.json$/,
  /(^|\/)\.github\/workflows\//
]
export const suspiciousCheckFiles = (paths: string[]): string[] =>
  paths.filter((p) => {
    const posix = p.replace(/\\/g, '/')
    return SUSPICIOUS.some((re) => re.test(posix))
  })

/** 시간 예산을 넘겼는가 (설계 G2, 명세 §40).
 *
 *  예산이 없거나 시계가 아직 시작하지 않았으면 언제나 거짓 — 둘 다 "잴 것이 없다" 이고, 그것을
 *  넘김으로 읽으면 예산을 켠 적 없는 Run 이 첫 실패에서 소진된다.
 *
 *  경계는 **넘었을 때**다(`>`). 정확히 예산만큼 걸린 수리는 예산 안이다. */
export function timeBudgetExceeded(
  task: Pick<Task, 'convergenceStartedAt'>,
  policy: ResolvedPolicy,
  nowMs: number
): boolean {
  if (policy.maxTotalMinutes === undefined) return false
  if (task.convergenceStartedAt === undefined) return false
  const started = Date.parse(task.convergenceStartedAt)
  // 손으로 고친 orchestration.json 에서만 나온다. 못 읽는 시각으로 예산을 끊지 않는다.
  if (Number.isNaN(started)) return false
  return nowMs - started > policy.maxTotalMinutes * 60_000
}

/** 이 Task 를 completed 로 옮기는 것이 **완료 강제**인가 (설계 G4, 명세 §30).
 *
 *  강제란 "완료 정책이 걸려 있는데 그것을 만족하지 않은 채 완료로 옮기는 것" 이다. 이 앱은 그 버튼을
 *  따로 두지 않고 `task-update --status completed` 를 그 자리로 쓴다(백엔드 설계 §3) — 비어 있던 것은
 *  버튼이 아니라 **기록**이었다. 그래서 이 판정이 필요하다: 평범한 손보기와 강제를 가르는 선.
 *
 *  정책이 없으면 강제가 아니다. 걸린 검사도 검토도 없으면 만족할 것이 없으니 역시 아니다. 검사가 아직
 *  한 번도 돌지 않았으면 **강제다** — 통과를 본 적이 없다는 점에서 실패와 같다. */
export function isOverrideCompletion(
  task: Pick<Task, 'checks' | 'reviewIssues' | 'validateConfigIds' | 'validateConfigId' | 'reviewRequested'>,
  policy: ResolvedPolicy | null
): boolean {
  if (policy === null) return false
  const wantsChecks = checkConfigIdsOf(task).length > 0
  const wantsReview = task.reviewRequested === true
  if (!wantsChecks && !wantsReview) return false
  if (wantsChecks) {
    // 한 번도 안 돌았거나, 마지막 라운드에 통과 아닌 것이 있으면 수렴하지 않았다
    if (!task.checks || task.checks.length === 0) return true
    if (task.checks.some((c) => c.status !== 'passed')) return true
  }
  if (wantsReview && (task.reviewIssues ?? []).some((i) => i.blocking)) return true
  // 검토를 요구했는데 아직 한 번도 받지 않았다 — 검사만 통과한 상태다
  if (wantsReview && task.reviewIssues === undefined) return true
  return false
}

/** 완료 정책의 지문 (설계 G3, 명세 §37).
 *
 *  **해시가 아니라 정규 문자열이다.** 설계는 `policyHash` 라고 적었지만 해시로 줄이면 충돌이 곧
 *  "정책이 바뀌었는데 못 봤다" 가 되고, 그 실패는 조용하다. 검사 두세 개짜리 정책의 문자열은 200자
 *  남짓이라 줄여서 얻을 것이 없고, 대신 저널에 남은 값을 사람이 읽을 수 있다.
 *
 *  담는 것은 **판정을 바꿀 수 있는 것만**이다(B6). 검사 구성은 `seedKeyOf` 로 찍는다 — 그 함수가
 *  이미 "타입 + 이 구성을 그것이게 하는 핵심 값" 이고 이름·폴더처럼 판정과 무관한 칸을 뺀다. 이름만
 *  고쳐도 "정책이 바뀌었다" 가 뜨면 이 표시는 곧 무시된다.
 *
 *  검사 목록은 **순서 그대로**다. 검사는 고른 순서로 돌고 첫 실패에서 멈추므로 순서가 판정을 바꾼다.
 *
 *  `keyOf` 가 null 을 주는 구성(지워졌다)은 `?` 로 남긴다 — 지워진 것과 바뀐 것을 구별하지 않는다:
 *  둘 다 "그 라운드에 돌던 것이 지금 없다" 이고 사람이 볼 이유도 같다. */
export function completionPolicyHash(
  task: Pick<Task, 'validateConfigIds' | 'validateConfigId' | 'reviewRequested'>,
  policy: ResolvedPolicy,
  keyOf: (configId: string) => string | null
): string {
  const budget = [
    policy.maxFixAttempts,
    policy.maxReviewRounds,
    policy.blockingSeverity,
    policy.maxTotalMinutes ?? '-'
  ].join('/')
  const checks = checkConfigIdsOf(task)
    .map((id) => `${id}=${keyOf(id) ?? '?'}`)
    .join(',')
  return `${budget}|${task.reviewRequested === true ? 'review' : 'no-review'}|${checks}`
}
