// How Astera's check runner (src/sandboxCheck/index.ts) tells a sandbox that failed while a check was being put in it from
// a check that ran and failed (Task K fix round 2, M1). The first is not the code's failure: the check-unavailable question
// asks a person (rule E5), where a failure would start a repair round that spends a model on code nobody broke. The two are
// told apart by markers the runner sets itself, never by reading what the sandbox printed:
// - the runner's own failure (srt's setup threw, `codex sandbox` stopped before the check started, a spawn failed) ends
//   with its own exit code and its own short mark as the last thing it prints (sandboxFailedOutput). The reason goes to a
//   file the launcher named (CHECK_REASON_ENV), since on Windows the output reaches the validator through ConPTY, which
//   glues and breaks long lines (fix round 3);
// - `codex sandbox` on Windows exits 1 both for its own failure ("windows sandbox failed: …", debug_sandbox.rs:568-573,
//   599-604 at rust-v0.160.0) and for a check that exited 1, so the check's shell prints CHECK_STARTED_MARK as a line of its
//   own before it runs the check (checkShell.ts); the runner takes that line out of the output and knows the check started.
// Codex's Windows sandbox gives the command pipes, not a console (`tty: false` in run_command_under_windows_session), so the
// runner reading codex's output through a pipe changes nothing the check sees. On macOS and Linux a Codex check runs as
// before, straight in its pty: a pipe there would take the check's terminal away.
import { randomUUID } from 'node:crypto'
import path from 'node:path'

/** The runner's exit code when it could not put the check in the sandbox: under 126 and 127, which POSIX gives a command
 *  that is not executable or not found, and under the 128 + n of a signal (Shell Command Language, "Exit Status for
 *  Commands"). A check may end with it too; only with the runner's own mark last is it read as the runner's. */
export const SANDBOX_FAILED_EXIT_CODE = 125
/** What the runner prints last when it could not put the check in the sandbox: short enough that no terminal wraps it,
 *  letters and dashes only. */
export const SANDBOX_FAILED_MARK = 'astera-sandbox-failed'
/** The variable naming the file the runner writes its reason to (validation.ts names a fresh one for each run). */
export const CHECK_REASON_ENV = 'ASTERA_CHECK_REASON_FILE'

/** What the runner prints when it could not put the check in the sandbox: its reason for a person reading the run, then
 *  its mark as the very last thing. */
export const sandboxFailedOutput = (detail: string): string =>
  `\r\nAstera could not put the check in the sandbox: ${detail.replace(/\s+/g, ' ').trim()}\r\n${SANDBOX_FAILED_MARK}\r\n`

/**
 * Whether a check's run ended as the runner's own failure: its exit code, and its mark at the very end of the output (with
 * the escapes stripped). Read by `endsWith` on the whole tail, not by a line's start: through ConPTY a line can arrive glued
 * to the one before it (a jump between rows is a cursor move, which stripping leaves as nothing) or broken where it wraps,
 * and the mark, short and printed last, still ends the output either way (fix round 3, measured with node-pty). Any other
 * code, or that code without the mark last, is the check's own result.
 */
export function sandboxStoppedBefore(exitCode: number, output: string): boolean {
  return exitCode === SANDBOX_FAILED_EXIT_CODE && output.trimEnd().endsWith(SANDBOX_FAILED_MARK)
}

/** A fresh file for one run's reason, in `dir`. */
export const checkReasonFileIn = (dir: string): string => path.join(dir, `failed-${randomUUID()}.txt`)

/** What a Windows check's shell prints as its own line before it runs the check (checkShell.ts): letters and dashes only,
 *  so cmd.exe's `echo` prints it as it is. */
export const CHECK_STARTED_MARK = 'astera-check-started'
/** The runner's first argument when it runs `codex sandbox` (the rest is codex's command, as it is). */
export const CODEX_CHECK_FLAG = '--codex'

