// Whether node-pty is whole enough to spawn with (docs/2026-09-22-host-unresponsive-recovery-design.md F7).
//
// **Why a Host would ever ask.** On 2026-09-22 a session deleted `%LOCALAPPDATA%\astera` to clear the
// CLI's `bin` beside it. Windows refused to delete the two files the running Host had open — its
// `node.exe` and `conpty.node` — and deleted the rest, including node-pty's JavaScript half. The Host
// went on running from what it had already loaded, perfectly well, for three hours. Then somebody
// opened a session, and node-pty's Windows spawn reached for a file that was no longer there:
//
//   `lib/windowsPtyAgent.js` starts a worker thread from `lib/worker/conoutSocketWorker.js`, whose job
//   is to connect to the conout pipe. The native `connect()` then calls `ConnectNamedPipe` on that
//   pipe **synchronously**, waiting for exactly that worker. The worker had died on the missing file,
//   and its error event was queued for the event loop the main thread was now blocked inside. Nothing
//   could ever deliver it. The Host stopped answering anything at all, and there was no way back.
//
// So the check is not about tidiness. It is the difference between a spawn that fails with a sentence
// and a Host that stops existing while still holding a person's sessions.
//
// Pure, with the platform and the filesystem as arguments, for the reason `address.ts` gives: these
// tests run on windows, macos and ubuntu and must not ask the machine which one it is on.
import { win32 as w } from 'node:path'

/** The file node-pty reaches for at spawn time, relative to its own `lib`. Named here rather than
 *  written into a path so the one thing this module knows about node-pty's insides is in one place. */
export const CONOUT_WORKER = 'worker\\conoutSocketWorker.js'

/**
 * The path of the file node-pty needs and does not have, or null when there is nothing to report.
 *
 * Null covers three different "nothing to report"s on purpose, and all three mean *spawn anyway*:
 * the file is there; this is not win32, where there is no worker thread to lose; and the caller could
 * not work out where node-pty lives, or the filesystem would not answer. The last is the one worth
 * saying out loud — **a check that cannot be made is not a failure**. Refusing to spawn on it would
 * turn a rare, self-repairing fault into a Host that never starts a session again.
 */
export function nodePtyMissing(a: {
  platform: NodeJS.Platform
  /** node-pty's own `lib` directory, or null when the caller could not resolve it. */
  libDir: string | null
  exists(p: string): boolean
}): string | null {
  if (a.platform !== 'win32' || !a.libDir) return null
  const worker = w.join(a.libDir, CONOUT_WORKER)
  try {
    return a.exists(worker) ? null : worker
  } catch {
    return null
  }
}
