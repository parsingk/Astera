# 통과할 때까지 자동 수정 — UI 첫 조각: 켜기와 보이기

Plan 1(`2026-09-19-completion-convergence-design.md`)이 만든 루프는 지금 **CLI로만 켤 수 있고, 켜도
화면에 아무것도 보이지 않는다.** 이 문서는 그 둘을 푸는 첫 조각이다 — 새 Run/Task 모달에서 켜고
검사를 고르게 하고, Task 노드와 사이드바에 진행을 보이게 한다. Completion 블록·버튼 셋·`docs/jobs.md`는
다음 조각이다(§8).

시안: https://claude.ai/artifact/PoESDLoaGqdu4LgFrhJ5Eq

## 1. 결정

| # | 결정 | 내용 |
|---|---|---|
| U1 | 범위는 켜기 + 보이기 최소선 | 모달 둘, 투영, 노드·사이드바 칩. 상세 블록·버튼·문서는 다음 조각 |
| U2 | 검사 결과는 모든 Run에 기록한다 | Plan 1 Task 4의 "수렴 Run에만 기록" 판정을 **뒤집는다.** `--validate`만 쓰는 기존 Job도 어느 검사가 깨졌는지 화면에서 봐야 한다. 대신 통과한 검사의 출력 꼬리는 저장하지 않는다 |
| U3 | 투영은 두 칸 | `JobTask.checks`(검사 있는 모든 Task)와 `JobTask.convergence`(정책 있는 Run만). 합치면 비수렴 Run이 의미 없는 예산 숫자를 들고 다닌다 |
| U4 | 스냅숏에는 칩이 그리는 것만 | 요약·이슈·의심 파일·출력 꼬리는 싣지 않는다. 사이드바 푸시마다 나가는 스냅숏이다 |
| U5 | 칩 줄은 meta 줄과 따로 | Gate가 열려 meta가 질문을 그릴 때도 무엇이 깨졌는지 함께 보이게 |
| U6 | 칩은 통과한 것까지 전부 | 몇 개 중 몇 개가 끝났고 어디서 멈췼는지 한눈에. 검사가 많은 Task는 시안의 `Telemetry opt-out` 카드가 그 한계를 보인다 |
| U7 | meta 줄이 막힌 검사 이름을 말한다 | 사람이 알아야 할 것은 provider보다 어느 검사가 막혔는가. provider는 칩 툴팁으로 |
| U8 | 검사 순서는 클릭 + ↑↓ | 첫 실패에서 멈추므로 순서가 비용을 좌우한다. 드래그는 이 모달에 선례가 없다 |
| U9 | 예상 시간은 모달에서 뺀다 | 새 Task는 한 번도 안 돌았으니 지어낼 근거가 없다. 대신 `CheckResult.startedAt/endedAt`으로 칩 툴팁에 지난 라운드의 실제 시간을 붙인다 |
| U10 | 한국어는 수정·통과 | 코드는 수리하지 않고 수정한다. 문장에서는 "수렴하지 않았다"가 아니라 "통과하지 못했다". 이름표는 결과만 말하는 "통과"가 아니라 켜면 무슨 일이 생기는지 말하는 "통과할 때까지 자동 수정". 코드 식별자(`convergence`, `repair`)는 영어로 그대로 |
| U11 | 화면이 필요한 판정은 core에 | 렌더러에는 테스트가 없다(`vitest`가 `environment: 'node'`). meta 줄 우선순위와 사이드바 칩 종류를 순수 함수로 빼서 거기서 테스트한다 — `view.ts` 머리말이 정한 규칙 |
| U12 | 도는 검사는 모른다고 말한다 | validator는 라운드 끝에 한 번 결과를 준다. 도는 동안 화면이 아는 것은 **지난 라운드**뿐이므로 "지금 도는 검사"를 지어내지 않고, 지난 라운드에 막힌 검사를 "다시 검사 중"으로 가리킨다 |

## 2. 투영

### 2.1 기록 — `state.ts`

`applyValidationResult`가 `checks`·`checkHistory`를 **정책이 없는 Run에도** 기록한다. 지금은
`history/unstable/checks/recorded` 넷이 `if (policy === null) {…}` 갈래 **뒤**에 있어 그 갈래가 `task`를
그대로 옮긴다. 넷을 갈래 앞으로 올리고, 그 갈래의 `moveTask(task, to, now)`를 `moveTask(recorded, to, now)`로
바꾼다. "checks·checkHistory 는 여기서 기록하지 않는다" 주석 둘도 함께 바뀐다.

