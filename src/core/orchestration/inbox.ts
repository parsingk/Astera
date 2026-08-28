// 앱이 스스로 돌리는 Run 의 받은편지함 판정. 순수하고 부수 효과가 없다 — schedule.ts 의
// slotsToFill 과 같은 이유로 그렇다(이 슬라이스에서 기계가 검사할 수 있는 유일한 부분이고,
// 매다는 자리는 main 의 배선이라 테스트가 없다).
import type { OrchState } from './state'

/** 코디네이터가 없는 Run 에서 워커의 `ask` 에 돌려주는 답. **고정 문구다.**
 *
 *  **왜 앱이 답하는가.** `ask` 는 부드리기다 — 워커는 답이 올 때까지 멈춰 서 있다. 그리고 프로토콜
 *  상 그 답을 줄 사람은 코디네이터인데, **그 Run 에 코디네이터가 없을 때가 있다.** 그래서 예전에는
 *  그 질문이 아무도 읽지 않는 채 쌓이고 워커는 누가 죽일 때까지 기다렸다 — 실측(2026-08-28): 한 줄
 *  스크립트를 고치는 Task 의 워커가 "이 설계를 승인해 달라"고 물은 뒤 1분 넘게 서 있다가 사람이
 *  탭을 닫아 `exitCode=1`, `No worker_done was received` 로 끝났다.
 *
 *  **코디네이터가 붙은 뒤에도 이 그물은 남는다.** 없는 순간이 세 가지 있다: 사이드바에서 코디네이터
 *  계정을 비워 둔 Run(그때는 앱이 직접 돌린다), 세션이 사라져 되띄우기가 그친 Run
 *  (`coordinatorFailures` 가 한계에 닿았다), 그리고 되띄우는 사이의 짧은 창.
 *
 *  **사람에게 올리지 않는 이유.** `question` 은 프로토콜상 "코디네이터여, 정해 달라"이고 그 질문의
 *  대부분은 spec 이 이미 답해 둔 것이다(위 실측이 그 사례다 — 물은 것이 "1을 2로 바꿔도 되나"였고
 *  spec 이 "2를 출력하라"였다). 그것을 사람에게 올리면 밤새 돌려두는 이 모드의 전제가 깨진다.
 *  진짜로 사람이 필요한 것은 `escalation`·`decision_gate` 이고 그 둘은 부드리기가 없다.
 *
 *  **영어인 이유.** 워커가 읽는 문구다 — spec 파일(coordinator.ts 의 buildSpecFile)과 재개 지시문
 *  (resumeSection.ts)이 영어인 것과 같은 자리이고, 화면 문구가 아니므로 i18n 을 타지 않는다. */
export const NO_COORDINATOR_ANSWER =
  'There is no coordinator on this Run — the app started you from its Jobs list and no agent is ' +
  'reading this inbox, so nobody is going to weigh in. Decide within the scope your spec already ' +
  'sets and carry on. If you genuinely cannot proceed, say so with `astera send --type escalation` ' +
  'and stop there; that one reaches a person.'

/** 답을 기다리며 멈춰 있는 워커의 질문들. 답할 코디네이터가 없는 Run 의 것만 낸다.
 *
 *  **Run 필터는 "답할 코디네이터가 없다" 하나다.** 예전에는 `autoDispatch` 로 물었다 — 코디네이터
 *  세션이라는 개념이 아직 없었고, 앱이 돌리는 Run 이 곧 코디네이터 없는 Run 이었다. 이제는 그 둘이
 *  같지 않다: 코디네이터에게 넘긴 Run 은 `autoDispatch` 가 꺼져 있고(한 Run 에 운전자는 하나),
 *  그 Run 의 질문은 앱이 답해서는 안 된다 — 코디네이터가 답할 것이다.
 *
 *  시작 게이트(`pendingStart`)와 일시 중지(`paused`), 예약 템플릿을 따로 보지 않는 이유: 그 세
 *  상태에서는 도는 워커가 없고, 아래 열린-Dispatch 검사가 이미 그것을 걸러낸다.
 *
 *  **이미 답한 질문은 내지 않는다.** 그래서 되풀이가 없다 — 답이 실리면(applyReply) 다음 바퀴에
 *  이 판정에 걸리지 않는다.
 *
 *  **"답이 있다" 의 기준을 `ask` 쪽 폴링에서 그대로 가져온다** — `answered` 이고 `answerBody` 가
 *  빈 문자열이 **아닐** 때만 답이다(server.ts 의 probe: "a real answerBody can never be the empty
 *  string"). 빈 답은 Dispatch 가 끝날 때 settlePendingQuestions 가 남기는 정리 표시일 뿐이다.
 *  `!answered` 만 보면 기다리는 쪽과 답을 세는 쪽의 판단이 갈리고, 그 틈에서 워커는 영원히 선다:
 *  손으로 고친 파일에 `{answered:true, answerBody:''}` 와 열린 Dispatch 가 함께 있으면 `ask` 는
 *  계속 기다리는데 이 판정은 답한 것으로 읽는다. 이 파일은 프로세스보다 오래 산다. */
