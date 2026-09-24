// Which process the Host is, written where an app that never got a `hello` can still read it
// (docs/2026-09-22-host-unresponsive-recovery-design.md F3).
//
// **Why the socket is not enough.** Everything the app knows about the Host arrives in the handshake,
// and the one case this exists for is the Host that accepts the connection and never answers it — a
// stuck event loop (2026-09-22). There is a Host, it holds a person's sessions, and the app cannot
// name it. Offering to restart it means being able to end it, and ending it means a pid.
//
// Shared between the two sides for the same reason `protocol.ts` is: the Host writes this file and the
// app reads it, and two copies of the format would be one copy too many.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** What the Host records about itself. `exe` is checked against what the app expects to have started
 *  before anything is ended, because a pid outlives the process it named and Windows reuses them. */
export interface HostPidFile {
  pid: number
  /** The same string the Host's `hello` carries, so a file left behind by an earlier Host can be told
   *  from the one the app is looking at. */
  startedAt: string
  /** The Host's own executable, from `process.execPath`. */
  exe: string
}

/** Beside `host.log`, in the profile the Host serves — the directory the log has already made. */
export function hostPidFilePath(profileDir: string): string {
  return path.join(profileDir, 'host', 'host.pid')
}

export function serializeHostPidFile(v: HostPidFile): string {
  return JSON.stringify(v)
}

/**
 * The record, or null for anything that is not a whole one.
 *
 * **Null on the slightest doubt, and that is the whole design of this function.** What is read here
 * decides which process gets ended. The file is written by something that can die mid-write, it sits
 * in a directory a person can open, and it can be left behind by a Host that exited badly — so a
 * field of the wrong type, a truncated line, or a pid that is not a plausible one has to read as "no
 * answer". "No answer" costs a person one manual step; a wrong answer ends somebody else's process.
 */
export function parseHostPidFile(text: string): HostPidFile | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const { pid, startedAt, exe } = v as { pid?: unknown; startedAt?: unknown; exe?: unknown }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  if (typeof startedAt !== 'string' || startedAt === '') return null
  if (typeof exe !== 'string' || exe === '') return null
  return { pid, startedAt, exe }
}

// ---- The app's own pid (host S3 Task 6, review I1) ----
//
// **Why the Host needs it.** "No app attached" does not mean "no app". An app that gave up on a Host
// whose event loop stalled runs its new sessions on local node-pty and does not reconnect, and every
// app runs alone for a while after a Host restart. Those sessions are invisible to the Host, so before
// it removes a worktree folder it asks this file whether an app is alive at all, and refuses if one
// is and is not attached (host/worktrees.ts).
//
// One decimal pid, nothing else. Written once the app holds the single-instance lock, removed on a
// clean quit; a crash leaves it behind, and a dead pid then reads as no app.
//
// **Pid reuse is not guarded against.** Reading back what executable a pid is costs a process spawn
// on Windows (`executableProbe`), too much for a check that runs per removal. A stale file whose pid
// Windows has since handed to another process makes the Host refuse a removal it could have done:
// the safe direction, cleared by opening and quitting Astera once, or by deleting the file.

export function appPidFilePath(profileDir: string): string {
  return path.join(profileDir, 'app.pid')
}

/** The app says it is running. Never throws: a profile it cannot write costs only this record. */
export function markAppRunning(profileDir: string, pid: number): void {
  try {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(appPidFilePath(profileDir), String(pid))
  } catch {
    /* without the file the Host reads "no app", which is the behaviour before this file existed */
  }
}

/** On a clean quit. Only a file that names this app: a second one's record is not this one's to drop. */
export function clearAppRunning(profileDir: string, pid: number): void {
  try {
    if (readFileSync(appPidFilePath(profileDir), 'utf8') === String(pid)) rmSync(appPidFilePath(profileDir), { force: true })
  } catch {
    /* no file, or nothing to do */
  }
}

/** The pid of a live app on this profile, or null: no file, not one pid, or a process that has ended. */
export function liveAppPid(profileDir: string): number | null {
  let text: string
  try {
    text = readFileSync(appPidFilePath(profileDir), 'utf8')
  } catch {
    return null
  }
  if (!/^[1-9][0-9]*$/.test(text)) return null
  const pid = Number(text)
  try {
    // Signal 0 asks whether the pid exists and does nothing to it; EPERM also means it does.
    process.kill(pid, 0)
    return pid
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? pid : null
  }
}
