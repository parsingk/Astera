// astera CLI logic.
// index.ts (the bundle entry point, out/main/cli.js) executes immediately at the top level and so
// cannot be tested — that is why the side-effect-free functions and main() were pulled in here.
// main() does not call itself inside this file, so importing this module (as the tests do) does not
// terminate the process.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { parseArgs } from '../core/orchestration/cliArgs'
import { publicFor } from '../core/orchestration/cliPublic'
import { humanFor, quietFor } from '../core/orchestration/cliHuman'
import { answerFromFile, fileAnswerable, readStateFile } from '../core/orchestration/stateFile'
import { connectHost, type ConnectFailure, type HostConnection } from '../core/host/connect'
import { HOST_FEATURE_ORCH } from '../core/host/protocol'
import { cliHostTarget, logToStderr, runHostCommand } from './host'
import {
  CLI_PROTOCOL,
  codeForStatus,
  dataFor,
  waitEnd,
  errEnvelope,
  exitCodeFor,
  messageFrom,
  okEnvelope,
  type CliErrorCode
} from '../core/orchestration/cliOutput'

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
 *  코드와 종료 코드의 표는 core/orchestration/cliOutput.ts 한 곳에만 있다(설계 §8). */
export function errorOutput(msg: string, code: CliErrorCode = 'FAILED'): string {
  return errEnvelope({ code, message: msg })
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
    code: 'TIMEOUT',
    message: `the Host at ${a.address} accepted the connection but did not say hello — it is running and not answering, so its state was not read from the file`
  }
}

/** 모드에 맞춘 성공 출력. **사람용이 없는 명령은 JSON 으로 되돌린다** — 코디네이터의
 *  명령들에 억지로 표를 씨우면 가이드가 시키는 것을 못 읽게 된다. */
export function renderOk(cmd: string, body: unknown, mode: OutputMode): string {
  if (mode === 'json') return okEnvelope(cmd, body)
  const data = dataFor(cmd, body)
  if (mode === 'quiet') return quietFor(data)
  return humanFor(cmd, data) ?? okEnvelope(cmd, body)
}

/** 모드에 맞춘 오류 출력. 사람에게는 봉투가 아니라 문장이다 — 코드는 종료 코드로 이미 간다. */
export function renderErr(msg: string, code: CliErrorCode, mode: OutputMode): string {
  return mode === 'json' ? errorOutput(msg, code) : `error: ${msg}`
}

export function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : text + '\n'
}

/** Fills the wantsStdin keys parseArgs collected (the flags whose value was '-') with the stdin
 *  text. The original args are not mutated (the same state-spread convention as server.ts). */
export function applyStdin(a: {
  args: Record<string, unknown>
  keys: string[]
  text: string
}): Record<string, unknown> {
  const next = { ...a.args }
  for (const key of a.keys) next[key] = a.text
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
          a.cmd === 'jobs-wait' || a.cmd === 'runs-wait'
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
  const hasExplicitCwd = typeof a.args.cwd === 'string' && a.args.cwd.length > 0
  return a.cmd === 'run-create' && !hasExplicitCwd ? { ...a.args, cwd: a.cwd } : a.args
}

/** 한 명령을 Host 에 묻고 그 답을 기다린다 (host control plane design §5).
 *
 *  **닿지 못한 것과 답을 못 받은 것을 가른다.** 연결이 답 전에 끊기면 그 Host 는 사라진 것이므로
 *  `unreachable` 과 같은 사실이고(보고는 파일에 적힌다), 시한을 넘긴 것은 연결은 됐는데 저쪽이
 *  멈춘 것이라 그냥 실패다 — HTTP 시절의 갈래(`ctl.signal.aborted`)를 그대로 옮긴 것이다. */
