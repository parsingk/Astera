// Running `codex plugin …` once per Codex account, each account being a CODEX_HOME folder. The spawn, the resolution and
// the time limit are the Claude runner's (claudePlugins/cli.ts); what is Codex's is the environment, which carries no
// trace of a parent session or of another account, and the name `codex` looked up the way sessions look it up.
import type { spawn as nodeSpawn } from 'node:child_process'
import { cleanCliEnv, createJsonCliRunner, type CliLookup, type PluginCliResult } from '../claudePlugins/cli'

/** The time limit of an add, which can fetch what it adds the way a Claude install does; every other command runs
 *  under the default limit. */
export const CODEX_PLUGIN_ADD_TIMEOUT_MS = 600_000

/** The environment of a `codex plugin` command: `cleanCliEnv(base)`, with CODEX_HOME set to `codexHome`. The ambient
 *  `~/.codex` account is `null`: `codex` finds it with no CODEX_HOME, so even one that `base` held is dropped. */
export function codexPluginCliEnv(base: NodeJS.ProcessEnv, codexHome: string | null): NodeJS.ProcessEnv {
  const env = cleanCliEnv(base)
  if (codexHome !== null) env.CODEX_HOME = codexHome
  return env
}

/** Like the Claude runner, a run never rejects: a non-zero exit with a JSON result is an ordinary answer. */
export type CodexPluginCliRun = (codexHome: string | null, args: string[], o?: { timeoutMs?: number }) => Promise<PluginCliResult>

export function createCodexPluginCliRunner(
  d: Omit<CliLookup, 'name'> & {
    /** What each run's environment starts from. A function is read at each run, after `refreshPath`, so a PATH that grew
     *  since the runner was made is the one the command gets. */
    baseEnv: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv)
    spawn?: typeof nodeSpawn
  }
): CodexPluginCliRun {
  const run = createJsonCliRunner({ ...d, name: 'codex' })
  return (codexHome, args, o) => run(args, () => codexPluginCliEnv(typeof d.baseEnv === 'function' ? d.baseEnv() : d.baseEnv, codexHome), o)
}
