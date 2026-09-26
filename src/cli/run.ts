// astera CLI logic.
// index.ts (the bundle entry point, out/main/cli.js) executes immediately at the top level and so
// cannot be tested — that is why the side-effect-free functions and main() were pulled in here.
// main() does not call itself inside this file, so importing this module (as the tests do) does not
// terminate the process.
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os, { homedir } from 'node:os'
import { leadingGlobals, parseArgs } from '../core/orchestration/cliArgs'
import { publicEvent, publicFor } from '../core/orchestration/cliPublic'
import { eventKey, followLine } from '../core/orchestration/cliFollow'
import { FOLLOW_WINDOW_MS } from '../core/orchestration/command'
import type { JobEvent } from '../core/types'
import { spelledCommand, unknownFlagError, usageFor } from '../core/orchestration/cliUsage'
import { humanFor, quietFor } from '../core/orchestration/cliHuman'
import { answerFromFile, fileAnswerable, readStateFile } from '../core/orchestration/stateFile'
import { connectHost, type ConnectFailure, type HostConnection } from '../core/host/connect'
import { HOST_FEATURE_ORCH, HOST_FEATURE_PING, HOST_FEATURE_REQUESTS, HOST_PROTOCOL } from '../core/host/protocol'
import { cliHostTarget, logToStderr, otherProtocolHost, runHostCommand, siblingHostError } from './host'
import { installFailureOf, resolveSkillsDir, skillsCommand } from './skills'
import {
  CLI_PROTOCOL,
  askTimeoutBody,
  codeForStatus,
  dataFor,
  waitEnd,
  errEnvelope,
  exitCodeFor,
  messageFrom,
  nextStepsFor,
  okEnvelope,
  silentHostEnd,
  sessionTurnEnd,
  type CliError,
  type CliErrorCode,
  type ReplayMark
} from '../core/orchestration/cliOutput'
import {
  KEEPALIVE_MS,
  KEEPALIVE_PING_MS,
  keepaliveLine,
  waitingCommand
} from '../core/orchestration/cliKeepalive'
import { agentContext, sessionUsage } from '../core/orchestration/cliAgentContext'
import { helloLine, verboseLog, type VerboseLog } from '../core/orchestration/cliVerbose'

/** 빌드가 박아 넣은 이 프로그램의 버전(electron.vite.config.ts). 앱과 CLI 는 한 프로그램이므로
 *  값이 하나이고, 그래서 둘이 갈라질 수가 없다. */
const CLI_VERSION = typeof __ASTERA_VERSION__ === 'string' ? __ASTERA_VERSION__ : '0.0.0'
import {
  DEFAULT_ASK_TIMEOUT_MS,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS
} from '../core/orchestration/types'
import { SCRIPT_TIMEOUT_MS } from '../core/agentBrowser/script'
import {
  queueableReportProblem,
  pendingReportFileName,
  pendingReportTempName,
  pendingReportsDirIn,
  serializePendingReport,
  undeliveredReportNotice
} from '../core/orchestration/pendingReports'

/** 오류 하나를 봉투에 담아 그 종료 코드와 함께 돌려준다 — 부르는 쪽이 둘을 따로 고르지 않도록.
 *  코드와 종료 코드의 표는 core/orchestration/cliOutput.ts 한 곳에만 있다(설계 §8).
 *
 *  `cmd` 는 `nextSteps` 를 고르는 데만 쓰인다 — 무엇이 실패했는지에 따라 다음에 칠 것이 달라진다
 *  (`jobs get` 의 404 는 `astera jobs list`). 명령이 정해지기 전에 나는 실패(파서·모드)는 주지
 *  않고, 그때는 일반적인 안내가 나간다. */
export function errorOutput(msg: string, code: CliErrorCode = 'FAILED', cmd?: string): string {
  return errEnvelope({ code, message: msg }, cmd)
}

export type OutputMode = 'json' | 'human' | 'quiet'

/**
 * 어떤 모양으로 낼 것인가 (공개 CLI 설계 §6).
 *
 * **TTY 를 보고 고를 수가 없다.** 설계는 그렇게 쓰려 했고, 재 보니 모두 아니었다 — 이 CLI 는
 * `ELECTRON_RUN_AS_NODE` 로 도는 electron.exe 이고, 그것은 진짜 콘솔에서도 `process.stdout.isTTY` 가
 * `undefined` 다(같은 콘솔에서 순수 node 는 `true`). Windows 에서 Electron 이 GUI 서브시스템
 * 바이너리라 그렇고, 셀틀이 띄우는 바이너리를 바꿀 수는 없다 — 패키지된 앱은 node 가 깔렸다고
 * 가정할 수 없어서 번들된 electron 을 쓴다.
 *
 * 그래서 **기본은 JSON 이고 사람용은 `--human` 으로 켜는다.** 있지도 않는 신호를 짐작하는 것보다
 * 물어보는 편이 낫고, 반대로 사람용을 기본으로 두면 지금 앴을 부르는 코디네이터가 `--json` 을 생략한
 * 자리에서(가이드가 전부 선택으로 적어 둔다) `tasks list` 의 spec·checks 를 잃는다.
 *
 * **둘을 함께 주면 거절한다.** 한쪽을 조용히 무시하면 사람은 자기가 친 것이 들었다고 믿는다.
 */
export function outputMode(a: {
  json: boolean
  human: boolean
  quiet: boolean
}): OutputMode | { error: string } {
  const asked = [a.json && 'json', a.human && 'human', a.quiet && 'quiet'].filter(Boolean)
  if (asked.length > 1)
    return { error: `${asked.map((x) => `--${String(x)}`).join(' and ')} ask for different things; pick one` }
  if (a.human) return 'human'
  if (a.quiet) return 'quiet'
  return 'json'
}

/** 앱의 응답 상태에서 종료 코드로. 2xx 는 0 이다 — ask --wait 의 타임아웃 응답도 200 이고, 이
 *  설계의 계약은 "타임아웃은 오류가 아니라 정보" 다(오케스트레이션 가이드 4.7절). */
export function exitCodeForStatus(status: number): number {
  return status >= 200 && status < 300 ? 0 : exitCodeFor(codeForStatus(status))
}

/**
 * 접속이 실패한 세 가지 중 **무엇이 "이 파일을 쓰는 사람이 아무도 없다" 를 뜻하는가**
 * (`ConnectFailure`, core/host/connect.ts).
 *
 * 파일로 답하는 길이 서 있는 전제가 그것 하나다(stateFile.ts 의 머리말). `'unreachable'` 만 그
 * 전제를 만족한다 — 그 주소에 아무것도 없었다.
 *
 * **`'protocol'` 은 Host 가 답한 것이다.** 판을 보고 거절했다는 것은 그 Host 가 돌고 있고 파일을
 * 쥐고 있다는 뜻이다. **`'timeout'` 은 파이프가 열렸는데 `hello` 가 안 온 것이다** — 이 저장소가
 * 회복 코드를 따로 두고 있는 바로 그 "살아 있는데 답하지 않는 Host" 다
 * (docs/2026-09-22-host-unresponsive-recovery-design.md). 둘 중 어느 쪽에서든 파일을 읽어 0 으로
 * 답하면 `astera status` 가 돌고 있는 Host 를 두고 `running: false, pid: null` 이라고 말한다.
 *
 * 코드는 표에 이미 있는 것을 쓴다(설계 §8, 열 개뿐이다). 판이 갈린 것은 9 — `orch` 를 알리지 않는
 * Host 에 붙었을 때와 같은 자리이고, 거기도 파일을 읽지 않고 9 로 끝낸다. 답하지 않는 것은 7 이다.
 */
/**
 * 살아 있는데 답하지 않는 Host 가 받는 코드.
 *
 * **그런 침묵은 두 자리에서 난다** — 파이프는 열렸는데 `hello` 가 안 오는 것(바로 아래
 * `connectFailureEnd`)과, 연결이 선 뒤에 답이 안 오는 것(`callHost` 의 `stuck`). 둘은 스크립트가
 * 분기할 것이 같다 — 기다렸고, 안 왔고, Host 는 여전히 거기 있다. 값을 한 자리에 둔 것은
 * 두 곳에 적으면 갈라지기 때문이고, 실제로 한쪽은 7 이고 다른 쪽은 1 로 갈라져 있었다.
 *
 * `wait` 이 서버쪽 마감을 넘겨 끝난 것도 같은 코드다(cliOutput 의 `waitEnd`) — 시한을
 * 어느 쪽에서 재든 스크립트가 보는 것은 하나여야 한다. 무엇이었는지는 문구가 말한다.
 */
export const SILENT_HOST_CODE: CliErrorCode = 'TIMEOUT'

export function connectFailureEnd(a: {
  error: ConnectFailure['error']
  address: string
}): { fallback: true } | { fallback: false; code: CliErrorCode; message: string } {
  if (a.error === 'unreachable') return { fallback: true }
  if (a.error === 'protocol')
    return {
      fallback: false,
      code: 'VERSION_MISMATCH',
      message: `the Host at ${a.address} speaks a different protocol version — it is running, so its state was not read from the file`
    }
  return {
    fallback: false,
    code: SILENT_HOST_CODE,
    message: `the Host at ${a.address} accepted the connection but did not say hello — it is running and not answering, so its state was not read from the file`
  }
}

/** 모드에 맞춘 성공 출력. **사람용이 없는 명령은 JSON 으로 되돌린다** — 코디네이터의
 *  명령들에 억지로 표를 씨우면 가이드가 시키는 것을 못 읽게 된다. */
