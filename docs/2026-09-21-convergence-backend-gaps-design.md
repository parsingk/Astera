# 자동 수정 — 명세가 요구하는데 비어 있던 넷

UI 두 조각이 끝난 뒤 원 명세(`ASTERA_COMPLETION_CONVERGENCE_LOOP_IMPLEMENTATION_SPEC_20260919.md`)를
코드와 한 줄씩 대조해 남은 것을 모았다. 넷은 **결정 기록 없이 비어 있던 것**이고, 이 문서가 그것을
닫는다. 나머지(§25 idempotency key 포맷, §20 `FailureClass` 열거형)는 백엔드 설계가 이 앱의 기존
관례로 대체한다고 이미 적어 둔 것이라 건드리지 않는다.

| 명세 | 비어 있던 것 | 이 조각 |
|---|---|---|
| §47 / §22 | 수정이 **중단**되면 그 시도가 예산을 먹는다 | G1 |
| §40 | 시간 예산(`maxTotalMinutes`) | G2 |
| §37 / §36 | 완료 정책 스냅숏과 "수리 중 정책이 바뀌었다" 판정 | G3 |
| §30 | 완료 강제의 **기록**(누가, 왜) | G4 |

## 1. 결정

| # | 결정 | 이유 |
|---|---|---|
| B1 | §47 의 "일시정지 후 같은 attempt 로 재개" 를 **문자 그대로 만들지 않는다.** 대신 **중단된 수리가 예산을 먹지 않게** 한다 | 이 앱의 일시정지는 **예약 Run 에만** 있고(`server.ts` 의 `run-pause`: "일시 중지는 예약에만 있다"), 재개는 "다음 예약 시각의 새 회차" 를 뜻한다고 문서로 못박혀 있다(`state.ts` 의 `resumeSchedule`). 보통 Run 에 일시정지를 새로 만드는 것은 제품 개념을 하나 더 만드는 일이고 이 조각의 범위가 아니다. **예산을 먹지 않는 것**은 §47 이 실제로 보호하려는 것("새 attempt 를 만들지 않는다")이고, 중단의 출처가 무엇이든(일시정지·정지·크래시) 같은 규칙이다 |
| B2 | "먹는다" 의 기준은 **판정을 냈거나 아직 돌고 있는가** | 바로 옆 `reviewRoundOf` 가 이미 그 규칙이다 — "유실된 검토는 라운드를 먹지 않는다". 같은 파일 두 줄 아래의 `repairCountOf` 만 그것을 어기고 있었다. 지금도 도는 수리는 세야 한다: 안 그러면 앱이 그 옆에 두 번째 수리를 연다 |
| B3 | 시간 예산의 시계는 **첫 검증이 시작된 때**부터 | 수렴이 시작되는 순간이 그때다. Task 생성 시각으로 재면 의존 Task 를 기다린 시간까지 예산에 들어간다 |
| B4 | 시간 예산을 넘겨도 **도는 수리를 죽이지 않는다** | 명세 §13 의 "자동 무한 재실행 금지" 는 *새로* 띄우지 말라는 것이다. 돌고 있는 워커를 중간에 끊으면 그 시도의 결과를 잃고, 그 손실은 예산이 막으려던 낭비보다 크다 |
| B5 | 정책 스냅숏은 **Run 이 아니라 Task 에** 둔다 | 완료 정책의 절반(어느 검사를, 어떤 순서로, 검토를 받을지)이 Task 의 칸이다. Run 에만 두면 Task 마다 다른 정책을 한 해시로 뭉개게 된다 |
| B6 | 스냅숏이 담는 것은 **판정을 바꿀 수 있는 것만** | 예산 숫자, 막는 severity, 검사 id 의 **순서 있는 목록**, 검토 요구 여부, 그리고 각 검사가 **실제로 실행하는 명령**. 이름·폴더처럼 판정과 무관한 칸은 넣지 않는다 — 넣으면 이름만 고쳐도 "정책이 바뀌었다" 가 뜬다 |
| B7 | 정책이 바뀌면 **막지 않고 표시한다** | 명세 §38 이 같은 판단을 이미 한다("무조건 실패 처리할 필요는 없지만 reviewer 에게 flag"). 사람이 라운드 사이에 검사를 고쳤을 수 있고 그것이 정당한 경우가 있다. 판정은 리뷰어와 사람의 몫이고, 앱의 일은 그 사실이 눈에 띄게 하는 것이다 |
| B8 | 완료 강제는 **새 명령을 만들지 않는다.** `task-update --status completed` 가 그 자리다 | 백엔드 설계 §3 이 이미 "그것이 탈출구" 라고 정했다. 비어 있던 것은 버튼이 아니라 **기록**이다 |
| B9 | 수렴이 끝나지 않은 Task 를 completed 로 옮길 때 **`--reason` 을 요구한다** | 명세 §30 이 "사용 시 반드시 reason 을 Journal 에 남긴다" 고 한다. 이유 없는 override 를 받으면 기록은 남지만 읽을 것이 없다. 요구는 **그 한 경우에만** 건다 — 평범한 손보기(ready 로 되돌리기 등)는 그대로다 |

