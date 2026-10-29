// Astera's runner for one sandboxed Task's check (Task K): run by the app's or the Host's own executable as node, outside
// the sandbox it puts the check in, as srt's own CLI is. It reads nothing but its arguments, and lives in the installed app,
// which a sandboxed session cannot write (core/sandbox/locations.ts sandboxReadOnly).
// - A Claude check on macOS and Linux (core/sandbox/srtCheck.ts): its one argument is the check (SrtCheckPayload as JSON).
// - A Codex check on Windows (fix round 2, core/sandbox/checkRunner.ts): `--codex` and then `codex sandbox`'s command as it
//   is; the runner learns from the check's shell that the check started.
// Its exit code is the check's; when it could not put the check in the sandbox, its own (checkRunner.ts
// SANDBOX_FAILED_EXIT_CODE) with its line last, which the validator reads as a check that could not be made, not a failure.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { checkRunnerExit, runCodexCheck } from '../core/sandbox/checkRunner'
import { loadSrt, runInSrt, srtHelpersOf, type SrtCheckPayload } from '../core/sandbox/srtCheck'

const SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const
/** The environment a check's process gets: this runner's without Astera's node flag. */
const { ELECTRON_RUN_AS_NODE: _flag, ...childEnv } = process.env

async function srtCheck(raw: string): Promise<number> {
  const payload = JSON.parse(raw || 'null') as SrtCheckPayload | null
  if (!payload || typeof payload.command !== 'string' || typeof payload.cwd !== 'string') throw new Error('the check to run was not given')
  // Where the package resolves from (inside app.asar in a packaged app): its helpers are named by their unpacked paths
  const packageRoot = path.dirname(createRequire(__filename).resolve('@anthropic-ai/sandbox-runtime/package.json'))
  return runInSrt({
    payload,
    helpers: srtHelpersOf(packageRoot, process.arch, process.platform),
    load: loadSrt,
    spawn: (command, opts) => {
      const child = spawn(command, { shell: true, stdio: 'inherit', cwd: opts.cwd, env: opts.env })
      // A stop of the check (its pty's hangup, or a signal) reaches the command too
      for (const signal of SIGNALS) process.on(signal, () => child.kill(signal))
      return child
    },
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    env: process.env,
    warn: (m) => process.stderr.write(`${m}\n`)
  })
}

function codexCheck(file: string, args: string[]): Promise<number> {
  return runCodexCheck({
    file,
    args,
    env: childEnv,
    // codex's output piped, for the mark; its input the pty's, as before. Codex's Windows sandbox hands the check pipes
    // anyway (checkRunner.ts)
    spawn: (f, a, opts) => {
      const child = spawn(f, a, { stdio: ['inherit', 'pipe', 'pipe'], env: opts.env, windowsHide: true })
      for (const signal of SIGNALS) process.on(signal, () => child.kill(signal))
      return child
    },
    out: (b) => void process.stdout.write(b),
    err: (b) => void process.stderr.write(b)
  })
}

void checkRunnerExit({ argv: process.argv.slice(2), srt: srtCheck, codex: codexCheck, print: (s) => void process.stdout.write(s) }).then((code) =>
  // A console's writes are asynchronous on Windows: exit once what was written has gone out
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
)