**통과한 검사의 `outputTail`은 `Task.checks`에 싣지 않는다.** 툴팁에 쓸모없고 용량의 대부분이다.
`checkHistory`는 configId마다 `'passed'|'failed'` 배열만 들고 있어 손댈 것이 없다.

스트립은 **기록 직전**에 한다 — validator는 그대로 잡는다. 이유: 정책 없는 Run의 "validation passed"
status 메시지 body가 그 출력을 싣고(`exitCode=0. …\n${output}`, `output`은 `a.results`에서 앞서 계산된다)
코디네이터가 읽는다. validator에서 빼면 그 문구가 바뀌어 Plan 1이 열한 Task에서 지킨 호환성 보장이 깨진다.

```ts
// state.ts — recorded 를 만들 때. 키를 아예 빼서 상태 파일에 "outputTail": undefined 가 남지 않게.
const checks: CheckResult[] = a.results.map((r) => {
  const { outputTail, ...rest } = r
  const kept = r.status === 'passed' ? rest : { ...rest, ...(outputTail !== undefined ? { outputTail } : {}) }
  return unstable.has(r.configId) ? { ...kept, unstable: true } : kept
})
```

`Task.checks`의 다른 소비자 — `failureSummary`, repair spec(`repair.ts`), 리뷰어 spec — 는 실패한 검사만
읽으므로 영향이 없다. 비수렴 Run에도 `unstable`이 붙을 수 있다(`worker-start --retry-of`로 실패→통과가
번갈면) — 정직한 표시이고 칩의 `~`가 그것이다.

Plan 1 설계 §18에 이 뒤집기를 11번 항목으로 더한다(§7). "비수렴 Run의 상태 파일이 커지지 않는다"는
보장은 **검사별 결과 한 줄만큼 커진다**로 바뀐다. 출력 꼬리는 여전히 실패한 검사에만, 라운드마다
덮어써서 남는다.

### 2.2 `JobTask` — `core/types.ts`

```ts
gate?: { id: string; question: string; options?: string[]; kind?: GateKind }
/** 이 Task 의 마지막 검증 라운드. **검사가 걸린 모든 Task 가 갖는다** — 자동 수정을 켠 Run 만이 아니다(U2).
 *  없으면 검사가 없는 Task 이고, 그때 노드는 칩 줄 자체를 그리지 않는다. 출력 꼬리·요약은 싣지 않는다(U4):
 *  칩이 그리는 것은 기호 하나이고, 이 스냅숏은 사이드바가 바뀔 때마다 나간다. */
checks?: {
  configId: string
  name: string
  status: CheckResult['status']
  /** 툴팁의 "실패 (exit N)" — 실패한 검사에만 뜻이 있지만 값이 있으면 그대로 옮긴다 */
  exitCode?: number
  /** 밀리초. startedAt·endedAt 둘 다 있을 때만 — 툴팁의 "지난 라운드 실제 시간" */
  durationMs?: number
  unstable?: true
}[]
/** 자동 수정 정책이 있는 Run 의 Task 만 갖는다(U3). 검사가 없는 Task 도 Run 에 정책이 있으면 갖는다 —
 *  검토만 걸린 Task 의 라운드를 그리기 위해서다. */
convergence?: {
  repairs: number
  maxFixAttempts: number
  reviewRound: number
  maxReviewRounds: number
  /** 지금 열린 Dispatch 가 repair 면 그 사유. 아니면 null */
  repairing: RepairReason | null
  /** 사람이 자동 수정을 멈춰 뒀다(Task.convergenceOff) */
  stopped: boolean
}
```

`gate.kind`는 `Gate.kind`를 그대로 옮긴다 — 사이드바가 "소진" 칩을 그릴 근거가 이것뿐이다
(`repairs >= maxFixAttempts`로 되짚으면 `grantedExtra`가 그 셈을 깨뜨린다). 다음 조각의 버튼 셋도 이 값을
쓴다. `durationMs`는 `endedAt - startedAt`을 여기서 계산해 싣는다 — 렌더러가 ISO 둘을 받아 빼는 것보다
스냅숏이 작고, 테스트할 자리가 core다.

### 2.3 `jobTaskOf` — `view.ts`

