// 트랜스크립트 레코드 중 **사람의 요청**만 가려낸다 — 스펙 §16.2. claude 와 codex 두 형식을 받는다.
//
// **문자열이 아니라 구조로 가린다.** history/parser.ts 의 MACHINE_USER_PREFIXES 는 관찰된
// 문자열의 차단 목록이고, 새 주입 종류가 생기면 조용히 낡는다(그 파일 주석이 실제로 그 일이
// 있었음을 기록한다). 여기서는 CLI 자신이 남긴 구조 표지를 본다.
//
// **두 형식은 레코드 모양이 서로 배타적이라 프로바이더를 물을 필요가 없다** — claude 는
// `type:'user'`, codex 는 `type:'response_item'` 이다. 어느 쪽도 아니면 거부한다.
//
// **claude 실측(2026-08-29, 최근 40개 파일, type:'user' 3,206개).**
//   도구 결과            toolUseResult 있음        2,674 (84%)
//   하네스 주입 알림      promptSource==='system'     204
//   스킬 본문·이미지      isMeta===true                31
//   압축 이어가기        isCompactSummary===true       4
//   슬래시 명령          promptSource 없음            23
//   **사람의 요청**       아래 허용 목록              257
//
// **codex 실측(2026-08-30, 최근 60개 rollout, role:'user' 메시지 262개).**
//   재개 되쓰기          user.text 가 여러 개         63   ("The following is the Codex agent history…")
//   AGENTS.md·환경·플러그인  그 밖의 kind 가 섞임        48
//   옛 기록(필드 없음)     content_item_kinds 없음     114   (8/25 세션 하나에 몰려 있다 — 옛 codex)
//   **사람의 요청**       kinds === ['user.text']      37
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

/** codex 의 허용 목록. **`content_item_kinds` 가 정확히 이 하나여야 사람이 친 것이다.**
 *
 *  codex 는 주입한 것의 종류를 스스로 이름 붙여 이 배열에 적는다 — `agents_md.instructions`,
 *  `environments.environment_context`, `plugins.recommendations`. 그래서 claude 의 `promptSource`
 *  와 같은 자리, 같은 성질의 표지다: **모르는 kind 는 기본으로 거부된다.**
 *
 *  **길이가 1 이어야 하는 이유.** `user.text` 가 여러 개인 레코드는 실측 63건이 **전부** 재개
 *  되쓰기였다("The following is the Codex agent history…"). codex 는 이어받을 때 지난 대화를
 *  user.text 조각 수십 개로 묶어 한 레코드에 넣는다. 그것을 사람의 요청으로 읽으면 켜기 전의
 *  대화가 Unit 이 되어 이 기능의 약속(스펙 §16.1)이 깨진다. 사람이 실제로 친 것은 언제나 하나다. */
const CODEX_HUMAN_KIND = 'user.text'

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** codex 레코드인가 — `response_item` 의 user 메시지. claude 쪽과 모양이 겹치지 않는다 */
const codexPayload = (record: Record<string, unknown>): Record<string, unknown> | null => {
  if (record.type !== 'response_item') return null
  const p = record.payload
  if (!isObj(p) || p.type !== 'message' || p.role !== 'user') return null
  return p
}

/** 레코드에서 사람이 읽을 텍스트를 꺼낸다.
 *
 *  claude: `message.content` 가 문자열이거나 `{type:'text'}` 블록 배열.
 *  codex: `payload.content` 가 `{type:'input_text'}` 블록 배열(실측 1,703개 전부 이 하나였다). */
export function requestTextOf(record: Record<string, unknown>): string {
  const codex = codexPayload(record)
  if (codex) return blockText(codex.content, 'input_text')

  const message = record.message
  if (!isObj(message)) return ''
  const content = message.content
  if (typeof content === 'string') return content
  return blockText(content, 'text')
}

/** `{type, text}` 블록 배열에서 그 종류의 text 만 이어 붙인다 */
function blockText(content: unknown, kind: string): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } => isObj(b) && b.type === kind && typeof b.text === 'string')
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
  const codex = codexPayload(record)
  if (codex) return isCodexHumanRequest(codex)

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

/** codex 쪽 판정. 표지가 없는 옛 기록은 **거부한다** — 허용 목록의 기본이 거부인 것과 같고,
 *  그 세션에서 Unit 이 안 생기는 것은 조용히 틀린 제목이 남는 것보다 낫다. 실측상 필드가 없는
 *  것은 옛 codex 하나뿐이고 지금 codex 는 늘 싣는다. */
function isCodexHumanRequest(payload: Record<string, unknown>): boolean {
  const meta = payload.internal_chat_message_metadata_passthrough
  if (!isObj(meta)) return false
  const kinds = meta.content_item_kinds
  if (!Array.isArray(kinds) || kinds.length !== 1 || kinds[0] !== CODEX_HUMAN_KIND) return false
  return blockText(payload.content, 'input_text').trim() !== ''
}

/** codex 가 한 턴을 끝냈다고 스스로 적은 자리.
 *
 *  **왜 창 제목이 아니라 이것인가.** codex 의 창 제목은 장식이라 스피너가 턴이 끝난 뒤에도 흐르고
 *  자식 프로세스가 덮어쓴다(`ProviderDescriptor.busyTitleReliable` 이 codex 에서 false 인 이유가
 *  그 실측이다). 그래서 claude 처럼 제목의 유휴 전환을 기다리면 codex 의 Unit 은 새 사용자
 *  메시지나 세션 종료로만 닫힌다. rollout 은 턴마다 이 레코드를 한 번 적으므로, 추측 대신
 *  codex 자신이 쓴 신호를 읽는다 — `main/codexRolloutWatcher.ts` 가 이미 같은 값을 턴 알림에
 *  쓰고 있고, 그 파일 머리주석이 "59개 파일 156턴에서 검증"이라고 적어 두었다.
 *
 *  **`turn_aborted` 는 여기 넣지 않는다.** 끊긴 턴은 완료가 아니고, 그 Unit 은 다음 사용자
 *  메시지나 세션 종료가 닫는다(WU §14). */
export function isCodexTurnComplete(record: Record<string, unknown>): boolean {
  if (record.type !== 'event_msg') return false
  const p = record.payload
  return isObj(p) && p.type === 'task_complete'
}
