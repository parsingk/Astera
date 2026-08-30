// 완료된 Work Unit 하나 → 화면의 "최근 변경" 한 줄 (ChangeSummary).
//
// **AI 를 부르지 않는다.** 이 단계는 결정적이다 — body 는 사용자의 요청 원문(unit.title)이다.
// ChangeSummary.body 의 계약은 "기능 관점의 변화 한 문장. 커밋 메시지가 아니다"인데, 사용자가
// 요청한 말이 바로 그 문장이다: "로그인 고쳐줘"는 무엇이 왜 바뀌었는지를 커밋 메시지보다 잘
// 말한다. AI 다듬기(의도 정규화)는 설명 생성 쪽(WU §22 의 V2)이지 이 줄의 일이 아니다.
//
// node: import 없음 — id 와 시각은 부르는 쪽(main)이 만든다.
import type { SessionWorkUnit } from '../workUnit/types'
import type { ChangeSummary } from './types'
import { evidenceIdOf } from './evidence'

/** 화면의 sourceLabel 규칙. 스펙 예시("세션 #182")를 따르되 이 앱의 세션에는 순번이 없어
 *  id 의 앞 여덟 자를 쓴다 — 사람이 두 변경을 구별하는 용도이지 식별자가 아니다.
 *  저장되는 데이터라 UI 언어를 따라 다시 그릴 수 없다: 스펙과 기존 픽스처의 표기를 그대로 쓴다. */
export function sessionLabelOf(sessionId: string): string {
  return `세션 ${sessionId.slice(0, 8)}`
}

/** completed 가 아닌 Unit 은 변경이 아니다 — abandoned 는 스펙 §7 이 "하류로 흐르지 않는다"고
 *  못박은 것이고, 열려 있는 것은 아직 결과가 없다. 부르는 쪽이 거르는 것을 잊어도 여기서 선다. */
export function changeSummaryOf(unit: SessionWorkUnit, id: string): ChangeSummary | null {
  if (unit.status !== 'completed') return null
  return {
    id,
    // completedAt 은 닫힐 때 반드시 채워진다(collector 의 close). 그래도 옛 파일에 없을 수
    // 있어 시작 시각으로 저하한다 — 없는 값보다 이른 값이 낫다: 정렬만 쓰는 자리다
    at: unit.completedAt ?? unit.startedAt,
    sourceKind: 'session',
    sourceId: unit.sessionId,
    sourceLabel: sessionLabelOf(unit.sessionId),
    body: unit.title,
    // **이 변경이 건드린 파일이 곧 이 줄의 근거다.** 단계를 눌렀을 때 "이 단계를 바꾼 변경" 칸이
    // 서는 것은 오직 이 겹침이다(scope.ts). 그 기능의 근거가 아닌 파일도 함께 들지만, 겹치지
    // 않으면 어디에도 서지 않으므로 거를 이유가 없다.
    evidenceIds: unit.git.observedChangedFiles.map(evidenceIdOf)
    // featureName 은 매핑이 정한 뒤 파이프라인이 채운다 — 이 단계는 기능을 모른다
  }
}