export function unattendedQuestions(s: OrchState): string[] {
  const unattendedRuns = new Set(
    s.runs.filter((r) => r.coordinatorSessionId === undefined).map((r) => r.id)
  )
  const openDispatchIds = new Set(
    s.dispatches.filter((d) => !d.outcome && !d.endedAt).map((d) => d.id)
  )
  return s.messages
    .filter(
      (m) =>
        m.type === 'question' &&
        // 위 JSDoc — `ask` 의 probe 와 같은 규칙이다
        (m.answerBody ?? '') === '' &&
        unattendedRuns.has(m.runId) &&
        // 워커가 아직 그 답을 기다리고 있어야 한다. Dispatch 가 끝났으면 기다리는 쪽이 없고,
        // `ask` 는 그 경우를 스스로 abandoned 로 빠져나온다(server.ts 의 probe).
        m.dispatchId !== undefined &&
        openDispatchIds.has(m.dispatchId)
    )
    .map((m) => m.id)
}

/** 코디네이터가 잠든 사이 쌓인, **아직 읽지 않은** 상향 메일. 깨울 대상을 낸다.
 *
 *  **왜 깨워야 하는가.** 코디네이터는 LLM 세션이라 턴이 끝나면 멈춘다. `check --wait` 안에 있는
 *  동안만 소식이 닿고, 그 루프를 놓으면 워커가 보고했는데도 아무 일도 일어나지 않는다 — 앱이
 *  코디네이터 없는 Run 에서 겪던 정지가 한 층 위로 옮겨간 것뿐이다. 인수 프롬프트가 루프를 돌라고
 *  말하지만(handover.ts), 말한 것과 지키는 것은 다르다.
 *
 *  **"읽었다" 의 기준은 ack 이다.** `check` 가 배치를 내고 `check --ack` 가 그것을 확인하므로
 *  (Delivery), `ackedAt` 이 붙은 메시지는 코디네이터가 손에 쥔 것이다. 배달만 되고 확인이 안 된
 *  것은 아직 처리 중일 수 있어 `staleMs` 로 유예한다 — 그 유예가 없으면 `check --wait` 안에 있는
 *  코디네이터를 헛되이 찌른다.
 *
 *  **heartbeat 는 세지 않는다.** 그것만으로는 코디네이터가 할 일이 없고, 그것 때문에 깨우면 살아
 *  있는 코디네이터를 주기적으로 두드리게 된다. 나머지는 전부 코디네이터의 행동을 요구한다 —
 *  `worker_done` 은 다음 Task 를, `status` 는 검증 결과를(가이드: 검증이 걸린 Task 는 그 메시지가
 *  올 때까지 정산되지 않는다), `question`·`escalation`·`decision_gate` 는 판단을. */
export function unreadUpwardMail(
  s: OrchState,
  a: { nowMs: number; staleMs: number }
): { runId: string; sessionId: string; messageIds: string[] }[] {
  const out: { runId: string; sessionId: string; messageIds: string[] }[] = []
  for (const run of s.runs) {
    const sessionId = run.coordinatorSessionId
    if (sessionId === undefined) continue
    const messageIds = s.messages
      .filter(
        (m) =>
          m.runId === run.id &&
          m.type !== 'heartbeat' &&
          m.ackedAt === undefined &&
          Date.parse(m.createdAt) <= a.nowMs - a.staleMs
      )
      .map((m) => m.id)
    if (messageIds.length > 0) out.push({ runId: run.id, sessionId, messageIds })
  }
  return out
}
