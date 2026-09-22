// astera's `host-*` commands: they talk to the Host directly, not through the app's HTTP server.
//
// **This file must not import from `./run` — `run.ts` imports this file, and the reverse would be a
// cycle.** So `runHostCommand` below returns a value instead of printing one; `run.ts` renders it
// with `renderOk` and calls `process.exit` itself.
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { HOST_PROTOCOL } from '../core/host/protocol'
import { connectHost, type HostConnection } from '../core/host/connect'
import { hostSpawnPlan, resolveHostEntry } from '../core/host/spawn'
import { hostRuntimeBase, hostRuntimePaths } from '../core/host/runtime'
import { HOST_UNRESPONSIVE_MS } from '../core/host/unresponsive'
import { hostAddress } from '../host/address'
import { userDataDir } from '../core/orchestration/cliDiscovery'
import { exitCodeFor } from '../core/orchestration/cliOutput'

/** What `astera host status` reports. **Answers without a Host**: the content says what is there and
 *  the exit code says whether the Host is running, which is the pair a script needs (spec §8). */
export function hostStatus(a: {
  conn: Pick<HostConnection, 'hello'> | null
  profileDir: string
  jobs: number
}): Record<string, unknown> {
  if (!a.conn)
    return { running: false, protocol: HOST_PROTOCOL, features: [], profile: a.profileDir, jobs: a.jobs }
  return {
    running: true,
    pid: a.conn.hello.pid,
    version: a.conn.hello.host,
    protocol: HOST_PROTOCOL,
    features: a.conn.hello.features,
    profile: a.profileDir,
    jobs: a.jobs
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
    | { outcome: 'refused'; sessions: number; jobs: number }
    | { outcome: 'timeout'; waitedMs: number }
): { body: Record<string, unknown>; code: number } {
  if (a.outcome === 'absent') return { body: { stopped: true, message: 'no Host was running' }, code: 0 }
  if (a.outcome === 'stopped') return { body: { stopped: true }, code: 0 }
  if (a.outcome === 'timeout')
    return {
      body: {
        stopped: false,
        message: `retire was sent, but the Host did not answer within ${a.waitedMs}ms — it may still be running (and possibly stuck)`
      },
      code: exitCodeFor('TIMEOUT')
    }
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  return {
    body: {
      stopped: false,
      sessions: a.sessions,
      jobs: a.jobs,
      message: `Cannot stop Host: ${plural(a.sessions, 'session')} and ${plural(a.jobs, 'Job')} are still running.`
    },
    code: exitCodeFor('CONFLICT')
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
}): { execPath: string; candidates: string[]; logPath: string } {
  const beside = a.cliEntry.replace(/[^/\\]+$/, 'host.js')
  return {
    execPath: a.execPath,
    candidates: a.runtimeEntry ? [a.runtimeEntry, beside] : [beside],
    logPath: `${a.profileDir.replace(/[\\/]+$/, '')}/host/host.log`
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
  const appName = path.basename(a.profileDir)
  const base = hostRuntimeBase({
    platform: a.platform,
    localAppData: a.env.LOCALAPPDATA,
    userData: a.profileDir,
    appName
  })
  if (!base || !a.resourcesPath) return undefined
  try {
    const manifest = JSON.parse(a.readFile(path.join(a.resourcesPath, 'host-runtime', 'runtime.json'))) as {
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
 * 이 실행이 말을 걸 Host — 그 주소와, 그 Host 가 쓰는 프로필 폴더.
 *
 * **`ASTERA_HOST` 가 언제나 이긴다.** 앱이 띄운 세션은 자기를 띄운 Host 와 말해야 하고, 설치본이
 * 함께 떠 있다고 해서 그쪽으로 새면 안 된다 — `ASTERA_INFO` 가 하던 일을 그대로 물려받는다(설계 §4).
 * 그 변수가 없으면 프로필에서 계산한다.
 *
 * **`profileDir` 은 언제나 계산된 값이다.** 주소를 손으로 지정해도 그 Host 가 어느 프로필을 쓰는지는
 * 주소가 말해 주지 않는다 — 상태 파일과 보고 큐가 있는 곳은 `ASTERA_PROFILE` 이 정한다.
 *
 * `run.ts` 와 이 파일이 같은 값을 쓴다. 두 벌로 두면 `astera host status` 가 보는 Host 와
 * `astera jobs list` 가 묻는 Host 가 갈리는 날이 온다.
 */
export function cliHostTarget(a: {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
}): { address: string; profileDir: string } {
  const profileDir = userDataDir({
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
  /** Overrides `HOST_UNRESPONSIVE_MS` for `host-stop`'s wait. Test injection only, the same way
   *  `HostServerDeps`'s `idleMs`/`helloMs` and `HostClientDeps`'s `pingMs` are — nothing waits out a
   *  real 15s to prove a silent Host resolves rather than hangs. */
  stopTimeoutMs?: number
}): Promise<{ body: unknown; code: number }> {
  if (a.cmd !== 'host-status' && a.cmd !== 'host-start' && a.cmd !== 'host-stop')
    return { body: { error: `${a.cmd} is not implemented yet` }, code: exitCodeFor('FAILED') }

  const { address, profileDir } = cliHostTarget({ env: a.env, platform: a.platform, home: a.home })

  /** One connect attempt, turned into the pair `runHostCommand` returns — or null when nothing
   *  answered, which the two callers below read differently (a failed `status` and a `start` that
   *  still has spawning left to do are not the same null). */
  const tryStatus = async (): Promise<{ body: unknown; code: number } | null> => {
    const connected = await connectHost({ address, app: CLI_VERSION, log: logToStderr })
    if ('error' in connected) return null
    const body = hostStatus({ conn: connected, profileDir, jobs: jobCountFrom(profileDir) })
    connected.close()
    return { body, code: 0 }
  }

  if (a.cmd === 'host-status') {
    return (
      (await tryStatus()) ?? {
        body: hostStatus({ conn: null, profileDir, jobs: jobCountFrom(profileDir) }),
        code: exitCodeFor('HOST_NOT_RUNNING')
      }
    )
  }

  if (a.cmd === 'host-stop') {
    const connected = await connectHost({ address, app: CLI_VERSION, log: logToStderr })
    if ('error' in connected) return hostStopResult({ outcome: 'absent' })
    // A `retire` that is honoured gets no reply, only the connection ending — so this races three
    // outcomes: `retire-refused`, the socket closing on its own, or neither ever arriving because the
    // Host's event loop is wedged and cannot run the code that would send either one.
    const outcome = await new Promise<{ body: unknown; code: number }>((resolve) => {
      let offMessage: () => void = () => {}
      let offClose: () => void = () => {}
      const settle = (r: { body: unknown; code: number }): void => {
        clearTimeout(timer)
        offMessage()
        offClose()
        resolve(r)
      }
      const waitedMs = a.stopTimeoutMs ?? HOST_UNRESPONSIVE_MS
      const timer = setTimeout(() => settle(hostStopResult({ outcome: 'timeout', waitedMs })), waitedMs)
      timer.unref?.()
      offMessage = connected.onMessage((m) => {
        if (m.t === 'retire-refused')
          settle(hostStopResult({ outcome: 'refused', sessions: m.sessions, jobs: m.jobs }))
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
    })
  })
  const entry = resolveHostEntry(targets.candidates, existsSync)
  if (!entry)
    return {
      body: { error: `no Host build found among: ${targets.candidates.join(', ')}` },
      code: exitCodeFor('HOST_NOT_RUNNING')
    }
  const plan = hostSpawnPlan({
    execPath: targets.execPath,
    entryPath: entry,
    profileDir,
    logPath: targets.logPath,
    version: CLI_VERSION
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
    body: { error: `the Host did not answer within ${START_TIMEOUT_MS}ms`, logPath: targets.logPath },
    code: exitCodeFor('HOST_NOT_RUNNING')
  }
}
