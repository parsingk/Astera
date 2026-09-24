// Ending a Host that has stopped answering (docs/2026-09-22-host-unresponsive-recovery-design.md F5).
//
// The ordinary way to replace a Host is to ask it: `retire`, and it ends its ptys and leaves. That
// needs a Host that reads its socket. The one this exists for does not — measured 2026-09-22, an
// event loop stuck inside node-pty's `ConnectNamedPipe`, accepting connections and answering none of
// them — so the only thing left is its pid.
//
// **Which makes checking that pid the whole job.** A pid is not a name: it outlives the process it
// belonged to, and Windows hands the number out again. The number here can come from a file an
// earlier Host left behind, so by the time somebody presses the button it may belong to anything at
// all. Nothing is ended before its executable has been read back and matched against the one this app
// starts a Host with, and any doubt at all means it is left alone.
//
// Pure, with the platform as an argument, for the reason `address.ts` and `runtime.ts` give: these
// tests run on windows, macos and ubuntu.
import path from 'node:path'
import { foldPathCase } from '../../core/files/paths'

/** What to run to learn a pid's executable, or null on a platform that needs no command — linux
 *  answers from `/proc/<pid>/exe`, which the caller reads directly. */
export function executableProbe(platform: NodeJS.Platform, pid: number): { file: string; args: string[] } | null {
  if (platform === 'win32') {
    // `-NoProfile` because a profile can take seconds and can print; `(Get-Process …).Path` writes the
    // path alone, and writes nothing at all for a pid that is gone.
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`]
    }
  }
  if (platform === 'darwin') return { file: 'ps', args: ['-p', String(pid), '-o', 'comm='] }
  return null
}

/** The path a probe printed, or null when it printed nothing worth reading. */
export function parseExecutablePath(stdout: string): string | null {
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '')
  return line ?? null
}

/**
 * Whether the pid may be ended.
 *
 * `skip-gone` and `skip-mismatch` are both "do not touch it", and they are kept apart because they
 * read differently to a person: one is a Host that has already ended, and the other is a process that
 * was never ours and needs saying out loud.
 */
export function hostKillPlan(a: {
  platform: NodeJS.Platform
  /** What this app would start a Host with — the runtime's `node.exe`, or the app executable. */
  expectedExe: string
  /** What the pid actually is, or null when it could not be read. */
  actualExe: string | null
}): 'kill' | 'skip-gone' | 'skip-mismatch' {
  if (!a.actualExe) return 'skip-gone'
  return samePath(a.platform, a.expectedExe, a.actualExe) ? 'kill' : 'skip-mismatch'
}

/** One file or two. Separators are not differences on win32 and are on posix; case follows the
 *  filesystem (foldPathCase: folded on win32 and darwin, kept on linux). */
function samePath(platform: NodeJS.Platform, a: string, b: string): boolean {
  const norm = (p: string): string => {
    const resolved = path.resolve(p.trim())
    return foldPathCase(platform === 'win32' ? resolved.replace(/\//g, '\\') : resolved, platform)
  }
  return norm(a) === norm(b)
}

/** What to run to end the Host, or null where `process.kill` is enough.
 *
 *  win32 takes the tree: the Host owns a `conhost.exe` per pty and the shells under them, and ending
 *  only the parent would leave those behind holding the console handles. */
export function killHostCommand(platform: NodeJS.Platform, pid: number): { file: string; args: string[] } | null {
  if (platform !== 'win32') return null
  return { file: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] }
}
