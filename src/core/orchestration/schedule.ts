import { DEFAULT_CONCURRENCY, FAILURE_LIMIT } from './types'
import type { OrchState } from './state'

/** 지금 워커를 띄워야 할 자리 하나.
 *
 *  **provider 칸이 없다.** 예전에는 Run 이 provider 를 들고 있어서 이 자리에 실어 보낼 수 있었다.
 *  이제 provider 는 Task 의 계정에서 나오는데, 계정 id 를 provider 로 옮기려면 계정 목록을 봐야
 *  하고 그것은 core 가 아니라 앱이 아는 것이다(이 파일이 지키는 경계). 그래서 계정만 싣고, 배선이
 *  `accountIds[0]` 에서 provider 를 알아낸다. */
export interface Slot {
  runId: string
  taskId: string
  /** 사람이 이 Task 에 지정해 둔 계정들, 순서대로(Task.accountIds). **여기서 판정하지 않고 그대로
   *  실어 보낸다** — 쓸 수 있는지는 계정 목록과 로그인 여부를 봐야 알고, 그 둘은 앱이 아는
   *  것이다(위 주석). 배선이 accountToDispatchOn 에 넘긴다.
   *
   *  **비어 있지 않다.** slotsToFill 이 계정 없는 Task 를 아예 고르지 않으므로(그런 Task 는 어느
   *  CLI 로 띄울지 알 수 없다), 이 칸은 언제나 있고 언제나 하나 이상이다. */
  accountIds: string[]
}

/** 지금 띄워야 할 것들. **부수 효과가 없고 같은 입력에 같은 답을 준다** — 이 판정이 순수해야
 *  하는 이유는 이것이 이 슬라이스에서 기계가 검사할 수 있는 유일한 부분이기 때문이다(스케줄러를
 *  매다는 자리는 main 의 배선이라 테스트가 없다).
 *
 *  **autoDispatch 인 Run 만 본다.** 코디네이터가 만든 Run 을 함께 돌리면 둘이 같은 ready Task 를
 *  두고 경합한다(Run.autoDispatch 의 주석 참고).
 *
 *  **계정이 없는 Task 는 건너뛴다.** 계정이 provider 의 유일한 출처이므로(Task.accountIds), 계정이
 *  없으면 어느 CLI 로 띄울지 알 수 없다. 만드는 두 자리가 모두 계정을 요구하지만 입력은 명령이
 *  아니라 파일이다 — orchestration.json 은 프로세스보다 오래 살고, 이 규칙 전에 만들어진 Task 와
 *  손으로 고친 파일에는 그 칸이 없다. graph.ts 가 순환을 다루는 것과 같은 이유다.
 *
 *  건너뛴 Task 가 조용히 멈추지는 않는다 — 아래 tasksMissingAccounts 가 그것들을 따로 내고,
 *  배선이 그 목록에 Gate 를 연다(accountToDispatchOn 이 거절할 때와 같은 자리). */
export function slotsToFill(s: OrchState): Slot[] {
  const slots: Slot[] = []
  for (const run of s.runs) {
    if (!run.autoDispatch) continue
    // 템플릿은 자신이 돌지 않는다 — 발화마다 자식 Run 이 생기고 그것이 돈다. 위의 autoDispatch
    // 검사가 이미 걸러내지만(run-create 가 예약이면 켜지 않는다) 그 사실에 기대지 않는다:
    // orchestration.json 은 프로세스보다 오래 살고 손으로 고쳐진다 — 이 파일 머리말이 계정 없는
    // Task 를 건너뛰는 것과 같은 이유다.
    if (run.schedule) continue
    // 사람이 '실행' 을 누르기 전까지는 돌지 않는다. autoDispatch 와 따로 두는 이유는
    // Run.pendingStart 의 주석에 있다 — 그것을 끄는 방식으로는 코디네이터 Run 과 구별되지 않는다.
    if (run.pendingStart) continue
    // **세워 둔 것도 배치하지 않는다.** 일시 중지가 도는 워커를 닫아도, 그 자리에 그 Run 의 다음
    // ready Task 가 곧바로 뜨면 "일시 중지" 가 "지금 도는 Task 하나만 멈춤" 이 된다. 예약을 세우면
    // 그 회차들에도 이 칸이 붙는다(state.ts 의 pauseSchedule).
    if (run.paused) continue
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
        // 계정이 없으면 provider 를 알 수 없다(이 함수 머리말) — 고르지 않는다
        (t.accountIds?.length ?? 0) > 0 &&
        // ready 인데 열린 Dispatch 가 있는 조합은 만들어질 수 없지만, 판정이 그 사실에 기대지
        // 않는다. 기대면 그 불변식이 깨지는 날 두 워커가 같은 Task 를 잡는다
        !open.some((d) => d.taskId === t.id)
    )
    for (const t of candidates.slice(0, room)) {
      // accountIds 는 위 필터가 비어 있지 않음을 보장한다(Slot.accountIds 의 주석)
      slots.push({ runId: run.id, taskId: t.id, accountIds: t.accountIds as string[] })
    }
  }
  return slots
}

/** 계정이 없어서 **띄울 수 없는** ready Task 들. slotsToFill 이 건너뛴 것들 중, 사람이 그 사실을
 *  알아야 하는 것만 낸다.
 *
 *  **왜 따로 내는가.** slotsToFill 은 "지금 띄울 자리"를 내고, 계정 없는 Task 는 그 자리가 아니다.
 *  그런데 그것을 그냥 빼고 끝내면 Run 이 이유 없이 서 있는다 — 이 하위 시스템이 없애려는 증상
 *  그대로다(ipc.ts 의 gateSlot 주석). 그래서 같은 Run 필터를 지나되 답이 다른 두 함수로 가른다.
 *
 *  **한 번만 열린다.** Gate 가 열리면 Task 는 blocked 로 가고(state.ts 의 createGate) 이 판정은
 *  ready 만 보므로 다음 바퀴에는 나오지 않는다. 사람이 계정을 넣고 Gate 를 풀면 다시 ready 가 되고
 *  그때는 slotsToFill 이 집어 간다.
 *
 *  회로 차단(FAILURE_LIMIT)에 걸린 Task 는 내지 않는다 — slotsToFill 이 같은 이유로 걸러내고, 그
 *  Task 에 대해 사람이 할 일은 계정 지정이 아니다. */
export function tasksMissingAccounts(s: OrchState): { runId: string; taskId: string }[] {
  const out: { runId: string; taskId: string }[] = []
  const open = s.dispatches.filter((d) => !d.outcome && !d.endedAt)
  for (const run of s.runs) {
    // slotsToFill 과 **같은** Run 필터다. 하나라도 어긋나면 앱이 돌리지 않는 Run 의 Task 에
    // Gate 가 열린다 — 코디네이터가 계정 없이 만든 Task 는 그가 worker-start 로 직접 띄운다.
    if (!run.autoDispatch) continue
    if (run.schedule) continue
    if (run.pendingStart) continue
    if (run.paused) continue
    for (const t of s.tasks) {
      if (t.runId !== run.id) continue
      if (t.status !== 'ready') continue
      if (t.consecutiveFailures >= FAILURE_LIMIT) continue
      if ((t.accountIds?.length ?? 0) > 0) continue
      if (open.some((d) => d.taskId === t.id)) continue
      out.push({ runId: run.id, taskId: t.id })
    }
  }
  return out
}
