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
  'accounts-list': 'accounts',
  'run-configs-list': 'runConfigs',
  'sessions-list': 'sessions',
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

/**
 * What an answer to an id that had already taken effect is called at the top of the envelope
 * (request receipts design §8, §7), or `null` for an ordinary answer.
 *
 * **Two words rather than one, because they promise different things.** `replayed` means the command
 * was not run a second time and this is the recorded answer. `observed` means the commit was not
 * repeated but the command did run again, so the body is what is true now — `check --ack <id> --wait`
 * polls afresh, and that poll can open a delivery the caller has never seen. One word for both would
 * make either promise false somewhere, and the dangerous direction is a caller skipping a body it
 * believes it has already handled.
 */
export type ReplayMark = 'replayed' | 'observed' | null

/**
 * **The mark sits at the top level, beside `ok`, and never inside `data`** (request receipts design
 * §8). `data` is the command's own published contract, so adding a field to it would change what
 * `run-create` returns to every caller; the fact that this particular answer is about an id already
 * used is about the call, not about the thing answered.
 *
 * Additive, so `CLI_PROTOCOL` stays 1 — a bump is for a change readers must react to, and a new
 * column is not one. Present only when there is one: a reader tests for it, and a `false` on every
 * ordinary answer would put a word about receipts in front of every caller that never asked for one.
 */
export const okEnvelope = (cmd: string, body: unknown, mark: ReplayMark = null): string =>
  JSON.stringify({ ok: true, ...(mark ? { [mark]: true } : {}), data: dataFor(cmd, body) })