export function callHost(a: {
  conn: HostConnection
  cmd: string
  args: Record<string, unknown>
  sessionId: string
  timeoutMs: number
}): Promise<{ status: number; body: unknown } | { unreachable: string } | { stuck: string }> {
  return new Promise((resolve) => {
    // 이 프로세스는 명령 하나를 묻고 끝난다 — 한 번에 하나뿐이라 상관 id 는 하나면 된다.
    const call = 'cli_1'
    let settled = false
    let offMessage: () => void = () => {}
    let offClose: () => void = () => {}
    const done = (r: { status: number; body: unknown } | { unreachable: string } | { stuck: string }): void => {
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
      if (m.t === 'orch-result' && m.call === call) done({ status: m.status, body: m.body })
    })
    offClose = a.conn.onClose(() =>
      done({ unreachable: `the Host closed the connection before answering ${a.cmd}` })
    )
    a.conn.call({ t: 'orch-call', call, cmd: a.cmd, args: a.args, session: a.sessionId })
  })
}

/** Absolute location of the guide document. Now that the CLI moved into a bundle artifact
 *  (out/main/cli.js), a relative path to resources/skills can no longer be fixed — __dirname points
 *  somewhere different in a packaged app than in dev mode. So it is not hardcoded but taken from the
 *  ASTERA_SKILLS environment variable the wiring injects (or the --skills-dir argument that
 *  overrides it). */
