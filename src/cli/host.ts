// astera's `host-*` commands: they ask about the Host itself rather than about orchestration.
//
// **This file must not import from `./run` — `run.ts` imports this file, and the reverse would be a
// cycle.** So `runHostCommand` below returns a value instead of printing one; `run.ts` renders it
// with `renderOk` and calls `process.exit` itself.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { HOST_PROTOCOL } from '../core/host/protocol'
import { connectHost, type HostConnection } from '../core/host/connect'
import { hostSpawnPlan, resolveHostEntry, type HostCliPaths } from '../core/host/spawn'
import { hostRuntimeBase, hostRuntimePaths } from '../core/host/runtime'
import { HOST_STOP_WAIT_MS } from '../core/host/unresponsive'
import { hostAddress, siblingHostAddresses } from '../host/address'
import { answers } from '../host/server'
import { resolveSkillsDir } from './skills'
import { nativePath, userDataDir } from '../core/orchestration/cliDiscovery'
import type { CliError } from '../core/orchestration/cliOutput'

/** What `astera host status` reports. **Answers without a Host**: the content says what is there and
 *  the exit code says whether the Host is running, which is the pair a script needs (spec §8). */
export function hostStatus(a: {
  conn: Pick<HostConnection, 'hello'> | null
  profileDir: string
  /** How many Jobs this profile's file holds, running or not. **Reported as `jobsInProfile`, and the
   *  name matters** (ruling F57/e): `host stop` refuses over a different number — the Runs with work
   *  in flight — and both were called `jobs`, so a script could read one and act on the other. */
  jobsInProfile: number
}): Record<string, unknown> {
  if (!a.conn)
    return { running: false, protocol: HOST_PROTOCOL, features: [], profile: a.profileDir, jobsInProfile: a.jobsInProfile }
  return {
    running: true,
    pid: a.conn.hello.pid,
    version: a.conn.hello.host,
    protocol: HOST_PROTOCOL,
    features: a.conn.hello.features,
    profile: a.profileDir,
    jobsInProfile: a.jobsInProfile
  }
}

/**
 * What a `host-*` command ends with. **A failure is a `CliError`, never a success-shaped body with a
 * non-zero exit** (review I1). run.ts sends it through `fail()`, so it gets the documented envelope
 * (`ok: false`, `error.code`, `error.nextSteps`) and, under `--human`, the `error:` sentence. What the
 * old bodies carried beside their message (the refusal's counts, the log path, the profile looked in)
 * is in `error.details`.
 */
export type HostCommandResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: CliError }

/**
 * The ending for a CLI that found nobody at its own address and a Host of **another** protocol
 * serving this profile (`otherProtocolHost`, conformance audit #12).
 *
 * **9, and the state file is not read.** The address carries the protocol, so the two builds miss
 * each other: the Host is running and writing that file, which is the one condition under which the
 * file cannot answer (stateFile.ts). It is the same fact `connectFailureEnd` answers 9 for when the
 * mismatch is seen in the handshake instead of in the address.
 *
 * `details` carries both protocols and the address, so `nextSteps` can tell this 9 from the one a
 * Host that does not know a command gives (cliOutput.ts). Here rather than in run.ts because the
 * `host-*` commands below end with it too, and this file cannot import run.ts.
 */
export function siblingHostError(a: { found: { protocol: number; address: string }; cliProtocol: number }): CliError {
  return {
    code: 'VERSION_MISMATCH',
    message:
      `a Host speaking protocol ${a.found.protocol} serves this profile at ${a.found.address}, and this astera speaks protocol ${a.cliProtocol}: ` +
      'they come from different builds of Astera. That Host is running, so its state was not read from the file. ' +
      'Quit Astera, stop that Host with the build that started it, then start the build you mean to use.',
    details: { hostProtocol: a.found.protocol, hostAddress: a.found.address, cliProtocol: a.cliProtocol }
  }
}