`policyOf`·`repairCountOf`·`reviewRoundOf`를 `./convergence`에서 들여온다. `running`은 이 함수가 이미 찾는
열린 Dispatch다.

```ts
const policy = policyOf(state, task)
…
...(open[0] ? { gate: { …기존 셋…, ...(open[0].kind ? { kind: open[0].kind } : {}) } } : {}),
...(task.checks?.length
  ? { checks: task.checks.map((c) => ({
      configId: c.configId, name: c.name, status: c.status,
      ...(c.startedAt && c.endedAt ? { durationMs: Date.parse(c.endedAt) - Date.parse(c.startedAt) } : {}),
      ...(c.unstable ? { unstable: true } : {})
    })) }
  : {}),
...(policy
  ? { convergence: {
      repairs: repairCountOf(state, task.id),
      maxFixAttempts: policy.maxFixAttempts,
      reviewRound: reviewRoundOf(state, task.id),
      maxReviewRounds: policy.maxReviewRounds,
      repairing: running?.repair ?? null,
      stopped: task.convergenceOff === true
    } }
  : {})
```

`policyOf(state, task) !== null`이 수렴 판정이다 — Plan 1 §18이 `convergence !== undefined`를 틀린 검사라고
적어 두었다.

## 3. 모달 둘

### 3.1 새 작업 — `NewRunModal`

체크박스 하나, 상태 하나(`const [convergence, setConvergence] = useState(false)`), `create()`의 인자에
`...(convergence ? { convergence: true } : {})`. 서버는 Plan 1이 이미 `--convergence`를 받는다. 자리는
예약 실행 `field` 바로 아래, 같은 `check-small` 모양.

이름표: **통과할 때까지 자동 수정**. 설명(`modal-hint`): "검사가 실패하면 앱이 같은 워커에게 무엇이 틀렸는지
돌려주고, 고친 뒤 다시 검사합니다. 정해진 횟수 안에 통과하지 못하면 멈추고 물어봅니다." 기본 꺼짐(명세 §42,
Plan 1 D12).

아래에 회색 줄로 기본값 셋 — `수정 최대 3회 · 검토 라운드 2회 · 막는 심각도 high` — 와 "이 값들은 CLI로만
바꿉니다". 안 보이면 "얼마나 시도하는 건데?"에 답이 없다. 값은 `FAILURE_LIMIT`·`MAX_REVIEW_ROUNDS`(`types.ts`)와
**새로 export하는** `DEFAULT_BLOCKING_SEVERITY`(`convergence.ts` — 지금 `policyOf` 안의 리터럴 `'high'`를 이 이름으로
뽑고 `policyOf`도 그것을 쓴다)에서 가져온다. 문자 그대로 박으면 상수가 바뀌는 날 화면이 거짓말한다. 두 파일
모두 `tsconfig.web.json`에 이미 있다.

### 3.2 새 Task — `NewTaskModal`

`validateConfigId: string` 상태와 `validateItems`/`Select`를 **순서 있는 배열**과 목록으로 바꾼다.

```ts
const [checks, setChecks] = useState<string[]>([])            // 고른 것, 실행 순서
const configs = runConfigs ?? []
const nameOf = (id: string) => configs.find((c) => c.id === id)?.name ?? id
const unpicked = configs.filter((c) => !checks.includes(c.id))
const add = (id: string) => setChecks((xs) => [...xs, id])
const remove = (id: string) => setChecks((xs) => xs.filter((x) => x !== id))
const move = (i: number, dir: -1 | 1) =>
  setChecks((xs) => { const ys = [...xs]; [ys[i], ys[i + dir]] = [ys[i + dir], ys[i]]; return ys })
```

전송은 `...(checks.length ? { validate: checks.join(',') } : {})`. 서버가 쉼표 목록을 받고 빈 칸을 400으로
거절한다(Plan 1 Task 9).

화면(시안 `새 Task — 검사 고르기`): 고른 것은 번호 칩 + 이름 + `↑` `↓` `✕`, 그 아래 힌트 한 줄, 그 아래
"고르지 않은 것"을 `+ 이름` 점선 버튼으로. 첫 항목의 `↑`와 마지막의 `↓`는 `disabled`. `configs`가 비었으면
목록 대신 `jobs.task.checksNone` 한 줄.

**접근성**: `↑` `↓` `✕`는 `<button type="button">`이고 `aria-label`을 단다(아이콘만 있는 버튼). 이 저장소
규칙대로 `role`/`onClick`을 `div`에 두지 않는다.

