// `astera` 가 내보내는 것의 계약 — 봉투, 오류 코드, 종료 코드
// (docs/2026-09-22-public-cli-design.md §7·§8).
//
// **여기가 순수한 이유.** 이것은 스크립트가 기대는 API 이고(명세 §43), API 는 프로세스를 띄우지
// 않고도 확인할 수 있어야 한다. run.ts 는 이 함수들을 부르고 `process.exit` 만 한다.
//
// **봉투를 서버가 아니라 CLI 가 씌운다.** 서버의 `{status, body}` 는 렌더러도 그대로 받는다
// (ipc.ts 의 orch.command) — 서버에서 씌우면 화면 쪽 호출자 전부가 한 겹을 벗겨야 한다. 계약은
// CLI 가 내보내는 것에 대한 것이므로 그 경계에서 씌우는 것이 맞다.

/** 스크립트가 분기하는 값. 문구는 사람의 것이고 이 코드는 기계의 것이다. */
export type CliErrorCode =
  | 'FAILED'
  | 'INVALID_ARGUMENTS'
  | 'HOST_NOT_RUNNING'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'CONFLICT'
  | 'TIMEOUT'
  | 'WAITING_FOR_INPUT'
  | 'VERSION_MISMATCH'
  | 'RUN_FAILED'

/** 코드 하나에 종료 코드 하나. 설계 §8 의 표가 이 객체다 — 표를 두 곳에 적으면 갈라진다. */
const EXIT: Record<CliErrorCode, number> = {
  FAILED: 1,
  INVALID_ARGUMENTS: 2,
  HOST_NOT_RUNNING: 3,
  NOT_FOUND: 4,
  PERMISSION_DENIED: 5,
  CONFLICT: 6,
  TIMEOUT: 7,
  WAITING_FOR_INPUT: 8,
  VERSION_MISMATCH: 9,
  RUN_FAILED: 10
}

export const exitCodeFor = (code: CliErrorCode): number => EXIT[code]

/**
 * 앱이 돌려준 HTTP 상태를 오류 코드로.
 *
 * 서버는 이미 400·403·404·409·501 로 가려 답한다(server.ts 의 bad·denied·notFound·conflict 와
 * 기본 분기). 그래서 이 표는 그 다섯을 옮기는 일이고, 나머지는 전부 일반 실패다 — **모르는 상태를
 * 그럴듯한 코드로 넘겨짚지 않는다.** 스크립트가 그 코드로 분기할 텐데, 짐작이 그 분기를 조용히 틀리게 만든다.
 *
 * **501 은 없는 id 가 아니라 없는 명령이다.** 앱이 그 명령을 모른다는 것은 이 CLI 가 앱보다 새
 * 빌드라는 뜻이고(셀틀이 가리키는 바이너리가 갈렸다), 스크립트가 보아야 하는 것은 "오타" 가 아니라 "버전이
 * 갈렸다" 다. 이미 나간 앱은 같은 경우에 404 를 준다 — 그쪽은 NOT_FOUND 로 떨어지고, 문구가
 * 무슨 일인지 말한다. 문구를 읽어 코드를 고르지는 않는다 — 계약을 문자열에 얹어 매는 일이다.
 */
export function codeForStatus(status: number): CliErrorCode {
  if (status === 400) return 'INVALID_ARGUMENTS'
  if (status === 403) return 'PERMISSION_DENIED'
  if (status === 404) return 'NOT_FOUND'
  if (status === 409) return 'CONFLICT'
  if (status === 501) return 'VERSION_MISMATCH'
  return 'FAILED'
}

export interface CliError {
  code: CliErrorCode
  message: string
  details?: Record<string, unknown>
}

/**
 * 배열을 이름 있는 칸에 담는다.
 *
 * **`data` 는 언제나 객체다** (설계 §7). 최상위 배열은 나중에 칸 하나를 더할 수 없다 — 읽는 쪽이
 * 전부 깨진다. `{"jobs": [...]}` 는 더할 수 있다.
 *
 * 이름을 명령마다 두는 이유는 읽는 사람이다. `items` 한 이름으로 통일하면 `jq '.data.items'` 가
 * 무엇의 목록인지 말하지 않는다. 표에 없는 명령의 배열은 `items` 로 떨어진다 — 공개 표면이 아닌
 * 명령들이고, 그쪽은 이 계약의 약속 밖이다.
 */
const LIST_FIELD: Record<string, string> = {
  'projects-list': 'projects',
  'jobs-list': 'jobs',
  'runs-list': 'runs',
  'tasks-list': 'tasks',
  'questions-list': 'questions',
  accounts: 'accounts',
  // 아래 셋은 공개 표면이 아니지만 코디네이터가 읽는다. "약속 밖" 은 무엇을 돌려줄지
  // 고칠 수 있다는 뜻이지, 읽는 쪽에게 일부러 불친절해도 된다는 뜻이 아니다 — 세을 한 이름으로
  // 묶으면 가이드가 그 자리마다 "어떤 items 인가" 를 다시 설명해야 한다.
  'run-configs': 'configs',
  'dispatch-show': 'dispatches',
  inbox: 'messages'
}

export function dataFor(cmd: string, body: unknown): Record<string, unknown> {
  if (Array.isArray(body)) return { [LIST_FIELD[cmd] ?? 'items']: body }
  // 객체가 아닌 것(문자열·숫자)을 돌려주는 명령은 없지만, 입력은 명령이 아니라 앱의 응답이다.
  if (body === null || typeof body !== 'object') return { value: body }
  return body as Record<string, unknown>
}

export const okEnvelope = (cmd: string, body: unknown): string =>
  JSON.stringify({ ok: true, data: dataFor(cmd, body) })

export const errEnvelope = (e: CliError): string =>
  JSON.stringify({
    ok: false,
    error: { code: e.code, message: e.message, details: e.details ?? {} }
  })

/** 앱의 오류 본문에서 문구를 꺼낸다. 서버는 `{error: string}` 로 답하지만 이 CLI 는 앱이 주는
 *  것을 그대로 믿지 않는다 — 읽을 수 없으면 원문을 그대로 싣는다. */
export function messageFrom(body: unknown, fallback: string): string {
  if (body !== null && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string')
    return (body as { error: string }).error
  return fallback
}

/**
 * CLI 와 앱이 주고받는 말의 판. **Host 의 프로토콜과 다른 것이다** — 그쪽은 앱과 Host 사이의
 * 것이고(core/host/protocol.ts), 이것은 사람이 치는 명령과 앱 사이의 것이다.
 *
 * 1 은 이 계약(봉투·종료 코드·이름)이 처음 서는 판이다. 올리는 때는 **읽는 쪽이 고쳐야 하는**
 * 변화가 있을 때뿐이다 — 칸을 더하는 것은 올리지 않는다(명세 §43: additive 를 선호한다).
 */
export const CLI_PROTOCOL = 1