/** What `astera host stop` reports for each of the four ways it can end (host control plane design
 *  §12). Kept pure and separate from the connecting and waiting below, the same way `hostStatus` is,
 *  so the four shapes can be checked without a socket.
 *
 *  **`'absent'` exits 0, not `HOST_NOT_RUNNING`.** Stopping something that is not there is not a
 *  failure — the person asked for no Host to be running, and none is. **`'refused'` is `CONFLICT`**,
 *  because a Host that is running and holding work is the one state this command cannot leave the way
 *  it was asked to. **`'timeout'` is `TIMEOUT`, not `stopped: true` and not a guess at either.** A
 *  Host whose event loop is wedged inside a synchronous call (measured 2026-09-22,
 *  docs/2026-09-22-host-unresponsive-recovery-design.md) never answers `retire` and never closes its
 *  socket either — silence here is a third outcome, not evidence for one of the other two, and the
 *  body says so plainly because what a person does next differs from "it left". */
export function hostStopResult(
  a:
    | { outcome: 'absent' }
    | { outcome: 'stopped' }
    | { outcome: 'refused'; sessions: number; runs: number }
    | { outcome: 'timeout'; waitedMs: number }
): HostCommandResult {
  if (a.outcome === 'absent') return { ok: true, body: { stopped: true, message: 'no Host was running' } }
  if (a.outcome === 'stopped') return { ok: true, body: { stopped: true } }
  if (a.outcome === 'timeout')
    return {
      ok: false,
      error: {
        code: 'TIMEOUT',
        message: `retire was sent, but the Host did not answer within ${a.waitedMs}ms — it may still be running (and possibly stuck)`,
        details: { waitedMs: a.waitedMs }
      }
    }
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  return {
    ok: false,
    error: {
      code: 'CONFLICT',
      // **`run`, because Runs are what is counted** (ruling F57/e). It said "Job" while counting
      // Runs, so one Job with two concurrent Runs read as two Jobs.
      message: `Cannot stop Host: ${plural(a.sessions, 'session')} and ${plural(a.runs, 'run')} are still running.`,
      // The counts a script acts on. They used to ride a success-shaped body (`ok: true` with exit 6);
      // they are the same numbers in the envelope every other refusal uses (review I1).
      details: { sessions: a.sessions, runs: a.runs }
    }
  }
}

/** This file's own copy of the build-time version. `run.ts` has one too (`CLI_VERSION`) but this file
 *  cannot import it (see the note at the top), so it reads the same injected global directly rather
 *  than going without an identity to hand the Host in `hello.app`. */
const CLI_VERSION = typeof __ASTERA_VERSION__ === 'string' ? __ASTERA_VERSION__ : '0.0.0'

/** The Job count for `host status` when nothing else has already read `orchestration.json`.
 *  **A bare `JSON.parse`, deliberately** — Task 8 (this SDD series) adds a shared loader that applies
 *  the same schema migration the app applies before trusting a count from this file; until then a
 *  count from an old shape may be slightly wrong, which is acceptable for this one command. Missing
 *  or unreadable file, or a shape with no `jobs` array, both read as 0 rather than failing the whole
 *  command over a count nobody asked for as the main answer. */
function jobCountFrom(profileDir: string): number {
  try {
    const parsed = JSON.parse(readFileSync(path.join(profileDir, 'orchestration.json'), 'utf8')) as {
      jobs?: unknown[]
    }
    return Array.isArray(parsed.jobs) ? parsed.jobs.length : 0
  } catch {
    return 0
  }
}

/** `connectHost`'s signal for a broken line or a handler that threw. stdout is the one structured
 *  envelope a command prints (`run.ts` renders it), so this goes to stderr instead — the same
 *  channel `host/index.ts` uses for its own startup errors, and one a person running this directly
 *  still sees without it landing inside anything a script parses. Exported because every other
 *  command connects to the same Host and owes its stdout to the same envelope. */
export const logToStderr = (m: string): void => {
  process.stderr.write(`astera: ${m}\n`)
}

/** Where a Host could be started from, most specific first.
 *
 *  **The prepared runtime comes first for a reason that is not speed.** The app spawns from it when
 *  it exists, and a CLI that spawned from somewhere else would put a second Host at the same address
 *  — one of them wins the pipe and the other exits, which is survivable but makes "which binary is
 *  my Host" unanswerable. Same candidate order, same Host. */