**바꾸지 않는 것**: `Select` 컴포넌트 — 계정·의존 칸이 계속 쓴다. 검증 구성 목록(`runConfigs`)을 받는 경로와
`compound` 제외 규칙도 그대로. `jobs.task.validateNone` 키는 이 모달이 유일한 사용처라 지운다.

## 4. 그리는 쪽

### 4.1 판정 — `core/orchestration/nodeMeta.ts` (신규, `tsconfig.web.json`에 추가)

렌더러에 판정을 두지 않는다(U11). 순수 함수 둘이 **구조**를 돌려주고, 렌더러가 `t()`로 문장을 만든다 —
core가 i18n을 모르게, 그리고 문장이 아니라 판정을 테스트하게. 이름이 `nodeMeta`인 이유: `JobsView.tsx`에
이미 사이드바 줄의 경과 문구를 만드는 `taskMeta()`가 있다.

```ts
export type NodeMeta =
  | { kind: 'gate'; question: string }
  | { kind: 'repairing'; repairs: number; max: number; failed: string | null }
  | { kind: 'checking'; retrying: string | null }
  | { kind: 'reviewing'; round: number; max: number }
  | { kind: 'failed'; name: string }
  | { kind: 'provider'; provider: Provider }
  | { kind: 'none' }

export function nodeMetaOf(task: JobTask): NodeMeta

export type ConvergenceChip =
  | { kind: 'repairing'; repairs: number; max: number }
  | { kind: 'reviewing'; round: number; max: number }
  | { kind: 'exhausted' }

/** 사이드바 줄의 칩. convergence 가 없으면 null — 비수렴 Run 의 줄은 지금 그대로다 */
export function convergenceChipOf(task: JobTask): ConvergenceChip | null
```

`firstBlocked(task)` = `checks`에서 첫 `failed`/`timed-out`의 `name`, 없으면 null. `nodeMetaOf`의 규칙,
위에서부터 첫 행이 이긴다:

| 조건 | 결과 | 문장 |
|---|---|---|
| `task.gate` | `gate` | 질문 — 지금과 같다 |
| `convergence?.repairing` | `repairing`, `failed = firstBlocked` | `수정 2/3 · Unit tests 실패` / review-failure면 `수정 1/3` |
| `status === 'validating'` | `checking`, `retrying = firstBlocked` | `다시 검사 중 · Unit tests` / 첫 라운드면 `검사 중`(U12) |
| `status === 'reviewing'` && `convergence` | `reviewing` | `검토 라운드 1/2` |
| `status === 'failed'` && `firstBlocked` | `failed` | `Integration tests 실패` — 시안의 `Telemetry opt-out`, 자동 수정 없는 Run |
| `task.provider` | `provider` | 지금과 같다 |
| 그 외 | `none` | 줄을 그리지 않는다 — 지금과 같다 |

`failed`가 `status === 'failed'`에만 붙는 이유: 비수렴 Run에서 `--retry-of`로 다시 띄운 `dispatched` Task도
지난 라운드의 실패 결과를 들고 있는데, 그 줄이 "실패"라고 말하면 지금 도는 워커가 없는 것처럼 읽힌다 —
거기서는 provider가 맞다.

`convergenceChipOf`, 같은 규칙:

| 조건 | 결과 |
|---|---|
| `!convergence` | null |
| `status === 'blocked'` && `gate?.kind === 'convergence-exhausted'` | `exhausted` |
| `convergence.repairing` | `repairing` |
| `status === 'reviewing'` | `reviewing` |
| 그 외 | null |

### 4.2 노드 — `RunDetail`

`const meta = task.gate?.question ?? task.provider` 한 줄이 `nodeMetaOf(task)` → `t()` 매핑으로 바뀐다(§5의 키).
`gate`·`provider`·`none`은 지금 코드 그대로.

**노드 높이 `NODE_H = 52`(`graphLayout.ts`)는 바꾸지 않는다.** `.detail-node`는 `grid-template-columns: auto 1fr`,
`align-content: center`의 격자이고 제목(11.5px×1.25)·meta(9px×1.3)가 2열에 두 줄로 선다. 칩 줄은 2열의 셋째
줄, 9.5px — 셋을 더해도 40px가 안 되어 52 안에 든다. 칩 줄은 `task.checks`가 있을 때만 요소를 그린다 —
없으면 노드는 지금과 같다. 칩 하나:

