import { promises as fs } from 'node:fs'
import path from 'node:path'

/** The coordinator's brief, named for the Run it manages. It lives in the same directory as the
 *  workers' spec files, so the boot sweep has to be able to recognise one; `startCoordinator` writes
 *  it. The name is here, in one place, so those two cannot drift. */
export const coordinatorBriefName = (runId: string): string => `coordinator-${runId}.md`

/**
 * Which of the spec directory's files a boot clears out. `files` is the directory listing, the rest
 * is the state the restart cleanup left behind, and the answer is the names to delete.
 *
 * The rule is short because the invariant behind it is: **a file in here is live exactly as long as
 * the thing that was told to read it is.** Two kinds live here.
 *
 * - A worker's spec, kept while its Dispatch is open. The worker was launched with "read this path
 *   and follow it", and `buildResumePacket` (orchestration/resumePacket.ts) writes the resume
 *   briefing back into that same file, acting only on an open Dispatch.
 *   **Open, not alive.** A Dispatch left open because its worker really is gone is one recovery may
 *   resume, and resuming reads the original spec — so keeping it is right there too, not lenient.
 * - A coordinator's brief, kept while the session managing that Run is one the Host handed back.
 *   `Run.coordinatorSessionId` is that session, and an adopted session keeps its id, so the match is
 *   direct. With no Host nothing was handed back and every brief goes, exactly as before the Host
 *   existed; with `'unknown'` every Run that has a coordinator keeps its brief, for the same reason
 *   the cleanup leaves Dispatches open on that answer.
 *
 * Matching is on the file name alone. `Dispatch.specPath` is an absolute path written by whichever
 * platform produced it, and orchestration.json is hand-edited, so both separators turn up; the names
 * themselves are unique. Taking a worker's name from the stored path rather than rebuilding it from
 * ids keeps that naming rule in the one place that owns it, `OrchCoordinator.startWorker`; a Run
 * stores no path for its brief, so that one name comes from `coordinatorBriefName`, which both this
 * and `startCoordinator` call.
 *
 * A pure function for the same reason `rollCoordinatorForSession` is one: the boot that calls it is
 * an electron-only closure inside `registerIpc`, and this decision deletes files.
 */
export function staleSpecFiles(a: {
  /** The spec directory's listing, as plain names. */
  files: readonly string[]
  /** Every Dispatch in the state the restart cleanup produced — open ones keep their spec. */
  dispatches: readonly { endedAt?: string; specPath: string }[]
  /** Every Run in that same state. */
  runs: readonly { id: string; coordinatorSessionId?: string }[]
  /** What the Host said about the sessions it still runs, in `load`'s own three answers. */
  live: ReadonlySet<string> | 'unknown' | undefined
}): string[] {
  const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? ''
  const keep = a.dispatches.filter((d) => !d.endedAt).map((d) => fileName(d.specPath))
  for (const r of a.runs) {
    if (r.coordinatorSessionId === undefined) continue
    if (a.live === 'unknown' || a.live?.has(r.coordinatorSessionId)) keep.push(coordinatorBriefName(r.id))
  }
  // The empty ones are dropped, not kept: `openDispatch` writes `specPath: ''` and the coordinator
  // fills it in once the worker is actually up, so a Dispatch caught in that window would otherwise
  // hold an empty name that must not be allowed to match anything.
  const live = new Set(keep.filter((n) => n !== ''))
  return a.files.filter((f) => !live.has(f))
}

/**
 * The sweep itself: `staleSpecFiles` over the directory's listing, then each of those files removed.
 * Run by whichever process owns the sweep: the Host at its own load when it announces `spawn`, since
 * from then on it writes specs too and is the one process that knows every writer is past its
 * restart; otherwise the app at its boot, as before.
 *
 * **Never throws.** A failed cleanup must never block the load or the boot that runs it: an
 * unreadable directory yields nothing to delete, and one file that will not go does not cost the rest
 * their turn. The worst outcome is a stale file nobody reads, which the next sweep retries. The answer
 * is the names that were removed, for the caller's log line.
 */
export async function sweepStaleSpecFiles(a: {
  dir: string
  /** The state the restart cleanup produced. */
  state: {
    dispatches: readonly { endedAt?: string; specPath: string }[]
    runs: readonly { id: string; coordinatorSessionId?: string }[]
  }
  live: ReadonlySet<string> | 'unknown' | undefined
}): Promise<string[]> {
  const files = await fs.readdir(a.dir).catch((): string[] => [])
  const removed: string[] = []
  for (const name of staleSpecFiles({ files, dispatches: a.state.dispatches, runs: a.state.runs, live: a.live })) {
    const gone = await fs
      .rm(path.join(a.dir, name), { recursive: true, force: true })
      .then(() => true)
      .catch(() => false)
    if (gone) removed.push(name)
  }
  return removed
}
