// `astera` 가 내보내는 것의 계약 — 봉투, 오류 코드, 종료 코드
// (docs/2026-09-22-public-cli-design.md §7·§8).
//
// **여기가 순수한 이유.** 이것은 스크립트가 기대는 API 이고(명세 §43), API 는 프로세스를 띄우지
// 않고도 확인할 수 있어야 한다. run.ts 는 이 함수들을 부르고 `process.exit` 만 한다.
//
// **봉투를 서버가 아니라 CLI 가 씌운다.** 서버의 `{status, body}` 는 렌더러도 그대로 받는다
// (ipc.ts 의 orch.command) — 서버에서 씌우면 화면 쪽 호출자 전부가 한 겹을 벗겨야 한다. 계약은
// CLI 가 내보내는 것에 대한 것이므로 그 경계에서 씌우는 것이 맞다.
import { verbsOf } from './cliArgs'
import { USAGE, spelledCommand } from './cliUsage'

/**
 * 스크립트가 분기하는 값. 문구는 사람의 것이고 이 코드는 기계의 것이다.
 *
 * **닫힌 집합이고, 목록이 곧 타입이다.** 아래 표들(`EXIT`, `STEPS`)이 이 목록의 `Record` 이므로,
 * 코드를 하나 더하면 두 표 모두가 그 이름을 대며 컴파일을 깨뜨린다 — 종료 코드를 정하지 않은
 * 코드도, 무엇을 하면 되는지 정하지 않은 코드도 나갈 수 없다. 배열로 둔 이유는 하나 더 있다:
 * `astera agent-context` 가 이 열 개를 그대로 실어 내보낸다(cliAgentContext.ts).
 */
export const CLI_ERROR_CODES = [
  'FAILED',
  'INVALID_ARGUMENTS',
  'HOST_NOT_RUNNING',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'CONFLICT',
  'TIMEOUT',
  'WAITING_FOR_INPUT',
  'VERSION_MISMATCH',
  'RUN_FAILED'
] as const

export type CliErrorCode = (typeof CLI_ERROR_CODES)[number]

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

/**
 * 없는 id 를 들은 세션 전용 명령에게, **있는 것들이 어디 있는가**.
 *
 * 공개 명령은 표가 필요 없다 — `jobs-get` 의 명사에 `list` 동사가 있으면 그것이 답이다(아래
 * `listingFor`). 여기 적힌 것은 `NOUNS` 밖의 명령들뿐이다.
 *
 * **항목 하나를 적기 전에 세 가지를 묻는다. 셋 다 실제로 한 번씩 틀렸다.**
 *
 * 1. *이 명령이 404 를 내기는 하는가.* 없는 id 가 세 갈래로 갈린다 — 직접 `notFound(...)`,
 *    `commit()` 이 `unknown …` 을 404 로 옮기는 것, 그리고 **순수 층의 `unknown …` 을 `bad()` 로
 *    내보내는 것(400 → 2)**. 세 번째를 빼먹고 적은 항목 셋이 죽어 있었다: `check`(`ackDelivery`·
 *    `nextDelivery` 가 `bad`), `send`(`case` 안에 `commit(` 이 아예 없다), `gate-resolve`
 *    (`resolveGate` 가 `bad`). 그 셋은 여기서 걷어 냈다. `worker-read`·`worker-release` 는 아예
 *    존재 검사를 하지 않아(command.ts 의 worker-release 주석) 404 가 날 자리가 없다.
 * 2. *권하는 명령이 같은 종류의 id 를 내놓는가.* `ask --resume` 은 id 를 `s.messages` 에서
 *    찾는데(`msg_…`) `questions list` 는 `s.gates` 를 준다(`gat_…`) — 줄은 잘 돌고, 거기서 고른
 *    id 는 전부 `not a question` 으로 2 가 된다. **더 나쁜 모양도 있다**: `task-create --run` 에
 *    `jobs list` 를 권하면 Job id 가 실제로 **받아들여져** 회차가 아니라 템플릿에 정의 Task 가
 *    생긴다. 0 으로 끝나고 다른 것이 만들어진다 — 실패하는 줄보다 나쁘다.
 * 3. *이 오류를 만난 쪽이 그 명령을 부를 수 있는가.* `ask` 는 워커도 부르는데 `inbox` 는
 *    `COORDINATOR_ONLY` 라(command.ts), 워커가 그 줄을 따르면 403 으로 5 를 받는다. 틀린 id 가
 *    아니라 아예 돌지 않는 줄이고, 증상만 다른 같은 결함이다. `reply` 는 자신이 코디네이터 전용
 *    이므로 `inbox` 가 맞다 — cliAgentContext.test.ts 가 이 짝을 지킨다.
 *
 * 여기 없는 명령은 가이드로 떨어진다. 손으로 쓴 표이므로 낡을 수 있고, 낡는 방식은 "새 404 자리가
 * 안내를 못 받는 것" 하나다 — 없는 명령을 가리키지는 않는다(cliAgentContext.test.ts 가 이 값들이
 * 실재하는 명령인지, 그리고 부를 수 있는 명령인지 본다).
 */