```tsx
<span className={`detail-check detail-check--${glyphKind}`} title={checkTooltip(c, t)}>
  {GLYPH[glyphKind]}{c.unstable && <sub>~</sub>}
</span>
```

`GLYPH = { passed: '✓', failed: '✗', 'timed-out': '✗', 'not-run': '○', retrying: '●' }`. `retrying`은
`CheckResult.status`가 아니라 그리기 위한 다섯째 종류다: `status === 'validating'`인 Task는 `firstBlocked`에
해당하는 칩 하나를 `●`로 그린다(지난 라운드에 막힌 것이 다시 도는 중이라는 뜻, U12). 첫 라운드라 `checks`가
없으면 칩 줄이 없고 meta의 `검사 중`만 보인다.

툴팁: `{name} — {결과}` + `durationMs`가 있으면 ` ({시간})`. 시간은 `core/run/duration.ts`의
`formatRunDuration({ startedAt: 0, exitedAt: durationMs }, 0)` — `Pick<RunStatus,'startedAt'|'exitedAt'>`과
`now`를 받으므로 어댑터 한 줄이다. 결과 문구는 `jobs.convergence.check.*`, `failed`는 `exitCode`를 함께.

`.detail-node--<status>` 클래스는 그대로. CSS는 `styles.css`에 `.detail-checks`(줄)와 `.detail-check--*` 다섯,
색은 노드 배경이 이미 쓰는 토큰(`--git-modified`, `--git-deleted`, `--accent`, `--text-faint`)을 빌린다.

### 4.3 사이드바 — `JobsView`

도는 Task 줄(`rows`, `isRunning`으로 걸러진 것)에서 `jobs-task-body` 뒤, `TaskGlyph` 앞에
`convergenceChipOf(task)`가 null이 아니면 칩 하나: `<span className="jobs-ordinal jobs-conv--{kind}">`. `.jobs-ordinal`의
모양을 빌리고 색만 kind별로 — `repairing`은 `--git-modified`, `reviewing`은 `--fi-purple`, 노드 배경과 같은 토큰.

소진된 Task는 `blocked`라 `isRunning`이 아니어서 `rows`에 서지 않는다 — Gate 줄(`gates.map`)의 `TaskIcon` 뒤에
같은 칩을 `exhausted`(`--git-conflict`)로 붙인다. `validating` Task는 지금처럼 접힌 수에만 — 이 조각에서 바꾸지 않는다.

## 5. 문구 — i18n 넷

| 키 | ko |
|---|---|
| `jobs.new.convergence` | 통과할 때까지 자동 수정 |
| `jobs.new.convergenceHint` | 검사가 실패하면 앱이 같은 워커에게 무엇이 틀렸는지 돌려주고, 고친 뒤 다시 검사합니다. 정해진 횟수 안에 통과하지 못하면 멈추고 물어봅니다. |
| `jobs.new.convergenceDefaults` | 수정 최대 {fix}회 · 검토 라운드 {review}회 · 막는 심각도 {severity} |
| `jobs.new.convergenceCliOnly` | 이 값들은 CLI로만 바꿉니다 |
| `jobs.task.validate` (문구만) | 완료 검사 |
| `jobs.task.checksHint` | 빠른 검사를 앞에 두세요 — 첫 실패에서 멈추므로, 느린 검사가 앞에 있으면 매 수정마다 그 시간을 버립니다. |
| `jobs.task.checksUnpicked` | 고르지 않은 것 |
| `jobs.task.checksNone` | 검사로 쓸 실행 구성이 없습니다 |
| `jobs.task.checkUp` / `.checkDown` / `.checkRemove` | 위로 / 아래로 / 빼기 (aria-label) |
| `jobs.convergence.node.repairing` | 수정 {repairs}/{max} · {failed} 실패 |
| `jobs.convergence.node.repairingNoCheck` | 수정 {repairs}/{max} |
| `jobs.convergence.node.rechecking` | 다시 검사 중 · {name} |
| `jobs.convergence.node.checking` | 검사 중 |
| `jobs.convergence.node.reviewing` | 검토 라운드 {round}/{max} |
| `jobs.convergence.node.failed` | {name} 실패 |
| `jobs.convergence.chip.repairing` | 수정 {repairs}/{max} |
| `jobs.convergence.chip.reviewing` | 검토 {round}/{max} |
| `jobs.convergence.chip.exhausted` | 소진 |
| `jobs.convergence.check.passed` / `.failed` / `.timedOut` / `.notRun` / `.retrying` / `.unstable` | 통과 / 실패 (exit {code}) / 타임아웃 / 돌지 않음 / 다시 도는 중 / 라운드 사이에 판정이 흔들림 |

