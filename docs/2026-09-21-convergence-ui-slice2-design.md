# 자동 수정 두 번째 조각 — 왜 실패했는지 보여 주고, 멈출 수 있게

첫 조각(`2026-09-20-convergence-ui-design.md`)이 "켜기와 보이기"를 끝내고 §8 에 넷을 남겼다. 그 넷과,
원 명세(`ASTERA_COMPLETION_CONVERGENCE_LOOP_IMPLEMENTATION_SPEC_20260919.md`)의 §53 UX 수용 기준
가운데 아직 비어 있는 줄을 함께 닫는다.

명세 대비 지금 자리:

| §53 UX | 상태 |
|---|---|
| 현재 completion state 가 Job UI 에 보인다 | **됐다** — 노드 meta 줄·사이드바 칩(첫 조각) |
| attempt / review round 가 보인다 | **됐다** — `수정 2/3`, `검토 1/2` |
| 실패 이유가 사람이 이해 가능한 summary 로 보인다 | **비었다** → V1 |
| Timeline 에 repair/recheck/review 흐름이 보인다 | **비었다** → V2 |
| Stop Auto-Fix / Retry / Review Failures | **부분** — 소진 Gate 의 `한 번 더 수정`·`실패로 표시`만 있다 → V3 |

§18(불안정 검사를 자동 무시하지 않고 표시)은 이미 칩의 `~` 로 그려진다. 새로 할 것이 없다.

## 1. 결정

| # | 결정 | 이유 |
|---|---|---|
| W1 | 실패 상세는 **스냅숏이 아니라 따로 부른다**(`orch.completion`, 한 번) | U4 가 스냅숏에서 뺀 이유는 그것이 **변경마다 푸시되는 것**이기 때문이다. 펼칠 때 한 번 가져오는 것은 그 이유에 걸리지 않는다. 대신 스냅숏은 계속 가볍게 둔다 |
| W2 | 상세 투영은 **전용 함수**다 — `task-list` 를 렌더러에서 부르지 않는다 | `task-list` 는 Run 의 **모든** Task 를 spec 본문째 넘긴다. 한 Task 의 꼬리를 보려고 그것을 다 건너보내는 것은 U4 가 막으려던 바로 그 무게이고, 남의 Task 내용까지 화면에 들어온다 |
| W3 | 상세에 싣는 것은 **실패한 검사의 꼬리 + 막는 리뷰 이슈 + 의심 파일**뿐 | 통과한 검사는 꼬리를 저장하지도 않는다(첫 조각 U2). 막지 않는 이슈는 개수만 말한다 — 판단에 쓰이지 않는 것을 펼쳐 두면 막는 것이 묻힌다 |
| W4 | 타임라인은 **Dispatch 가 수리인지**를 말한다. 검사 한 건 한 건은 **말하지 않는다** | `Dispatch.repair` 는 이미 저장돼 있어 파생이 공짜다. 반면 라운드별 검사 시각은 **어디에도 없다** — `checks` 는 마지막 라운드만, `checkHistory` 는 통과/실패 수열만 갖는다. 없는 것을 그리려면 백엔드가 회차를 저장해야 하고 그것은 이 조각이 아니다 |
| W5 | `다시 시도` 버튼은 **만들지 않는다** | 소진 전에는 루프가 이미 자동으로 다시 시도하고 있어 누를 것이 없다. 소진 뒤에는 Gate 의 `한 번 더 수정`이 그 버튼이다. 멈춰 둔 Task 를 다시 켜는 것은 서버가 거절한다(`--convergence on` 은 없다 — Task 는 Run 을 따른다). 없는 명령을 부르는 버튼을 만들지 않는다 |
| W6 | `실패 보기` 는 **별도 버튼이 아니라 상세 블록의 펼침**이다 | 누르면 나오는 것이 상세 블록이다. 버튼 하나와 블록 하나를 따로 두면 같은 것을 두 번 그린다 |
| W7 | `자동 수정 중지`는 **확인을 받는다** | 되돌릴 수 없다 — 서버에 `--convergence on` 이 없다. 되돌릴 수 없는 것은 묻고 나서 한다(저장소의 `confirm.ts` 관례) |
| W8 | 멈춘 Task 는 **칩으로 말한다** | 첫 조각이 `JobConvergence.stopped` 를 투영에 싣고 아무도 안 읽어, 사람이 꺼 둔 Task 와 도는 Task 가 구별되지 않았다. 중지 버튼을 만드는 지금이 그 칸을 읽을 자리다 |
| W9 | 판정은 **core 에 순수 함수로** | 첫 조각 U11 과 같다. 렌더러에는 테스트 환경이 없다 |
| W10 | `한 번 더 수정`이 조용히 실패하는 것을 **화면이 말한다** | 서버는 이미 `retryOnceFailed` 를 응답에 싣는다. 상세 창이 그 본문을 버려서, 사람이 누른 버튼이 아무 일도 안 했는데 성공처럼 보인다. 첫 조각 §8 이 "다음 조각의 첫 항목"으로 지목한 것 |