## 2. G1 — 중단된 수리는 예산을 먹지 않는다

`convergence.ts`:

```ts
export const repairCountOf = (s: OrchState, taskId: string): number =>
  s.dispatches.filter(
    (d) => d.taskId === taskId && d.repair !== undefined && (d.outcome !== undefined || d.endedAt === undefined)
  ).length
```

세는 것은 둘이다. **판정을 낸 수리**(`outcome` 있음)와 **아직 도는 수리**(`endedAt` 없음). 빠지는 것은
하나 — 판정을 못 낸 채 끝난 수리다. 일시정지가 닫은 것(`closedBy: 'pause'`), 사람이 멈춘 것(`'stop'`),
앱이 죽어 잃은 것이 모두 여기 든다.

**소진 Gate 의 문구가 함께 정직해진다.** 지금은 "3번 고쳤습니다" 가 실제로 고쳐 본 횟수가 아니라 연
Dispatch 수였다.

## 3. G2 — 시간 예산

`ConvergencePolicy` 에 `maxTotalMinutes?: number`. 없으면 시간 예산이 없다(지금 동작 그대로).

시계의 시작은 `Task.convergenceStartedAt` — 그 Task 가 **처음 `validating` 이 된 때**. `applyWorkerDone`
이 Task 를 validating 으로 옮길 때 없으면 찍는다(있으면 덮지 않는다 — 라운드마다 다시 찍으면 예산이
영원히 리셋된다).

`routeFailure` 의 순서에 한 줄이 든다. 멈춤 > 일시정지 > **시간 소진** > 횟수 소진. 시간이 먼저인 이유:
둘 다 소진이지만 사람에게 보여 줄 이유가 다르고, 시간이 넘었으면 횟수가 남았어도 열지 않는다.

```
jobs.convergence.gate.timeExhausted
  '이 Task 의 자동 수정이 시간 예산({minutes}분)을 넘겼습니다. {repairs}번 고쳤고 아직 실패합니다: {failures}'
```

Gate 의 종류는 `convergence-exhausted` 그대로다 — 사람이 고를 것("한 번 더 수정" / "실패로 표시")이
같기 때문이다. 다르게 만들면 UI 와 서버의 갈래가 하나 더 늘고 얻는 것이 없다.

## 4. G3 — 정책 스냅숏

`Task.policySnapshot?: { hash: string; capturedAt: string }`. Task 가 처음 validating 이 될 때 찍는다
(G2 의 시계와 같은 자리, 같은 이유).

해시의 재료(`completionPolicyHash`, 순수 함수):