const LISTING: Record<string, readonly string[]> = {
  // 이 404 는 회차가 아니라 `--coordinator-account` 의 계정이다
  'run-create': ['astera accounts'],
  // **`--id` 는 Job 도 회차도 받고, 지우는 것이 다르다.** Job 을 주면 그 계획과 회차 전부가
  // 사라진다 — 회차 하나를 지우려던 사람에게 `jobs list` 만 주면 그 목록의 id 가 바로 그 사고다.
  'run-delete': ['astera jobs list', 'astera runs list'],
  'run-start': ['astera jobs list'],
  'run-pause': ['astera jobs list'],
  'run-resume': ['astera jobs list'],
  'run-spawn': ['astera jobs list'],
  'run-merge': ['astera runs list'],
  'run-worktree-set': ['astera runs list'],
  'run-use': ['astera runs list'],
  // **회차다.** `--run` 에 Job id 도 통하지만 그것은 템플릿의 정의 Task 를 만드는 다른 일이다.
  // `--deps`·`--parent` 가 못 찾는 것은 Task 다.
  'task-create': ['astera runs list', 'astera tasks list'],
  'task-update': ['astera tasks list'],
  // **Dispatch 를 통째로 세는 명령은 없다** — `dispatch-show` 는 Task 하나의 것만 준다. 그래서 두
  // 줄이고, 앞 줄이 뒷줄의 `<taskId>` 를 준다. 한 줄만 주면 채워질 길이 없는 자리표시자가 된다.
  // `worker-start` 는 Task 를 못 찾기도 하고(`--task`) 세션을 못 찾기도 하는데(`--terminal`),
  // sessionId 를 내놓는 것은 Dispatch 쪽이라 같은 두 줄이 둘 다 덮는다.
  'worker-start': ['astera tasks list', 'astera dispatch-show --task <taskId>'],
  'worker-show': ['astera tasks list', 'astera dispatch-show --task <taskId>'],
  'worker-retain': ['astera tasks list', 'astera dispatch-show --task <taskId>'],
  'worker-stop': ['astera tasks list', 'astera dispatch-show --task <taskId>'],
  'worker-abandon': ['astera tasks list', 'astera dispatch-show --task <taskId>'],
  // **워커가 만나는 404 다.** 메시지를 세는 명령(`inbox`)은 코디네이터 전용이라 이 자리에서는
  // 부를 수 없다. 들고 있던 questionId 가 없다는 것은 그 질문이 사라졌다는 뜻이므로, 워커가
  // 실제로 할 수 있는 일은 다시 묻는 것이다.
  ask: ['astera ask --task-id <taskId> --question <text>'],
  // **메시지다, Gate 가 아니다**(`applyReply` 의 `unknown question: <messageId>`). 이쪽은 부르는
  // 쪽이 코디네이터이므로 `inbox` 를 부를 수 있다.
  reply: ['astera inbox'],
  'gate-create': ['astera tasks list']
}

/** 없는 id 를 말한 명령에게 줄 목록 명령들. */
function listingFor(cmd: string | undefined): readonly string[] {
  if (cmd === undefined) return ['astera help']
  const dash = cmd.indexOf('-')
  const noun = dash < 0 ? cmd : cmd.slice(0, dash)
  if (verbsOf(noun)?.includes('list') === true) return [`astera ${noun} list`]
  if (Object.hasOwn(LISTING, cmd)) return LISTING[cmd]
  // 공개 표면 밖의 명령은 가이드가 유일한 문서다. `astera --help` 는 그것들을 적지 않는다.
  return ['astera help']
}

