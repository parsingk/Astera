// 트랜스크립트의 `type:'user'` 레코드 중 **사람의 요청**만 가려낸다 — 스펙 §16.2.
//
// **문자열이 아니라 구조로 가린다.** history/parser.ts 의 MACHINE_USER_PREFIXES 는 관찰된
// 문자열의 차단 목록이고, 새 주입 종류가 생기면 조용히 낡는다(그 파일 주석이 실제로 그 일이
// 있었음을 기록한다). 여기서는 CLI 자신이 남긴 구조 표지를 본다.
//
// **실측(2026-08-29, 최근 40개 파일, type:'user' 3,206개).**
//   도구 결과            toolUseResult 있음        2,674 (84%)
//   하네스 주입 알림      promptSource==='system'     204
//   스킬 본문·이미지      isMeta===true                31
//   압축 이어가기        isCompactSummary===true       4
//   슬래시 명령          promptSource 없음            23
//   **사람의 요청**       아래 허용 목록              257
//
// history/parser.ts 는 건드리지 않는다: 히스토리 목록은 promptSource 가 없던 시절의 옛 기록도
// 다루므로 그쪽은 문자열 판정이 여전히 맞다. 두 벌인 이유가 이것이다.
// (toTitle 은 그 파일에서 가져다 쓴다 — 그것은 문자열 다듬기이지 판정이 아니다. 다만 그 파일이
// node:fs 를 최상위에서 import 하므로, 이 모듈을 렌더러 번들에 넣으려면 toTitle 을 잎 모듈로
// 먼저 올려야 한다 — 지금 렌더러는 이 파일을 import 하지 않아 문제가 없다.)
import { toTitle } from '../history/parser'

/** `promptSource` 가 이 넷 중 하나여야 사람의 요청이다.
 *
 *  **허용 목록인 것이 요점이다.** 차단 목록이면 CLI 가 새 주입 종류를 더할 때마다 그것이 사람의
 *  말로 새어 들어오고, 그때 Work Unit 의 제목이 하네스가 쓴 글이 된다. 허용 목록은 모르는 값을
 *  기본으로 거부하므로 새 종류가 생겨도 조용히 틀리지 않는다 — 대신 CLI 가 값 이름을 바꾸면
 *  사람의 말을 놓치는데, 그쪽은 Unit 이 안 생겨 눈에 띈다. 조용히 틀리는 것보다 낫다.
 *
 *  `sdk` 가 들어 있는 이유: 프로그램이 넣은 것이지만 **사람의 요청을 대신한다**(재개 브리핑 등).
 *  사람이 하던 작업을 이어 달라는 요청이므로 목표로 본다. */
export const HUMAN_PROMPT_SOURCES: ReadonlySet<string> = new Set([
  'typed',
  'queued',
  'sdk',
  'suggestion_accepted'
])

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** 레코드에서 사람이 읽을 텍스트를 꺼낸다. content 는 문자열이거나 블록 배열이다 */
export function requestTextOf(record: Record<string, unknown>): string {
  const message = record.message
  if (!isObj(message)) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => isObj(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/** Unit 의 제목. `toTitle` 은 빈 문자열에 null 을 주는데 Unit 은 제목 없이 설 수 없으므로 감싼다.
 *
 *  **감싸는 자리가 여기인 이유:** 이 규칙이 배선(collector)에 있으면 검증되지 않는다 — 이 저장소는
 *  main 의 배선에 테스트를 두지 않는다. 스펙 §8 이 "지어내지 않는다"를 규칙으로 못박았으므로
 *  그 규칙은 테스트가 닿는 자리에 있어야 한다. */
export function titleOf(text: string): string {
  return toTitle(text) ?? '(제목 없음)'
}

export function isHumanRequest(record: Record<string, unknown>): boolean {
  if (record.type !== 'user') return false
  // 도구 결과. 실측에서 84% 가 이것이고, 문자열을 보지 않고도 갈린다
  if (record.toolUseResult !== undefined) return false
  // 스킬 본문과 이미지 자리표시자. 개수는 적지만 바이트로는 대부분이다
  if (record.isMeta === true) return false
  // 압축 이어가기 안내
  if (record.isCompactSummary === true) return false
  // 허용 목록. 모르는 값과 없는 값(슬래시 명령)이 여기서 걸린다
  if (typeof record.promptSource !== 'string' || !HUMAN_PROMPT_SOURCES.has(record.promptSource))
    return false

  const text = requestTextOf(record).trim()
  if (text === '') return false
  // 슬래시 명령의 잔여. 이 표지는 CLI 구현이 정한 것이라 문자열로 잡는 편이 정확하다 —
  // 남은 유일한 접두사이고, 무엇을 위한 것인지가 이 한 줄로 끝난다
  if (text.startsWith('<command-name')) return false

  return true
}
