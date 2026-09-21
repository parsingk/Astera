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
import { infoPathFor } from '../core/orchestration/cliDiscovery'
import {
  CLI_PROTOCOL,
  codeForStatus,
  errEnvelope,
  exitCodeFor,
  messageFrom,
  okEnvelope,
  type CliErrorCode
} from '../core/orchestration/cliOutput'

/** 빌드가 박아 넣은 이 프로그램의 버전(electron.vite.config.ts). 앱과 CLI 는 한 프로그램이므로
 *  값이 하나이고, 그래서 둘이 갈라질 수가 없다. */
const CLI_VERSION = typeof __ASTERA_VERSION__ === 'string' ? __ASTERA_VERSION__ : '0.0.0'
import { DEFAULT_ASK_TIMEOUT_MS, DEFAULT_CHECK_TIMEOUT_MS } from '../core/orchestration/types'
import { SCRIPT_TIMEOUT_MS } from '../core/agentBrowser/script'
import {
  queueableReportProblem,
  pendingReportFileName,
  pendingReportTempName,
  pendingReportsDirFrom,
  serializePendingReport,
  undeliveredReportNotice
} from '../core/orchestration/pendingReports'

/** 오류 하나를 봉투에 담아 그 종료 코드와 함께 돌려준다 — 부르는 쪽이 둘을 따로 고르지 않도록.
 *  코드와 종료 코드의 표는 core/orchestration/cliOutput.ts 한 곳에만 있다(설계 §8). */
export function errorOutput(msg: string, code: CliErrorCode = 'FAILED'): string {
  return errEnvelope({ code, message: msg })
}

/** 앱의 응답 상태에서 종료 코드로. 2xx 는 0 이다 — ask --wait 의 타임아웃 응답도 200 이고, 이
 *  설계의 계약은 "타임아웃은 오류가 아니라 정보" 다(오케스트레이션 가이드 4.7절). */
