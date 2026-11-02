// Running `claude plugin …` in Astera's own Claude Code config folder (`extensions/claude-plugins`), the only place
// Astera installs, checks, updates and removes shared plugins. Never a session: a session started there would sweep
// versions that account sessions still use (M6).
//
// Every run carries --json and an environment with no trace of a parent session or an account: Claude Code ignores
// --accept-command while CLAUDECODE is set (M8), and an inherited CLAUDE_CONFIG_DIR would point the command at an
// account's folder. `claude` is found the way sessions find it, and on win32 a `.cmd` claude runs through the npm shim
// as node on its script, or through cmd.exe only when no argument is cmd.exe syntax (higgsfield's commandFor).
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { commandFor } from '../../higgsfield/runner'
import { killProcessTree } from '../../run/kill'
import { resolveWindowsExecutable, warmWindowsExecutable } from '../../sessions/windowsExecutable'

export interface PluginCliResult {
  code: number | null
  /** The command's JSON result (see `jsonOf`), or null. */
  json: Record<string, unknown> | unknown[] | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Set when nothing was run: the arguments hold cmd.exe syntax and `claude` is a `.cmd` that only cmd.exe can run. */
  refused?: string
}

/** A non-zero exit with a JSON result is an ordinary answer (`"outcome":"failed"`), so a run never rejects. */
export type PluginCliRun = (args: string[], o?: { timeoutMs?: number }) => Promise<PluginCliResult>

/** An install or an update can clone a repository and run a marketplace's build command. */
export const PLUGIN_INSTALL_TIMEOUT_MS = 600_000
/** Every other command, and a run that names no time limit. */
export const PLUGIN_COMMAND_TIMEOUT_MS = 120_000

/** After the kill, the run answers even without an exit once this long has passed (realRunner's grace). */
const KILL_GRACE_MS = 5_000

const NOT_PASSED = /^(ASTERA_|CLAUDE_|CODEX_|CLAUDECODE$)/i
/** A setting the person chose: where Git Bash is, which Claude Code needs on win32. */
const KEPT = 'CLAUDE_CODE_GIT_BASH_PATH'

/** The environment of a `claude plugin` command: `base` without any ASTERA_, CLAUDE_ or CODEX_ variable and without
 *  CLAUDECODE, except CLAUDE_CODE_GIT_BASH_PATH, and with CLAUDE_CONFIG_DIR set to `home`. Case-insensitive, as a
 *  Windows environment block is. */
export function pluginCliEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (!NOT_PASSED.test(k) || k.toUpperCase() === KEPT) env[k] = v
  env.CLAUDE_CONFIG_DIR = home
  return env
}

const objectOrArray = (text: string): Record<string, unknown> | unknown[] | null => {
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown> | unknown[]) : null
  } catch {
    return null
  }
}

/** The JSON result in a run's stdout: all of it when it is one JSON object or array (`plugin list --json` prints its
 *  array indented over many lines), else the last line that is one (`install --json` prints progress text first). */
function jsonOf(stdout: string): Record<string, unknown> | unknown[] | null {
  const whole = objectOrArray(stdout)
  if (whole !== null) return whole
  const lines = stdout.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const v = objectOrArray(lines[i])
    if (v !== null) return v
  }
  return null
}

export function createPluginCliRunner(d: {
  home: string
  platform: NodeJS.Platform
  baseEnv: NodeJS.ProcessEnv
  spawn?: typeof nodeSpawn
  /** Where `claude` is on win32. Default: the PATH lookup sessions use (buildClaudeCommand). */
  resolve?: (name: string) => string | null
  /** Awaited before `resolve` on win32: the same lookup off the calling thread, its answer kept for `resolve`.
   *  Default: warmWindowsExecutable. */
  warm?: (name: string) => Promise<unknown>
}): PluginCliRun {
  const env = pluginCliEnv(d.baseEnv, d.home)
  const resolve = d.resolve ?? resolveWindowsExecutable
  const warm = d.warm ?? warmWindowsExecutable
  return async (args, o = {}) => {
    const full = args.includes('--json') ? args : [...args, '--json']
    // Looked up off the thread first (audit U-10): `resolve` then reads the kept answer instead of walking PATH
    // synchronously, which a dead drive on PATH held for 20 to 60 s. A failed warm leaves `resolve` to look itself.
    if (d.platform === 'win32') await warm('claude').catch(() => null)
    // As a session starts it: by name on posix; on win32 by the file PATH names, else by the bare name with no shell,
    // which then fails to start (windowsSpawn's rule for a name PATH does not know)
    const found = d.platform === 'win32' ? resolve('claude') : null
    const cmd = found === null ? { file: 'claude', args: full, env } : commandFor(found, d.platform, full, env)
    if ('refusal' in cmd) {
      // cmdRefusal's advice after the ';' is for registering an MCP client by hand; only its diagnosis applies here
      const refused = `${cmd.refusal.split(';')[0]}; nothing was run`
      return { code: null, json: null, stdout: '', stderr: '', timedOut: false, refused }
    }
    return new Promise((answer) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false
      let limit: NodeJS.Timeout | undefined
      let grace: NodeJS.Timeout | undefined
      const finish = (code: number | null, extra = ''): void => {
        if (settled) return
        settled = true
        clearTimeout(limit)
        clearTimeout(grace)
        stderr += extra
        answer({ code, json: jsonOf(stdout), stdout, stderr, timedOut })
      }
      let child: ChildProcess
      try {
        const opts: SpawnOptions = { env: cmd.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
        child = (d.spawn ?? nodeSpawn)(cmd.file, cmd.args, opts)
      } catch (e) {
        finish(127, String(e))
        return
      }
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (s: string) => { stdout += s })
      child.stderr?.on('data', (s: string) => { stderr += s })
      child.on('error', (e) => finish(127, `${stderr === '' ? '' : '\n'}${String(e)}`))
      child.on('close', (code) => finish(code))
      const ms = o.timeoutMs ?? PLUGIN_COMMAND_TIMEOUT_MS
      limit = setTimeout(() => {
        timedOut = true
        stderr += `${stderr === '' ? '' : '\n'}claude did not finish within ${Math.round(ms / 1000)} s`
        // After a kill the exit is the answer: a process the child started may still hold the pipes open
        child.once('exit', (code) => finish(code))
        grace = setTimeout(() => finish(child.exitCode, '\nclaude did not exit after the kill'), KILL_GRACE_MS)
        // The whole tree: on win32 claude may run under cmd.exe
        killProcessTree(child)
      }, ms)
    })
  }
}