## 2. V1 — 왜 실패했는지 보여 준다

### 2.1 투영

`core/orchestration/completion.ts`(신규), 순수 함수:

```ts
export interface CompletionCheckDetail {
  configId: string
  name: string
  status: 'passed' | 'failed' | 'timed-out' | 'not-run'
  exitCode?: number
  /** 실패·타임아웃한 검사만. 통과한 검사는 꼬리를 저장하지 않는다(첫 조각 U2) */
  outputTail?: string
  unstable?: true
}
export interface CompletionDetail {
  taskId: string
  checks: CompletionCheckDetail[]
  /** 막는 이슈만. 판단에 쓰이는 것이 이것이다 */
  blockingIssues: ReviewIssue[]
  /** 막지 않는 이슈는 개수만 — 있다는 사실은 말하고, 펼쳐서 막는 것을 묻지 않는다 */
  otherIssueCount: number
  /** 검사 설정을 건드린 파일. 리뷰어에게 넘어간 그 목록을 사람도 본다 */
  suspiciousFiles: string[]
}
export function completionDetailOf(task: Task): CompletionDetail | null
```

`null` 은 "이 Task 에는 보여 줄 것이 없다" — 검사도 이슈도 의심 파일도 없을 때.

### 2.2 IPC

`orch.completion(projectPath, runId, taskId)` — `orch.runDetail` 과 같은 소유 가드를 그대로 쓴다.
Run 이 이 프로젝트의 것이 아니면 `null`. Task 가 그 Run 의 것이 아니어도 `null` — Run 소유만 보고
Task 를 믿으면, 이 문이 남의 Run 의 Task 를 읽는 우회로가 된다.

### 2.3 화면

고른 노드 아래, 이벤트 목록 위에 접힌 블록. 여는 순간 한 번 부르고, 노드를 바꾸면 다시 부른다.

```
완료 검사
  ✗ 통합 테스트 (exit 1)      [자세히]
  ✓ 타입체크
  ● 빌드 — 돌지 않음

막는 리뷰 이슈 2
  HIGH  세션 무효화 경쟁 조건   src/auth/session.ts:41
  HIGH  롤백 처리 누락          src/auth/login.ts:88
  그 밖의 이슈 3

검사 설정이 바뀐 파일
  package.json
```

꼬리는 검사마다 따로 접는다. 넷이 한꺼번에 펼쳐지면 그중 무엇이 막고 있는지 다시 찾아야 한다.

## 3. V2 — 타임라인이 수리를 수리라고 말한다

`JobEvent` 의 `dispatch-started` 에 `repair?: RepairReason` 한 칸. `review?: boolean` 이 이미 같은
모양으로 있고, `Dispatch.repair` 가 이미 저장돼 있다 — 파생만 안 하고 있었다.

