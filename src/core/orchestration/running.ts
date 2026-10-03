import type { JobTask, RunOutcome } from '../types'
import type { OrchState } from './state'
import { FAILURE_LIMIT, type Task } from './types'

// tasksOwnedBy, isTerminal and outcomeOf moved here from view.ts so runningRunCount can ask outcomeOf:
// the renderer's build includes this file and not view.ts, which re-exports them.

/** ownerId 는 회차의 id 이거나, 아직 회차가 없는 Job 의 id 다 — 뒤쪽이면 정의 Task 를 센다.
 *  두 id 는 접두사가 달라(`job_`·`run_`) 섞일 수 없다. */
export const tasksOwnedBy = (state: OrchState, ownerId: string): Task[] =>
  state.tasks.filter((t) => t.runId === ownerId || t.jobId === ownerId)

/** Task 가 더 움직이지 않는가.
 *
 *  failed 는 그것만으로 terminal 이 아니다 — 전이표(types.ts)의 `failed: ['dispatched', 'blocked']`
 *  가 말하듯 실패한 Task 는 재시도되고, 그것이 FAILURE_LIMIT 까지의 정상 흐름이다. view.ts 의
 *  progressOf 가 같은 이유로 failed 를 완료로 세지 않는다. 재시도가 소진되어야(연속 실패가
 *  FAILURE_LIMIT) 더 움직이지 않는다. */
export const isTerminal = (t: Task): boolean =>
  t.status === 'completed' || (t.status === 'failed' && t.consecutiveFailures >= FAILURE_LIMIT)

/** Run 이 끝났는지, 끝났다면 성공인지 실패인지.
 *
 *  **저장된 값이 아니라 파생이다.** 명시적인 close 명령을 두면 코디네이터가 그것을 부른다는
 *  규율에 기대게 되고, 잊으면 화면은 지금과 똑같아진다.
 *
 *  terminal 의 정의는 store.ts 의 TTL 정리와 **일부러 다르다.** 그쪽은 30일간 아무 일도 없었던
 *  Run 을 버릴지 정하는 자리라 재시도 중인 Task 가 있을 수 없고, 재시도가 남았는지 여부가 결과를
 *  바꾸지 않는다. 여기는 지금 도는 Run 에 라벨을 붙이는 자리다 — 두 번째 시도를 기다리는 Task 를
 *  '실패'로 적으면 다음 시도에서 라벨이 사라진다. 같은 상수로 묶지 말 것.
 *
 *  Task 가 없으면 running: Run 만 만들고 Task 를 아직 만들지 않은 상태가 정상적인 시작 지점이다.
 *  every 는 빈 배열에 참이므로, 이 가드가 없으면 방금 만든 Run 이 completed 로 보인다.
 *  (store.ts 가 같은 이유로 own.length > 0 을 두고 있다.)
 *
 *  failed 가 completed 를 이긴다 — 사람이 손봐야 하는 Run 을 목록에서 바로 찾을 수 있어야 한다.
 *
 *  대가: 모두 끝난 뒤 Task 가 추가되면 completed 가 running 으로 되돌아간다. 진행률 숫자도 같은
 *  방식으로 움직이므로 정직한 표시라고 본다. */
export function outcomeOf(state: OrchState, runId: string): RunOutcome {
  const tasks = tasksOwnedBy(state, runId)
  if (tasks.length === 0) return 'running'
  if (!tasks.every(isTerminal)) return 'running'
  return tasks.some((t) => t.status === 'failed') ? 'failed' : 'completed'
}

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
    // **A Run with its coordinator attached counts while it has work left** (e2e 2026-10-01:
    // `runsRunning: 0` beside a coordinator planning a Task-less Run). That coordinator is the work in
    // flight: it plans and places. Not once the Run is paused (`runs stop` stopped it) or finished
    // (a manual Run keeps its coordinator for a grace after its Tasks end, and that is not work).
    (run.coordinatorSessionId !== undefined && run.paused !== true && outcomeOf(s, run.id) === 'running') ||
    s.tasks.some(
      (t) =>
        t.runId === run.id &&
        (t.status === 'validating' ||
          t.status === 'reviewing' ||
          (t.status === 'dispatched' && open.some((d) => d.taskId === t.id)))
    )
  ).length
}