export function resolveGuidePath(a: {
  args: Record<string, unknown>
  env: NodeJS.ProcessEnv
  /** Which guide. `astera help` is the orchestration guide; `astera browser help` the browser's. */
  guide?: 'orchestration' | 'browser'
}): { ok: true; path: string } | { ok: false; error: string } {
  const dir =
    typeof a.args.skillsDir === 'string' && a.args.skillsDir.length > 0
      ? a.args.skillsDir
      : a.env.ASTERA_SKILLS
  if (!dir)
    return {
      ok: false,
      error:
        'ASTERA_SKILLS is not set (and no --skills-dir given) — is this session started by the app?'
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
  const parsed = parseArgs(process.argv.slice(2))
  if ('error' in parsed) {
    out(errorOutput(parsed.error, 'INVALID_ARGUMENTS'))
    process.exit(exitCodeFor('INVALID_ARGUMENTS'))
  }

  const mode = outputMode({ json: parsed.json, human: parsed.human, quiet: parsed.quiet })
  if (typeof mode !== 'string') {
    out(errorOutput(mode.error, 'INVALID_ARGUMENTS'))
    process.exit(exitCodeFor('INVALID_ARGUMENTS'))
  }

  // help has to work without a server connection — handle it before reading ASTERA_INFO.
  if (parsed.cmd === 'help') {
    const resolved = resolveGuidePath({ args: parsed.args, env: process.env })
    if (!resolved.ok) {
      out(errorOutput(resolved.error))
      process.exit(1)
    }
    const guide = readGuide(resolved.path)
    if (!guide.ok) {
      out(errorOutput(guide.error))
      process.exit(1)
    }
    out(guide.content)
    process.exit(0)
  }

  // The browser guide works without a server too — same shape as help above.
  if (parsed.cmd === 'browser-help') {
    const resolved = resolveGuidePath({ args: parsed.args, env: process.env, guide: 'browser' })
    if (!resolved.ok) {
      out(errorOutput(resolved.error))
      process.exit(1)
    }
    const guide = readGuide(resolved.path)
    if (!guide.ok) {
      out(errorOutput(guide.error))
      process.exit(1)
    }
    out(guide.content)
    process.exit(0)
  }

  // **세션 밖에서도 Host 를 찾는다**(설계 §4). 세션 안이면 `ASTERA_HOST` 가 있고 그것이 언제나
  // 이긴다 — 그 세션은 자기를 띄운 Host 와 말해야 한다. 없으면 프로필에서 계산한다.
  const { address, profileDir } = cliHostTarget({
    platform: process.platform,
    env: process.env,
    home: homedir()
  })
  const sessionId = process.env.ASTERA_SESSION ?? ''

  // **stdin is read before connecting, not after.** A report's body arrives on stdin, and the
  // report has to be complete before either unreachable path below can write it down — a worker that
  // finishes while the Host is gone fails at the connect, not at the reply. For every other command
  // this only changes the order of two steps that both end the same way.
  let args = parsed.args
  if (parsed.wantsStdin.length > 0) {
    const text = await readStdin()
    args = applyStdin({ args, keys: parsed.wantsStdin, text })
  }

  /** The Host could not be reached at all, and the command is not one the state file can answer.
   *  A report is written down and the agent is told so; everything else fails exactly as it did.
   *
   *  **Exit 0 once it is recorded.** Not because it succeeded — the notice says plainly that it did
   *  not — but because there is nothing here for the agent to do about it, and a non-zero exit is
   *  what left workers deciding for themselves whether to retry, give up, or read their own finished
   *  work as failed. When the write itself fails there is something wrong, and both halves of it are
   *  said in one error. */
  const unreachable: (reason: string) => never = (reason) => {
    const problem = queueableReportProblem({ cmd: parsed.cmd, args })
    if (problem !== null) {
      // A report one flag short of being recordable is told which flag, not that the app is away:
      // the second is true and useless, and the agent could fix the first itself.
      //
      // **닿지 못한 것은 HOST_NOT_RUNNING(3) 이다.** 스크립트가 "앱이 없다" 와 "명령이 실패했다" 를
      // 가를 수 있어야 한다(설계 §8) — 인자가 모자란 보고만 그 갈래가 아니라 잘못된 인자다.
      const code = problem === 'not a report' ? 'HOST_NOT_RUNNING' : 'INVALID_ARGUMENTS'
      out(errorOutput(problem === 'not a report' ? reason : `${problem} (the Host is not running)`, code))
      process.exit(exitCodeFor(code))
    }
    const written = writePendingReport({
      profileDir,
      sessionId,
      cmd: parsed.cmd,
      args,
      queuedAt: new Date().toISOString(),
      nonce: randomBytes(4).toString('hex')
    })
    if (!written.ok) {
      out(
        errorOutput(
          `${reason} — and the report could not be recorded either: ${written.error}`,
          'HOST_NOT_RUNNING'
        )
      )
      process.exit(exitCodeFor('HOST_NOT_RUNNING'))
    }
    // 다른 모든 응답과 같은 봉투로 나간다 — 이것만 예외면 `jq .ok` 가 이 한 경우에만 null 이 된다.
    out(renderOk(parsed.cmd, undeliveredReportNotice({ path: written.path }), mode))
    process.exit(0)
  }

  // **host 명령은 앱의 접속 정보를 안 읽는다.** 그 정보가 없는 것이 이 명령이 답해야 할 사실이고,
  // 읽으려다 실패하면 물어본 것에 답하지 못한 채 끝난다.
  if (parsed.cmd.startsWith('host-')) {
    const { body, code } = await runHostCommand({
      cmd: parsed.cmd,
      env: process.env,
      platform: process.platform,
      home: homedir()
    })
    out(renderOk(parsed.cmd, body, mode))
    process.exit(code)
  }

  // `astera browser js --file check.js` — the script from a file instead of stdin
  if (parsed.cmd === 'browser-js' && typeof args.file === 'string') {
    try {
      args = { ...args, script: readFileSync(args.file, 'utf8') }
    } catch (e) {
      out(errorOutput(`cannot read ${args.file}: ${String(e)}`))
      process.exit(1)
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
  const withoutHost = async (reason: string): Promise<{ status: number; body: unknown }> => {
    if (parsed.cmd === 'version') versionWithoutHost()
    if (!fileAnswerable(parsed.cmd)) unreachable(reason)
    const state = readStateFile(path.join(profileDir, 'orchestration.json'))
    // 못 읽은 파일을 빈 Job 목록으로 내면 사람은 자기 Job 이 사라졌다고 읽는다.
    if (!state) unreachable(reason)
    return answerFromFile({ state, cmd: parsed.cmd, args, sessionId })
  }

  const reply = await (async (): Promise<{ status: number; body: unknown }> => {
    const conn = await connectHost({ address, app: CLI_VERSION, log: logToStderr })
    if ('error' in conn) {
      // **셋 중 하나만 "아무도 없다" 다** (connectFailureEnd). 나머지 둘에서 파일을 읽으면 살아
      // 있는 주인의 파일을 0 으로 답하게 된다 — 바로 아래 `orch` 없는 Host 를 9 로 끝내는 가지와
      // 같은 판단이다.
      const end = connectFailureEnd({ error: conn.error, address })
      if (!end.fallback) {
        if (parsed.cmd === 'version') versionWithoutHost()
        out(renderErr(end.message, end.code, mode))
        process.exit(exitCodeFor(end.code))
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
      out(renderErr(`the Host at ${address} does not answer orchestration commands`, code, mode))
      process.exit(exitCodeFor(code))
    }
    const r = await callHost({
      conn,
      cmd: parsed.cmd,
      args: argsForCall({ cmd: parsed.cmd, args, cwd: process.cwd() }),
      sessionId,
      timeoutMs: clientTimeoutMs({ cmd: parsed.cmd, args })
    })
    conn.close()
    // **시한을 넘긴 것은 닿지 못한 것이 아니다.** 위의 시한은 분 단위이고, 그것을 넘겼다는 것은
    // 연결은 됐는데 저쪽이 멈췄다는 뜻이다 — 보고는 이미 적용됐을 수 있으므로 적어 두지 않는다.
    if ('stuck' in r) {
      out(errorOutput(r.stuck))
      process.exit(1)
    }
    if ('unreachable' in r) return withoutHost(r.unreachable)
    return r
  })()

  if (reply.status >= 200 && reply.status < 300) {
    // `version` 만 저쪽 답에 이쪽 값을 더한다. 둘은 한 프로그램이라 같은 값이어야 하고, 다르면
    // 그 자체가 사람이 봐야 할 사실이다 — 셔틀이 가리키는 바이너리가 갈렸다는 뜻이다. 칸 이름은
    // `app` 그대로다: 답하는 것은 이제 Host 이지만 그 둘은 한 빌드이고, 이름은 스크립트의 계약이다.
    const body =
      parsed.cmd === 'version'
        ? {
            cli: CLI_VERSION,
            app: (reply.body as { version?: string | null } | null)?.version ?? null,
            protocol: (reply.body as { protocol?: number } | null)?.protocol ?? CLI_PROTOCOL
          }
        : // 공개 읽기 명령은 허용된 칸만 내보낸다(설계 §11). 명령 층이 아니라 여기서 가리는 이유는
          // 봉투와 같다 — 화면도 같은 명령 층을 쓰고, 그쪽은 온전한 개체가 필요하다.
          publicFor(parsed.cmd, reply.body)
    // **`wait` 만 성공을 다시 판정한다.** 저쪽은 200 으로 무엇으로 끝났는지만 말하고,
    // 그것을 종료 코드로 바꾸는 것은 이쪽의 일이다(cliOutput 의 waitEnd).
    if (parsed.cmd === 'jobs-wait' || parsed.cmd === 'runs-wait') {
      const end = waitEnd(body)
      if (end !== null) {
        out(mode === 'json' ? errEnvelope(end) : `error: ${end.message}`)
        process.exit(exitCodeFor(end.code))
      }
    }
    out(renderOk(parsed.cmd, body, mode))
    process.exit(0)
  }
  // **`version` 은 저쪽이 답하지 못해도 답한다.** 이 명령이 있는 이유가 "둘이 갈렸는가" 를
  // 말하는 것인데, 갈라서 저쪽이 이 명령을 모를 때 잠자코 있으면 쓸 데가 없다 — 이 명령을 모르는
  // Host 는 501 로 답한다. CLI 가 확실히 아는 것은 그대로 나가고, 무엇이 잘못됐는지는 다음 명령이
  // 제 코드로 분명하게 말한다.
  if (parsed.cmd === 'version') versionWithoutHost()
  const code = codeForStatus(reply.status)
  out(renderErr(messageFrom(reply.body, `the Host answered ${reply.status}`), code, mode))
  process.exit(exitCodeFor(code))
}