export function hostStartTargets(a: {
  cliEntry: string
  execPath: string
  profileDir: string
  version: string
  runtimeEntry?: string
  /** `resolveSkillsDir`'s answer. Undefined when this build's skills cannot be found, and then no CLI
   *  paths are passed at all: the Host started without them does not spawn rather than guess (§2.2). */
  skillsDir?: string
}): { execPath: string; candidates: string[]; logPath: string; cli?: HostCliPaths } {
  const beside = a.cliEntry.replace(/[^/\\]+$/, 'host.js')
  return {
    execPath: a.execPath,
    candidates: a.runtimeEntry ? [a.runtimeEntry, beside] : [beside],
    logPath: `${a.profileDir.replace(/[\\/]+$/, '')}/host/host.log`,
    // This CLI's own binary and bundle are what a worker's `astera` shuttle runs: the same pair the
    // app passes, so a Host started from either end spawns the same workers.
    ...(a.skillsDir ? { cli: { exec: a.execPath, entry: a.cliEntry, skills: a.skillsDir } } : {})
  }
}

/** Where this build's prepared Host runtime would be, if one was shipped and this machine already
 *  has it — undefined otherwise, which falls `hostStartTargets` through to the `host.js` beside
 *  `cli.js`.
 *
 *  **Only ever looks.** Laying a runtime down is `prepareHostRuntime`'s job
 *  (`src/main/host/runtime.ts`) — 87MB of copying that the app alone owns; the CLI outlives the app
 *  by design, but it never lays anything down itself.
 *
 *  **`resourcesPath` and `readFile` are parameters, not globals** — the same choice `resolveHostEntry`
 *  makes with `exists` and `prepareHostRuntime` makes with the whole `RuntimeFs`. The one branch that
 *  matters for a released build — a prepared runtime actually being there — can otherwise only be
 *  exercised by a packaged install; injecting the read is what lets a test put a fake `runtime.json`
 *  in front of it instead. In development `runtime.json` does not exist (nothing is shipped outside a
 *  packaged build), and an unset `resourcesPath` (not a real Electron process at all) reads the same
 *  way — both fall through to "no prepared runtime" rather than failing the command, the same way
 *  `src/main/ipc.ts`'s own read of this file treats it missing. */
export function preparedRuntimeEntry(a: {
  profileDir: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  resourcesPath: string | undefined
  readFile(p: string): string
}): string | undefined {
  // `userDataDir`'s last path segment is the app's own name (`astera` or `astera-dev`) — the CLI has
  // no `app.getName()` to ask, and this is the one place written down instead of hardcoding either
  // string.
  //
  // **The path rules are `a.platform`'s, not this process's** — the same reason `platform` is a
  // parameter at all. Only win32 ever gets past `hostRuntimeBase`, whose own joins are `path.win32`;
  // with the host's `path` a win32 profile read on posix is one segment with no basename, and the
  // manifest path is joined with `/` (found by running this file's tests on Linux CI).
  const p = a.platform === 'win32' ? path.win32 : path.posix
  const appName = p.basename(a.profileDir)
  const base = hostRuntimeBase({
    platform: a.platform,
    localAppData: a.env.LOCALAPPDATA,
    userData: a.profileDir,
    appName
  })
  if (!base || !a.resourcesPath) return undefined
  try {
    const manifest = JSON.parse(a.readFile(p.join(a.resourcesPath, 'host-runtime', 'runtime.json'))) as {
      node?: unknown
    }
    const nodeVersion = typeof manifest.node === 'string' ? manifest.node.trim() : ''
    if (!nodeVersion) return undefined
    return hostRuntimePaths({ base, nodeVersion, appVersion: CLI_VERSION }).entryPath
  } catch {
    // No `resources/host-runtime` at all (development), or a manifest this build cannot read. Either
    // way, `hostStartTargets` falls back to the candidate beside `cli.js`.
    return undefined
  }
}

