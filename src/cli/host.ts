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
 *  envelope this command prints (`run.ts` renders it), so this goes to stderr instead — the same
 *  channel `host/index.ts` uses for its own startup errors, and one a person running this directly
 *  still sees without it landing inside anything a script parses. */
const logToStderr = (m: string): void => {
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
 *  by design, but it never lays anything down itself. In development `runtime.json` under
 *  `process.resourcesPath` does not exist (nothing is shipped outside a packaged build), and that
 *  absence reads the same as "no prepared runtime" rather than a failure — the same way
 *  `src/main/ipc.ts`'s own read of this file treats it missing. */
function preparedRuntimeEntry(a: {
  profileDir: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
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
  if (!base) return undefined
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(process.resourcesPath, 'host-runtime', 'runtime.json'), 'utf8')
    ) as { node?: unknown }
    const nodeVersion = typeof manifest.node === 'string' ? manifest.node.trim() : ''
    if (!nodeVersion) return undefined
    return hostRuntimePaths({ base, nodeVersion, appVersion: CLI_VERSION }).entryPath
  } catch {
    // No `resources/host-runtime` at all (development), or a manifest this build cannot read. Either
    // way, `hostStartTargets` falls back to the candidate beside `cli.js`.
    return undefined
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
}): Promise<{ body: unknown; code: number }> {
  if (a.cmd !== 'host-status' && a.cmd !== 'host-start')
    // host-stop is the next task in this series; not reachable yet because cliArgs only just started
    // accepting the word (task 2 added the noun).
    return { body: { error: `${a.cmd} is not implemented yet` }, code: exitCodeFor('FAILED') }

  const profileDir = userDataDir({
    platform: a.platform,
    env: a.env,
    home: a.home,
    dev: a.env.ASTERA_PROFILE === 'dev'
  })
  const address = hostAddress({
    profileDir,
    platform: a.platform,
    tmpDir: os.tmpdir(),
    protocol: HOST_PROTOCOL
  }).address

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

  // host-start: a Host that is already there is success, not an error — the person asked for a Host
  // to be running, and one is.
  const already = await tryStatus()
  if (already) return already

  const targets = hostStartTargets({
    cliEntry: process.argv[1] ?? '',
    execPath: process.execPath,
    profileDir,
    version: CLI_VERSION,
    runtimeEntry: preparedRuntimeEntry({ profileDir, platform: a.platform, env: a.env })
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
