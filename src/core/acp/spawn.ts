// Starting an external reviewer's agent (design 3.5): what environment it gets and what exactly is handed to child_process.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { MANAGED_ENV_KEYS, INHERITED_AGENT_ENV_KEYS } from '../sessions/cliEnv'
import { HOST_ONLY_ENV } from '../host/spawn'
import { fitsWindowsCommandLine, resolveWindowsExecutable, windowsSpawn } from '../sessions/windowsExecutable'
import { ensureOnWindowsPath } from '../sessions/windowsPath'
import { ensureInstallDirOnPath } from '../sessions/installDirPath'
import type { InstallableCli } from '../install/cliInstall'

const WITHHELD: ReadonlySet<string> = new Set<string>([...MANAGED_ENV_KEYS, ...INHERITED_AGENT_ENV_KEYS])

/** The environment an external agent gets: `base` without what Astera plants for its own sessions, the parent session's
 *  identity and the Host's own switches, so the agent is never taken for one of them or handed their tokens. NO_BROWSER:
 *  a login the agent wants must not open a window on a Host that has no one in front of it. */
export function agentChildEnv(base: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(base)) if (!WITHHELD.has(k) && !HOST_ONLY_ENV.test(k)) env[k] = v
  env.NO_BROWSER = 'true'
  return env
}

/** The extensions cmd.exe tries for a name without one, in its order. */
const SHIM_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd']

const ensureFound = async (name: string): Promise<void> => {
  await ensureOnWindowsPath([name])
  // The helper types its names as the two CLIs Astera installs; for any other name it only looks the name up on PATH
  await ensureInstallDirOnPath([name as InstallableCli])
}

/** What to hand child_process for `r`. A bare name is looked up on the PATH of this process after checking for a CLI
 *  installed since it started; on win32 a `.cmd` shim goes through cmd.exe as windowsSpawn does for every tool.
 *  An absolute command is a path and is not looked up (findOnWindowsPath), but npm writes `gemini`, `gemini.cmd` and
 *  `gemini.ps1` side by side, and `C:\...\npm\gemini` alone would be the shell script no Windows loader runs: an
 *  absolute command with none of cmd.exe's extensions takes the first of them that exists beside it. */
export async function resolveAgentCommand(
  r: { command: string; args: string[] },
  platform: NodeJS.Platform,
  o: { ensure?: (name: string) => Promise<void>; resolve?: (name: string) => string | null; exists?: (p: string) => boolean } = {}
): Promise<{ ok: true; file: string; args: string[] } | { ok: false; error: string }> {
  if (!/[\\/]/.test(r.command)) await (o.ensure ?? ensureFound)(r.command)
  if (platform !== 'win32') return { ok: true, file: r.command, args: r.args }
  let command = r.command
  if (path.win32.isAbsolute(command) && !SHIM_EXTENSIONS.includes(path.win32.extname(command).toLowerCase())) {
    const exists = o.exists ?? existsSync
    const sibling = SHIM_EXTENSIONS.map((ext) => command + ext).find((p) => exists(p))
    if (sibling !== undefined) command = sibling
  }
  const spawnable = windowsSpawn(command, r.args, o.resolve ?? resolveWindowsExecutable)
  if (!fitsWindowsCommandLine(spawnable.file, spawnable.args))
    return { ok: false, error: `The command line for ${r.command} is longer than Windows can run. Shorten its arguments.` }
  return { ok: true, file: spawnable.file, args: spawnable.args }
}