렌더러 문구:

| 지금 | 뒤 |
|---|---|
| `{provider} 시작` | 구현: 그대로 |
| `{provider} 시작` | 수리(검사 실패): `{provider} — 검사 실패를 고치는 중` |
| `{provider} 시작` | 수리(검토 실패): `{provider} — 검토 지적을 고치는 중` |
| `{provider} 시작` | 검토: 그대로(이미 `review` 로 구분한다) |

**하지 않는 것**: 검사 회차별 줄(`14:24 2 tests failed`, `14:31 Re-running checks`). 그 시각이 상태에
없다(W4). 명세 §28 의 그림을 온전히 그리려면 백엔드가 회차 시각을 저장해야 한다 — 이 문서의 §6 에
남긴다.

## 4. V3 — 멈출 수 있게, 그리고 멈춘 것이 보이게

### 4.1 중지

고른 노드에 `자동 수정 중지` 버튼. 보이는 조건은 순수 함수로:

```ts
export function canStopConvergence(t: JobTask): boolean
```

`convergence` 가 있고, `stopped` 가 아니고, Task 가 아직 끝나지 않았을 때만. 누르면 확인을 받고
(`confirm.ts`), `task-update --id <taskId> --convergence off`.

확인 창이 말하는 것: 도는 수리는 끝까지 가고 그 판정이 Gate 로 온다는 것, 그리고 **다시 켤 수 없다**는
것. 두 번째가 이 창이 있는 이유다.

### 4.2 멈췄다고 말한다

`nodeMetaOf` 에 갈래 하나. `stopped` 인 Task 는 meta 줄이 `자동 수정 멈춤` 이고, 사이드바 칩도 같다.
지금은 멈춘 Task 가 도는 Task 와 똑같이 `수정 2/3` 을 달고 서 있다.

## 5. V4 — `한 번 더 수정`이 실패하면 말한다

`RunDetail` 의 `resolveGate` 가 `reply.body.retryOnceFailed` 를 읽어 `setGateError` 로 띄운다.
지금은 `reply.status` 만 보고 본문을 버린다. 서버는 Gate 자체가 풀린 것이 맞으므로 200 을 주고,
수리를 못 연 사실은 본문에만 싣는다(`server.ts:1870`).

## 6. 이 조각이 하지 않는 것

- **검사 회차별 타임라인**(명세 §28 의 온전한 그림). 회차 시각이 상태에 없다. 백엔드가
  `CheckResult` 를 라운드별로 남겨야 한다 — 저장이 커지므로 그 자체가 하나의 결정이다.
- **멈춘 자동 수정을 다시 켜기**. 서버가 `--convergence on` 을 거절한다("Task 는 Run 을 따른다").
  켜는 의미를 정하는 것이 먼저다 — 남은 예산은 얼마인가, 지난 판정은 유효한가.
- **명세 §49 metrics**. 화면 이야기가 아니다.
- **명세 §54 Phase 4**(선택적 재검사, 진단 file:line 파싱, flaky 자동 판정, 검사별 timeout).
  백엔드 설계가 D15 로 범위 밖에 두었다.

## 7. 테스트

| 파일 | 고정하는 것 |
|---|---|
| `completion.test.ts` (신규) | 통과한 검사에는 꼬리가 없다; 막는 이슈만 싣고 나머지는 개수; 보여 줄 것이 없으면 null |
| `nodeMeta.test.ts` | 멈춘 Task 의 meta 와 칩이 도는 Task 와 다르다; `canStopConvergence` 의 세 조건 |
| `timeline.test.ts` | 수리 Dispatch 가 `repair` 를 달고 나온다; 구현·검토 Dispatch 는 안 단다 |
| `ipc.test.ts` | `orch.completion` 이 남의 Run·남의 Task 에 null 을 준다 |
| `catalog.test.ts` | 네 카탈로그 (기존) |

렌더러는 `npm run typecheck` 와 `npm run build`.