/**
 * 인자가 틀렸다고 들은 명령에게 줄 사용법 명령 하나.
 *
 * **공개 표면 밖의 명령은 `astera agent-context` 로 보낸다.** 가이드가 아니다 — 그 명령이 있는
 * 이유가 산문 대신 기계가 읽을 표면을 주는 것인데, 자기가 대신하려는 문서를 권하면 앞뒤가 맞지
 * 않는다. 플래그를 틀린 호출자에게 필요한 것도 설명이 아니라 그 명령의 플래그 목록이다.
 */
function usageCommandFor(cmd: string | undefined): string {
  if (cmd === undefined) return 'astera --help'
  if (Object.hasOwn(USAGE, cmd)) return `astera ${spelledCommand(cmd)} --help`
  return 'astera agent-context'
}

/**
 * 코드 하나에 **칠 수 있는 명령 줄들**.
 *
 * `error.message` 는 무엇이 일어났는지 말하고, 이것은 다음에 무엇을 치면 되는지 말한다. 부르는
 * 쪽이 대개 에이전트이므로 "Host 를 켜라" 가 아니라 `astera host start` 여야 한다 — 문장은 다시
 * 번역해야 하고, 번역은 틀릴 수 있다.
 *
 * **열 개를 다 덮는다.** `Record<CliErrorCode, …>` 이므로 열한 번째 코드는 여기서 무엇을 할지
 * 정하기 전에는 컴파일되지 않는다.
 *
 * **비어 있는 것도 판단이다.** `FAILED` 는 빈 목록인데, 그 코드가 뜻하는 것이 "아래 아홉 중
 * 어느 것도 아니다" 이기 때문이다 — 원인이 무엇인지 이쪽은 모르고, 아무 명령이나 얹으면 그것이
 * 맞는 경우보다 틀린 경우가 많다. 무엇이 있었는지는 `message` 가 앱의 문구를 그대로 싣는다.
 */
const STEPS: Record<CliErrorCode, (cmd: string | undefined) => readonly string[]> = {
  FAILED: () => [],
  INVALID_ARGUMENTS: (cmd) => [usageCommandFor(cmd)],
  HOST_NOT_RUNNING: () => ['astera host start'],
  NOT_FOUND: (cmd) => listingFor(cmd),
  // 403 은 언제나 "이 세션은 그 명령을 부를 수 없다" 다(command.ts 의 COORDINATOR_ONLY). 누가
  // 무엇을 부를 수 있는지는 가이드에만 적혀 있고, 그것을 읽는 것 말고 칠 것이 없다.
  PERMISSION_DENIED: () => ['astera help'],
  // 409 는 지금 상태 때문에 거절된 것이므로, 답은 "지금 무엇이 도는가" 다.
  CONFLICT: (cmd) => [cmd?.startsWith('host-') === true ? 'astera host status' : 'astera status'],
  // 시한을 넘긴 것과 Host 가 살아서 답하지 않는 것이 같은 코드다(run.ts 의 SILENT_HOST_CODE).
  // 둘을 가르는 명령이 이것이다 — 앞의 경우에는 답하고 뒤의 경우에는 답하지 않는다(docs/cli.md).
  TIMEOUT: () => ['astera host status'],
  // 8 은 질문이 열린 것과 회차가 멈춘 것, 둘 다다. 어느 쪽인지는 `details.state` 가 말한다.
  WAITING_FOR_INPUT: () => [
    'astera questions list --status open',
    'astera questions answer --id <questionId> --answer <text>',
    'astera runs resume --id <runId>'
  ],
  // 두 빌드가 갈렸다. 무엇과 무엇이 갈렸는지 보고, 옛 Host 를 물린다(docs/cli.md 의 Exit 9).
  VERSION_MISMATCH: () => ['astera version', 'astera host stop'],
  RUN_FAILED: () => ['astera tasks list --run <runId> --status failed']
}

/**
 * 이 실패 다음에 칠 명령들.
 *
 * **자리표시자는 `details` 에서 채운다.** `<runId>` 는 `details.runId` 가 있으면 그 값이 된다 —
 * `wait` 의 오류는 이미 그 값을 싣고 있고(`waitEnd`), 채워 주면 그대로 칠 수 있는 줄이 된다.
 * 없는 것은 자리표시자로 남는다: 짐작한 id 를 채우는 것보다 비워 두는 편이 낫다.
 */
