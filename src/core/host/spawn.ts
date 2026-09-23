// How the app starts the Host (design §4). Pure: the plan is a value, and the caller passes it to
// child_process.spawn — which is what makes the shape of the call testable, the same arrangement
// src/core/orchestration/exec/shuttle.ts uses for the CLI shuttle.
import type { SpawnOptions } from 'node:child_process'

/** Variables that belong to one agent session and must not reach the Host: it is not a worker, and
 *  slice 2 will have it spawn workers of its own that would inherit them in turn. */
const NOT_INHERITED = /^(ASTERA_SESSION|ASTERA_CLI|ASTERA_SKILLS|CLAUDE_CODE_|CLAUDECODE$)/

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
}): HostSpawnPlan {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(a.env ?? process.env)) if (!NOT_INHERITED.test(k)) env[k] = v
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
        ASTERA_HOST_VERSION: a.version
      }
    }
  }
}