export function exitCodeForStatus(status: number): number {
  return status >= 200 && status < 300 ? 0 : exitCodeFor(codeForStatus(status))
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

/** Headroom stacked on top of the server's long-poll deadline so the client never hangs up before
 *  the server does. It absorbs the polling interval (POLL_MS) and event-loop delay the server takes
 *  to send its response once the deadline is reached — with headroom narrower than the server's
 *  deadline, the client's AbortController cuts the connection while the server is still preparing
 *  its response, and the contract that a timeout is information rather than an error breaks (this
 *  was the defect where ask's default was shorter than the server's default). */
const TIMEOUT_HEADROOM_MS = 30_000

/** ask and check --wait are long-polled by the server, so the per-command default deadline has to
 *  come from the same constants the server uses (core/orchestration/types.ts) — split into two
 *  copies, the values drift apart. Other commands do not long-poll, so their default is effectively
 *  unused and they reuse check's value (there is no reason to add another constant). If
 *  --timeout-ms was given, that value is used as is. */
export function clientTimeoutMs(a: { cmd: string; args: Record<string, unknown> }): number {
  const defaultForCmd =
    a.cmd === 'ask' ? DEFAULT_ASK_TIMEOUT_MS : a.cmd === 'browser-js' ? SCRIPT_TIMEOUT_MS : DEFAULT_CHECK_TIMEOUT_MS
  const base = typeof a.args.timeoutMs === 'number' ? a.args.timeoutMs : defaultForCmd
  return base + TIMEOUT_HEADROOM_MS
}

export function buildRequest(a: {
  port: number
  token: string
  sessionId: string
  cmd: string
  args: Record<string, unknown>
  /** The CLI process's own process.cwd(). Used only to fill run-create's --cwd default (see below) */
  cwd: string
}): { url: string; init: { method: string; headers: Record<string, string>; body: string } } {
  // run-create in server.ts fills a missing --cwd with process.cwd(), but that is evaluated in the
  // Electron main process and has nothing to do with the CLI process's working directory — omit it
  // and the Run's cwd becomes the app's own working directory (arbitrary in a packaged app), and
  // every worker of that Run (--worktree current being the default) comes up in the wrong place.
  // Only when --cwd was not given explicitly is it filled here with the CLI's own cwd (a.cwd) — an
  // explicit value always wins.
  const hasExplicitCwd = typeof a.args.cwd === 'string' && a.args.cwd.length > 0
  const args = a.cmd === 'run-create' && !hasExplicitCwd ? { ...a.args, cwd: a.cwd } : a.args
  return {
    url: `http://127.0.0.1:${a.port}/`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${a.token}`,
        'x-astera-session': a.sessionId
      },
      body: JSON.stringify({ cmd: a.cmd, args })
    }
  }
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

export function readInfo(
  infoPath: string
): { ok: true; info: { port: number; token: string } } | { ok: false; error: string } {
  try {
    const info = JSON.parse(readFileSync(infoPath, 'utf8')) as { port: number; token: string }
    return { ok: true, info }
  } catch {
    return {
      ok: false,
      error: `cannot read ${infoPath} — is the app running with orchestration enabled?`
    }
  }
}

/** Writes one undelivered report into the queue beside the info file.
 *
 *  **Synchronous, and it answers instead of throwing.** This is the last line of defence: the server
 *  could not be reached, so if this write is lost the finished work is lost with it. An error comes
 *  back as a value so `main` can tell the agent both things that went wrong in one line — the report
 *  did not reach the app *and* it could not be written down — rather than the process dying with a
 *  stack trace in the middle of a worker's command.
 *
 *  The folder is created here because nothing else makes it: the app writes `orch-info.json` into
 *  its parent, and this subfolder exists only once there has been something to queue.
 *
 *  **Written under a temporary name and renamed into place**, the same shape as
 *  `OrchestrationStore`'s writes. A worker reporting at the moment the app comes back is exactly
 *  the case this whole path exists for, and that is also the moment the app lists this folder — so
 *  a report written in place could be read half-finished. A same-directory rename onto a name
 *  nothing else uses (the nonce makes it unique) is a metadata operation on both platforms: the
 *  reader sees either no such file or the whole of it. */
export function writePendingReport(a: {
  infoPath: string
  sessionId: string
  cmd: string
  args: Record<string, unknown>
  queuedAt: string
  nonce: string
}): { ok: true; path: string } | { ok: false; error: string } {
  const dir = pendingReportsDirFrom(a.infoPath)
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

  // **세션 밖에서도 앱을 찾는다**(설계 §4). 세션 안이면 `ASTERA_INFO` 가 있고 그것이 언제나
  // 이긴다 — 그 세션은 자기를 띄운 앱과 말해야 한다. 없으면 설치본의 것을 본다.
  const infoPath = infoPathFor({
    platform: process.platform,
    env: process.env,
    home: homedir()
  })
  const sessionId = process.env.ASTERA_SESSION ?? ''

  // **`version` 은 앱이 없어도 답한다**(명세 §11). CLI 는 자기 버전을 빌드에서 받아 알고 있고,
  // 앱 쪽 값은 붙으면 붙는 대로 싣는다 — 앱이 없다고 버전을 못 말할 이유가 없다.
  if (parsed.cmd === 'version') {
    const info = readInfo(infoPath)
    if (!info.ok) {
      out(okEnvelope('version', { cli: CLI_VERSION, app: null, protocol: CLI_PROTOCOL }))
      process.exit(0)
    }
  }
  // **stdin is read before the info file, not after.** A report's body arrives on stdin, and the
  // report has to be complete before either unreachable path below can write it down — the app
  // deletes orch-info.json as it quits, so a worker that finishes while the app is closed fails at
  // `readInfo`, not at `fetch`. For every other command this only changes the order of two steps
  // that both end the same way.
  let args = parsed.args
  if (parsed.wantsStdin.length > 0) {
    const text = await readStdin()
    args = applyStdin({ args, keys: parsed.wantsStdin, text })
  }

  /** The server could not be reached at all. A report is written down and the agent is told so;
   *  everything else fails exactly as it did, because nothing else can be answered by a file.
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
      out(errorOutput(problem === 'not a report' ? reason : `${problem} (the app is not running)`, code))
      process.exit(exitCodeFor(code))
    }
    const written = writePendingReport({
      infoPath,
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
    out(undeliveredReportNotice({ path: written.path }))
    process.exit(0)
  }

  const info = readInfo(infoPath)
  if (!info.ok) unreachable(info.error)

  // `astera browser js --file check.js` — the script from a file instead of stdin
  if (parsed.cmd === 'browser-js' && typeof args.file === 'string') {
    try {
      args = { ...args, script: readFileSync(args.file, 'utf8') }
    } catch (e) {
      out(errorOutput(`cannot read ${args.file}: ${String(e)}`))
      process.exit(1)
    }
  }

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), clientTimeoutMs({ cmd: parsed.cmd, args }))
  try {
    const { url, init } = buildRequest({
      port: info.info.port,
      token: info.info.token,
      sessionId,
      cmd: parsed.cmd,
      args,
      cwd: process.cwd()
    })
    const res = await fetch(url, { ...init, signal: ctl.signal })
    const text = await res.text()
    // 앱이 JSON 이 아닌 것을 돌려주는 경로는 없지만, 읽을 수 없는 답을 그대로 흘리면 계약이
    // 깨진 채 스크립트에 닿는다 — 읽을 수 없다는 사실 자체를 봉투에 담는다.
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(text)
    } catch {
      out(errorOutput(`the app answered something that is not JSON: ${text.slice(0, 200)}`))
      process.exit(exitCodeFor('FAILED'))
    }
    if (res.status >= 200 && res.status < 300) {
      // `version` 만 앱의 답에 이쪽 값을 더한다. 둘은 한 프로그램이라 같은 값이어야 하고, 다르면
      // 그 자체가 사람이 봐야 할 사실이다 — 셔틀이 가리키는 바이너리가 갈렸다는 뜻이다.
      const body =
        parsed.cmd === 'version'
          ? {
              cli: CLI_VERSION,
              app: (parsedBody as { version?: string | null } | null)?.version ?? null,
              protocol: (parsedBody as { protocol?: number } | null)?.protocol ?? CLI_PROTOCOL
            }
          : parsedBody
      out(okEnvelope(parsed.cmd, body))
      process.exit(0)
    }
    // **`version` 은 앱이 답하지 못해도 답한다.** 이 명령이 있는 이유가 "둘이 갈렸는가" 를
    // 말하는 것인데, 갈라서 앱이 이 명령을 모를 때 침못하면 쓸 데가 없다 — 이미 나간 앱은 404,
    // 이후의 앱은 501 로 답한다. 토큰이 상해 403 이 와도 마찬가지다: 앱 쪽 칸만 비고 CLI 가 확실히
    // 아는 것은 그대로 나간다. 무엇이 잘못됐는지는 다음 명령이 제 코드로 분명하게 말한다.
    if (parsed.cmd === 'version') {
      out(okEnvelope('version', { cli: CLI_VERSION, app: null, protocol: CLI_PROTOCOL }))
      process.exit(0)
    }
    const code = codeForStatus(res.status)
    out(errorOutput(messageFrom(parsedBody, `the app answered ${res.status}`), code))
    process.exit(exitCodeFor(code))
  } catch (e) {
    // **A timeout is not an unreachable server.** The deadline above is minutes long; reaching it
    // means the connection was made and something on the other side is stuck, so the report may
    // already have been applied. That keeps failing exactly as it did — only a request that never
    // reached anything is written down.
    if (ctl.signal.aborted) {
      out(errorOutput(`request failed: ${String(e)}`))
      process.exit(1)
    }
    unreachable(`request failed: ${String(e)}`)
  } finally {
    clearTimeout(timer)
  }
}