/**
 * 없는 id 를 들은 세션 전용 명령에게, **있는 것들이 어디 있는가**.
 *
 * 공개 명령은 표가 필요 없다 — `jobs-get` 의 명사에 `list` 동사가 있으면 그것이 답이다(아래
 * `listingFor`). The one exception is a public command whose own noun's list is the wrong kind:
 * `tasks-list` fails on `--run`, and `tasks list` gives Task ids. An entry here wins over the noun.
 *
 * **항목 하나를 적기 전에 세 가지를 묻는다. 셋 다 실제로 한 번씩 틀렸다.**
 *
 * 1. *Does this command return 404 at all?* A missing id reaches the caller three ways: a direct
 *    `notFound(...)`, `commit()` mapping `unknown …` to 404, and a pure-layer refusal handed
 *    straight on. The third used to be `bad()` (400 → 2), and three entries written without
 *    noticing it were dead and were removed. It is now `refused()`, which answers 404 for a refusal
 *    state.ts marks `missing`, so `check --ack`, `send`'s worker_done and `gate-resolve` do return
 *    404 and have entries again. `worker-read` and `worker-release` check no existence at all
 *    (command.ts, the worker-release note), so they have nowhere to return 404 from.
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
  // 이 404 는 회차가 아니라 `--coordinator-account` 의 계정이다. **`accounts list` 로 권한다** —
  // 셸에서 부른 쪽도 칠 수 있는 공개 이름이다. 동사 없는 `accounts` 는 세션 명령이라 `--help` 에 없다.
  'run-create': ['astera accounts list'],
  // 공개 이름도 같다 — 명사 규칙(`jobs list`)은 계획 id 를 주는데, 이 명령이 못 찾는 것은 계정이다.
  'jobs-create': ['astera accounts list'],
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
  // `--deps`·`--parent` 가 못 찾는 것은 Task 다. `--account` 가 못 찾는 것은 계정이다.
  'task-create': ['astera runs list', 'astera tasks list', 'astera accounts list'],
  // **네 가지를 못 찾는다**: `--job` 의 계획, `--run` 의 회차, `--deps`·`--parent` 의 Task,
  // `--account` 의 계정. task-create 와 달리 `jobs list` 를 권해도 된다 — 이 명령은 플래그가 종류를
  // 정하므로 `--run` 에 넣은 계획 id 는 정의 Task 가 되지 않고 404 로 돌아온다(command.ts).
  'tasks-add': ['astera jobs list', 'astera runs list', 'astera tasks list', 'astera accounts list'],
  // 못 찾는 것은 `--job` 의 계획이다. 명사 규칙은 첫 대시에서 잘라 `run` 을 명사로 읽는다.
  'run-configs-list': ['astera jobs list'],
  'task-update': ['astera tasks list'],
  // **못 찾는 것은 `--account` 의 계정뿐이다.** 명사 규칙은 `skills list` 를 줄 텐데, 같은
  // `--account` 를 준 그 줄은 같은 404 다.
  'skills-list': ['astera accounts list'],
  'skills-install': ['astera accounts list'],
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
  'gate-create': ['astera tasks list'],
  // **A Gate, not a message** — the opposite of `reply`. resolveGate looks in `s.gates`, and
  // `questions list` lists `s.gates` (`gat_…`). It is public, not coordinator-only.
  'gate-resolve': ['astera questions list'],
  // **Two things can be missing, so two alternative lines.** `--run`: `runs list` gives run ids,
  // and it is not coordinator-only. `--ack`: `check` again hands back the batch still
  // unacknowledged, and its `deliveryId` (`dlv_…`) is the id to ack; it acks nothing itself, so
  // nothing is lost. `check` is coordinator-only, and so is the command that hit this 404. Neither
  // line changes anything, so a caller that runs both in order, not knowing which applied, loses
  // nothing either.
  check: ['astera runs list', 'astera check'],
  // **The Run of `--run`, not a Task.** The noun rule would offer `tasks list` again, which gives
  // Task ids; `runs list` gives run ids and is public.
  'tasks-list': ['astera runs list'],
  // **The Job of `--job`, not a run** — the same shape the other way round. The noun rule would offer
  // `runs list` again, which gives run ids, and a run id given to `--job` is the same 404.
  'runs-list': ['astera jobs list'],
  // **The Task or Dispatch a worker_done named** — the same two lines as `worker-*`, the first
  // giving the second its `<taskId>`. `send` is a worker's command, so neither line may be
  // coordinator-only, and neither is.
  send: ['astera tasks list', 'astera dispatch-show --task <taskId>']
}

/** 없는 id 를 말한 명령에게 줄 목록 명령들. */
function listingFor(cmd: string | undefined): readonly string[] {
  if (cmd === undefined) return ['astera help']
  if (Object.hasOwn(LISTING, cmd)) return LISTING[cmd]
  const dash = cmd.indexOf('-')
  const noun = dash < 0 ? cmd : cmd.slice(0, dash)
  if (verbsOf(noun)?.includes('list') === true) return [`astera ${noun} list`]
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
const STEPS: Record<
  CliErrorCode,
  (cmd: string | undefined, details: Record<string, unknown>) => readonly string[]
> = {
  FAILED: () => [],
  INVALID_ARGUMENTS: (cmd) => [usageCommandFor(cmd)],
  // **`host start` 가 3 으로 끝난 것에 `host start` 를 권하지 않는다**(리뷰 I1). 방금 그것이 안 됐다.
  // 무엇을 봤는지는 `host status` 가 말하고, Host 의 로그 자리는 이 오류의 details 가 싣는다.
  HOST_NOT_RUNNING: (cmd) => [cmd === 'host-start' ? 'astera host status' : 'astera host start'],
  // **`tasks add --validate` 의 없는 구성 id 는 그 계획의 목록 한 줄이다**(phase D). 그 404 만 답에
  // 계획 id 를 싣고 오고(command.ts, run.ts 가 `details` 로 옮긴다), 채워진 줄은 그대로 칠 수 있다.
  // 문구가 아니라 칸으로 가른다 — CONFLICT 의 `requestId` 와 같은 판단이다.
  NOT_FOUND: (cmd, details) =>
    cmd === 'tasks-add' && typeof details.jobId === 'string'
      ? ['astera run-configs list --job <jobId>']
      : listingFor(cmd),
  // 403 은 "이 세션에는 허락되지 않는다" 다. 대개 COORDINATOR_ONLY 명령을 워커가 부른 것이고
  // (command.ts), `worker-start --terminal` 에 다른 회차의 세션을 준 것도 403 이다(phase D). 어느
  // 쪽이든 무엇이 허락되는지는 가이드에 적혀 있고, 그것을 읽는 것 말고 칠 것이 없다.
  PERMISSION_DENIED: () => ['astera help'],
  // 409 는 지금 상태 때문에 거절된 것이므로, 답은 "지금 무엇이 도는가" 다.
  //
  // **요청 하나가 이미 돌고 있어서 난 409 만은 다른 것을 묻는다**(요청 영수증 설계 §7). 그 거절이
  // 말하는 "지금 상태" 는 Job 도 회차도 아니라 **그 요청**이고, 런타임의 `pending` 문장도 기다렸다
  // 다시 물으라고 말한다 — 그 "다시 묻는" 명령이 `astera status` 일 수는 없다. 문구가 아니라 `details`
  // 의 칸으로 가른다(Host 가 그 봉투에 `requestId` 를 싣는다): 계약을 문자열에 매는 것이 이 표가
  // 처음부터 피해 온 일이다.
  CONFLICT: (cmd, details) =>
    typeof details.requestId === 'string'
      ? ['astera requests show --id <requestId>']
      : [cmd?.startsWith('host-') === true ? 'astera host status' : 'astera status'],
  // 시한을 넘긴 것과 Host 가 살아서 답하지 않는 것이 같은 코드다(run.ts 의 SILENT_HOST_CODE).
  // 둘을 가르는 명령이 이것이다 — 앞의 경우에는 답하고 뒤의 경우에는 답하지 않는다(docs/cli.md).
  //
  // **`ask` 는 그 앞에 한 줄이 더 있다, 질문 id 를 알 때만.** 답이 오지 않은 채 끝난 `ask` 의
  // 질문은 여전히 열려 있고, 그것을 실패로 읽고 다시 묻는 워커는 같은 사람에게 질문을 둘 만든다
  // (`silentHostEnd` 가 이 `details` 를 채운다). 조건이 붙는 이유는 자리표시자다: 모르는 id 를
  // `<questionId>` 로 남겨 주면 워커가 채울 수 있는 것은 짐작뿐이고, 짐작한 id 는 2 로 끝나거나
  // 남의 질문을 기다린다. **`--timeout-ms` 도 같은 방식으로 붙인다** — 표는 인자를 보지 못하지만
  // `details` 는 보고, 그것이 없으면 덜 아는 쪽(답이 아예 안 온 갈래)이 더 나쁜 줄을 받는다.
  TIMEOUT: (cmd, details) => {
    if (cmd !== 'ask' || typeof details.questionId !== 'string') return ['astera host status']
    const resume =
      typeof details.timeoutMs === 'number'
        ? 'astera ask --resume <questionId> --timeout-ms <timeoutMs>'
        : 'astera ask --resume <questionId>'
    return [resume, 'astera host status']
  },
  // 8 은 질문이 열린 것과 회차가 멈춘 것, 둘 다다. 어느 쪽인지는 `details.state` 가 말한다.
  WAITING_FOR_INPUT: () => [
    'astera questions list --status open',
    'astera questions answer --id <questionId> --answer <text>',
    'astera runs resume --id <runId>'
  ],
  // 두 빌드가 갈렸다. 무엇과 무엇이 갈렸는지 보고, 옛 Host 를 물린다(docs/cli.md 의 Exit 9).
  //
  // **다른 판의 Host 를 주소에서 찾은 9 는 `host stop` 이 아니다**(cli/host.ts 의 siblingHostError). 그
  // Host 는 이 CLI 의 주소에 없으므로 이 CLI 의 `host stop` 은 "없다" 고 답한다. 그만두게 하는 것은
  // 문구가 말하고(앱을 닫고, 그 Host 를 띄운 빌드로 멈춘다), 칠 명령은 그다음 이 판으로 다시
  // 띄우는 것이다 — `host start` 는 다른 판의 Host 가 아직 있으면 띄우지 않고 9 로 거절한다.
  // 실패한 것이 `host start` 자신이면 그것을 다시 권하지 않는다. 돌고 도는 안내다(리뷰 I1).
  VERSION_MISMATCH: (cmd, details) =>
    typeof details.hostProtocol === 'number'
      ? cmd === 'host-start'
        ? ['astera version']
        : ['astera version', 'astera host start']
      : ['astera version', 'astera host stop'],
  RUN_FAILED: () => ['astera tasks list --run <runId> --status failed']
}

/**
 * 이 실패 다음에 칠 명령들.
 *
 * **자리표시자는 `details` 에서 채운다.** `<runId>` 는 `details.runId` 가 있으면 그 값이 된다 —
 * `wait` 의 오류는 이미 그 값을 싣고 있고(`waitEnd`), 채워 주면 그대로 칠 수 있는 줄이 된다.
 * 없는 것은 자리표시자로 남는다: 짐작한 id 를 채우는 것보다 비워 두는 편이 낫다.
 *
 * **글자와 수를 둘 다 채운다.** 채울 값이 언제나 id 인 것은 아니다 — `--timeout-ms <ms>` 는 수이고,
 * 그것을 받으려고 `details` 에 문자열로 적어 두면 봉투를 읽는 쪽이 수를 글자로 받는다. 채우는
 * 규칙이 "이 오류가 이미 싣고 있는 값" 이므로 종류로 가르지 않는다.
 */
export function nextStepsFor(a: {
  code: CliErrorCode
  /** 어떤 명령이 실패했는가. 명령이 정해지기 전(파서 실패)에는 없다. */
  cmd?: string
  details?: Record<string, unknown>
}): string[] {
  const details = a.details ?? {}
  /**
   * **답이 아예 안 온 실패에서는 "닿았는가" 가 먼저다** (요청 영수증 설계 §8). 그 끝에서만
   * `details` 가 이 줄을 싣는다(run.ts 의 `lostAnswerDetails`) — 표는 인자도 요청 id 도 보지
   * 못하므로, 이 한 줄은 코드가 아니라 실려 온 사실에서 나온다.
   *
   * **`retryCommand` 는 여기 오지 않는다.** 그것은 `details` 에만 있고, 이유는 순서다: 확인하기
   * 전에 다시 보내는 것이 이 기능이 막으려는 바로 그 행동이다. 먼저 물어보고, 그 답이 `absent` 일
   * 때 치는 줄이 그쪽에 준비돼 있다.
   */
  const lost = typeof details.queryCommand === 'string' ? [details.queryCommand] : []
  const own = STEPS[a.code](a.cmd, details)
  // **Except for 3, where the receipt question needs the very thing that is missing.** With no Host
  // reachable, `requests show` exits 3 as well, so an agent working down the list in order would get
  // a second "I do not know" before reaching the line that fixes it. There the line that starts a
  // Host comes first and the receipt question after it, where it can actually answer.
  return (a.code === 'HOST_NOT_RUNNING' ? [...own, ...lost] : [...lost, ...own]).map((step) =>
    step.replace(/<([A-Za-z]+)>/g, (whole, key: string) => {
      const v = details[key]
      return typeof v === 'string' || typeof v === 'number' ? String(v) : whole
    })
  )
}

/**
 * **`nextSteps` 는 언제나 있다.** 할 것이 없으면 빈 배열이다 — `details` 가 `{}` 로 언제나 있는
 * 것과 같은 판단이고, 읽는 쪽이 `error.nextSteps[0]` 앞에 칸의 유무를 먼저 묻지 않아도 되게 한다.
 */
export const errEnvelope = (e: CliError, cmd?: string, mark: ReplayMark = null): string =>
  JSON.stringify({
    ok: false,
    // **A failure that is about an already-used id is marked too**, in the same place and for the
    // same reason as the success envelope's (`okEnvelope`). A recorded 404 comes back as a 404 and
    // exits 4, which is the point; what the mark adds is that this one answers a call that already
    // happened, so a caller does not read it as a fresh id that has since gone missing.
    ...(mark ? { [mark]: true } : {}),
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

/** 다시 기다리는 한 줄. `--json` 을 붙이지 않는 것은 다른 모든 `nextSteps` 줄과 같은 판단이다 —
 *  JSON 이 이미 기본이고, 켜는 플래그를 권하면 그것이 기본이 아니라고 가르치게 된다. */
const resumeCommand = (a: { questionId: string; args: Record<string, unknown> }): string =>
  `astera ask --resume ${a.questionId}${typeof a.args.timeoutMs === 'number' ? ` --timeout-ms ${a.args.timeoutMs}` : ''}`

/**
 * 다시 기다릴 수 없는 두 경우, **다른 문장**. 둘 다 명령 대신 사실을 준다 — 이 자리에서 줄 수
 * 있는 명령은 자리표시자가 남은 줄뿐이고, 그것을 채우는 방법은 짐작밖에 없다.
 *
 * **한 문장을 두 자리에 쓰면 한쪽에서 거짓이 된다.** 실제로 그랬다: 답이 오지 않은 갈래에
 * "답이 질문을 이름 붙이지 못했다" 를 붙여 놓았고, 그 줄을 읽는 에이전트는 **답은 왔다 = 질문은
 * 만들어졌다** 로 읽는다. 그 갈래에서 이쪽이 아는 것은 그 반대다. 시한을 넘긴 답이 무엇을
 * 가르치는가가 이 기능 전체의 요지이므로, 문장도 갈라 둔다.
 */
const UNNAMED_QUESTION =
  'the answer did not name the question, so this wait cannot be resumed safely; the question may still be pending, so do not ask again'

/** 답이 **아예 오지 않은** 갈래(`silentHostEnd`). 질문이 만들어졌는지조차 이쪽은 모른다. */
/** 답이 **아예 오지 않았고**, 그 부름이 요청 id 를 실어 보낸 갈래.
 *
 *  **영수증이 생기면서 이 자리의 사실이 바뀌었다.** 예전에는 질문이 만들어졌는지 알 길이 없었고
 *  그래서 이 문장이 그렇게 말했다. 지금은 그 길이 있고, 같은 봉투의 `nextSteps[0]` 이 바로 그
 *  명령이다 — 문장만 옛것으로 남겨 두면 한 봉투가 두 가지를 말한다. */
const ASK_RECEIPT_FIRST = (id: string): string =>
  `no answer came back at all, so this wait cannot be resumed from here — but this call carried a request id, and \`astera requests show --id ${id}\` says whether the question was created and what its id is. Run that before asking again: asking again risks a second question in front of the same person`

/** 그리고 id 를 못 실은 갈래 — 영수증을 모르는 옛 Host 앞에서 새긴 id 는 버려진다
 *  (`requestForHost`). 거기서는 예전의 사실이 그대로 참이다. */
const NO_ANSWER_AT_ALL =
  'no answer came back at all, so there is no way to tell from here whether the question was created; it cannot be resumed safely, and asking again risks a second question in front of the same person'

/**
 * 시한이 지난 `ask` 의 답에 **다시 기다리는 법**을 싣는다.
 *
 * **시한을 넘긴 것은 실패가 아니다** — 질문은 여전히 열려 있고 여전히 사람을 기다린다(가이드 4.8:
 * 타임아웃 응답은 200 이고 종료 코드는 0 이다). 그런데 그것을 "실패했다" 로 읽고 다시 묻는 워커는
 * 같은 사람에게 질문을 **둘** 만들고, 사람은 그중 하나에 답하고 워커는 다른 하나를 기다린다.
 * 그래서 이 답이 스스로 다음 수를 말해야 한다.
 *
 * **`nextSteps` 라는 같은 이름을 쓴다.** 이 CLI 에는 "다음에 칠 명령 줄" 을 뜻하는 이름이 이미
 * 하나 있고(`error.nextSteps`), 부르는 쪽이 대개 그 이름을 이미 읽을 줄 안다. 성공 본문에 다른
 * 이름을 하나 더 만들면 같은 뜻의 낱말이 둘이 되고, 읽는 쪽은 자리마다 어느 것인지 물어야 한다.
 * 종료 코드는 그대로 0 이다 — 여기서 코드를 하나 더 만들면 열한 번째가 된다.
 *
 * **CLI 층에서 씌운다, 서버가 아니라.** `astera …` 로 시작하는 줄은 명령 층의 어휘가 아니다 —
 * 같은 `handleCommand` 를 화면(ipc.ts)도 부르고, 그쪽에는 칠 셀이 없다. 봉투를 이 파일이 씌우는
 * 것과 같은 판단이다(머리말).
 */
export function askTimeoutBody(a: { body: unknown; args: Record<string, unknown> }): unknown {
  const b = a.body
  if (b === null || typeof b !== 'object') return b
  const timed = b as { timedOut?: unknown; questionId?: unknown }
  // 답이 온 ask 와 그 밖의 모든 것은 손대지 않는다 — 기다림이 아닌 출력에 기다림의 안내를 붙이면
  // 그 안내가 아무것도 뜻하지 않게 된다.
  if (timed.timedOut !== true) return b
  const id = typeof timed.questionId === 'string' && timed.questionId.length > 0 ? timed.questionId : null
  if (id === null) return { ...b, cannotResume: UNNAMED_QUESTION, nextSteps: [] }
  return { ...b, nextSteps: [resumeCommand({ questionId: id, args: a.args })] }
}

/**
 * Host 가 **답을 아예 주지 않은 채** 이쪽 시한이 지났을 때의 문구와 `details` (run.ts 의 `stuck`).
 *
 * 위의 `askTimeoutBody` 와 같은 사고를 다른 자리에서 막는다. 그쪽은 답이 온 갈래이고 이쪽은 답이
 * 오지 않은 갈래인데, 워커가 읽는 결론은 똑같이 "실패했으니 다시 묻자" 가 되기 쉽다 — 그리고
 * 이쪽이 더 나쁘다: 질문은 만들어졌을 수도 있고 아닐 수도 있어서, 다시 물으면 둘이 될 수도 있고
 * 첫 질문이 영영 답 없이 남을 수도 있다.
 *
 * **아는 것과 모르는 것을 가른다.** `--resume` 으로 기다리던 중이었다면 id 는 이 프로세스가
 * 보낸 값이므로 확실히 안다. 새 질문이었다면 id 를 돌려받지 못했으므로 모르고 — 질문이
 * 만들어졌는지조차 모른다 — 그때는 명령이 아니라 그 사실을 말한다(`NO_ANSWER_AT_ALL`).
 *
 * **부르는 쪽이 정한 시한도 함께 싣는다.** 답이 온 갈래(`askTimeoutBody`)는 인자를 보고 그 값을
 * 줄에 옮기는데, 이쪽만 그것을 잃으면 **덜 아는 쪽이 더 나쁜 줄을 받는다**. 표는 인자를 보지
 * 못하므로 값을 `details` 로 건네고, 자리표시자를 채우는 것은 `nextStepsFor` 가 이미 한다.
 */
export function silentHostEnd(a: {
  cmd: string
  args: Record<string, unknown>
  /** `callHost` 가 만든 "안 왔다" 한 줄. */
  reason: string
  /** 이 부름이 실어 보낸 요청 id, 실은 것이 있으면. **문장이 여기서 갈린다**: 영수증이 있는 쪽은
   *  질문이 만들어졌는지 물어볼 수 있고, 없는 쪽은 여전히 알 길이 없다. */
  request?: string
}): { message: string; details: Record<string, unknown> } {
  if (a.cmd !== 'ask') return { message: a.reason, details: {} }
  const resuming = typeof a.args.resume === 'string' && a.args.resume.length > 0 ? a.args.resume : null
  if (resuming !== null)
    return {
      message: `${a.reason} — the question is still pending; resume waiting rather than asking again`,
      details: {
        questionId: resuming,
        ...(typeof a.args.timeoutMs === 'number' ? { timeoutMs: a.args.timeoutMs } : {})
      }
    }
  if (a.request !== undefined)
    return { message: `${a.reason} — ${ASK_RECEIPT_FIRST(a.request)}`, details: {} }
  return { message: `${a.reason} — ${NO_ANSWER_AT_ALL}`, details: {} }
}

/**
 * CLI 와 앱이 주고받는 말의 판. **Host 의 프로토콜과 다른 것이다** — 그쪽은 앱과 Host 사이의
 * 것이고(core/host/protocol.ts), 이것은 사람이 치는 명령과 앱 사이의 것이다.
 *
 * 1 은 이 계약(봉투·종료 코드·이름)이 처음 서는 판이다. 올리는 때는 **읽는 쪽이 고쳐야 하는**
 * 변화가 있을 때뿐이다 — 칸을 더하는 것은 올리지 않는다(명세 §43: additive 를 선호한다).
 */
export const CLI_PROTOCOL = 1
