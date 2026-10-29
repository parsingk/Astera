// Astera's runner for one sandboxed Claude Task's check (Task K, core/sandbox/srtCheck.ts): run by the app's or the Host's
// own executable as node, outside the sandbox it puts the check in, as srt's own CLI is. Its one argument is the check
// (SrtCheckPayload as JSON); its exit code is the check's. It reads nothing else, and lives in the installed app, which a
// sandboxed session cannot write (core/sandbox/locations.ts sandboxReadOnly).
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { loadSrt, runInSrt, type SrtCheckPayload } from '../core/sandbox/srtCheck'

async function main(): Promise<number> {
  const payload = JSON.parse(process.argv[2] ?? 'null') as SrtCheckPayload | null
  if (!payload || typeof payload.command !== 'string' || typeof payload.cwd !== 'string') throw new Error('the check to run was not given')
  return runInSrt({
    payload,
    load: loadSrt,
    spawn: (command, opts) => {
      const child = spawn(command, { shell: true, stdio: 'inherit', cwd: opts.cwd, env: opts.env })
      // A stop of the check (its pty's hangup, or a signal) reaches the command too
      for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
      return child
    },
    mkdir: (dir) => mkdirSync(dir, { recursive: true }),
    env: process.env
  })
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`Astera could not run the check in the sandbox: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
)