/**
 * 끝의 구분자를 걷는다 — `nativePath` 와 같은 이유로 같은 자리에서(바로 아래 `cliHostTarget`).
 *
 * `C:\astera-dev\` 는 `C:\astera-dev` 와 같은 폴더인데 sha256 이 달라 다른 Host 가 된다.
 * `userDataDir` 은 이미 같은 것을 걷고 값을 실어 보내는 쪽은 끝에 구분자를 붙이지 않으므로,
 * 이 줄도 지금 있는 주소를 하나도 바꾸지 않는다.
 *
 * **뿌리는 걷지 않는다.** `C:\` 를 `C:` 로 만들면 win32 에서 다른 것을 가리키고(그것은 그
 * 드라이브의 현재 디렉터리다), posix 의 `/` 를 걷으면 빈 문자열이 된다. 둘 다 구분자 하나짜리
 * 뿌리로 되돌린다 — 프로필이 뿌리일 리는 없지만, 그냥 두는 것과 망가뜨리는 것은 다른 일이다.
 *
 * **무엇이 구분자인지는 플랫폼이 정한다.** posix 에서 역슬래시는 파일 이름에 쓸 수 있는 보통
 * 글자다 — 조건 없이 걷으면 실재하는 폴더 `/home/me/dir\` 가 `/home/me/dir` 이 되고, 그 둘은 다른
 * 폴더다. 바로 아래 `nativePath` 가 같은 이유로 같은 자리에서 플랫폼을 받는다.
 *
 * **아무것도 걷지 않았으면 아무것도 붙이지 않는다.** 드라이브 갈래가 되돌리는 것은 자기가 방금
 * 걷어 낸 구분자이지 원본의 마지막 글자가 아니다 — 구분자 없는 `C:` 하나가 들어오면 그 둘이
 * 다르고, 마지막 글자를 붙이면 `C::` 가 된다.
 */
const withoutTrailingSeparator = (p: string, platform: NodeJS.Platform): string => {
  const stripped = p.replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '')
  if (stripped === p) return p
  if (stripped === '') return p.slice(0, 1)
  if (/^[A-Za-z]:$/.test(stripped)) return stripped + p.slice(stripped.length, stripped.length + 1)
  return stripped
}

/**
 * 이 실행이 말을 걸 Host — 그 주소와, 그 Host 가 쓰는 프로필 폴더.
 *
 * **프로필이 먼저다.** 앱이 띄운 세션에는 그 앱의 프로필 폴더가 실려 온다(`ASTERA_PROFILE_DIR`,
 * core/sessions/manager.ts) — 주소도 보고 큐도 거기서 나온다. 그 변수가 없으면(사람이 셀에서 직접
 * 부른 경우) 플랫폼에서 계산한다.
 *
 * **왜 주소가 아니라 폴더인가.** 개발본은 `-dev` 접미사를 `app.isPackaged` 로 붙이고(src/main/index.ts)
 * 그 사실을 환경변수로 내보내는 곳이 없었다 — 그래서 개발본이 띄운 워커가 설치본의 Host 에 말을
 * 걸었고, 못 보낸 보고를 설치본의 큐에 적었다(F43, 2026-09-22 실측). 주소만으로는 못 고친다:
 * 상태 파일과 보고 큐가 있는 곳은 주소가 말해 주지 않는다.
 *
 * **`ASTERA_HOST` 는 주소만 이긴다.** 특정 Host 를 손으로 가리키는 장치이고, 그 Host 가 어느
 * 프로필을 쓰는지는 여전히 주소가 말해 주지 않는다.
 *
 * **실려 온 경로는 그 플랫폼의 철자로 맞춘다.** 주소는 이 문자열의 sha256 이라(host/address.ts)
 * 같은 폴더라도 철자가 다르면 **다른** Host 를 가리킨다 — 정슬래시로 적은 것과 역슬래시로 적은
 * 것이 그렇고(`nativePath`), 끝에 구분자를 붙인 것과 안 붙인 것이 그렇다
 * (`withoutTrailingSeparator`). 어느 쪽이든 손으로 그렇게 적으면 살아 있는 Host 를 두고
 * `running: false` 라고 답하게 되고, 그것은 이 설계가 가장 애써 피하는 거짓말이다
 * (core/orchestration/stateFile.ts 의 머리말).
 * **지금 있는 주소는 하나도 바뀌지 않는다** — 값을 실어 보내는 쪽은 전부 이미 네이티브 철자이고
 * 끝에 구분자를 붙이지 않는다(앱과 Host 는 `app.getPath('userData')` 를 그대로 싣고,
 * `userDataDir` 은 win32 에서 `nativePath` 를 태우며 끝 구분자를 이미 걷는다). 사람이 직접 적은
 * 값만 구제된다.
 *
 * **대소문자는 여기서 손대지 않는다.** win32 의 경로는 대소문자를 가리지 않으므로 그것도 같은
 * 집안이지만, 맞추려면 지금 있는 주소가 전부 바뀐다 — 위 두 줄이 안전한 이유가 바로 "아무것도
 * 안 바뀐다" 이고, 그 성질이 없다. 남겨 둔 채로 적어 둔다.
 *
 * `run.ts` 와 이 파일이 같은 값을 쓴다. 두 벌로 두면 `astera host status` 가 보는 Host 와
 * `astera jobs list` 가 묻는 Host 가 갈리는 날이 온다.
 */