`jobs.new.*`는 `NewRunModal`이 이미 쓰는 접두다(`jobs.new.schedule`). `jobs.task.validateNone`은 지운다(§3.2).
en/ja/es는 같은 뜻으로; `catalog.test.ts`가 네 로케일의 키 동등성을 이미 고정한다.

## 6. 테스트

| 파일 | 고정하는 것 (테스트 이름) |
|---|---|
| `state.test.ts` | `꺼진 Run 도 checks·checkHistory 를 기록한다` · `통과한 검사의 outputTail 은 키를 빼고, 실패한 검사의 것은 남긴다` · `통과해도 status 메시지 body 는 출력을 싣는다 — 벗기는 것은 기록에서만` |
| `events.test.ts` | `정책 없는 Run 의 validating → failed 도 check 요약을 싣는다` — Journal 이 함께 바뀐 것을 고정 |
| `view.test.ts` | describe `snapshotFor — 검사 결과와 자동 수정 진행` 일곱: checks 는 모든 Task 에·durationMs 는 둘 다 있을 때만, checks 없는 Task 는 칸 없음, convergence 는 정책 있는 Run 에만·기본값·repairs·reviewRound, repairing null·stopped, reviewRound 는 outcome 있는 검토만, gate.kind 전달, **repairs 는 예산으로 clamp** |
| `nodeMeta.test.ts` (신규) | `nodeMetaOf` 우선순위 여섯(Gate → repairing → validating → reviewing → failed → provider/none) · `convergenceChipOf` 셋(없으면 null, 소진은 gate.kind 로만, repairing/reviewing/null) · `firstBlocked` · `retryingCheckOf` 다섯(막힌 것이 있으면 그것, 지난 라운드가 전부 통과했으면 첫 검사, validating 이 아니면 null, 검사가 없으면 null, `nodeMetaOf` 의 `checking` 과 같은 것을 가리킴) |
| `convergence.test.ts` | `빈 정책은 기본값 셋 — 심각도 기본은 DEFAULT_BLOCKING_SEVERITY 다` |
| `catalog.test.ts` | 네 로케일 키 동등성 (기존) — 새 키 25개, 지운 키 1개 |
| `server.test.ts` | 변경 없음 — `--convergence`·`--validate a,b`는 Plan 1이 고정했다 |

렌더러는 `npm run typecheck`(`tsconfig.web.json`)과 `npm run build`. 수동 확인: dev 앱에서 새 Run에 체크박스를
켜고 Task에 검사 셋을 순서 바꿔 넣고 만들기 → `astera task-show`로 `validateConfigIds` 순서 확인 → 워커 세션에서
`worker_done` → 노드 칩과 사이드바 칩이 바뀌는 것.

## 7. Plan 1 설계 문서 정정 (이 문서와 같은 커밋에서)

- §13.1–§13.5를 이 문서를 가리키는 두 줄로 줄인다. §13.3의 `convergence?` 스케치는 이 문서 §2.2가 대체한다.
- §18에 11번 항목: "**Task 4의 '수렴 Run에만 기록' 판정을 UI 조각이 뒤집었다.** `--validate`만 쓰는 Run의
  Task도 어느 검사가 깨졌는지 노드에 보여야 하는데, 그 정보가 상태에 없으면 그릴 수 없다. 고친 것:
  `applyValidationResult`가 모든 Run에 `checks`·`checkHistory`를 기록하고, 통과한 검사의 `outputTail`은 키를 뺀다.
  status 메시지 문구는 그대로다. 비수렴 Run의 상태 파일은 검사별 한 줄만큼 커진다. `2026-09-20-convergence-ui-design.md` §2.1."

## 8. 다음 조각

Completion 블록(`task-show`로 outputTail·blocking 이슈·의심 파일 펼침), 버튼 셋(자동 수정 중지·다시 시도·실패
보기), `RunDetail.tsx`가 `gate-resolve`의 `retryOnceFailed` 응답을 버리는 것(Plan 1 최종 리뷰가 남긴 첫 항목),
`docs/jobs.md`의 "통과할 때까지 자동 수정" 절.