```
maxFixAttempts | maxReviewRounds | blockingSeverity | maxTotalMinutes
validateConfigIds (순서 그대로)
reviewRequested
검사마다: type 과 그것이 실행하는 것(shell 은 command, npm 은 script+args, …)
```

검사 정의를 어떻게 받는가: 해시 함수는 `(configId) => string | null` 하나를 받는다. core 는 RunConfig
저장소를 모르고(그것은 main 의 것), 이 함수는 순수해야 테스트가 붙는다.

라운드가 시작될 때 다시 계산해 스냅숏과 다르면 `Task.policyChanged = true`. 그 뒤로:

- 리뷰어 spec 에 한 줄이 더해진다 — 의심 파일 목록과 같은 자리, 같은 이유(명세 §38).
- 완료 상세 블록이 그것을 말한다(`jobs.completion.policyChanged`).
- 저널에 `TASK_POLICY_CHANGED`.

**막지 않는다**(B7). 한 번 참이 되면 그 Task 가 끝날 때까지 참이다 — 되돌려 놓아도 "그 사이에 바뀌어
있었다" 는 사실은 남는다.

## 5. G4 — 완료 강제의 기록

`task-update --status completed` 가, 그 Task 가 **수렴을 끝내지 않았는데** 완료로 가는 경우:

- `--reason` 이 없으면 거절한다. 메시지가 무엇을 달라는지 말한다(B9).
- 저널에 `TASK_COMPLETED_WITH_OVERRIDE { taskId, reason, checks }` — 명세 §30 의
  `run.completed_with_override` 에 대응한다. 이름이 다른 이유: 이 앱의 저널은 Task 단위이고, 강제되는
  것도 Run 이 아니라 Task 다.

"수렴을 끝내지 않았다" 의 판정(`isOverrideCompletion`, 순수 함수): 이 Task 에 완료 정책이 걸려 있고
(검사 목록이 있거나 검토를 요구한다), **그리고** 마지막 라운드가 통과가 아니다(실패·타임아웃한 검사가
있거나, 막는 리뷰 이슈가 남아 있거나, 검사가 아직 한 번도 돌지 않았다).

## 6. 이 조각이 하지 않는 것

- **보통 Run 의 일시정지**(§47 의 문자 그대로). B1 이 이유다 — 제품 개념을 새로 만드는 일이라 사람이
  정할 문제다.
- **토큰·비용 예산**(§40 의 나머지). 이 앱은 Dispatch 단위 토큰 계정을 갖고 있지 않다. 시간은 지금
  가진 것으로 잴 수 있고, 토큰은 그렇지 않다.
- **정책이 바뀌었을 때 자동으로 막는 것**(B7).
- **검사 내용의 약화 탐지**(§36 의 나머지 — 단언 약화, `test.skip`). 파일이 바뀐 사실까지가 앱이 볼 수
  있는 것이고, 그 안을 읽는 것은 리뷰어의 일이다(§33).

## 7. 테스트

| 파일 | 고정하는 것 |
|---|---|
| `convergence.test.ts` | `repairCountOf` 가 판정 낸 것과 도는 것만 센다; 일시정지·정지·유실로 닫힌 수리는 안 센다 |
| `convergence.test.ts` (신규) | `completionPolicyHash` 가 순서를 구별하고, 이름만 바뀌면 같고, 명령이 바뀌면 다르다 |
| `state.test.ts` | 시간 예산을 넘기면 횟수가 남아도 소진 Gate; `convergenceStartedAt` 은 한 번만 찍힌다; 멈춤·일시정지가 시간 소진보다 앞선다 |
| `state.test.ts` | `isOverrideCompletion` 의 갈래들 |
| `server.test.ts` | 수렴 안 끝난 Task 를 completed 로 옮길 때 `--reason` 없으면 거절, 있으면 저널에 남는다 |
| `catalog.test.ts` | 네 카탈로그 (기존) |