export function cliHostTarget(a: {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
}): { address: string; profileDir: string } {
  const given = a.env.ASTERA_PROFILE_DIR
  const profileDir =
    given !== undefined && given.length > 0
      ? withoutTrailingSeparator(nativePath(given, a.platform), a.platform)
      : userDataDir({
          platform: a.platform,
          env: a.env,
          home: a.home,
          dev: a.env.ASTERA_PROFILE === 'dev'
        })
  const explicit = a.env.ASTERA_HOST
  if (explicit !== undefined && explicit.length > 0) return { address: explicit, profileDir }
  return {
    address: hostAddress({
      profileDir,
      platform: a.platform,
      tmpDir: os.tmpdir(),
      protocol: HOST_PROTOCOL
    }).address,
    profileDir
  }
}

/** How long `host start` waits for a freshly spawned Host to answer its first `hello`, and how often
 *  it checks. Generous, not tuned: a cold start pays for requiring node-pty and opening the pipe, and
 *  there is nothing else this command is doing meanwhile. */
const START_TIMEOUT_MS = 5_000
const START_POLL_MS = 200

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Runs a `host-*` command and hands back what happened, without printing anything (see the note at
 *  the top of this file) — `run.ts` renders `body` and exits with `code`. */
export async function runHostCommand(a: {
  cmd: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  /** Overrides `HOST_STOP_WAIT_MS` for `host-stop`'s wait. Test injection only, the same way
   *  `HostServerDeps`'s `idleMs`/`helloMs` and `HostClientDeps`'s `pingMs` are — nothing waits out a
   *  real 35s to prove a silent Host resolves rather than hangs. */
  stopTimeoutMs?: number
}): Promise<HostCommandResult> {
  if (a.cmd !== 'host-status' && a.cmd !== 'host-start' && a.cmd !== 'host-stop')
    return { ok: false, error: { code: 'FAILED', message: `${a.cmd} is not implemented yet` } }

  const { address, profileDir } = cliHostTarget({ env: a.env, platform: a.platform, home: a.home })

  /** One connect attempt, turned into the pair `runHostCommand` returns — or null when nothing
   *  answered, which the two callers below read differently (a failed `status` and a `start` that
   *  still has spawning left to do are not the same null). */
  const tryStatus = async (): Promise<HostCommandResult | null> => {
    const connected = await connectHost({ address, app: CLI_VERSION, log: logToStderr })
    if ('error' in connected) return null
    const body = hostStatus({ conn: connected, profileDir, jobsInProfile: jobCountFrom(profileDir) })
    connected.close()
    return { ok: true, body }
  }

  /** A Host of another protocol on this profile, as the 9 both `host status` and `host start` end
   *  with: the same answer `status` gives (review M5), so a script hears one story. */
  const sibling = async (): Promise<HostCommandResult | null> => {
    const found = await otherProtocolHost({ profileDir, platform: a.platform, tmpDir: os.tmpdir() })
    return found === null ? null : { ok: false, error: siblingHostError({ found, cliProtocol: HOST_PROTOCOL }) }
  }

  if (a.cmd === 'host-status') {
    const up = await tryStatus()
    if (up) return up
    const other = await sibling()
    if (other) return other
    // **No Host is a 3 in the error envelope**, with what the success body used to say in `details`:
    // the profile looked in and how many Jobs its file holds. Troubleshooting sends people here to
    // read the profile, and the message names it too.
    return {
      ok: false,
      error: {
        code: 'HOST_NOT_RUNNING',
        message: `no Host is running for the profile ${profileDir}`,
        details: hostStatus({ conn: null, profileDir, jobsInProfile: jobCountFrom(profileDir) })
      }
    }
  }

  if (a.cmd === 'host-stop') {
    const connected = await connectHost({ address, app: CLI_VERSION, log: logToStderr })
    if ('error' in connected) return hostStopResult({ outcome: 'absent' })
    // A `retire` that is honoured gets no reply, only the connection ending — so this races three
    // outcomes: `retire-refused`, the socket closing on its own, or neither ever arriving because the
    // Host's event loop is wedged and cannot run the code that would send either one.
    const outcome = await new Promise<HostCommandResult>((resolve) => {
      let offMessage: () => void = () => {}
      let offClose: () => void = () => {}
      const settle = (r: HostCommandResult): void => {
        clearTimeout(timer)
        offMessage()
        offClose()
        resolve(r)
      }
      const waitedMs = a.stopTimeoutMs ?? HOST_STOP_WAIT_MS
      const timer = setTimeout(() => settle(hostStopResult({ outcome: 'timeout', waitedMs })), waitedMs)
      timer.unref?.()
      offMessage = connected.onMessage((m) => {
        if (m.t === 'retire-refused')
          settle(hostStopResult({ outcome: 'refused', sessions: m.sessions, runs: m.runs }))
      })
      offClose = connected.onClose(() => settle(hostStopResult({ outcome: 'stopped' })))
      connected.call({ t: 'retire', reason: 'user' })
    })
    connected.close()
    return outcome
  }

  // host-start: a Host that is already there is success, not an error — the person asked for a Host
  // to be running, and one is.
  const already = await tryStatus()
  if (already) return already
  // **Not while a Host of another protocol serves this profile** (conformance audit #12). It is at
  // another address, so nothing above saw it, and a second Host would write the same state file.
  // This is the step the 9 for that case offers next, so it has to be safe to follow.
  const other = await sibling()
  if (other) return other

  const targets = hostStartTargets({
    cliEntry: process.argv[1] ?? '',
    execPath: process.execPath,
    profileDir,
    version: CLI_VERSION,
    runtimeEntry: preparedRuntimeEntry({
      profileDir,
      platform: a.platform,
      env: a.env,
      resourcesPath: process.resourcesPath,
      readFile: (p) => readFileSync(p, 'utf8')
    }),
    skillsDir: resolveSkillsDir({ resourcesPath: process.resourcesPath, cliEntry: process.argv[1] ?? '', exists: existsSync })
  })
  const entry = resolveHostEntry(targets.candidates, existsSync)
  if (!entry)
    return {
      ok: false,
      error: {
        code: 'HOST_NOT_RUNNING',
        message: `no Host build found among: ${targets.candidates.join(', ')}`,
        details: { candidates: targets.candidates }
      }
    }
  const plan = hostSpawnPlan({
    execPath: targets.execPath,
    entryPath: entry,
    profileDir,
    logPath: targets.logPath,
    version: CLI_VERSION,
    cli: targets.cli
  })
  const child = spawn(plan.command, plan.args, plan.options)
  // A spawn that fails arrives as an async 'error' event, not a throw — see the same handling in
  // `src/main/ipc.ts`'s `startHostClient`. The polling loop below reports the outcome either way; this
  // only keeps a failed spawn from being an unhandled process-level error.
  child.on('error', (err) => logToStderr(`the Host could not be started: ${String(err)}`))
  child.unref()

  const deadline = Date.now() + START_TIMEOUT_MS
  for (;;) {
    const up = await tryStatus()
    if (up) return up
    if (Date.now() >= deadline) break
    await sleep(START_POLL_MS)
  }
  return {
    ok: false,
    error: {
      code: 'HOST_NOT_RUNNING',
      message: `the Host did not answer within ${START_TIMEOUT_MS}ms — its log is at ${targets.logPath}`,
      details: { logPath: targets.logPath }
    }
  }
}

/**
 * A Host of **another** protocol version that serves this profile right now, or `null`.
 *
 * **Asked only on the path where this CLI found nobody at its own address** (run.ts), before it
 * answers from the state file or says there is no Host. The address carries the protocol
 * (host/address.ts), so an installed build and a development build of different protocols miss each
 * other, and the one that misses would read the file a live Host is writing, or tell the person to
 * start a second Host on the same profile (conformance audit #12).
 *
 * Cheap and bounded: one directory listing, then one connect per sibling found, in parallel, each
 * given at most a second (`answers`). Connecting is what tells a live Host from a posix socket
 * directory its Host left behind. Nothing is said on the connection, so no Host of any version is
 * asked to do anything.
 */
export async function otherProtocolHost(a: {
  profileDir: string
  platform: NodeJS.Platform
  tmpDir: string
}): Promise<{ protocol: number; address: string } | null> {
  const siblings = siblingHostAddresses({ ...a, protocol: HOST_PROTOCOL, list: (dir) => readdirSync(dir) })
  const live = await Promise.all(siblings.map((s) => answers(s.address)))
  return siblings.find((_, i) => live[i]) ?? null
}
