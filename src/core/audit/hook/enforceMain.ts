// The Enforce hook's entry (enforce design §5): bundled into one file by the build (electron.vite.enforceHook.ts) and
// written into the profile beside the Rules, where `<Astera's node> astera-enforce-hook.cjs <claude|codex>` runs it for
// each tool call. It always exits 0: a deny is printed, never signalled by a failure the CLIs would let through.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { runEnforceHook, unreadableCallDeny } from './enforceHook'

const profileDir = __dirname
const provider = process.argv[2] === 'codex' ? 'codex' : 'claude'

/** Blocks this thread for `ms`: the hook is one short process, and a busy rules file is retried in place. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function readRules(): string | null {
  try {
    return readFileSync(path.join(profileDir, 'audit-policy.json'), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function append(file: string, line: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, line)
}

function finish(stdin: string): void {
  let out: string
  try {
    out = runEnforceHook({
      stdin,
      provider,
      profileDir,
      sessionId: process.env.ASTERA_SESSION,
      platform: process.platform,
      now: Date.now,
      readRules,
      append,
      sleep: sleepSync
    })
  } catch {
    out = unreadableCallDeny()
  }
  process.stdout.write(out, () => process.exit(0))
}

const chunks: Buffer[] = []
process.stdin.on('data', (c: Buffer) => chunks.push(c))
process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
process.stdin.on('error', () => finish(''))
