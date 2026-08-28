// 앱이 스스로 돌리는 Run 의 받은편지함 판정. 순수하고 부수 효과가 없다 — schedule.ts 의
// slotsToFill 과 같은 이유로 그렇다(이 슬라이스에서 기계가 검사할 수 있는 유일한 부분이고,
// 매다는 자리는 main 의 배선이라 테스트가 없다).
import type { OrchState } from './state'

/** 코디네이터가 없는 Run 에서 워커의 `ask` 에 돌려주는 답. **고정 문구다.**
 *
 *  **왜 앱이 답하는가.** `ask` 는 부드리기다 — 워커는 답이 올 때까지 멈춰 서 있다. 그리고 프로토콜
 *  상 그 답을 줄 사람은 코디네이터인데, 앱이 만든 Run(`Run.autoDispatch`)에는 코디네이터 세션이
 *  없다. 사이드바 버튼이 IPC 로 Run 을 만들 뿐이고 LLM 은 한 명도 관여하지 않는다. 그래서 예전에는
 *  그 질문이 아무도 읽지 않는 채 쌓이고 워커는 누가 죽일 때까지 기다렸다 — 실측(2026-08-28): 한 줄
 *  스크립트를 고치는 Task 의 워커가 "이 설계를 승인해 달라"고 물은 뒤 1분 넘게 서 있다가 사람이
 *  탭을 닫아 `exitCode=1`, `No worker_done was received` 로 끝났다.
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
 *  **Run 필터가 slotsToFill 보다 좁은 이유.** 저쪽은 "지금 워커를 띄울 자리"를 고르므로 시작 게이트
 *  (`pendingStart`)와 일시 중지(`paused`)를 함께 본다. 여기서 찾는 것은 **이미 돌고 있는** 워커의
 *  질문이므로 그 둘은 판정에 들어오지 않는다 — 그 두 상태에서는 열린 Dispatch 자체가 없고, 아래
 *  열린-Dispatch 검사가 그것을 이미 걸러낸다. 남는 것은 "이 Run 의 코디네이터가 앱인가" 하나다.
 *
 *  예약 템플릿을 빼는 이유는 slotsToFill 과 같다: 템플릿은 자신이 돌지 않으므로 그 아래에 도는
 *  워커가 없다. 회차는 `autoDispatch` 가 켜진 자식 Run 이라 그대로 들어온다.
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
  const appRuns = new Set(
    s.runs.filter((r) => r.autoDispatch && !r.schedule).map((r) => r.id)
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
        appRuns.has(m.runId) &&
        // 워커가 아직 그 답을 기다리고 있어야 한다. Dispatch 가 끝났으면 기다리는 쪽이 없고,
        // `ask` 는 그 경우를 스스로 abandoned 로 빠져나온다(server.ts 의 probe).
        m.dispatchId !== undefined &&
        openDispatchIds.has(m.dispatchId)
    )
    .map((m) => m.id)
}