export function renderOk(cmd: string, body: unknown, mode: OutputMode, mark: ReplayMark = null): string {
  if (mode === 'json') return okEnvelope(cmd, body, mark)
  const data = dataFor(cmd, body)
  if (mode === 'quiet') return quietFor(data)
  // **사람용 두 모드는 표시를 싣지 않는다.** 재생의 요점은 첫 답을 받은 것과 구별되지 않는 것이고,
  // 그것이 재생이었다는 사실은 봉투를 읽는 쪽 — 즉 스크립트 — 의 것이다. `--quiet` 는 id 목록이라
  // 얹을 자리조차 없다. 사람용이 없어 봉투로 되돌아가는 명령은 봉투이므로 그때는 실린다.
  return humanFor(cmd, data) ?? okEnvelope(cmd, body, mark)
}

/**
 * 모드에 맞춘 오류 출력. 사람에게는 봉투가 아니라 문장이다 — 코드는 종료 코드로 이미 간다.
 *
 * **다음에 칠 것은 두 모드 모두에 나간다.** 스크립트가 받는 `error.nextSteps` 와 같은 줄이고
 * (cliOutput 의 `nextStepsFor`), 사람에게도 같은 것이 필요하다 — 무엇이 잘못됐는지 읽고 나서 다음
 * 질문은 언제나 "그래서 뭘 치지" 다. JSON 쪽은 봉투가 이미 싣고 있으므로 **한 번만** 나간다.
 */
export function renderErr(e: CliError, mode: OutputMode, cmd?: string, mark: ReplayMark = null): string {
  if (mode === 'json') return errEnvelope(e, cmd, mark)
  const steps = nextStepsFor({ code: e.code, cmd, details: e.details })
  return [`error: ${e.message}`, ...(steps.length === 0 ? [] : ['try:', ...steps.map((s) => `  ${s}`)])].join(
    '\n'
  )
}

export function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : text + '\n'
}

/**
 * Why an empty standard input cannot be the value, or `null`.
 *
 * **A `-` is a promise that the value is coming, and nothing arriving means it did not.** The
 * heredoc was forgotten, the pipe was closed, or this is a terminal — the one thing it never means is
 * that the value is the empty string. The worst case of passing it on is silent and expensive:
 * `send --type worker_done --body -` does not require a body (`workerDoneFieldError`), so an empty
 * report posts at exit 0, the Dispatch closes, and the coordinator reads a finished Task whose
 * summary is gone.
 *
 * A caller that really means an empty value writes `--body ""`, which the parser takes as a value
 * like any other.
 */