/** `codex sandbox` as the runner waits on it: its output piped, so the runner sees the mark. */
export interface CodexCheckChild {
  stdout: { on(event: 'data', fn: (chunk: Buffer) => void): unknown }
  stderr: { on(event: 'data', fn: (chunk: Buffer) => void): unknown }
  on(event: 'close', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

/** Signal numbers for an exit code a shell would give (128 + n); a signal not listed reads 128. */
const SIGNALS: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }
/** Output held while the mark has not come: past this, codex printed more than a launch ever does, so it is let through
 *  and the check is taken as started (its own exit code then stands). */
const HOLD_MAX = 64 * 1024

/** Where the mark stands as a whole line in `b` (after the start or a line end, before `\n` or `\r\n`): the bytes to drop.
 *  Null when it is not there yet, or not yet followed by its line end. */
function markLineIn(b: Buffer): { start: number; end: number } | null {
  const mark = Buffer.from(CHECK_STARTED_MARK)
  for (let at = b.indexOf(mark); at !== -1; at = b.indexOf(mark, at + 1)) {
    if (at > 0 && b[at - 1] !== 0x0a) continue
    const after = at + mark.length
    if (b[after] === 0x0a) return { start: at, end: after + 1 }
    if (b[after] === 0x0d && b[after + 1] === 0x0a) return { start: at, end: after + 2 }
  }
  return null
}

/**
 * Runs `codex sandbox` (its command as windowsSpawn builds it) and resolves with the check's exit code once the check's
 * shell said it started. Codex's output goes on as it comes, without the mark's line. Rejects, with codex's own last line,
 * when codex stops before the check started (its sandbox could not be put around it) or cannot be started at all.
 */
export function runCodexCheck(o: {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
  spawn: (file: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => CodexCheckChild
  out: (chunk: Buffer) => void
  err: (chunk: Buffer) => void
}): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = o.spawn(o.file, o.args, { env: o.env })
    let started = false
    let held = Buffer.alloc(0)
    let errTail = ''
    child.stdout.on('data', (chunk) => {
      if (started) return o.out(chunk)
      held = Buffer.concat([held, chunk])
      const line = markLineIn(held)
      if (line === null && held.length <= HOLD_MAX) return
      started = true
      const rest = line === null ? held : Buffer.concat([held.subarray(0, line.start), held.subarray(line.end)])
      held = Buffer.alloc(0)
      if (rest.length > 0) o.out(rest)
    })
    child.stderr.on('data', (chunk) => {
      errTail = (errTail + chunk.toString()).slice(-2048)
      o.err(chunk)
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (held.length > 0) o.out(held)
      const result = signal ? 128 + (SIGNALS[signal] ?? 0) : (code ?? 1)
      if (started || result === 0) return resolve(result)
      const said = errTail.split(/\r?\n/).filter((l) => l.trim() !== '').at(-1)?.trim()
      reject(new Error(`codex sandbox stopped with exit code ${result} before the check started${said ? `: ${said}` : ''}`))
    })
  })
}

/**
 * The runner's exit code for its arguments (src/sandboxCheck/index.ts): an srt check from its one argument, a Codex check
 * from the command after CODEX_CHECK_FLAG, each with the check's own exit code; and when it could not put the check in the
 * sandbox (`srt` or `codex` rejects), SANDBOX_FAILED_EXIT_CODE, its reason handed to `record` first (the file the launcher
 * named), then sandboxFailedOutput printed, its mark last.
 */
export async function checkRunnerExit(o: {
  argv: string[]
  srt(payload: string): Promise<number>
  codex(file: string, args: string[]): Promise<number>
  print(text: string): void
  record(reason: string): void
}): Promise<number> {
  try {
    if (o.argv[0] !== CODEX_CHECK_FLAG) return await o.srt(o.argv[0] ?? '')
    const [file, ...args] = o.argv.slice(1)
    if (file === undefined) throw new Error('the codex command to run was not given')
    return await o.codex(file, args)
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim()
    // The mark is enough to read the case; a reason that could not be kept costs only the person's words
    try {
      o.record(reason)
    } catch {}
    o.print(sandboxFailedOutput(reason))
    return SANDBOX_FAILED_EXIT_CODE
  }
}

/** How a session manager starts a Windows Codex check through the runner. */
export interface CodexCheckRunner {
  /** The runner for `cmd` (codex's own command, windowsSpawn's shape): Astera's own executable as node on `runnerPath`. */
  launch(cmd: { file: string; args: string[] }): { file: string; args: string[]; env: Record<string, string> }
}

export function codexCheckRunner(o: { execPath: string; runnerPath: string }): CodexCheckRunner {
  return { launch: (cmd) => ({ file: o.execPath, args: [o.runnerPath, CODEX_CHECK_FLAG, cmd.file, ...cmd.args], env: { ELECTRON_RUN_AS_NODE: '1' } }) }
}
