import { DEFAULT_CONCURRENCY, FAILURE_LIMIT } from './types'
import type { OrchState } from './state'
import type { Provider } from '../providers/meta'

/** 지금 워커를 띄워야 할 자리 하나. provider 는 Run 이 정하고, 계정은 이것을 받는 쪽이
 *  defaultAccountIdOf 로 고른다 — 계정 목록은 core 가 아니라 앱이 아는 것이다. */
export interface Slot {
  runId: string
  taskId: string
  provider: Provider
  /** 사람이 이 Task 에 지정해 둔 계정(Task.accountId). **여기서 판정하지 않고 그대로 실어 보낸다** —
   *  쓸 수 있는지는 계정 목록과 로그인 여부를 봐야 알고, 그 둘은 앱이 아는 것이다(위 주석).
   *  배선이 accountToDispatchOn 에 넘긴다. 없으면 이 칸 자체가 없다: undefined 를 실으면 Slot 을
   *  값으로 비교하는 자리에서 "지정 없음"과 갈라진다. */
  accountId?: string
}

/** 지금 띄워야 할 것들. **부수 효과가 없고 같은 입력에 같은 답을 준다** — 이 판정이 순수해야
 *  하는 이유는 이것이 이 슬라이스에서 기계가 검사할 수 있는 유일한 부분이기 때문이다(스케줄러를
 *  매다는 자리는 main 의 배선이라 테스트가 없다).
 *
 *  **autoDispatch 인 Run 만 본다.** 코디네이터가 만든 Run 을 함께 돌리면 둘이 같은 ready Task 를
 *  두고 경합한다(Run.autoDispatch 의 주석 참고).
 *
 *  **provider 가 없는 Run 은 건너뛴다.** run-create 가 셋을 함께 넣으므로 명령으로는 만들 수 없는
 *  조합이지만, 입력은 명령이 아니라 파일이다 — orchestration.json 은 프로세스보다 오래 살고 손으로
 *  고쳐진다. graph.ts 가 순환을 다루는 것과 같은 이유다. */
export function slotsToFill(s: OrchState): Slot[] {
  const slots: Slot[] = []
  for (const run of s.runs) {
    if (!run.autoDispatch) continue
    const provider = run.provider
    if (!provider) continue
    const open = s.dispatches.filter((d) => !d.outcome && !d.endedAt)
    const openHere = open.filter((d) => {
      const t = s.tasks.find((x) => x.id === d.taskId)
      return t?.runId === run.id
    }).length
    const room = (run.concurrency ?? DEFAULT_CONCURRENCY) - openHere
    if (room <= 0) continue
    const candidates = s.tasks.filter(
      (t) =>
        t.runId === run.id &&
        t.status === 'ready' &&
        // worker-start 가 어차피 회로 차단으로 거절한다. 여기서 걸러야 같은 실패가 매 저장마다
        // 로그를 채우지 않는다 — 그 로그는 진짜 문제를 덮는다
        t.consecutiveFailures < FAILURE_LIMIT &&
        // ready 인데 열린 Dispatch 가 있는 조합은 만들어질 수 없지만, 판정이 그 사실에 기대지
        // 않는다. 기대면 그 불변식이 깨지는 날 두 워커가 같은 Task 를 잡는다
        !open.some((d) => d.taskId === t.id)
    )
    for (const t of candidates.slice(0, room)) {
      slots.push({
        runId: run.id,
        taskId: t.id,
        provider,
        ...(t.accountId !== undefined ? { accountId: t.accountId } : {})
      })
    }
  }
  return slots
}