export function stdinMissingError(a: { keys: readonly string[]; text: string }): string | null {
  if (a.keys.length === 0 || a.text !== '') return null
  const flags = a.keys.map((k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(', ')
  return `${flags} read nothing from standard input — send the text in, or give the flag a value`
}

/** Fills the wantsStdin keys parseArgs collected (the flags whose value was '-') with the stdin
 *  text. The original args are not mutated (the same state-spread convention as server.ts). */
export function applyStdin(a: {
  /** The command, for the one flag whose value is typed into a terminal rather than stored. */
  cmd?: string
  args: Record<string, unknown>
  keys: string[]
  text: string
}): Record<string, unknown> {
  const next = { ...a.args }
  for (const key of a.keys) next[key] = a.text
  // **`sessions send --text -` loses exactly one trailing newline.** A heredoc or `echo |` always ends
  // in one, and typed into a terminal it is a keystroke of its own before the Enter the command
  // presses — a second Enter in a shell, a newline in an agent's input box. One and no more, so text
  // that really ends in a blank line keeps it. Every other flag keeps its text byte for byte.
  if (a.cmd === 'sessions-send' && typeof next.text === 'string' && a.keys.includes('text'))
    next.text = next.text.replace(/\r?\n$/, '')
  return next
}

/** Headroom stacked on top of the Host's long-poll deadline so the client never gives up before the
 *  Host does. It absorbs the polling interval (POLL_MS) and event-loop delay the Host takes to send
 *  its response once the deadline is reached — with headroom narrower than the Host's deadline,
 *  `callHost`'s own `setTimeout` fires while the Host is still preparing its response, the command
 *  ends as `stuck`, and the contract that a timeout is information rather than an error breaks (this
 *  was the defect where ask's default was shorter than the server's default). */
const TIMEOUT_HEADROOM_MS = 30_000

/** ask and check --wait are long-polled by the server, so the per-command default deadline has to
 *  come from the same constants the server uses (core/orchestration/types.ts) — split into two
 *  copies, the values drift apart. Other commands do not long-poll, so their default is effectively
 *  unused and they reuse check's value (there is no reason to add another constant). If
 *  --timeout-ms was given, that value is used as is. */
export function clientTimeoutMs(a: { cmd: string; args: Record<string, unknown> }): number {
  const defaultForCmd =
    a.cmd === 'ask'
      ? DEFAULT_ASK_TIMEOUT_MS
      : a.cmd === 'browser-js'
        ? SCRIPT_TIMEOUT_MS
        : // **기다리는 명령은 서버와 같은 마감을 써야 한다.** 짧은 값을 쓰면 서버가 답을
          // 준비하는 사이에 클라이언트가 연결을 끊고, "타임아웃은 정보다" 는 계약이 깨진다
          // (ask 의 기본값이 서버보다 짧아서 실제로 그러였다).
          a.cmd === 'jobs-wait' || a.cmd === 'runs-wait' || (a.cmd === 'sessions-send' && a.args.wait === true)
          ? DEFAULT_WAIT_TIMEOUT_MS
          : DEFAULT_CHECK_TIMEOUT_MS
  const base = typeof a.args.timeoutMs === 'number' ? a.args.timeoutMs : defaultForCmd
  return base + TIMEOUT_HEADROOM_MS
}

/** The arguments as they go on the wire.
 *
 *  `run-create` fills a missing --cwd with `process.cwd()` in the process that answers it, but that
 *  is the Host's working directory and has nothing to do with the CLI process's — omit it and the
 *  Run's cwd becomes wherever the Host happens to have been started, and every worker of that Run
 *  (--worktree current being the default) comes up in the wrong place. Only when --cwd was not given
 *  explicitly is it filled here with the CLI's own cwd (a.cwd) — an explicit value always wins. */
export function argsForCall(a: {
  cmd: string
  args: Record<string, unknown>
  /** The CLI process's own process.cwd(). */
  cwd: string
}): Record<string, unknown> {
  // **A project path is resolved here too** (`--project`, `projects find --path`): the Host resolves a
  // relative path against its own working directory, which is not the shell's, so `--project .` would
  // name whatever folder the Host was started in.
  const pathKey = a.cmd === 'projects-find' ? 'path' : PROJECT_COMMANDS.has(a.cmd) ? 'project' : null
  if (pathKey !== null) {
    const p = a.args[pathKey]
    return typeof p === 'string' && p.length > 0 && !path.isAbsolute(p)
      ? { ...a.args, [pathKey]: path.resolve(a.cwd, p) }
      : a.args
  }
  const given = typeof a.args.cwd === 'string' && a.args.cwd.length > 0 ? a.args.cwd : null
  // `sessions create` takes --cwd as required and gets no default, but a relative one is resolved here
  // for the same reason: the session would otherwise start in the Host's folder.
  if (a.cmd === 'sessions-create')
    return given !== null && !path.isAbsolute(given) ? { ...a.args, cwd: path.resolve(a.cwd, given) } : a.args
  // `jobs create` is run-create under its public name (command.ts), so it needs the same default.
  if (a.cmd !== 'run-create' && a.cmd !== 'jobs-create') return a.args
  if (given === null) return { ...a.args, cwd: a.cwd }
  // **An explicit relative path is resolved here too, for the same reason.** Sent as typed, `--cwd .`
  // is resolved against whichever process answers it, and the Job's workers start there.
  return path.isAbsolute(given) ? a.args : { ...a.args, cwd: path.resolve(a.cwd, given) }
}

/** The commands that take a project (`--project <path>`): the lists a project narrows. The global
 *  `--project`, before the command, fills theirs in (`withDefaultProject`). */
const PROJECT_COMMANDS: ReadonlySet<string> = new Set(['jobs-list', 'runs-list', 'sessions-list'])

/**
 * The global `--project` as the default of a command's own (CLI spec §24).
 *
 * **Only for the commands that take a project**, and **only when the command was not given one**: a
 * `--project` after the command is the more specific ask and wins. Every other command ignores the
 * default, as it would ignore an environment variable it does not read; the same line can then carry
 * the default in front of any command, which is what a default is for.
 */
export function withDefaultProject(a: {
  cmd: string
  args: Record<string, unknown>
  project: string | undefined
}): Record<string, unknown> {
  if (a.project === undefined || !PROJECT_COMMANDS.has(a.cmd) || a.args.project !== undefined) return a.args
  return { ...a.args, project: a.project }
}

/**
 * `--request-id <id>` taken off the line, because it rides the **message** rather than the arguments
 * (request receipts design §8).
 *
 * **Why it cannot stay in `args`.** Everything left there goes on the wire as an argument to the
 * command that was typed, and no `case` in `handleCommand` reads this one: it is a fact about the
 * call, which is why the envelope carries it in its own field beside `session`
 * (core/host/protocol.ts). Left in `args` it would also be written into an undelivered report's
 * queue file as if it were one of that report's own flags.
 *
 * **A flag with no value is refused rather than dropped.** `parseArgs` turns a bare `--request-id`
 * into `true`, and quietly ignoring that is the exact fault this design is built against — Orca's
 * `check --peek` takes the key and drops it, and "the caller's whole reason for passing the flag is
 * a belief about what happens next" (§3).
 */
export function liftRequestId(
  args: Record<string, unknown>
): { request?: string; args: Record<string, unknown> } | { error: string } {
  const given = args.requestId
  // Nothing to lift, and the arguments are handed back as they came — a caller that passed no key
  // pays not even a copy (§9).
  if (given === undefined) return { args }
  if (typeof given !== 'string' || given === '') return { error: '--request-id needs an id' }
  const rest = { ...args }
  delete rest.requestId
  return { request: given, args: rest }
}

/**
 * The id this invocation is known by when the caller named none (request receipts design §8).
 *
 * **A receipt's value is highest exactly where the caller did not plan for failure.** Somebody who
 * thought to pass `--request-id` has already thought about retries; the caller who did not is the one
 * who, when the answer is lost, has nothing to check — and that caller is the reason this exists.
 * Minting only for the first leaves the protection with the people who needed it least. Without it
 * the error of a lost answer cannot name an id, and that sentence — here is your request id, here is
 * how to check it, here is how to retry it — is the sentence the feature exists to write.
 *
 * **And it changes no success path.** A replay is only ever triggered by an id being *presented
 * again*; a minted one is sent once and never re-sent by this program, so nobody gets a different
 * answer, a different exit code or a different order for not having asked (§9). What an unkeyed
 * caller pays is one `randomUUID()`, 36 bytes on the wire, and — only if the command acted — one
 * bounded entry in a map that nothing reads.
 *
 * `randomUUID` rather than this repo's `a<8 hex>-<n>` convention (`core/chat/adapterCore.ts`) because
 * there is no counter here to carry: one CLI process asks one thing and exits.
 */
export const mintRequestId = (): string => randomUUID()

/**
 * What the id does against the Host we actually reached (request receipts design §8).
 *
 * **Auto-minting forces two different degradations, and the split is the whole point.** A Host from
 * before receipts destructures `{cmd, args, session}`, ignores a field it does not know, and runs the
 * command unprotected.
 *
 * - A **presented** key is refused, and nothing is sent. Silence there is the dangerous half: the
 *   caller typed the flag because of a belief about what happens next, and letting the command run
 *   would make that belief false without telling anyone. Exit 9 is the same shape and code as the
 *   `HOST_FEATURE_ORCH` check below it, because it is the same fact — this Host is an older build.
 * - An **auto-minted** id is dropped and the command runs exactly as it did before receipts existed.
 *   Refusing here would break every command against every older Host over a protection nobody asked
 *   for.
 *
 * In one line: we refuse to break a promise we made, and we never refuse over one we did not.
 */
export function requestForHost(a: {
  /** The id this invocation holds, presented or minted. */
  request: string
  /** True when the caller typed `--request-id`. */
  presented: boolean
  features: readonly string[]
  address: string
}): { send: string | undefined } | { error: CliError } {
  if (a.features.includes(HOST_FEATURE_REQUESTS)) return { send: a.request }
  if (!a.presented) return { send: undefined }
  return {
    error: {
      code: codeForStatus(501),
      message: `the Host at ${a.address} does not keep request receipts — it is an older build, and --request-id cannot protect this call against it`
    }
  }
}

/**
 * A receipt's recorded response, filtered as the command that produced it would have been filtered.
 *
 * **Why this keys on the *recorded* command while the line that calls it keys on `parsed.cmd`.**
 * Everywhere else in this program the two are the same command: a caller retries `jobs get`, the
 * reply is a Job, and `jobs-get`'s allowlist is the right one. `requests show` is the one place they
 * come apart — what it carries is some other command's answer, and `SHAPE` has no entry for
 * `requests-show`, so `publicFor` would hand back that answer untouched. Fetching a Job through a
 * receipt would then print the fields `jobs get` hides. `cliPublic.ts` exists to be one boundary and
 * that would make it two. The receipt names the command it answered (`cmd`, which the Host records
 * beside the reply), so the honest key is what the body *is* rather than what was typed to fetch it.
 *
 * **A command with no `SHAPE` entry passes through, and that is right rather than a gap.** The
 * session-only commands were never filtered in the first place, which is `publicFor`'s own stated
 * rule: shaping them "가리려 들면 가이드가 시키는 것을 못 읽게 만들 뿐이다". Turning a missing entry
 * into a refusal here would make a replay show less than the original command printed.
 *
 * Only a `completed` receipt has a `response` at all; `pending` and `absent` pass straight through,
 * as does anything that is not the shape this expects.
 */
export function shownReceipt(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return body
  const held = body as { cmd?: unknown; response?: unknown }
  const response = held.response
  if (typeof held.cmd !== 'string' || response === null || typeof response !== 'object') return body
  const recorded = response as { body?: unknown }
  return { ...held, response: { ...recorded, body: publicFor(held.cmd, recorded.body) } }
}

/**
 * One argv token as a command line carries it. **The line these build is POSIX shell syntax**, and
 * that is a decision rather than a default — see `retryCommandLine` for what it costs and what it
 * buys.
 *
 * **Single quotes, because they are the only quoting that expands nothing.** We publish this line as
 * one a person or an agent can paste, so the first requirement is that pasting it cannot *run*
 * anything. Inside double quotes a shell still expands `$HOME`, `$(date)` and backticks, so a
 * `--question 'ship at $(date)?'` that came back inside an error would execute `date` on its way to
 * being refused by the fingerprint. Inside single quotes nothing at all is special, backslashes
 * included, which is also what makes a Windows path come back as the path that was typed.
 *
 * A single quote inside the value is the one character that cannot be written inside single quotes,
 * so it closes, escapes and reopens — `'\''`, the POSIX idiom. That is the one place this line is
 * bash-and-zsh only rather than bash-and-PowerShell.
 *
 * Everything in the safe set below is a character no shell does anything with, which is what keeps
 * the ordinary line — ids, flags, plain words — free of quotes nobody needs.
 */
const shellToken = (t: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(t) ? t : `'${t.replace(/'/g, `'\\''`)}'`

/**
 * The line that presents this request id again (request receipts design §8).
 *
 * **Built from the argv this process was given, not from the parsed arguments**, and that is what
 * makes it a line that really runs. Rebuilding from `args` would have to re-serialise every value
 * this program has already interpreted — a `--deps` back into JSON, a `--check` back into repeats,
 * an `--options` back into CSV or JSON depending on which it was — and each of those is a place for
 * the printed line to differ from the one that was typed. It would also inline whatever `-` read
 * from stdin, so a report of a few kilobytes would come back inside an error envelope. The argv is
 * exact, already the right size, and it round-trips through `parseArgs` by construction.
 *
 * Any `--request-id` already on the line is taken off and the real id appended, so the line carries
 * the id this call was actually made with — including the case where the flag read its value from
 * stdin and the token on the line is a bare `-`.
 *
 * **And what this process added on the way out is written in** (`implicit`). `argsForCall` fills a
 * missing `--cwd` on `run-create` with this process's working directory, and that value is part of
 * the request the Host fingerprinted. Print the typed line alone and running it from another folder
 * sends a different `cwd`, which is refused as "already used with different arguments" while the two
 * lines are character for character the same — safe, and impossible to explain.
 *
 * **The line is POSIX shell syntax** (`shellToken`): bash, zsh, and Git Bash on Windows, which is
 * where `astera` is run from when an agent runs it. PowerShell reads the same single quotes, apart
 * from a value that contains one. `cmd.exe` does not read single quotes at all, so a value with a
 * space in it has to be requoted there. Both documents that publish this line say so rather than
 * calling it universal, which is what it was and was not.
 */
export function retryCommandLine(a: {
  argv: readonly string[]
  request: string
  /** Arguments this process put on the wire that are not on the line (`implicitArgs`). */
  implicit?: Record<string, unknown>
}): string {
  const rest: string[] = []
  for (let i = 0; i < a.argv.length; i++) {
    if (a.argv[i] !== '--request-id') {
      rest.push(a.argv[i])
      continue
    }
    // Its value goes with it. A next token that is itself a flag means the id was never given one,
    // and `liftRequestId` has already refused that line — so there is nothing to skip.
    const next = a.argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) i++
  }
  for (const [key, value] of Object.entries(a.implicit ?? {})) {
    const flag = `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
    // `true` is a flag with no value, as `parseArgs` reads it back. Nothing but a string reaches here
    // today (`argsForCall` adds one `cwd`); JSON is what a future one would have to be written as for
    // the parser to read the same value back, and printing it is better than dropping the flag.
    if (value === true) rest.push(flag)
    else rest.push(flag, typeof value === 'string' ? value : JSON.stringify(value))
  }
  return ['astera', ...rest, '--request-id', a.request].map(shellToken).join(' ')
}

/** What this process put on the wire that the caller did not type — the difference `argsForCall`
 *  makes. Derived rather than listed, so whatever that function fills in next is carried without
 *  anybody remembering to add it here. */
export function implicitArgs(
  typed: Record<string, unknown>,
  sent: Record<string, unknown>
): Record<string, unknown> {
  const added: Record<string, unknown> = {}
  for (const key of Object.keys(sent)) if (!Object.hasOwn(typed, key)) added[key] = sent[key]
  return added
}

/**
 * **The sentence this feature exists to write** (request receipts design §8): here is your request
 * id, here is how to check what became of it, here is how to retry it.
 *
 * It rides `error.details` of the two endings that leave the question open — the socket closing
 * before the answer arrives, and this client's own deadline passing — because those are the two
 * places where the Host commits before it answers and the caller learns nothing. An agent that reads
 * `error.details` gets the recovery path without having read the guide.
 *
 * **Empty when no id was sent**, which is the case against a Host too old to keep receipts
 * (`requestForHost` dropped the minted one) and the case where the connection never opened at all.
 * There is no receipt to ask about then, and naming one would send the caller to a command that can
 * only answer `absent` — the one answer that means nothing at all.
 */
export function lostAnswerDetails(a: {
  argv: readonly string[]
  /** What actually went on the wire, which is not always what this process minted. */
  request: string | undefined
  /** Arguments this process added on the way out, so the retry line sends what the first call sent
   *  (`implicitArgs`). */
  implicit?: Record<string, unknown>
  /** The flags whose value came from standard input (`parseArgs`'s `wantsStdin`). */
  fromStdin?: readonly string[]
}): Record<string, unknown> {
  if (a.request === undefined) return {}
  const head = {
    requestId: a.request,
    queryCommand: `astera requests show --id ${shellToken(a.request)}`
  }
  /**
   * **A command that read part of itself from standard input has no line to print, so none is
   * printed.**
   *
   * `parseArgs` never puts a `-` value into `args` — `applyStdin` fills it afterwards — so the argv
   * this line is built from still carries the bare `-`, and `browser js` carries nothing at all. The
   * payload is simply not on the line, and the guide teaches `-` with a heredoc as *the* way to pass
   * a spec, a body, a question or a report.
   *
   * **Both endings of printing it anyway are worse than saying nothing.** Against a Host that
   * restarted, the retry runs with an empty body and `worker_done` does not require one, so a
   * worker's finished report posts empty at exit 0 and the coordinator reads it as delivered.
   * Against a live Host, the fingerprint differs and the caller is told to use a different id —
   * which, followed literally, creates the second Task or the second question this whole mechanism
   * exists to prevent.
   *
   * **And the payload is not inlined instead.** It can be a whole spec, it can carry secrets, and a
   * line that looks runnable and is not is exactly how this went wrong. What the caller gets is the
   * one sentence it can act on: run what you ran, with this id, feeding the same input the same way.
   */
  if (a.fromStdin !== undefined && a.fromStdin.length > 0) {
    const flags = a.fromStdin.map((k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(', ')
    return {
      ...head,
      retryNote:
        `this command read ${flags} from standard input, so the line to retry it cannot be written out here. ` +
        `Run the same command again with --request-id ${a.request} and the same input on stdin.`
    }
  }
  return {
    ...head,
    retryCommand: retryCommandLine({ argv: a.argv, request: a.request, implicit: a.implicit })
  }
}

/** The ids a refusal names, as `details` for the envelope, or nothing: `requestId` (the 409 for a
 *  request already in flight), `jobId` (`tasks add --validate`'s unknown configuration, CLI phase
 *  D), `repair` (the profile file a 409 says only the app can repair, Host S2) and `retry` (a 409
 *  from a Host that is leaving, which the same command retried once a Host is up clears) and `runId` (a
 *  later `jobs run` whose coordinator did not start: the run it left behind, host S4+S5 Task 15; and the
 *  Run a `check --ack` of no such batch was checked against, for its `check --run <runId>` step). Undefined
 *  rather than an empty object so a failure that names none prints `details: {}` exactly as it did before. */
export function refusalDetailsOf(body: unknown): Record<string, unknown> | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const out: Record<string, unknown> = {}
  for (const key of ['requestId', 'jobId', 'repair', 'retry', 'runId'] as const) {
    const id = (body as Record<string, unknown>)[key]
    if (typeof id === 'string' && id !== '') out[key] = id
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 한 명령을 Host 에 묻고 그 답을 기다린다 (host control plane design §5).
 *
 *  **닿지 못한 것과 답을 못 받은 것을 가른다.** 연결이 답 전에 끊기면 그 Host 는 사라진 것이므로
 *  `unreachable` 과 같은 사실이고(보고는 파일에 적힌다), 시한을 넘긴 것은 연결은 됐는데 저쪽이
 *  멈춘 것이라 그냥 실패다 — HTTP 시절의 갈래(`ctl.signal.aborted`)를 그대로 옮긴 것이다. */
/** One answer from the Host. `replayed` is there when this answer came out of a receipt rather than
 *  out of a run of the command (request receipts design §8) — the same word the Host puts on
 *  `orch-result`, carried to the envelope this program prints. */
export interface HostAnswer {
  status: number
  body: unknown
  replayed?: true
  observed?: true
}

/** Which of the two words this answer wears at the top of the envelope, if either (`ReplayMark`).
 *  They are never both set, and an ordinary answer wears neither. */
export const markOf = (r: Pick<HostAnswer, 'replayed' | 'observed'>): ReplayMark =>
  r.replayed === true ? 'replayed' : r.observed === true ? 'observed' : null

export function callHost(a: {
  conn: HostConnection
  cmd: string
  args: Record<string, unknown>
  sessionId: string
  /** The id this request is known by, when `--request-id` gave one (`liftRequestId`). Absent from
   *  the message when there is none: a Host that knows the field must be able to tell a caller that
   *  named no id from one that named an empty one. */
  request?: string
  timeoutMs: number
}): Promise<HostAnswer | { unreachable: string } | { stuck: string }> {
  return new Promise((resolve) => {
    // 이 프로세스는 명령 하나를 묻고 끝난다 — 한 번에 하나뿐이라 상관 id 는 하나면 된다.
    const call = 'cli_1'
    let settled = false
    let offMessage: () => void = () => {}
    let offClose: () => void = () => {}
    const done = (r: HostAnswer | { unreachable: string } | { stuck: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      offMessage()
      offClose()
      resolve(r)
    }
    const timer = setTimeout(
      () => done({ stuck: `the Host did not answer ${a.cmd} within ${a.timeoutMs}ms` }),
      a.timeoutMs
    )
    timer.unref?.()
    offMessage = a.conn.onMessage((m) => {
      if (m.t === 'orch-result' && m.call === call)
        done({
          status: m.status,
          body: m.body,
          ...(m.replayed === true ? { replayed: true } : {}),
          ...(m.observed === true ? { observed: true } : {})
        })
    })
    offClose = a.conn.onClose(() =>
      done({ unreachable: `the Host closed the connection before answering ${a.cmd}` })
    )
    a.conn.call({
      t: 'orch-call',
      call,
      cmd: a.cmd,
      args: a.args,
      session: a.sessionId,
      ...(a.request === undefined ? {} : { request: a.request })
    })
  })
}

/** `callHost`, timed for `--verbose`: how long the round trip took and how it ended. With `--verbose`
 *  off this is `callHost` itself. */
export function timedCall(
  verbose: VerboseLog,
  a: Parameters<typeof callHost>[0]
): ReturnType<typeof callHost> {
  return verbose.timed(`call ${a.cmd}`, () => callHost(a), (r) =>
    'unreachable' in r ? `no answer: ${r.unreachable}` : 'stuck' in r ? `no answer: ${r.stuck}` : `status ${r.status}`
  )
}

/** How `followRun` ended. `ended` carries the body `runs wait` would have answered with (the Host's
 *  `waitEndingFor`, or a `timeout` built here), so the caller turns it into the same exit code. */
export type FollowEnd =
  | { ended: Record<string, unknown> }
  | { refused: HostAnswer }
  | { unreachable: string }
  | { stuck: string }

/**
 * `astera runs follow` (CLI spec §22): the timeline of a run, printed as it happens, until the run ends.
 *
 * **Why a loop of long polls and not a push.** The Host does push state, but only to the app: its
 * `orch-state` message goes to the attached app's connection, and a CLI client has no subscription to
 * ask for. Adding one would be a new message, a new feature flag and a new failure mode (a subscriber
 * that stops reading) on the Host. A `runs-follow` call is an ordinary `orch-call` instead, answered by
 * the same command layer as `runs wait` with the same `pollUntil`: it comes back as soon as there are
 * more events than this loop has printed, or the run reaches an ending, or its window passes. Every
 * Host that answers orchestration commands can answer it, a lost connection is the ordinary 3, and
 * there is nothing on the Host to clean up when this process goes away.
 *
 * **Each event is printed once**, keyed by `eventKey`, in the order the Host's timeline gives. When
 * there are new events the Host sends the whole timeline, so an event whose time is earlier than one
 * already printed is still printed when it appears. `seen` is how many this loop has printed.
 *
 * **Ctrl+C ends this process only.** Nothing here writes, and the Host's poll ends at its window.
 */
export async function followRun(a: {
  id: unknown
  mode: OutputMode
  /** The whole follow's deadline, `--timeout-ms`. */
  timeoutMs: number
  write: (line: string) => void
  /** One `runs-follow` call, with the client-side deadline for it. */
  call: (
    args: Record<string, unknown>,
    timeoutMs: number
  ) => Promise<HostAnswer | { unreachable: string } | { stuck: string }>
  /** How long one call may hold on the Host. Shorter in tests. */
  windowMs?: number
  now?: () => number
}): Promise<FollowEnd> {
  const now = a.now ?? Date.now
  const windowMs = a.windowMs ?? FOLLOW_WINDOW_MS
  const deadline = now() + a.timeoutMs
  const printed = new Set<string>()
  for (;;) {
    const waitMs = Math.max(0, Math.min(windowMs, deadline - now()))
    const r = await a.call({ id: a.id, seen: printed.size, waitMs }, waitMs + TIMEOUT_HEADROOM_MS)
    if ('unreachable' in r || 'stuck' in r) return r
    if (r.status < 200 || r.status >= 300) return { refused: r }
    const page = (r.body ?? {}) as {
      runId?: unknown
      jobId?: unknown
      progress?: unknown
      events?: JobEvent[]
      ending?: Record<string, unknown> | null
    }
    for (const e of page.events ?? []) {
      const key = eventKey(e)
      if (printed.has(key)) continue
      printed.add(key)
      // One envelope per line in JSON (NDJSON), one sentence per line for a person, and nothing for
      // `--quiet`, whose answer is the exit code.
      if (a.mode === 'json') a.write(okEnvelope('runs-follow', { event: publicEvent(e) }))
      else if (a.mode === 'human') a.write(followLine(e))
    }
    if (page.ending) return { ended: page.ending }
    if (now() >= deadline)
      return { ended: { state: 'timeout', runId: page.runId, jobId: page.jobId, progress: page.progress } }
  }
}

/**
 * Says on **stderr**, every `KEEPALIVE_MS`, that a waiting command is still waiting — and whether the
 * Host is still answering (cliKeepalive.ts has the why and the interval's argument).
 *
 * **stdout is never touched.** It carries one result and one envelope, so a caller needs no filter to
 * remove these; `2>/dev/null` and `--no-keepalive` are both there for a caller that wants stderr
 * empty. Nothing is written for a command that does not wait, because a liveness line on an answer
 * that came back at once is noise that teaches the reader to ignore the line.
 *
 * **The ping is what makes the line worth printing.** A bare timer proves this process is alive,
 * which was never in doubt; what a person watching a five-minute silence needs to know is whether the
 * Host is. So each tick asks (`ping`, answered with `pong` — the same heartbeat the app runs, and the
 * exact failure it was built for: an event loop wedged inside node-pty answers nothing at all), and
 * each line carries how long ago the last answer came. A Host too old to know `ping` does not
 * announce the feature, and then the line says only what it can honestly say.
 *
 * The timing arguments are parameters so this can be tested in milliseconds rather than minutes.
 */
export function startKeepalive(a: {
  conn: Pick<HostConnection, 'hello' | 'call' | 'onMessage'>
  cmd: string
  args: Record<string, unknown>
  /** False for `--no-keepalive`. */
  enabled: boolean
  /** How often to ping. */
  tickMs?: number
  /** How often to print. */
  lineMs?: number
  now?: () => number
  write?: (line: string) => void
}): { stop: () => void } {
  if (!a.enabled || !waitingCommand({ cmd: a.cmd, args: a.args })) return { stop: () => {} }
  const now = a.now ?? Date.now
  const write = a.write ?? logToStderr
  const lineMs = a.lineMs ?? KEEPALIVE_MS
  // A Host that does not answer pings is not woken between lines — there is nothing to ask it.
  const canPing = a.conn.hello.features.includes(HOST_FEATURE_PING)
  const tickMs = a.tickMs ?? (canPing ? KEEPALIVE_PING_MS : lineMs)
  const startedAt = now()
  // The `hello` that opened this connection arrived a moment ago and is an answer like any other, so
  // the first line has a real number to report rather than a gap that looks like silence.
  let lastAnswerAt = startedAt
  let lastLineAt = startedAt
  let seq = 0
  const off = canPing
    ? a.conn.onMessage((m) => {
        if (m.t === 'pong') lastAnswerAt = now()
      })
    : (): void => {}
  const timer = setInterval(() => {
    const at = now()
    // Half a tick of slack: a timer that fires a hair early must not push the line a whole tick out.
    if (at - lastLineAt >= lineMs - tickMs / 2) {
      lastLineAt = at
      write(
        keepaliveLine({
          cmd: a.cmd,
          elapsedMs: at - startedAt,
          silentMs: canPing ? at - lastAnswerAt : null
        })
      )
    }
    if (canPing) a.conn.call({ t: 'ping', seq: ++seq })
  }, tickMs)
  // Nothing should be held open by this: the socket already keeps the process alive for exactly as
  // long as the call it is reporting on.
  timer.unref?.()
  return {
    stop: () => {
      clearInterval(timer)
      off()
    }
  }
}

/** Absolute location of the guide document. Now that the CLI moved into a bundle artifact
 *  (out/main/cli.js), a relative path to resources/skills can no longer be fixed — __dirname points
 *  somewhere different in a packaged app than in dev mode. So it is taken from the --skills-dir
 *  argument, else the ASTERA_SKILLS environment variable the wiring injects into a session, else
 *  `bundled`.
 *
 *  **`bundled` is where this binary's own resources are** (`resolveSkillsDir`, the same lookup
 *  `skills install` finds its stubs with). Without it `astera help` failed in any shell Astera did
 *  not start, and it is the command `--help`'s first screen points at (conformance audit #70).
 *  ASTERA_SKILLS still wins inside a session: it names the app that started the session, which is
 *  the guide that session's commands answer to. */
export function resolveGuidePath(a: {
  args: Record<string, unknown>
  env: NodeJS.ProcessEnv
  /** The skills folder beside this binary, or undefined when none was found. */
  bundled?: string
  /** Which guide. `astera help` is the orchestration guide; `astera browser help` the browser's. */
  guide?: 'orchestration' | 'browser'
}): { ok: true; path: string } | { ok: false; error: string } {
  const dir =
    typeof a.args.skillsDir === 'string' && a.args.skillsDir.length > 0
      ? a.args.skillsDir
      : a.env.ASTERA_SKILLS || a.bundled
  if (!dir)
    return {
      ok: false,
      error:
        'ASTERA_SKILLS is not set, no --skills-dir was given, and no resources/skills was found beside this build'
    }
  const file = a.guide === 'browser' ? 'browser-guide.md' : 'orchestration-guide.md'
  return { ok: true, path: path.join(dir, file) }
}

export function readGuide(
  guidePath: string
): { ok: true; content: string } | { ok: false; error: string } {
  try {
    return { ok: true, content: readFileSync(guidePath, 'utf8') }
  } catch {
    return { ok: false, error: `cannot read ${guidePath} — is resources/skills packaged?` }
  }
}

/** Writes one undelivered report into the queue in the profile.
 *
 *  **Synchronous, and it answers instead of throwing.** This is the last line of defence: the server
 *  could not be reached, so if this write is lost the finished work is lost with it. An error comes
 *  back as a value so `main` can tell the agent both things that went wrong in one line — the report
 *  did not reach the app *and* it could not be written down — rather than the process dying with a
 *  stack trace in the middle of a worker's command.
 *
 *  The folder is created here because nothing else makes it: it exists only once there has been
 *  something to queue.
 *
 *  **Written under a temporary name and renamed into place**, the same shape as
 *  `OrchestrationStore`'s writes. A worker reporting at the moment the app comes back is exactly
 *  the case this whole path exists for, and that is also the moment the app lists this folder — so
 *  a report written in place could be read half-finished. A same-directory rename onto a name
 *  nothing else uses (the nonce makes it unique) is a metadata operation on both platforms: the
 *  reader sees either no such file or the whole of it. */
export function writePendingReport(a: {
  profileDir: string
  sessionId: string
  cmd: string
  args: Record<string, unknown>
  queuedAt: string
  nonce: string
}): { ok: true; path: string } | { ok: false; error: string } {
  const dir = pendingReportsDirIn(a.profileDir)
  const name = pendingReportFileName({ queuedAt: a.queuedAt, nonce: a.nonce })
  const file = path.join(dir, name)
  const tmp = path.join(dir, pendingReportTempName(name))
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      tmp,
      serializePendingReport({
        queuedAt: a.queuedAt,
        sessionId: a.sessionId,
        cmd: a.cmd,
        args: a.args
      }),
      'utf8'
    )
    renameSync(tmp, file)
    return { ok: true, path: file }
  } catch (e) {
    // The working file is cleared so a failed write leaves nothing behind. If even that fails
    // there is nothing further to try: the reader ignores the name, so at worst a small file stays
    // in the folder.
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* nothing left to try */
    }
    return { ok: false, error: `cannot write ${dir}: ${String(e)}` }
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('')
    const chunks: Buffer[] = []
    process.stdin.on('data', (c: Buffer) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function out(text: string): void {
  process.stdout.write(ensureTrailingNewline(text))
}

/** The function the thin shell of the entry point (index.ts) calls straight through. It does not
 *  call itself here, so a test that imports this file does not terminate the process. */
export async function main(): Promise<void> {
  // **Usage comes first, before the parser and before any Host.** All three levels used to end
  // badly here: `--help` was `expected a command, got flag`, `jobs --help` was `jobs needs one of:
  // …`, and `jobs list --help` parsed `--help` as an ordinary flag and *ran the command*. Answering
  // in front of `parseArgs` is what stops that, and it is also what lets `--help` answer with
  // nothing running — the text is already in this program (cliUsage.ts).
  // Read once and kept: the recovery line an ambiguous failure carries is this argv with the request
  // id appended (`retryCommandLine`), and a second read of the same array would be a second chance
  // for the two to disagree.
  const argv = process.argv.slice(2)
  const help = usageFor(argv, sessionUsage)
  if (help !== null) {
    if ('error' in help) {
      out(errorOutput(help.error, 'INVALID_ARGUMENTS'))
      process.exit(exitCodeFor('INVALID_ARGUMENTS'))
    }
    // Text, not an envelope, and exit 0. `--help` is inherently for a person, the same footing as
    // `astera help`, and asking for it is not one of the ten failures.
    out(help.text)
    process.exit(0)
  }

  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    out(errorOutput(parsed.error, 'INVALID_ARGUMENTS'))
    process.exit(exitCodeFor('INVALID_ARGUMENTS'))
  }

  const mode = outputMode({ json: parsed.json, human: parsed.human, quiet: parsed.quiet })
  if (typeof mode !== 'string') {
    out(errorOutput(mode.error, 'INVALID_ARGUMENTS'))
    process.exit(exitCodeFor('INVALID_ARGUMENTS'))
  }

  /** `--verbose` (cliVerbose.ts): stderr only, and nothing at all unless it was given. */
  const verbose = verboseLog({ enabled: parsed.verbose, write: logToStderr })

  /**
   * **모드가 정해진 뒤의 모든 실패는 이 문 하나를 지난다.**
   *
   * 앞선 세 자리(사용법 오류·파서 오류·모드 오류)는 아직 모드가 없어서 봉투로 나가고, 그
   * 아래로는 전부 여기로 온다. 성공 쪽은 이미 `renderOk` 한 곳으로 모여 있었고 실패 쪽만
   * 자리마다 흩어져 있었다.
   *
   * **자리마다 고치는 것을 그만두려고 만들었다.** 이 가지에서 `--human` 이 봉투를 찍은 것이
   * 네 번째이고, 그때마다 고친 것은 그 자리 하나였다. 새 실패 경로를 더하는 사람이 기본값으로
   * 얻는 것이 모드를 따르는 쪽이어야 한다 — 기억해야 할 목록으로 두면 다음에 또 잊는다.
   * `FAIL_SEAM` 아래로 봉투를 직접 만드는 호출이 남아 있지 않은 것을 run.test.ts 가 지킨다.
   */
  /** The answer this process is carrying, once there is one. **`fail` reads its mark from here**,
   *  because a replayed failure goes out through `fail` and `fail` is built long before there is any
   *  answer to mark. Null until then, and nothing has a mark. */
  let answer: HostAnswer | null = null
  const fail: (e: CliError) => never = (e) => {
    out(renderErr(e, mode, parsed.cmd, answer === null ? null : markOf(answer)))
    process.exit(exitCodeFor(e.code))
  }
  // FAIL_SEAM — 이 줄 아래에서 실패를 내보내는 길은 `fail` 하나다. 봉투를 직접 짓는 호출을
  // 두지 않는다(run.test.ts 가 이 표식 아래를 훑는다).

  // **공개 명령은 선언하지 않은 플래그를 거절한다**(cliUsage.ts 의 unknownFlagError). 무시하면
  // `runs wait --timeout 30m` 이 기본 한 시간을 기다린다. 세션 전용 명령은 예전처럼 지나간다.
  // From the command on: the global flags before it (`--project <path>`, the modes) are not the
  // command's, and a leading `--project` must not be judged as that command's own flag.
  const lead = leadingGlobals(argv)
  const flagError = unknownFlagError(parsed.cmd, 'error' in lead ? argv : argv.slice(lead.start))
  if (flagError !== null) fail({ code: 'INVALID_ARGUMENTS', message: flagError })

  // **스키마도 Host 없이 답한다** — `--help` 와 같은 자리다(cliAgentContext.ts). 물어본 것이 "이
  // 바이너리가 무엇을 할 줄 아는가" 이고, 그 답은 이 프로그램 안에 이미 있다.
  //
  // **모드를 보지 않고 언제나 봉투다.** 이것은 스키마이고 스키마는 JSON 이다 — `--human` 에 칸을
  // 맞춘 표를 씌울 것이 없고, `--quiet` 의 id 목록은 더더욱 아니다.
  if (parsed.cmd === 'agent-context') {
    out(okEnvelope(parsed.cmd, agentContext()))
    process.exit(0)
  }

  // help has to work without a Host — handle it before working out which one to talk to.
  /** The skills folder beside this binary, looked up only by the two guide commands below. */
  const bundledSkills = (): string | undefined =>
    resolveSkillsDir({ resourcesPath: process.resourcesPath, cliEntry: process.argv[1] ?? '', exists: existsSync })

  if (parsed.cmd === 'help') {
    const resolved = resolveGuidePath({ args: parsed.args, env: process.env, bundled: bundledSkills() })
    if (!resolved.ok) fail({ code: 'FAILED', message: resolved.error })
    const guide = readGuide(resolved.path)
    if (!guide.ok) fail({ code: 'FAILED', message: guide.error })
    out(guide.content)
    process.exit(0)
  }

  // The browser guide works without a server too — same shape as help above.
  if (parsed.cmd === 'browser-help') {
    const resolved = resolveGuidePath({ args: parsed.args, env: process.env, bundled: bundledSkills(), guide: 'browser' })
    if (!resolved.ok) fail({ code: 'FAILED', message: resolved.error })
    const guide = readGuide(resolved.path)
    if (!guide.ok) fail({ code: 'FAILED', message: guide.error })
    out(guide.content)
    process.exit(0)
  }

  // **세션 밖에서도 Host 를 찾는다**(설계 §4). 세션 안이면 앱이 자기 프로필 폴더를 실어 보내고
  // (`ASTERA_PROFILE_DIR`), 주소도 보고 큐도 그 폴더에서 나온다. 주소 하나로는 못 한다 — 주소는 그
  // Host 가 어느 프로필을 쓰는지 말해 주지 않고, 못 보낸 보고를 적을 곳이 거기서 나온다(F43).
  // `ASTERA_HOST` 는 주소만 이긴다. 둘 다 없으면 플랫폼에서 계산한다 — `cliHostTarget` 이 그 순서를 쥐고 있다.
  const { address, profileDir } = cliHostTarget({
    platform: process.platform,
    env: process.env,
    home: homedir()
  })
  const sessionId = process.env.ASTERA_SESSION ?? ''
  verbose.say(`Host address ${address} (profile ${profileDir})`)

  // **stdin is read before connecting, not after.** A report's body arrives on stdin, and the
  // report has to be complete before either unreachable path below can write it down — a worker that
  // finishes while the Host is gone fails at the connect, not at the reply. For every other command
  // this only changes the order of two steps that both end the same way.
  let args = parsed.args
  if (parsed.wantsStdin.length > 0) {
    const text = await readStdin()
    // **An empty stdin is refused rather than passed on as an empty value.**
    //
    // A `-` is the caller saying "the value is coming on stdin", and nothing arriving means the
    // heredoc was forgotten, the pipe was closed, or this is a terminal — never that the value is
    // the empty string. Passed on, the worst case is silent and expensive: `send --type worker_done
    // --body -` does not require a body (`workerDoneFieldError`), so an empty report posts at exit
    // 0, the Dispatch closes, and the coordinator reads a finished Task whose summary is gone.
    //
    // Refusing costs a caller that really meant an empty value one flag (`--body ""`), which is a
    // line it can write, and it is the parser's own kind of failure: the arguments do not say what
    // the caller meant.
    const missing = stdinMissingError({ keys: parsed.wantsStdin, text })
    if (missing !== null) fail({ code: 'INVALID_ARGUMENTS', message: missing })
    args = applyStdin({ cmd: parsed.cmd, args, keys: parsed.wantsStdin, text })
  }

  // **`--request-id` leaves `args` here, before anything reads them** (liftRequestId): the queue
  // below writes `args` into a file, `argsForCall` hands them to the command, and this flag belongs
  // to neither. After stdin rather than before it, so `--request-id -` reads its id the way every
  // other flag with a `-` does.
  const lifted = liftRequestId(args)
  if ('error' in lifted) fail({ code: 'INVALID_ARGUMENTS', message: lifted.error })
  args = withDefaultProject({ cmd: parsed.cmd, args: lifted.args, project: parsed.project })
  /** **Every invocation carries an id, whether or not one was asked for** (`mintRequestId`, §8).
   *  Which of the two it is matters in exactly one place, against a Host too old to keep receipts:
   *  there a presented key is refused and a minted one is dropped (`requestForHost`). */
  const presented = lifted.request !== undefined
  const request = lifted.request ?? mintRequestId()

  /** The Host could not be reached at all, and the command is not one the state file can answer.
   *  A report is written down and the agent is told so; everything else fails exactly as it did.
   *
   *  **Exit 0 once it is recorded.** Not because it succeeded — the notice says plainly that it did
   *  not — but because there is nothing here for the agent to do about it, and a non-zero exit is
   *  what left workers deciding for themselves whether to retry, give up, or read their own finished
   *  work as failed. When the write itself fails there is something wrong, and both halves of it are
   *  said in one error. */
  const unreachable: (reason: string, lost?: Record<string, unknown>) => never = (reason, lost) => {
    const problem = queueableReportProblem({ cmd: parsed.cmd, args })
    if (problem !== null) {
      // A report one flag short of being recordable is told which flag, not that the app is away:
      // the second is true and useless, and the agent could fix the first itself.
      //
      // **닿지 못한 것은 HOST_NOT_RUNNING(3) 이다.** 스크립트가 "앱이 없다" 와 "명령이 실패했다" 를
      // 가를 수 있어야 한다(설계 §8) — 인자가 모자란 보고만 그 갈래가 아니라 잘못된 인자다.
      const code = problem === 'not a report' ? 'HOST_NOT_RUNNING' : 'INVALID_ARGUMENTS'
      fail({
        code,
        message: problem === 'not a report' ? reason : `${problem} (the Host is not running)`,
        // **Only the ending that is really ambiguous carries the recovery line.** A report one flag
        // short is a fact about the arguments, and telling that caller to go and check a request id
        // would send it after a receipt its own line never earned.
        ...(problem === 'not a report' ? { details: lost } : {})
      })
    }
    const written = writePendingReport({
      profileDir,
      sessionId,
      cmd: parsed.cmd,
      args,
      queuedAt: new Date().toISOString(),
      nonce: randomBytes(4).toString('hex')
    })
    if (!written.ok)
      fail({
        code: 'HOST_NOT_RUNNING',
        message: `${reason} — and the report could not be recorded either: ${written.error}`,
        details: lost
      })
    // 다른 모든 응답과 같은 봉투로 나간다 — 이것만 예외면 `jq .ok` 가 이 한 경우에만 null 이 된다.
    out(renderOk(parsed.cmd, undeliveredReportNotice({ path: written.path }), mode))
    process.exit(0)
  }

  // **host 명령은 앱의 접속 정보를 안 읽는다.** 그 정보가 없는 것이 이 명령이 답해야 할 사실이고,
  // 읽으려다 실패하면 물어본 것에 답하지 못한 채 끝난다.
  if (parsed.cmd.startsWith('host-')) {
    // **실은 키를 받아 놓고 버리지 않는다** (요청 영수증 설계 §3). 이 셋은 `orch-call` 을 타지 않고
    // Host 의 명령 층에 닿지도 않으므로 영수증을 남길 수가 없다 — Host 쪽이 `state-put`·`state-get`
    // 에 실린 id 를 400 으로 거절하는 것과 같은 자리이고, 같은 이유다. 그중 `host stop` 은 **일을
    // 한다**: 조용히 버리면 부르는 쪽은 그 종료가 보호받는다고 믿는다.
    if (presented)
      fail({
        code: 'INVALID_ARGUMENTS',
        message: `${spelledCommand(parsed.cmd)} does not go through the Host's command layer, so it cannot carry a request id`
      })
    const done = await runHostCommand({
      cmd: parsed.cmd,
      env: process.env,
      platform: process.platform,
      home: homedir()
    })
    // A failure is a `CliError` and goes out like every other one (review I1): `ok: false`, its code,
    // its nextSteps, and the `error:` sentence under `--human`. `host stop`'s refusal keeps its counts
    // in `error.details`.
    if (!done.ok) fail(done.error)
    out(renderOk(parsed.cmd, done.body, mode))
    process.exit(0)
  }

  // **skills 도 Host 없이 답한다** — 프로필의 accounts.json·app-settings.json 을 읽고 계정의 설정
  // 폴더에 스킬 파일을 심는다(cli/skills.ts). Host 에게 물을 것이 없으므로 host 명령보다도 앞선
  // 자리가 맞지만, `--request-id` 를 거절하려면 그것을 걷어 낸 뒤여야 한다. 거절하는 이유는 바로
  // 위 host 명령과 같다: 명령 층에 닿지 않아 영수증이 없고, `skills install` 은 일을 한다.
  if (parsed.cmd === 'skills-list' || parsed.cmd === 'skills-install') {
    if (presented)
      fail({
        code: 'INVALID_ARGUMENTS',
        message: `${spelledCommand(parsed.cmd)} does not go through the Host's command layer, so it cannot carry a request id`
      })
    const skillsDir = resolveSkillsDir({
      resourcesPath: process.resourcesPath,
      cliEntry: process.argv[1] ?? '',
      exists: existsSync
    })
    if (skillsDir === undefined)
      fail({ code: 'FAILED', message: 'cannot find the skill sources (resources/skills) beside this build' })
    const done = await skillsCommand({ cmd: parsed.cmd, args, profileDir, skillsDir, log: logToStderr })
    if (!done.ok) fail(done.error)
    const shaped = publicFor(parsed.cmd, done.body)
    // 요청한 설치가 안 된 것은 명령의 실패다(1). 무엇이 안 됐는지는 가린 답 그대로 details 에 실린다.
    const failed = installFailureOf(shaped)
    if (failed !== null) fail(failed)
    out(renderOk(parsed.cmd, shaped, mode))
    process.exit(0)
  }

  // `astera browser js --file check.js` — the script from a file instead of stdin
  if (parsed.cmd === 'browser-js' && typeof args.file === 'string') {
    try {
      args = { ...args, script: readFileSync(args.file, 'utf8') }
    } catch (e) {
      fail({ code: 'FAILED', message: `cannot read ${args.file}: ${String(e)}` })
    }
  }

  /** **`version` 은 Host 가 없어도 답한다**(명세 §11). CLI 는 자기 버전을 빌드에서 받아 알고 있고,
   *  저쪽 값은 붙으면 붙는 대로 싣는다 — Host 가 없다고 버전을 못 말할 이유가 없다. */
  const versionWithoutHost: () => never = () => {
    out(renderOk('version', { cli: CLI_VERSION, app: null, protocol: CLI_PROTOCOL }, mode))
    process.exit(0)
  }

  /** Host 에 닿지 못했다. **보기만 하는 명령은 파일이 답한다**(stateFile.ts) — Host 가 없다는 것은
   *  그 파일을 아무도 쓰고 있지 않다는 뜻이므로, 거기 적힌 것이 곧 지금이다. 나머지는 예전과 똑같이
   *  실패한다: 보고면 적어 두고, 아니면 3 으로 끝난다.
   *
   *  **"없다" 를 가르는 것은 부르는 쪽이다** — `connectFailureEnd` 가 돌려보낸 실패만 여기 온다.
   *  살아 있는 Host 는 여기 닿지 않는다. */
  const withoutHost = async (
    reason: string,
    /** The recovery line, on the one call of this that had already sent the command
     *  (`lostAnswerDetails`). Absent from the other one, where the connection never opened: nothing
     *  was sent, so there is no receipt for anyone to ask about. */
    lost?: Record<string, unknown>
  ): Promise<HostAnswer> => {
    if (parsed.cmd === 'version') versionWithoutHost()
    // **Nobody at this address is not yet nobody** (`otherProtocolHost`, conformance audit #12). A
    // Host of another protocol serving this profile is at another address, and it is writing the
    // file read below; "start one with astera host start" would start a second Host on the same
    // profile. A worker's complete report skips the check: it is written to the queue either way,
    // and the queue is the path that never loses one.
    if (queueableReportProblem({ cmd: parsed.cmd, args }) !== null) {
      const found = await otherProtocolHost({ profileDir, platform: process.platform, tmpDir: os.tmpdir() })
      if (found !== null) fail(siblingHostError({ found, cliProtocol: HOST_PROTOCOL }))
    }
    if (!fileAnswerable(parsed.cmd)) unreachable(reason, lost)
    const stateFile = path.join(profileDir, 'orchestration.json')
    const state = readStateFile(stateFile)
    // 못 읽은 파일을 빈 Job 목록으로 내면 사람은 자기 Job 이 사라졌다고 읽는다.
    if (!state) unreachable(reason, lost)
    verbose.say(`no Host answered, so ${spelledCommand(parsed.cmd)} is answered from the state file ${stateFile}`)
    return answerFromFile({ state, cmd: parsed.cmd, args, sessionId })
  }

  // **`answer` and `reply` are one value, deliberately written as one statement each.** `fail` reads
  // the mark off `answer`, and it can be called from inside the branches below — a replayed failure
  // is exactly that — so the assignment must not be something a later edit can move past them.
  // Defining `reply` *from* `answer` is what makes that impossible rather than merely unlikely.
  answer = await (async (): Promise<HostAnswer> => {
    const connectStarted = Date.now()
    const conn = await connectHost({ address, app: CLI_VERSION, log: logToStderr })
    verbose.say(
      'error' in conn
        ? `connecting to ${address} failed after ${Date.now() - connectStarted}ms: ${conn.error}`
        : helloLine(conn.hello, Date.now() - connectStarted)
    )
    if ('error' in conn) {
      // **셋 중 하나만 "아무도 없다" 다** (connectFailureEnd). 나머지 둘에서 파일을 읽으면 살아
      // 있는 주인의 파일을 0 으로 답하게 된다 — 바로 아래 `orch` 없는 Host 를 9 로 끝내는 가지와
      // 같은 판단이다.
      const end = connectFailureEnd({ error: conn.error, address })
      if (!end.fallback) {
        if (parsed.cmd === 'version') versionWithoutHost()
        fail({ code: end.code, message: end.message })
      }
      return withoutHost(
        `cannot reach the Host at ${address} (${conn.error}) — start one with \`astera host start\``
      )
    }
    // **말할 줄 아는지 먼저 본다.** 이 기능을 알리지 않은 Host 는 `orch-call` 을 모르는 메시지로
    // 흘려버리고 아무 답도 하지 않는다 — 물어보고 시한까지 기다리면 사람은 몇 분을 잃고 나서
    // 아무것도 알게 되지 않는다. 명령을 모르는 것과 같은 자리이므로 같은 코드(501 → 9)다.
    if (!conn.hello.features.includes(HOST_FEATURE_ORCH)) {
      conn.close()
      if (parsed.cmd === 'version') versionWithoutHost()
      const code = codeForStatus(501)
      fail({ code, message: `the Host at ${address} does not answer orchestration commands` })
    }
    // **A presented key against a Host that cannot keep receipts ends here, with nothing sent**
    // (`requestForHost`, §8). Below the check above because both are the same question asked of the
    // same handshake, and an older Host that answers no orchestration command at all has already been
    // refused by the more general one.
    //
    // **`version` still answers**, the third time this file makes that exemption and for the reason
    // it gives at the bottom: this command exists to say whether the two builds have diverged, and a
    // Host too old for receipts is precisely that fact. Nothing is lost by it either — `version`
    // reads, so it leaves no receipt against any Host, and the key it dropped was protecting nothing.
    const carried = requestForHost({ request, presented, features: conn.hello.features, address })
    if ('error' in carried) {
      conn.close()
      if (parsed.cmd === 'version') versionWithoutHost()
      fail(carried.error)
    }
    // **기다리는 명령만, 그리고 stderr 에만**(cliKeepalive.ts). 여기서 시작하고 답이 오면 끄는
    // 이유는 자리 하나다: 기다림은 이 한 줄이고, 그 밖의 모든 명령은 이 자리를 스쳐 지나간다.
    //
    // **끄는 것은 `finally` 다.** `callHost` 가 거절하지 않는 것은 저쪽 함수의 성질이지 이 줄의
    // 성질이 아니고, 결과가 나간 뒤에도 도는 타이머는 같은 셸에서 이어 치는 다음 명령의 출력에
    // 줄을 섞는다. 언제나 꺼진다는 것이 이 자리에서 보여야 한다.
    const keepalive = startKeepalive({
      conn,
      cmd: parsed.cmd,
      args,
      enabled: !parsed.noKeepalive
    })
    // **`runs follow` is a loop of calls on this one connection** (followRun). It prints as it goes, and
    // its ending comes back here as the body `runs wait` answers with, so the exit code below is the
    // same code. It carries no request id: it reads, and a receipt is kept only for a call that acted.
    if (parsed.cmd === 'runs-follow') {
      const followed = await followRun({
        id: args.id,
        mode,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_WAIT_TIMEOUT_MS,
        write: out,
        call: (callArgs, timeoutMs) =>
          timedCall(verbose, { conn, cmd: parsed.cmd, args: callArgs, sessionId, timeoutMs })
      }).finally(() => keepalive.stop())
      conn.close()
      if ('stuck' in followed) fail({ code: SILENT_HOST_CODE, message: followed.stuck })
      if ('unreachable' in followed) fail({ code: 'HOST_NOT_RUNNING', message: followed.unreachable })
      if ('refused' in followed) return followed.refused
      return { status: 200, body: followed.ended }
    }
    // Held rather than passed inline: the retry line below has to carry what this actually sent,
    // and `argsForCall` fills a missing `--cwd` that the typed line does not have (`implicitArgs`).
    const sentArgs = argsForCall({ cmd: parsed.cmd, args, cwd: process.cwd() })
    const r = await timedCall(verbose, {
      conn,
      cmd: parsed.cmd,
      args: sentArgs,
      sessionId,
      request: carried.send,
      timeoutMs: clientTimeoutMs({ cmd: parsed.cmd, args })
    }).finally(() => keepalive.stop())
    conn.close()
    // **시한을 넘긴 것은 닿지 못한 것이 아니다.** 위의 시한은 분 단위이고, 그것을 넘겼다는 것은
    // 연결은 됐는데 저쪽이 멈췄다는 뜻이다 — 보고는 이미 적용됐을 수 있으므로 적어 두지 않는다.
    // 연결이 선 뒤의 침묵도 hello 전의 침묵과 같은 코드로 끝난다(`SILENT_HOST_CODE`) —
    // 예전에는 이쪽만 1 이었고, 그것은 스크립트에게 같은 일을 두 번 분기하라는 말이었다.
    // **답이 아예 오지 않은 두 끝은 요청 id 와 칠 명령 둘을 싣고 나간다**(`lostAnswerDetails`,
    // 설계 §8). 이 둘이 이 기능이 있는 이유다 — Host 는 답하기 전에 커밋하므로, 여기서 아는 것은
    // "일어났을 수도 있다" 하나뿐이고, 그것을 스스로 알아낼 길이 부르는 쪽에는 없었다.
    const lost = lostAnswerDetails({
      argv,
      request: carried.send,
      implicit: implicitArgs(args, sentArgs),
      fromStdin: parsed.wantsStdin
    })
    if ('stuck' in r) {
      // **`ask` 는 이 자리에서 한 마디를 더 한다**(cliOutput 의 silentHostEnd). 답이 오지 않았다는
      // 것은 질문이 사라졌다는 뜻이 아니다 — 열린 채로 남아 있을 수 있고, 그것을 실패로 읽고 다시
      // 묻는 워커는 같은 사람에게 질문을 둘 만든다.
      const end = silentHostEnd({ cmd: parsed.cmd, args, reason: r.stuck, request: carried.send })
      fail({ code: SILENT_HOST_CODE, message: end.message, details: { ...end.details, ...lost } })
    }
    if ('unreachable' in r) return withoutHost(r.unreachable, lost)
    return r
  })()
  const reply = answer

  if (reply.status >= 200 && reply.status < 300) {
    // `version` 만 저쪽 답에 이쪽 값을 더한다. 둘은 한 프로그램이라 같은 값이어야 하고, 다르면
    // 그 자체가 사람이 봐야 할 사실이다 — 셔틀이 가리키는 바이너리가 갈렸다는 뜻이다. 칸 이름은
    // `app` 그대로다: 답하는 것은 이제 Host 이지만 그 둘은 한 빌드이고, 이름은 스크립트의 계약이다.
    const answered =
      parsed.cmd === 'version'
        ? {
            cli: CLI_VERSION,
            app: (reply.body as { version?: string | null } | null)?.version ?? null,
            protocol: (reply.body as { protocol?: number } | null)?.protocol ?? CLI_PROTOCOL
          }
        : // **`requests show` 만 친 명령이 아니라 실려 온 명령으로 가린다**(`shownReceipt`). 그것이
          // 싣고 오는 것은 다른 명령의 답이고, 여기서 `parsed.cmd` 로 가리면 `requests-show` 는
          // 표에 없으므로 아무것도 안 가린 채 나간다 — 영수증이 가림막을 도는 길이 된다.
          parsed.cmd === 'requests-show'
          ? shownReceipt(reply.body)
          : // 공개 읽기 명령은 허용된 칸만 내보낸다(설계 §11). 명령 층이 아니라 여기서 가리는 이유는
            // 봉투와 같다 — 화면도 같은 명령 층을 쓰고, 그쪽은 온전한 개체가 필요하다.
            publicFor(parsed.cmd, reply.body)
    // **시한이 지난 `ask` 는 다시 기다리는 법을 싣고 나간다**(cliOutput 의 askTimeoutBody). 200 이고
    // 0 으로 끝나는 것은 그대로다 — 시한을 넘긴 것은 실패가 아니라 정보이고, 열한 번째 종료 코드를
    // 만들 일도 아니다. 답이 온 `ask` 와 그 밖의 명령은 이 함수를 그대로 지나간다.
    const body = parsed.cmd === 'ask' ? askTimeoutBody({ body: answered, args }) : answered
    // **`wait` 만 성공을 다시 판정한다.** 저쪽은 200 으로 무엇으로 끝났는지만 말하고,
    // 그것을 종료 코드로 바꾸는 것은 이쪽의 일이다(cliOutput 의 waitEnd).
    if (parsed.cmd === 'jobs-wait' || parsed.cmd === 'runs-wait' || parsed.cmd === 'runs-follow') {
      const end = waitEnd(body)
      if (end !== null) {
        fail(end)
      }
    }
    // `sessions send --wait` (CLI spec §15): how the turn ended decides the exit code, as for a wait.
    if (parsed.cmd === 'sessions-send' && args.wait === true) {
      const end = sessionTurnEnd(body)
      if (end !== null) fail(end)
    }
    out(renderOk(parsed.cmd, body, mode, markOf(reply)))
    process.exit(0)
  }
  // **`version` 은 저쪽이 답하지 못해도 답한다.** 이 명령이 있는 이유가 "둘이 갈렸는가" 를
  // 말하는 것인데, 갈라서 저쪽이 이 명령을 모를 때 잠자코 있으면 쓸 데가 없다 — 이 명령을 모르는
  // Host 는 501 로 답한다. CLI 가 확실히 아는 것은 그대로 나가고, 무엇이 잘못됐는지는 다음 명령이
  // 제 코드로 분명하게 말한다.
  if (parsed.cmd === 'version') versionWithoutHost()
  const code = codeForStatus(reply.status)
  fail({
    code,
    message: messageFrom(reply.body, `the Host answered ${reply.status}`),
    // **A refusal that names a request carries that id into `details`** — the 409 for a request
    // already in flight does (host/orch.ts), and it is what lets this failure's `nextSteps` say
    // `requests show --id <it>` instead of the general `astera status`. `tasks add --validate`'s 404
    // carries its Job the same way, for `run-configs list --job <it>`. Read as a field rather than
    // out of the message, because a contract hung on a string is the thing `codeForStatus` refuses
    // to do one line above.
    details: refusalDetailsOf(reply.body)
  })
}
