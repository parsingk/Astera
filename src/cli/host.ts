// astera's `host-*` commands: they talk to the Host directly, not through the app's HTTP server.
//
// **This file must not import from `./run` — `run.ts` imports this file, and the reverse would be a
// cycle.** So `runHostCommand` below returns a value instead of printing one; `run.ts` renders it
// with `renderOk` and calls `process.exit` itself.
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HOST_PROTOCOL } from '../core/host/protocol'
import { connectHost, type HostConnection } from '../core/host/connect'
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

/** Runs a `host-*` command and hands back what happened, without printing anything (see the note at
 *  the top of this file) — `run.ts` renders `body` and exits with `code`. */
export async function runHostCommand(a: {
  cmd: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
}): Promise<{ body: unknown; code: number }> {
  if (a.cmd !== 'host-status')
    // host-start and host-stop are the next two tasks in this series; not reachable yet because
    // cliArgs only just started accepting the words (this task also adds the noun).
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
  const connected = await connectHost({ address, app: CLI_VERSION, log: logToStderr })
  const conn = 'error' in connected ? null : connected
  const jobs = jobCountFrom(profileDir)
  const body = hostStatus({ conn, profileDir, jobs })
  conn?.close()
  return { body, code: conn ? 0 : exitCodeFor('HOST_NOT_RUNNING') }
}
