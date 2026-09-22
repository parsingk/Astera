import type { JobTask } from '../types'
import type { OrchState } from './state'

/** 지금 일이 도는 Task 의 개수. 사이드바의 `+N` 과 두 화면(JobsView·RunDetail)의 머리 숫자가
 *  이것을 센다. 렌더러가 아니라 여기 있는 이유는 elapsed.ts 와 같다 — 렌더러에 테스트가 없어서,
 *  이 규칙은 테스트가 닿는 자리에 있어야 한다. 실제로 이 함수는 그 이유 때문에 생겼다: 규칙이
 *  렌더러에 있던 동안 같은 결함이 두 화면에 각각 복사되어 있었고, 둘이 똑같이 틀려서 "두 화면이
 *  같은 숫자를 적는가"를 보는 확인마저 통과했다.
 *
 *  **상태만으로는 답이 안 된다.** worker-stop 은 세션을 닫고 Task 는 일부러 그대로 둔다
 *  (server.ts: "The Task is left alone — the orchestrator looks at worker-show and decides for
 *  itself"). 그래서 상태로 세면 껐는데도 dispatched 인 Task 가 계속 도는 것으로 세어져, 워커를 다
 *  끈 Run 이 줄 하나 없이 `+4` 를 세운다.
 *
 *  **열린 Dispatch 로만 세도 답이 안 된다.** 앱이 하는 일에는 세션이 없다:
 *  - validating — 검증은 앱이 돌린다(ipc.ts 의 validator). 세션이 아예 없어서, Dispatch 로 세면
 *    검증만 남은 Run 이 화면에서 사라진다.
 *  - reviewing — 상태가 먼저 바뀌고 검토 세션이 async 로 뒤따라 뜬다(ipc.ts 의 void startReview).
 *    그 틈에 0 으로 떨어지면 검토가 시작될 때마다 숫자가 깜빡인다.
 *
 *  그래서 **dispatched 만 열린 Dispatch 를 요구한다** — worker-stop 이 어긋내는 상태가 그 하나다.
 *  열린 Dispatch 의 증거로 startedAt 을 쓴다: view.ts 의 jobTaskOf 가 provider·startedAt 을 열린
 *  Dispatch 에서만 싣고, JobTask.provider 의 주석이 그것을 "A Dispatch that has ended does not
 *  count" 로 적어 두었다.
 *
 *  **남은 구멍(의도한 것):** *검토* 워커를 멈추면 reviewing 이 그대로 세어진다. reviewing +
 *  열린 Dispatch 없음은 "곧 뜰 것"과 "껐다"가 JobTask 만으로 구별되지 않는다 — 구별하려면 그 Task
 *  의 검토 Dispatch 가 존재하는지를 봐야 하고 그것은 이 투영에 실려 있지 않다. 흔한 쪽(구현 워커를
 *  멈추는 것)을 고치고, 검토가 뜨는 동안 숫자가 깜빡이는 것을 사는 대신 이쪽을 남겼다. */
export function runningCount(tasks: readonly JobTask[]): number {
  return tasks.filter((t) =>
    t.status === 'dispatched'
      ? t.startedAt !== undefined
      : t.status === 'validating' || t.status === 'reviewing'
  ).length
}

/** 워커가 멈춰 세워진 Task — `dispatched` 인데 열린 Dispatch 가 없다. worker-stop 이 만드는 상태다:
 *  releaseWorker 가 killSession 으로 세션을 정말 죽이고(coordinator.ts), Task 는 일부러 그대로
 *  둔다(server.ts). 그래서 이 Task 는 "워커에게 넘어갔고 아직 결론이 없다"인데 **일하는 워커는
 *  없다.**
 *
 *  글리프 문구가 이것을 물어야 하는 이유: 상태 문구는 `dispatched` 를 "워커가 일하는 중"이라고
 *  적는데, 그 말이 이 상태에서는 거짓이다. 회전 자체는 거짓이 아니다 — 그것은 "결론이 나지 않았다"로
 *  읽히고 그것은 맞다. 거짓인 것은 살아 있는 워커를 약속하는 낱말 쪽이다.
 *
 *  runningCount 와 같은 파일에 있는 이유는 **같은 질문**이기 때문이다. 이것을 렌더러에 두면 그
 *  질문의 답이 다시 두 벌이 된다 — 개수가 두 화면에 복사되어 똑같이 틀렸던 것이 그 결과였다. */
export function isStoppedWorker(t: JobTask): boolean {
  return t.status === 'dispatched' && t.startedAt === undefined
}

/** 지금 일이 도는 회차의 수 — `astera host stop` 이 거절할 때 세는 값이다(ruling F57).
 *
 *  **`runningCount` 와 같은 질문을 같은 규칙으로 답한다**, 입력만 다르다: 저쪽은 화면에 실려 간
 *  `JobTask` 투영을 보고 이쪽은 상태 원본을 본다. 규칙을 따로 쓰면 화면이 "도는 중" 이라고 적은
 *  회차를 Host 가 멈춰도 되는 것으로 읽는 날이 온다.
 *
 *  그래서 판정도 그대로다: `validating`·`reviewing` 은 세션 없이 앱이 도는 일이라 그 자체로 세고,
 *  `dispatched` 는 **열린 Dispatch 를 요구한다** — worker-stop 이 세션을 죽이고 Task 는 일부러
 *  그대로 두므로(server.ts), 상태만 보면 다 꺼 놓은 회차가 영원히 "도는 중" 이 된다.
 *
 *  **아직 시작하지 않은 계획은 세지 않는다.** Task 가 전부 pending·ready 인 회차는 사람이 Host 를
 *  멈추는 것을 막을 이유가 없다 — 지킬 일이 아직 없고, 그 상태로 막으면 세워 둔 계획 하나가
 *  `host stop` 을 영영 거절한다. 문서가 약속하는 것도 "진행 중인 일" 이다(docs/cli.md). */
export function runningRunCount(s: OrchState): number {
  const open = s.dispatches.filter((d) => !d.outcome && !d.endedAt)
  return s.runs.filter((run) =>
    s.tasks.some(
      (t) =>
        t.runId === run.id &&
        (t.status === 'validating' ||
          t.status === 'reviewing' ||
          (t.status === 'dispatched' && open.some((d) => d.taskId === t.id)))
    )
  ).length
}
