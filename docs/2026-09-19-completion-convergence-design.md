# Completion Convergence — 워커의 "done"은 제안이고, 완료는 정책이 정한다

워커가 `worker_done`을 보냈다고 Task가 끝나지 않는다. 검사(check)가 실패하면 앱이 **같은 워커에게**
무엇이 틀렸는지 들려주고 고치게 한 뒤 다시 검사하고, 검사가 통과하면 다른 provider의 검토를 받고,
검토가 blocking 이슈를 내면 다시 고치게 한다. 정해진 횟수 안에 수렴하지 않으면 자동 실행을 멈추고
정확한 상태를 사람에게 넘긴다.

이 문서는 업로드된 명세 `ASTERA_COMPLETION_CONVERGENCE_LOOP_IMPLEMENTATION_SPEC_20260919.md`
(이하 **명세**)를 이 저장소의 실제 구조에 맞춰 구현하는 설계다. 명세가 정한 것은 절 번호로 인용하고,
명세가 모르는 이 저장소의 사정은 여기서 결정한다.

## 1. 왜

명세 §0이 요구한 대로 현재 구조를 먼저 조사했다. 뼈대는 이미 있다:

- `TaskStatus`에 `validating`·`reviewing`이 있고, 검증 → 검토 순서가 강제된다 (`state.ts`).
- 재시도는 같은 Task의 새 Dispatch(`Dispatch.retryOf`)이고, `consecutiveFailures`가 3에서 회로를 끊는다.
- 워커 세션은 보고 뒤에도 프롬프트에서 기다린다(spec 파일의 "After reporting, end your turn and wait
  at the agent prompt … new instructions arrive as input"). `--terminal <sessionId>`로 살아 있는
  세션에 새 지시를 써넣는 경로가 있다 (`coordinator.ts`).
- Journal은 OrchState 전후 diff에서 파생되고(`continuity/events.ts`), recovery는 Dispatch 단위로
  유실을 판정한다(`recovery/reconciler.ts`).

빠진 것은 셋이고, 그 셋이 명세의 전부다.

1. **루프의 운전자가 코디네이터 LLM이다.** 검증·검토가 실패하면 Task는 `failed`가 되고 status 메시지
   하나가 남는다. `worker-start --retry-of`를 부를지는 그 메시지를 읽은 코디네이터의 판단이다.
   사이드바로 만든 Run은 전부 코디네이터에게 인계되므로(`run-start`가 `autoDispatch`를 지운다) 제품의
   주 경로가 이렇다. 명세 §1·§6·§55-1: "Completion policy is authoritative", "Agent가 스스로 완료
   판정 — 금지".
2. **진단이 다음 시도에 전달되지 않는다.** `applyValidationResult`의 주석이 자백한다: "buildSpecFile은
   spec 파일에 title과 spec만 싣는다 — 무엇이 틀렸는지 다음 시도에 전달하는 것은 코디네이터의 일이다."
   재시도 워커는 무엇이 실패했는지 모르는 채 같은 일을 다시 한다. 명세 §9.
3. **검토 결과가 pass/fail 이분법이다.** severity도 blocking도 file:line도 없다. 명세 §14·§15.

## 2. 결정

| # | 결정 | 내용 |
|---|---|---|
| D1 | 단위는 Task | check와 워커가 걸리는 단위가 Task다. Run의 완료는 지금처럼 `outcomeOf`가 Task들에서 계산한다. 명세의 "Run 완료"는 여기서 Task 완료다 (§11·§12의 attempt 예시가 Task 단위다) |
| D2 | 앱이 루프를 소유한다 | convergence Run의 Task는 첫 `worker_done` 이후 수렴 또는 소진까지 앱이 책임진다. 코디네이터는 status 메시지로 진행을 읽기만 한다 (§1·§6·§43·§55) |
| D3 | 같은 워커가 고친다 | 구현 Dispatch의 세션이 살아 있으면 그 세션에 fix 요청을 써넣는다. 죽었으면 새 워커에 fix 요청을 spec 절로 붙인다. 문구 생성기는 하나다 (§10) |
| D4 | attempt = Dispatch, 새 상태 없음 | 수리 시도는 `Dispatch.repair`로 표시한 평범한 Dispatch다. 전이 둘(`validating→dispatched`, `reviewing→dispatched`)을 열되 repair Dispatch를 여는 쓰기에서만 허용한다 (§11·§12) |
| D5 | 판정과 repair는 한 번의 쓰기 | 검증 실패가 `failed`를 경유하면 Task 하나인 Run이 순간 `failed`가 되어 `JOB_RUN_FAILED`가 Journal에 박힌다. 그래서 판정과 repair Dispatch 열기는 같은 setState다 |
| D6 | 예산은 `consecutiveFailures` | 새 카운터를 두지 않는다. 검증→검토 경로에서 0으로 되돌리지 않는 기존 규칙이 그대로 예산이다. `maxFixAttempts`는 그 카운터에 대한 **repair 경로의 한도**다 (§13·§55-5) |
| D7 | 소진은 `failed`가 아니라 Gate | 명세 §13의 "[Retry Once] [Mark Failed]"는 Astera에서 Gate options다. jobs.md §6 "실패는 전부 Gate로 보인다"와 같은 규칙 |
| D8 | check = RunConfig id, 목록 | `Task.validateConfigIds: string[]`(순서 있음). 명세 §4.2의 check 종류는 이 앱에서 전부 RunConfig이고, review는 `reviewRequested`다. 새 validation 모델을 만들지 않는다 (§0·§4.2) |
| D9 | 첫 실패에서 멈춘다 | check는 순서대로 돌고 하나가 실패하면 뒤는 `not-run`이다. 재검증 때는 전부 다시 (§7·§17). 명세 §56의 "Build not run"이 이 표시다 |
| D10 | timeout·infra는 repair가 아니다 | `onCannotRun`으로 가는 모든 것(구성 없음, cwd 사라짐, 정지, 2회 timeout)이 Gate다. exit≠0만 코드 실패다 (§19·§20) |
| D11 | 리뷰 결과는 파일로 | 리뷰어는 `<specPath>.review.json`에 이슈를 쓰고 지금처럼 `worker_done`을 보낸다. CLI 변경 없음. blocking은 앱이 severity로 계산한다 (§14·§15) |
| D12 | 켜는 것은 Run, 기본 꺼짐 | `Run.convergence`가 있으면 켜진 것. 새 Run 모달의 체크박스로 명시적으로 켠다. 필드 없는 Run은 지금 동작 그대로 (§41·§42) |
| D13 | Journal은 기존 이름에 얹는다 | 명세 §24의 `completion.*`를 새로 emit하지 않는다. 파생 규약(`TASK_CHECK_*`, `ATTEMPT_*`)을 따르고 셋만 더한다 (§23·§24) |
| D14 | 코디네이터는 말로 비켜 세운다 | 수렴 중인 Task의 네 상태 모두에서 `worker-start`는 이미 거절된다. 바꿀 것은 status 메시지 문구, 가이드, 그리고 `worker-release` 거절 하나다 |
| D15 | Phase 4는 범위 밖 | selective recheck, 진단 file:line 파싱, flaky 자동 판정, RunConfig별 timeout은 하지 않는다 (§54) |

## 3. 범위

P0 = 명세 §54의 Phase 1(결정론적 수리 루프) + Phase 2(검토 수렴) + Phase 3(신뢰성). 명세 §3의
non-goals를 그대로 지킨다 — Agent가 정책을 재정의하지 않고, AI가 임의 shell command를 check로
만들지 않고, merge를 완료 조건에 섞지 않고(§31), human approval을 AI가 대신하지 않는다.

`Mark Complete Anyway`(§30)는 두지 않는다. `task-update --status completed`가 이미 그 탈출구이고,
그것은 코디네이터·사람의 명시적 명령이다.

## 4. 모델

### 4.1 타입 (`core/orchestration/types.ts`)

```ts
/** Run 수준 정책. **있으면 켜진 것이다.** 값이 없는 칸은 아래 상수를 쓴다. */
export interface ConvergencePolicy {
  /** repair를 몇 번까지 여는가. 기본 FAILURE_LIMIT(3) */
  maxFixAttempts?: number
  /** 검토 라운드 상한. 기본 MAX_REVIEW_ROUNDS(2) */
  maxReviewRounds?: number
  /** 이 severity 이상이 blocking. 기본 'high' — critical·high가 막고, medium은 켜면 막는다 (§15) */
  blockingSeverity?: 'high' | 'medium'
}
export const MAX_REVIEW_ROUNDS = 2
/** check 하나의 타임아웃. RunConfig에는 타임아웃 칸이 없으므로 P0는 상수다 (§19) */
export const CHECK_TIMEOUT_MS = 30 * 60_000

export interface CheckResult {
  configId: string
  /** RunConfig.name — 구성이 나중에 지워져도 화면과 fix 요청이 이름을 부를 수 있게 찍어 둔다 */
  name: string
  status: 'passed' | 'failed' | 'timed-out' | 'not-run'
  exitCode?: number
  /** ANSI를 벗긴 마지막 4000자. not-run에는 없다 */
  outputTail?: string
  startedAt?: string
  endedAt?: string
  /** 이 check의 판정이 라운드 사이에서 fail→pass→fail로 흔들렸다 (§18). 자동으로 무시되지 않는다 */
  unstable?: true
}

export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export interface ReviewIssue {
  id: string
  severity: ReviewSeverity
  /** 앱이 정책으로 계산한다. 리뷰어가 쓴 값이 아니다 */
  blocking: boolean
  title: string
  description: string
  file?: string
  line?: number
  suggestedFix?: string
}
```

기존 타입에 더하는 칸:

```ts
interface Run {
  convergence?: ConvergencePolicy
}
interface Task {
  /** 순서대로 도는 check들. validateConfigId는 이 칸이 생기기 전의 Task를 읽을 때만 쓴다 */
  validateConfigIds?: string[]
  /** 마지막 검증 라운드의 check별 결과. 라운드마다 덮어쓴다 — 이력은 Journal과 status 메시지에 */
  checks?: CheckResult[]
  /** configId → 라운드별 판정. unstable 판정의 근거. 길이는 maxFixAttempts+1을 넘지 않는다 */
  checkHistory?: Record<string, ('passed' | 'failed')[]>
  /** 마지막 검토의 이슈 전부, blocking 여부 포함 */
  reviewIssues?: ReviewIssue[]
  /** 사람이 이 Task의 자동 수정을 멈췄다(Stop Auto-Fix). 도는 repair는 끝까지 가고 그 판정은 Gate다 */
  convergenceOff?: true
  /** §38 — 이 attempt가 check의 동작을 바꾸는 파일을 건드렸다. 실패 사유가 아니라 표시다 */
  suspiciousFiles?: string[]
}
interface Dispatch {
  /** 이 Dispatch가 구현이 아니라 수리인가, 그리고 왜. review와 배타적이다 */
  repair?: 'check-failure' | 'review-failure'
}
interface Gate {
  /** 앱이 특별히 다루는 Gate. 소진 Gate의 해소가 retry-once/mark-failed로 갈라진다 */
  kind?: 'convergence-exhausted' | 'convergence-paused' | 'convergence-stopped'
}
```

### 4.2 헬퍼 (`core/orchestration/convergence.ts`, 순수)

```ts
/** 옛 Task의 validateConfigId까지 합친 check 목록. 없으면 빈 배열 */
checkConfigIdsOf(task): string[]
/** 이 Task의 Run에 걸린 정책, 기본값을 채워서. Run에 없으면 null — null이면 지금 동작이다.
 *  Task.convergenceOff는 여기서 보지 않는다: 그것은 "정책이 없다"가 아니라 "사람이 멈췼다"이고,
 *  판정 함수가 따로 읽어 Gate로 보낸다 */
policyOf(state, task): Required<ConvergencePolicy> | null
/** 지금까지 연 repair 수 = repair 표시가 있는 Dispatch 수 */
repairCountOf(state, taskId): number
/** 보고를 낸(outcome 있는) 검토 Dispatch 수. 유실된 검토는 라운드를 먹지 않는다 */
reviewRoundOf(state, taskId): number
/** severity → blocking */
isBlocking(severity, policy): boolean
/** 라운드별 판정에서 fail→pass→fail 또는 pass→fail→pass가 보이는 configId들 */
unstableChecks(history): string[]
/** §38의 파일 목록. package.json, vitest.config.*, jest.config.*, tsconfig*.json, eslint*, biome.json,
 *  .github/workflows/** 에 걸리는 것 */
suspiciousCheckFiles(paths: string[]): string[]
```

저장하지 않고 세는 것들(repair 수, review round)이 명세 §55-5("retry count를 메모리에서만 관리
금지")를 만족하는 이유는 Dispatch가 durable하기 때문이다.

## 5. 상태 기계

새 상태는 없다. 전이 둘을 연다.

```
dispatched ──worker_done──▶ validating ──all pass──▶ reviewing ──no blocking──▶ completed
    ▲                          │                        │
    │        fail & 예산 남음   │      blocking & 예산 남음│
    └──── repair Dispatch ◀────┴────────────────────────┘
                               │                        │
                    예산 소진   ▼                        ▼
                     blocked + Gate(kind: 'convergence-exhausted', options: retry-once | mark-failed)
```

전이표(`ALLOWED`)에 `validating: [..., 'dispatched']`, `reviewing: [..., 'dispatched']`를 더한다.
기존 주석이 이 둘을 금지한 이유는 "검증 결과가 도착할 자리가 사라진다"인데, 그것은 검증이 **도는
중**의 이야기다. 판정이 도착한 뒤에는 성립하지 않는다 — 주석을 그렇게 고친다. 두 전이의 유일한 진입은
`openRepairDispatch`이고, `moveTask`를 직접 부르는 자리는 없다.

### 5.1 판정 함수

```ts
/** 배선이 미리 정해 넘기는 "repair를 어디에 열 것인가". 판정을 **할지**는 순수 층이 정한다. */
type RepairTarget =
  | { kind: 'same-session'; sessionId: string; cwd: string; provider: Provider; accountId: string }
  | { kind: 'fresh'; provider: Provider; accountId: string }

applyValidationResult(s, {
  taskId,
  results: CheckResult[],
  canReview?: boolean,
  repair: RepairTarget
}, now): Res<{ task: Task; repair?: Dispatch }>
```

실패한 결과가 있을 때의 분기, 위에서부터 첫 번째가 이긴다:

| 조건 | 결과 |
|---|---|
| `policyOf(...) === null` (convergence가 없는 Run) | 지금과 같다: `failed`, `consecutiveFailures+1`, "Retry with worker-start --retry-of" 메시지 |
| `task.convergenceOff` | `blocked` + Gate(kind `'convergence-stopped'`), `consecutiveFailures+1`. 사람이 자동 수정을 멈춘 뒤의 실패는 사람에게 |
| `run.paused` | `blocked` + Gate(kind `'convergence-paused'`). 멈춘 회차는 이어지지 않으므로(jobs.md §7) repair를 열지 않는다 |
| `consecutiveFailures + 1 > policy.maxFixAttempts` | **소진**: `blocked` + Gate(kind `'convergence-exhausted'`, options `['retry-once', 'mark-failed']`), `consecutiveFailures+1`. Gate 질문은 §13의 모양 — 몇 번 고쳤고 무엇이 아직 실패하는지 |
| 그 외 | `openRepairDispatch(reason: 'check-failure', target)`, `consecutiveFailures+1`, status 메시지 "The app is repairing this Task (repair k of N)…" |

k번째 연속 실패가 k ≤ maxFixAttempts이면 k번째 repair를 열고, maxFixAttempts+1번째 실패가 소진이다.
명세 §44의 pseudocode(`attempt ≤ maxFixAttempts + 1`)와 같은 셈이다. 기본 3이면 구현 1회 + 수리 3회.

통과한 결과만 있을 때는 지금과 같다(`reviewing` 또는 `completed`; `consecutiveFailures`는 reviewing으로
갈 때 보존, completed에서 0). 어느 갈래든 `Task.checks`와 `checkHistory`를 갱신하고, 결과 요약을
status 메시지에 싣는다.

```ts
applyReviewResult(s, {
  taskId, dispatchId, outcome, subject, body,
  /** 파일에서 읽은 이슈. 파일이 없으면 undefined, 깨졌으면 'malformed' */
  issues?: ReviewIssueInput[] | 'malformed',
  repair: RepairTarget
}, now)
```

- `'malformed'` → `blockForReview` Gate("reviewer output could not be parsed"). 명세 §14의 `error`.
- 이슈 정규화(§6.2)를 거쳐 `Task.reviewIssues`에 싣고 blocking을 계산한다.
- blocking 없음 → `completed`, `consecutiveFailures = 0`. non-blocking 이슈는 화면에만 남는다.
- blocking 있음 → `policyOf`가 null이면 지금처럼 `failed`; `reviewRoundOf + 1 ≥ maxReviewRounds`
  또는 check 예산 소진이면 소진 Gate; 아니면 `openRepairDispatch(reason: 'review-failure', target)`,
  `consecutiveFailures+1`.

```ts
/** validating·reviewing에서 repair Dispatch를 여는 유일한 자리 */
openRepairDispatch(s, {
  taskId, reason, target,
  /** 직전 구현·수리 Dispatch — retryOf로 잇는다 */
  retryOf: string
}, now): Res<Dispatch>
```

`openDispatch`와 다른 점: Task 상태가 `validating`·`reviewing`이어야 하고, **예산을 보지 않는다** —
예산은 부르는 쪽(§5.1의 표, `consecutiveFailures`)이 이미 판정했고, 규칙이 두 곳에 있으면 갈라진다.
`FAILURE_LIMIT` 회로 검사도 없다(회로는 코디네이터 재시도의 예산이다). 같은 sessionId
검사는 그대로다 — 이전 Dispatch가 닫혀 있으니 통과하고, 닫히지 않았다면 거절이 맞다. `same-session`이면
그 sessionId로, `fresh`면 `worker-start`가 쓰는 `pending:<hex>` placeholder로 연다(`isPlaceholder`,
`ATTEMPT_START_REQUESTED`→`ATTEMPT_STARTED`가 그 교체를 이미 안다).

### 5.2 소진 Gate의 해소

`gate-resolve`가 kind `'convergence-exhausted'`인 Gate를 풀 때:

- `retry-once` → `resolveGate`(→ `pending`/`ready`) 뒤 배선이 곧바로 `openDispatch({ repair: <마지막 사유>,
  retryOf, ignoreCircuit: true })`로 repair 하나를 더 연다. 예산과 무관하게 **정확히 하나**다. 그 시도가
  또 실패하면 다시 소진 Gate. fix 요청에는 마지막 실패가 실린다.
- `mark-failed` → `task-update --status failed`와 같은 전이표 우회로 `failed`.
- 그 밖의 답(자유 텍스트) → 지금의 `resolveGate` 그대로(`pending`으로 돌아가 코디네이터/사람이 다시
  띄운다).

`'convergence-paused'`·`'convergence-stopped'` Gate는 보통 Gate처럼 풀린다.

### 5.3 바뀌지 않는 것

- `policyOf`가 null이면 위 함수들은 지금과 **문구까지** 같은 결과를 낸다. 회귀 테스트가 그것을 고정한다.
- 워커가 스스로 `worker_done --outcome failed`를 보낸 것은 check의 판정이 아니다. 지금처럼 검증 없이
  `failed`로 가고 코디네이터·사람이 다시 띄운다 — 명세 §6이 바꾸는 것은 "done"의 뜻이고, 워커 자신이
  "안 됐다"고 하는데 앱이 고치라고 보낼 근거는 없다(`applyWorkerDone`의 기존 주석과 같은 판단).
- check도 review도 없는 Task는 convergence Run에서도 `worker_done`으로 곧바로 `completed`다(§41).

## 6. Fix 요청 (§9·§16·§35·§39)

### 6.1 spec 파일

`buildRepairSpecFile`(`coordinator.ts`, `buildSpecFile`의 형제):

```
# <title>                                  ← 원래 spec 그대로
<spec>
<knowledge 절>                              ← 원래와 같은 목록
<commit obligation>                         ← 워크트리면 그대로
---
## Repair request (assembled by the app — do not delete)

Your previous report for this task did not satisfy the completion checks. This is repair 2 of 3.

### What failed
- Check "Unit tests" (npm test) — exit 1. Output tail:
    …last lines…
- Check "Build" — not run (stopped at the first failure).
   또는
- Review (Codex) found 2 blocking issues:
  1. HIGH — Session invalidation race condition — src/auth/session.ts:42
     …description…  Suggested fix: …

### Rules
Do not redefine the objective. Do not remove, skip or weaken failing tests unless the objective
explicitly requires it. Do not disable lint rules, bypass the build, or change how the checks run.
Fix the failing completion conditions with the smallest correct change — correctness before size.
Astera, not you, decides whether the completion conditions are met: after your fix it re-runs every
check, then review. Do not declare the task complete in your report.
---
## Reporting obligation …                    ← 새 taskId/dispatchId로, 기존 문구
```

check와 리뷰가 둘 다 있으면 둘 다 싣는다(review-failure repair 뒤의 재검증에서 check가 깨진 경우).

### 6.2 두 경로, 한 생성기

- **same-session**: `coordinator.startWorker({ terminal: sessionId, spec: <repair spec>, … })`. `--terminal`
  분기가 이미 spec 파일을 쓰고 `waitUntilIdle` 뒤 한 줄 프롬프트를 PTY에 넣는다. 프롬프트는
  `repairWorkerPrompt(specPath, taskId, dispatchId)` — "Your previous report did not satisfy the
  completion checks. Read ${specPath}: it says what failed and how to report."
- **fresh**: `coordinator.startWorker({ worktree: <원래 Dispatch의 cwd>, retryOf, spec: <repair spec>, … })`.
  서버의 `worker-start`가 하는 placeholder → 실제 세션 커밋과 rollback을 같은 헬퍼로 쓴다.

배선(`ipc.ts`)이 판정 직전에 `RepairTarget`을 계산한다: 마지막 구현·수리 Dispatch를 찾아
`isAlive(sessionId)`면 `same-session`, 아니면 `fresh`. 계정은 그 Dispatch의 것이다 — Task의 체인은
세션 시작 때 정해졌고(가이드 4.3), 같은 Task이므로 같은 체인이다.

## 7. 검사 실행 (`main/orchestration/validator.ts`)

`Pending`이 `configIds: string[]`, `index`, `results: CheckResult[]`, `timedOutOnce: Set<configId>`를
든다. 큐 규율(cwd당 하나, `skip`, `markStopped`, lost-sight 무시, `settling`·`advance`의 identity 검사)은
그대로다.

```ts
interface ValidatorRunner {
  start(a: { cwd; taskId; configId }): Promise<{ runId; name } | 'skip'>
  output(runId): string
  /** timeout이 부른다 — core.run.stop */
  stop(runId): void
}
deps.onSettled({ taskId, results: CheckResult[] })
```

- `configIds[index]`를 띄우고, exit 0이면 `passed`를 기록하고 다음을 띄운다. exit≠0이면 `failed`를 기록하고
  뒤의 것을 `not-run`으로 채워 `onSettled`. 전부 통과하면 `onSettled`.
- **timeout**: check를 띄울 때 `CHECK_TIMEOUT_MS` 타이머. 만료되면 `head.timedOut = true`로 표시하고
  `runner.stop(runId)`. 이어 오는 exit는 `markStopped`와 같은 우선순위로 읽어 `timed-out`으로 기록한다.
  그 configId가 `timedOutOnce`에 없으면 넣고 **같은 check를 한 번 다시** 띄운다(§19). 이미 있으면
  `onCannotRun({ reason: 'check "<name>" timed out twice' })` — Gate다. timed-out은 워커에게 코드
  실패로 전달되지 않는다.
- `onCannotRun`으로 가는 모든 사유(구성 없음, cwd 사라짐, `prepareRun` 예외, 사용자 정지, 2회 timeout)가
  명세 §20의 environment/infrastructure다. 출력을 읽어 npm registry 장애를 알아내는 휴리스틱은 넣지 않는다.
- lost-sight exit는 지금처럼 결과가 아니다. 타이머도 그때 멈추지 않는다 — Host가 살아 있으면 진짜 exit가
  뒤에 오고, 죽었으면 timeout이 그것을 대신 끝낸다.

배선의 `runner.start`는 `prepareRun({ configId })`를 그대로 쓰고 `name`을 함께 돌려준다. `validation: true`
표시도 그대로다.

## 8. 리뷰 구조화 (§14·§15·§33·§34·§36–§38)

### 8.1 리뷰어 spec (`buildReviewSpecFile`)

더하는 절 넷:

- **Checks that ran** — 통과한 check 이름 목록. "Whether the code compiles and the tests run is settled"
  문장이 이 목록을 가리킨다.
- **Previous review round** — 직전 라운드의 이슈(blocking만). "Each of these must be verified as
  addressed; an issue that is still there is a finding."
- **Files that change how the checks run** — `Task.suspiciousFiles`. "Scrutinise these first: a change
  here can make a check pass without making the work correct."
- **Structured verdict** — `<specPath>.review.json`에 아래 모양으로 쓴 뒤 지금처럼 `worker_done`:

```json
{ "issues": [ { "severity": "critical|high|medium|low|info", "title": "…", "description": "…",
                "file": "src/x.ts", "line": 42, "suggestedFix": "…" } ] }
```

"판정 기준을 넓히지 않는다"는 기존 문구(취향으로 반려하지 말라)는 그대로다 — severity는 그 기준 안에서
**얼마나 심각한가**이고, 기준 밖의 것은 `low`/`info`다.

### 8.2 파서와 정규화 (`core/orchestration/review.ts`, 순수)

```ts
parseReviewFile(text): { ok: true; issues: ReviewIssueInput[] } | { ok: false; error: string }
normalizeIssues(a: { outcome; subject; body; issues?: ReviewIssueInput[]; policy }): ReviewIssue[]
```

- 파일 **없음** → 지금 방식: `failed`면 body를 description으로 한 `high` 이슈 하나, `succeeded`면 없음.
- 파일 **깨짐**(JSON 아님, `issues`가 배열이 아님, severity가 다섯 값 밖) → `'malformed'` → Gate.
- **모순은 blocking 쪽이 이긴다**: `succeeded`인데 blocking 이슈가 있으면 blocking으로 다룬다; `failed`인데
  blocking 이슈가 없으면 body로 `high` 이슈를 합성한다. §15 "Agent가 reviewer 결과를 무시하고 complete할
  수 없어야 한다"의 구현이다.
- `id`는 앱이 붙인다(`rvw_<hex>`).

서버의 `send worker_done`(검토 분기)이 `${specPath}.review.json`을 읽어 `applyReviewResult`에 넘긴다.
파일 읽기 실패(권한 등)는 없음으로 다루지 않고 `'malformed'`로 다룬다 — 조용히 통과시키면 "검토됨"과
"검토 못 함"이 같아진다(`blockForReview`의 주석과 같은 이유).

### 8.3 의심 파일 (§38)

repair 또는 구현 Dispatch의 `worker_done`을 받을 때 배선이 `git diff --name-only <baseHead> HEAD`를
그 cwd에서 돈다. `baseHead`는 그 Task의 첫 구현 Dispatch의 체크포인트 HEAD(`CHECKPOINT_CREATED`
row / `stopSnapshot.headCommit`)이고, 없으면 워커가 보고한 `filesModified`를 쓴다. `suspiciousCheckFiles`가
걸러 `Task.suspiciousFiles`에 싣는다. 실패 사유가 아니다 — 리뷰어 spec과 UI 칩과 status 메시지에만 간다.

Completion policy 자체(RunConfig의 내용, `validateConfigIds`)는 앱 store에 있어 워커가 손댈 수 없다.
명세 §37의 snapshot은 구조적으로 이미 만족된다 — 사람이 RunConfig를 Run 도중 고치는 것은 막지 않는다.

### 8.4 라운드와 순서

review-fix 뒤에는 **항상** `validating`(check 전부) → 새 검토 Dispatch(round+1)다(§16). 리뷰어는 매
라운드 새 세션이고(§33 독립 맥락) `pickReviewer`는 그대로다. `reviewRoundOf`가 `maxReviewRounds`에
닿았는데 아직 blocking이면 소진 Gate.

## 9. 코디네이터 격리 (D14)

수렴 중인 Task는 `validating`·`reviewing`·`dispatched`(repair 열림)·`blocked`(Gate) 중 하나이고 넷
모두에서 `worker-start`는 이미 거절된다(`cannot dispatch from status`, `dispatch already open`,
`task is blocked by an open gate`). 그 세션을 `--terminal`로 다른 Task에 쓰는 것도 `sessionId already
in use`로 막힌다. 바꾸는 것:

- **status 메시지 문구.** convergence Run에서 검증·검토 실패 메시지는 "Retry with worker-start
  --retry-of" 대신: *"The app is repairing this Task (repair 2 of 3). Do not start a worker for it — you
  will be told when it converges, or asked through a Gate when it cannot."* body의 기계적 줄
  (`exitCode=`, `repair=`)은 유지한다. 꺼진 Run은 지금 문구.
- **`worker-release` 거절.** Task가 `validating`·`reviewing`이거나 열린 repair Dispatch가 있는 convergence
  Run이면 `409 task is still converging — release after it completes`. 수렴 뒤에는 지금처럼 코디네이터가
  닫는다. 앱이 자동으로 release하는 자리는 만들지 않는다(기존 규칙).
- **가이드와 브리핑.** `orchestration-guide.md`에 "Convergence Runs" 절(위 두 규칙과 "그 Task의 재시도는
  앱의 일이다"), `handover.ts`의 브리핑에 Run이 convergence면 한 단락, `astera help`에 새 플래그.

## 10. Recovery (§23, Case D)

repair Dispatch는 평범한 Dispatch이므로 `candidates`·`decideRecovery`·`executeRecovery`가 그대로
적용된다. 손대는 곳:

- `LostAttempt.appDriven = run.autoDispatch === true || (run.convergence !== undefined && dispatch.repair !== undefined)`.
  repair에 대해서는 앱이 dispatch 권한을 갖는다 — `redispatch`·`smart-resume`가 열린다. 코디네이터 Run의
  첫 구현 attempt는 지금처럼 review Gate다.
- `LostAttempt.hasValidateConfig = checkConfigIdsOf(task).length > 0`.
- `executeRecovery`의 `startWorker`가 `retryOf`와 함께 `repair` 표시를 이어받는다(유실된 repair의 재시도도
  repair다). fix 요청은 `retryOf` Dispatch의 spec 파일에 이미 있으므로 다시 만들지 않고 그 파일을 쓴다 —
  `resume-native`는 그 대화가 이어지고, `smart-resume`의 briefing은 그 spec 뒤에 붙는다.
- same-session 쓰기 경로도 `onPromptWrite`로 `PROMPT_WRITE_REQUESTED/CONFIRMED`를 남긴다(`via:
  'terminal'`). "repair Dispatch를 열었는데 프롬프트를 쓰기 전에 죽었다"가 결정표의 "the prompt never
  left the app → redispatch(safe)" 행에 걸린다.
- **부팅 시 중단된 검증**(`OrchestrationStore.load` → `interruptStalledTask`): convergence Run이면 Gate를
  열지 않고 검증을 다시 큐에 넣는다 — check는 멱등이고 Case D가 요구하는 것이 "validation safely
  resume/retry"다. 중단된 **검토**는 리뷰어 세션이 죽었으니 새 검토 Dispatch를 연다(`reviewRoundOf`가
  outcome 있는 것만 세므로 라운드를 먹지 않는다). 꺼진 Run은 지금처럼 Gate.
- **중복 없음**(§25): 판정 하나에 setState 하나. `applyValidationResult`는 Task가 `validating`이 아니면
  거절한다(이미). 두 번 온 exit는 `settling`이 막는다(이미). Journal 키는 기존 규칙(dispatch id·`now`).

## 11. 한도, 정지, 일시 중지 (§21·§22·§46–§48)

- **Usage limit / account rolling** — 공짜다. repair Dispatch는 같은 세션에 있고 그 세션의 롤링 체인은
  시작 때 등록됐다. 롤이 나면 `rekeyDispatch`가 열린 repair Dispatch를 새 세션으로 옮기고 `ResumeEntry`를
  남긴다. "account rolling은 같은 attempt"(§22)가 attempt = Dispatch에서 저절로 나온다. fresh 경로는
  `startWorker`를 쓰므로 체인을 같이 넘긴다. 리셋 대기(§48)는 `stopSnapshot.reason: 'waiting'`으로 이미
  화면에 보인다.
- **질문**(§21) — repair 워커의 `ask`는 보통 Dispatch의 것과 같다. Task는 `dispatched`이고 attempt 번호는
  Dispatch이므로 유지된다.
- **Cancel**(§46) — `worker-stop`이 repair Dispatch를 `closedBy: 'stop'`으로 닫고 스윕이 건너뛴다(지금
  규칙). 도는 check의 정지는 `run.stop → markStopped → Gate`(지금 규칙). `run-delete`는 지금처럼.
- **Pause**(§47) — 이 앱의 pause는 예약 회차에만 있고 "멈춘 회차는 이어지지 않는다"(jobs.md §7). §47의
  "같은 attempt로 재개"는 대응물이 없다. 보장하는 것 하나: **멈춘 Run에서 repair를 열지 않는다**(§5.1의
  두 번째 행). 멈추기가 열린 repair Dispatch를 `closedBy: 'pause'`로 닫는 것은 지금 규칙.

## 12. Journal과 Timeline (§23·§24·§28)

Journal은 파생이고 대문자 스네이크가 규약이다. 명세 §24의 이름을 새로 emit하지 않고 이렇게 대응한다:

| 명세 §24 | 이 앱 |
|---|---|
| `completion.attempt.started` | `ATTEMPT_START_REQUESTED` payload에 `repair: 'check-failure' \| 'review-failure' \| null` |
| `completion.check.started/passed/failed` | 기존 `TASK_CHECK_STARTED/PASSED/FAILED`; PASSED/FAILED payload에 `checks: {configId, status, exitCode}[]` (출력은 싣지 않는다) |
| `completion.review.started` | 새 `TASK_REVIEW_STARTED` (→`reviewing`) |
| `completion.review.approved` | 새 `TASK_REVIEW_PASSED` (`reviewing→completed`) |
| `completion.review.changes_requested` | 새 `TASK_REVIEW_CHANGES_REQUESTED` (`reviewing→dispatched` with repair; payload에 이슈의 severity/title/blocking) |
| `completion.exhausted` | 새 `TASK_CONVERGENCE_EXHAUSTED` (kind `'convergence-exhausted'` Gate로 `blocked`될 때; payload에 repairs, reviewRounds, 남은 실패 요약). 기존 `TASK_WAITING_INPUT`도 함께 |
| `completion.fix.requested/started/resumed/completed` | 기존 `ATTEMPT_*`와 `PROMPT_WRITE_*` |
| `completion.waiting_for_user` | 기존 `TASK_WAITING_INPUT` |
| `completion.converged` | 기존 `TASK_COMPLETED` |
| `completion.policy.loaded` | 없음 — 정책은 Run에 있고 `JOB_RUN_STARTED` payload에 `convergence`를 싣는다 |

`taskTransitionEvents`가 `from === 'reviewing'`을 새로 본다. idempotencyKey 규칙은 그대로.

**Timeline**(`timeline.ts`)은 status 메시지의 subject와 Dispatch 시작을 그린다. subject를 사람 문장으로:

```
Checks failed: Unit tests (2 of 3 ran)
Sent failures back to Claude (repair 1 of 3)
All 3 checks passed
Codex review found 1 blocking issue
Sent review issues back to Claude (repair 2 of 3)
Review approved
Completion loop exhausted after 3 repairs
```

repair Dispatch의 `dispatch-started` 이벤트는 `JobEvent`에 `repair` 표시를 실어 렌더러가 "수리 시작"으로
구별해 그린다. 코디네이터가 읽는 body는 기계적 줄을 유지한다.

§49 metrics는 Journal에서 센다. telemetry는 보내지 않는다.

## 13. UI (§27–§29)

### 13.1 켜기 — `NewRunModal`

동시성·코디네이터 계정·예약 옆에 체크박스 "완료 수렴 — 검사가 실패하면 앱이 같은 워커에게 고치게 하고
다시 검사합니다". 기본 꺼짐(§42). `run-create --convergence`. 숫자 셋은 CLI 플래그만(`--max-fix-attempts`,
`--max-review-rounds`, `--blocking-severity`).

### 13.2 check 목록 — `NewTaskModal`

단일 셀렉트를 체크 목록으로. 고른 순서를 번호 칩으로 보여 주고 그 순서가 실행 순서다.
`task-create --validate a,b,c`(쉼표 목록 — `--files-modified`·`--options`의 규약).

### 13.3 투영 — `JobTask.convergence?` (`view.ts`의 `jobTaskOf`, convergence Run에서만)

```ts
convergence?: {
  repairs: number; maxFixAttempts: number
  reviewRound: number; maxReviewRounds: number
  /** 지금 열린 Dispatch가 repair면 그 사유 */
  repairing: 'check-failure' | 'review-failure' | null
  checks: { configId; name; status; exitCode?; summary /* outputTail 마지막 3줄 */; unstable?: true }[]
  blockingIssues: { severity; title; file?; line? }[]
  nonBlockingCount: number
  suspiciousFiles: string[]
  /** 소진 Gate가 열려 있으면 그 요약 */
  exhausted?: string
  stopped: boolean  // convergenceOff
}
```

outputTail 전체는 싣지 않는다 — 스냅숏은 사이드바 푸시마다 간다. 펼쳐 볼 때는 `orch.command(...,
'task-show')`로 받는다.

### 13.4 Job 상세 — `RunDetail`

- 노드 `meta` 줄: repair 중 "수리 2/3 · Claude", `validating` "검사 중", `reviewing` "검토 라운드 1/2".
- 노드 아래 check 칩 한 줄: ✓ ✗ ● ○ (passed / failed·timed-out / 도는 중 / not-run). 툴팁 = 이름과 summary.
  unstable은 칩에 `~`.
- 노드를 고르면 `.detail-events` 위에 **Completion 블록**(§27): check 목록과 상태, "수리 2 / 3",
  "검토 라운드 1 / 2", blocking 이슈(severity · 제목 · file:line), non-blocking 개수, unstable·의심 파일 칩,
  마지막 실패 요약(펼치면 outputTail — `task-show`).
- 버튼(§29): **자동 수정 중지** → `task-update --convergence off`. 도는 repair는 끝까지 가고 그 판정은
  `'convergence-stopped'` Gate. **다시 시도** = 기존 띄우기/다시 띄우기. **실패 보기** = 블록 펼침 + 워커
  세션 탭 점프(기존 jump). 소진 Gate의 retry-once / mark-failed는 기존 **답하기**가 `gate.options`를
  버튼으로 그린다 — 새 UI 없음.

### 13.5 사이드바 — `JobsView`

repair 중인 Task는 열린 Dispatch가 있어 이미 줄이다. "수리 2/3" 칩만 더한다. `validating`은 지금처럼
접힌 수에만.

### 13.6 문구

Gate 질문은 recovery처럼 `t(lang, key)`로 만든다(기존 검증 Gate의 한국어 하드코딩은 그쪽의 알려진 후속).
앱이 조립하는 오케스트레이션 문자열(status 메시지, fix 요청, spec 절)은 규약대로 영어. i18n 키는
en/es/ja/ko 넷.

## 14. 서버·CLI 변경 목록

| 명령 | 변경 |
|---|---|
| `run-create` | `--convergence`, `--max-fix-attempts N`, `--max-review-rounds N`, `--blocking-severity high\|medium` → `Run.convergence` |
| `task-create` | `--validate` 쉼표 목록 → `validateConfigIds`. 단일 값도 목록으로 저장 |
| `task-update` | `--convergence off` → `Task.convergenceOff` |
| `task-show` / `task-list --json` | `checks`, `reviewIssues`, `suspiciousFiles`, `convergenceOff` 노출 |
| `run-show --json` | `convergence` 노출 |
| `worker-release` | 수렴 중 409 (§9) |
| `send --type worker_done` (검토) | `${specPath}.review.json` 읽기 → `applyReviewResult` |
| `gate-resolve` | kind `'convergence-exhausted'`의 retry-once / mark-failed 처리 (§5.2) |
| `help` | 위 플래그 문서화, Convergence Runs 단락 |

배선(`ipc.ts`): `RepairTarget` 계산, repair 열기 뒤 `startWorker`(terminal 또는 fresh) + rollback,
`suspiciousFiles` 계산, validator의 새 runner 계약, 부팅 시 중단 검증 재실행.

## 15. 테스트 (§50–§52)

| 파일 | 고정하는 것 |
|---|---|
| `state.test.ts` | check 전부 통과 / 하나 실패 → 같은 세션 repair Dispatch(`retryOf`·`repair`·같은 sessionId) / fresh는 placeholder / 여러 실패 / 예산 소진 → Gate(kind·options) / **꺼진 Run은 지금과 같은 `failed`와 문구** / `convergenceOff` → Gate / 멈춘 회차 → Gate / check→review→check 경로의 `consecutiveFailures` / blocking 임계값 high·medium / outcome-이슈 모순 규칙 / malformed → Gate / review round 상한 / retry-once는 정확히 하나 / `canTransition` 표(`validating→dispatched` 허용, `moveTask` 직접 호출 없음) |
| `convergence.test.ts` | `checkConfigIdsOf`(옛 `validateConfigId` 병합), `policyOf`, `repairCountOf`, `reviewRoundOf`(유실 검토 제외), `unstableChecks`, `suspiciousCheckFiles` |
| `review.test.ts` | `parseReviewFile` 정상/깨짐, `normalizeIssues`의 세 규칙 |
| `validator.test.ts` | 순서 실행, 첫 실패에서 멈춤과 `not-run`, timeout → stop → `timed-out` → 1회 재시도 → 2회째 `onCannotRun`, lost-sight 무시와 `markStopped` 우선은 그대로 |
| `events.test.ts` | `TASK_REVIEW_*`, `TASK_CONVERGENCE_EXHAUSTED`, `ATTEMPT_START_REQUESTED.repair`, 같은 diff 두 번 → 같은 idempotencyKey |
| `server.test.ts` | 수렴 중 `worker-release` 409, convergence 여부별 status 문구, `.review.json` 있음/없음/깨짐, `--validate a,b`, `run-create --convergence`, `task-update --convergence off`, `gate-resolve` retry-once/mark-failed, 기존 `worker-start` 거절 경로 불변 |
| `decide.test.ts` / `execute.test.ts` / `reconciler.test.ts` | repair Dispatch의 `appDriven` → redispatch 허용, `hasValidateConfig`가 목록을 읽음, 재시도가 `repair`를 이어받음 |
| `store.test.ts` | 부팅 시 convergence Run의 중단 검증은 Gate 없이 재실행, 중단 검토는 새 검토 Dispatch |
| `view.test.ts` / `timeline.test.ts` | `JobTask.convergence` 투영, repair 시작 이벤트의 요약 문장 |
| `coordinator.test.ts` | `buildRepairSpecFile`의 절 구성(check·리뷰·둘 다), `buildReviewSpecFile`의 새 절 넷 |
| **`convergence.integration.test.ts`** | §51 — A 검사 실패→수리→통과→검토→완료 · B 검토 blocking→수리→검사→검토→완료 · C 수리 중 한도 → `rekeyDispatch` → 같은 Dispatch가 이어짐 · D 검증 중 크래시 → `store.load` → 재실행, repair 중복 없음 · E 소진 → Gate, 더 이상 dispatch 없음. 서버 층에서 가짜 `ValidatorRunner`·가짜 코디네이터(`server.test.ts`의 가짜 재사용) |

회귀(§52): 기존 스위트 전부 그대로 통과. `convergence`가 없는 Run의 결과가 문구까지 지금과 같다는
명시적 테스트. 완료 판정은 `npm run typecheck`·`npm test`·`npm run build`.

## 16. 구현 순서

1. **순수 층** — 타입, `convergence.ts` 헬퍼, `review.ts` 파서, `state.ts`의 판정 함수와
   `openRepairDispatch`, 전이표, 테스트. 여기까지는 배선 없이 전부 검증된다.
2. **validator** — 목록 실행, timeout, 새 runner 계약.
3. **repair 배선** — `RepairTarget`, `buildRepairSpecFile`, `startWorker` terminal/fresh 호출과 rollback,
   status 문구, `worker-release` 거절, `run-create`/`task-create`/`task-update` 플래그.
4. **리뷰 구조화** — 리뷰어 spec 절 넷, `.review.json` 읽기, `suspiciousFiles` 계산.
5. **신뢰성** — recovery의 `appDriven`·`hasValidateConfig`·repair 이어받기, 부팅 시 재실행,
   Journal 이벤트 셋, Timeline 문장.
6. **UI** — 투영, `NewRunModal`·`NewTaskModal`·`RunDetail`·`JobsView`, i18n 넷.
7. **문서** — `docs/jobs.md`, `orchestration-guide.md`, `handover.ts`, `help`.
8. **통합 테스트** — §51 A–E.

1은 2·3과 독립이고, 4는 3 뒤, 5는 3 뒤, 6은 1 뒤 언제든, 8은 전부 뒤다.

## 17. 명세 §53 수용 기준 대응

| 명세 | 이 문서 |
|---|---|
| Worker "done"만으로 완료하지 않는다 | §5 — `validating`/`reviewing`을 거치지 않는 완료는 check·review가 없는 Task뿐 |
| Completion Policy가 authoritative | D2, §5.1 |
| 실패 → repair loop, repair 후 재검사 | §5.1, §6, §8.4 |
| blocking 이슈 → repair, 그 뒤 check 재실행 | §5.1 `applyReviewResult`, §8.4 |
| max attempt/budget | D6, §5.1 세 번째 행, §8.4 |
| Journal 기록, crash 복구, 중복 없음 | §10, §12 |
| usage limit + Smart Resume | §11 |
| pause/resume/cancel | §11 (pause는 이 앱의 의미로) |
| check config를 Agent가 약화할 수 없다 | §8.3 — 정책은 앱 store에 있다 |
| anti-gaming signal을 review에 전달 | §8.1·§8.3 |
| infra vs code | D10, §7 |
| flaky를 자동 무시하지 않는다 | §7 `unstable`, §13.4 |
| exhausted에서 자동 실행 중단 | §5.1·§5.2 — Gate가 풀릴 때까지 아무것도 띄우지 않는다 |
| UI: 상태·attempt·round·요약·Timeline·버튼 셋 | §12, §13 |
| unit / integration / regression / typecheck / test / build | §15 |