export function nextStepsFor(a: {
  code: CliErrorCode
  /** 어떤 명령이 실패했는가. 명령이 정해지기 전(파서 실패)에는 없다. */
  cmd?: string
  details?: Record<string, unknown>
}): string[] {
  const details = a.details ?? {}
  return STEPS[a.code](a.cmd).map((step) =>
    step.replace(/<([A-Za-z]+)>/g, (whole, key: string) =>
      typeof details[key] === 'string' ? (details[key] as string) : whole
    )
  )
}

/**
 * **`nextSteps` 는 언제나 있다.** 할 것이 없으면 빈 배열이다 — `details` 가 `{}` 로 언제나 있는
 * 것과 같은 판단이고, 읽는 쪽이 `error.nextSteps[0]` 앞에 칸의 유무를 먼저 묻지 않아도 되게 한다.
 */
export const errEnvelope = (e: CliError, cmd?: string): string =>
  JSON.stringify({
    ok: false,
    error: {
      code: e.code,
      message: e.message,
      details: e.details ?? {},
      nextSteps: nextStepsFor({ code: e.code, cmd, details: e.details })
    }
  })

/** 앱의 오류 본문에서 문구를 꺼낸다. 서버는 `{error: string}` 로 답하지만 이 CLI 는 앱이 주는
 *  것을 그대로 믿지 않는다 — 읽을 수 없으면 원문을 그대로 싣는다. */
export function messageFrom(body: unknown, fallback: string): string {
  if (body !== null && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string')
    return (body as { error: string }).error
  return fallback
}

/**
 * `wait` 가 무엇으로 끝났는가 — 성공이면 `null`, 아니면 그 오류.
 *
 * **이 명령만 `ok` 가 HTTP 가 아니라 기다린 결과를 뜻한다.** 물어본 것이 "잘 끝날 때까지
 * 기다려라" 이므로, 실패로 끝난 회차를 `ok: true` 로 내면 스크립트가 그것을 성공으로 읽는다.
 * 서버가 200 으로 답하는 이유는 그쪽에 맞는 상태 코드가 없기 때문이고, 억지로 골라 쓰면
 * 4나 6 이 뜻하는 것이 명령마다 달라진다.
 *
 * `paused` 가 8번인 이유. 설계 §8 은 8을 "질문이 열려 멈춘 것" 으로 적었지만, 세워 둔 회차도
 * 같은 종류의 끝이다 — **사람이 손대기 전에는 움직이지 않는다.** 무엇이 막았는지는 본문의
 * `state` 가 가른다.
 */
export function waitEnd(body: unknown): CliError | null {
  const b = (body ?? {}) as { state?: unknown; questionId?: unknown; taskId?: unknown; runId?: unknown; progress?: unknown }
  const at = (): Record<string, unknown> => ({ runId: b.runId ?? null, progress: b.progress ?? null })
  switch (b.state) {
    case 'completed':
      return null
    case 'failed':
      return { code: 'RUN_FAILED', message: 'the run finished with failures', details: at() }
    case 'waiting':
      return {
        code: 'WAITING_FOR_INPUT',
        message: 'a question is open and nothing moves until it is answered',
        details: { ...at(), questionId: b.questionId ?? null, taskId: b.taskId ?? null }
      }
    case 'paused':
      return {
        code: 'WAITING_FOR_INPUT',
        message: 'it is paused and nothing moves until someone resumes it',
        details: { ...at(), state: 'paused' }
      }
    case 'timeout':
      return { code: 'TIMEOUT', message: 'it had not finished when the deadline passed', details: at() }
    default:
      // 서버가 모르는 끝을 내는 길은 없지만, 짐작해서 0 으로 내보내면 스크립트가 안 끝난
      // 일을 끝난 것으로 읽는다.
      return { code: 'FAILED', message: `the app answered with an ending this CLI does not know: ${String(b.state)}`, details: at() }
  }
}

/**
 * CLI 와 앱이 주고받는 말의 판. **Host 의 프로토콜과 다른 것이다** — 그쪽은 앱과 Host 사이의
 * 것이고(core/host/protocol.ts), 이것은 사람이 치는 명령과 앱 사이의 것이다.
 *
 * 1 은 이 계약(봉투·종료 코드·이름)이 처음 서는 판이다. 올리는 때는 **읽는 쪽이 고쳐야 하는**
 * 변화가 있을 때뿐이다 — 칸을 더하는 것은 올리지 않는다(명세 §43: additive 를 선호한다).
 */
export const CLI_PROTOCOL = 1
