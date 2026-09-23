// How the app starts the Host (design §4). Pure: the plan is a value, and the caller passes it to
// child_process.spawn — which is what makes the shape of the call testable, the same arrangement
// src/core/orchestration/exec/shuttle.ts uses for the CLI shuttle.
import type { SpawnOptions } from 'node:child_process'
import { INHERITED_AGENT_ENV_KEYS } from '../sessions/cliEnv'

/** Variables that belong to one agent session and must not reach the Host: it is not a worker, and
 *  it spawns workers of its own that would inherit them in turn. The astera ones by prefix; the
 *  Claude Code ones are exactly the session-identity list cliEnvFor clears for an app worker
 *  (INHERITED_AGENT_ENV_KEYS), not the whole CLAUDE_CODE_ family: CLAUDE_CODE_USE_BEDROCK,
 *  CLAUDE_CODE_OAUTH_TOKEN and the like are settings a person chose, and a Host worker must keep
 *  them just as an app worker does. An inherited CLAUDE_CODE_CHILD_SESSION is what turns a worker's
 *  transcript off. */
const NOT_INHERITED_ASTERA = /^(ASTERA_SESSION|ASTERA_CLI|ASTERA_SKILLS)/
const NOT_INHERITED_AGENT: ReadonlySet<string> = new Set(INHERITED_AGENT_ENV_KEYS)
const notInherited = (k: string): boolean => NOT_INHERITED_ASTERA.test(k) || NOT_INHERITED_AGENT.has(k)

/** What the Host's own start adds to its environment — the runtime switch and the Host's own
 *  settings. None of it may reach an agent the Host spawns: ELECTRON_RUN_AS_NODE turns any Electron
 *  binary the agent runs into plain Node (design D4, §2.2). Case-insensitive because a Windows
 *  environment block is. Written by prefix so an ASTERA_HOST_ variable added later is covered too. */
export const HOST_ONLY_ENV: RegExp = /^(ELECTRON_RUN_AS_NODE$|ASTERA_HOST_)/i

/** The environment a worker the Host spawns starts from (D4): the Host's own, minus HOST_ONLY_ENV.
 *  Everything else is kept on purpose. The Host was started from the app's environment minus only
 *  the parent session's identity (hostSpawnPlan), and SessionManager then runs this through
 *  cliEnvFor exactly as the app does, so a worker sees what a worker the app spawned would. */
export function hostWorkerBaseEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (!HOST_ONLY_ENV.test(k)) base[k] = v
  return base
}

/** The three paths a Host needs before it can spawn a worker itself (§2.2): the binary and the
 *  bundle the worker's `astera` shuttle runs, and the skills folder the CLI's help reads. The app and
 *  `astera host start` know them; the Host, started as plain Node, cannot find them on its own. */
export interface HostCliPaths {
  exec: string
  entry: string
  skills: string
}

const HOST_CLI_ENV = { exec: 'ASTERA_HOST_CLI_EXEC', entry: 'ASTERA_HOST_CLI_ENTRY', skills: 'ASTERA_HOST_SKILLS' } as const

/** The CLI paths this Host was started with, or the names of the variables that are unset, empty, or
 *  name a path that is not there. **Any one missing means none**: the Host does not guess a path
 *  (§2.2), so a Host started by an older app or CLI, which passes none of them, does not spawn. The
 *  `ASTERA_HOST_` prefix is what keeps all three away from the workers (HOST_ONLY_ENV). */
export function hostCliPaths(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean
): HostCliPaths | { missing: string[] } {
  const missing: string[] = []
  for (const name of [HOST_CLI_ENV.exec, HOST_CLI_ENV.entry, HOST_CLI_ENV.skills]) {
    const v = env[name]
    if (!v || !exists(v)) missing.push(name)
  }
  if (missing.length > 0) return { missing }
  return { exec: env[HOST_CLI_ENV.exec]!, entry: env[HOST_CLI_ENV.entry]!, skills: env[HOST_CLI_ENV.skills]! }
}

export interface HostSpawnPlan {
  command: string
  args: string[]
  options: SpawnOptions & { env: NodeJS.ProcessEnv; cwd: string; detached: true; stdio: 'ignore' }
}

/** The first candidate that exists, or null when the bundle was never emitted (a partial build, or a
 *  packaging mistake). Null means the app runs without a Host, which is a supported state. */
export function resolveHostEntry(candidates: string[], exists: (p: string) => boolean): string | null {
  return candidates.find(exists) ?? null
}

export function hostSpawnPlan(a: {
  execPath: string
  entryPath: string
  profileDir: string
  logPath: string
  version: string
  env?: NodeJS.ProcessEnv
  /** Absent from a caller that cannot name all three, and then the Host it starts does not spawn. */
  cli?: HostCliPaths
}): HostSpawnPlan {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(a.env ?? process.env)) if (!notInherited(k)) env[k] = v
  return {
    command: a.execPath,
    args: [a.entryPath],
    options: {
      detached: true,
      // The Host outlives the app — by a minute in slice 1, indefinitely from slice 3 — and an
      // inherited working directory would pin whatever folder the app was launched from for that
      // whole time: on win32 that blocks deleting the install directory, on posix it keeps a mount
      // busy. The profile directory is somewhere the Host already has a stake in.
      cwd: a.profileDir,
      // Nothing reads the Host's output, and a pipe nobody drains would eventually block it. Its log
      // file is where it speaks.
      stdio: 'ignore',
      // The Host is a console program started from a windowed one, so without this Windows is free to
      // give it a console of its own — a black window that flashes up behind the app. `detached`
      // already asks for DETACHED_PROCESS, which normally covers it; this says so rather than
      // relying on that mapping, and costs nothing on the platforms that ignore it.
      windowsHide: true,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        ASTERA_HOST_PROFILE_DIR: a.profileDir,
        ASTERA_HOST_LOG: a.logPath,
        ASTERA_HOST_VERSION: a.version,
        ...(a.cli
          ? {
              [HOST_CLI_ENV.exec]: a.cli.exec,
              [HOST_CLI_ENV.entry]: a.cli.entry,
              [HOST_CLI_ENV.skills]: a.cli.skills
            }
          : {})
      }
    }
  }
}
