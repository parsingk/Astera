// Session sourceLabel formatting — this is where text like "세션 sess-abcd" on screen comes from.
// node: no imports.

/** 화면의 sourceLabel 규칙. 스펙 예시("세션 #182")를 따르되 이 앱의 세션에는 순번이 없어
 *  id 의 앞 여덟 자를 쓴다 — 사람이 두 변경을 구별하는 용도이지 식별자가 아니다.
 *  저장되는 데이터라 UI 언어를 따라 다시 그릴 수 없다: 스펙과 기존 픽스처의 표기를 그대로 쓴다. */
export function sessionLabelOf(sessionId: string): string {
  return `세션 ${sessionId.slice(0, 8)}`
}
