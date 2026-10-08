// What the transcript and git-dir watchers share: a non-recursive `fs.watch` on one directory that
// can be re-armed by a sweep, and the size/mtime stamp the sweep compares. Built after
// core/hooks/eventWatcher.ts, without chokidar, because the Host imports these (src/host/importFence.test.ts).
import { watch, statSync, promises as fsp, type FSWatcher } from 'node:fs'
import { dirIdentity, dirIdentityAsync, namesAPath } from '../../files/watchedDir'

/** How often the sweep runs. fs.watch sometimes delivers nothing at all (measured on macOS, see
 *  HookEventWatcher.sweep), so the sweep is what bounds the delay of a dropped event. */
export const WATCH_SWEEP_MS = 10_000
/** A session writes its transcript, and git its index, HEAD and reflog, in bursts; one call per burst. */
export const WATCH_DEBOUNCE_MS = 100

export type Stamp = { size: number; mtimeMs: number } | null

/** null when the file is not there (yet), which compares unequal to any real stamp. */
export function stampOf(file: string): Stamp {
  try {
    const s = statSync(file)
    return { size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

/** stampOf without blocking the thread (performance audit H3): what the sweep reads. */
export async function stampOfAsync(file: string): Promise<Stamp> {
  try {
    const s = await fsp.stat(file)
    return { size: s.size, mtimeMs: s.mtimeMs }
  } catch {
    return null
  }
}

/** The sweep's reads, injectable so a test with fake timers can have them answer within the tick it advances. */
export interface SweepReads {
  stat(file: string): Promise<Stamp>
  identity(dir: string): Promise<bigint | null>
}
export const realSweepReads: SweepReads = { stat: stampOfAsync, identity: dirIdentityAsync }

/** A sweep check that took this long is a folder that stopped answering (a share gone away). Its reads are
 *  asynchronous, so it never holds the process's thread; it is left out of the sweep for SLOW_PAUSE_MS so it does not
 *  tie up a pool thread every sweep either (performance audit H3). */
export const SLOW_CHECK_MS = 1_000
export const SLOW_PAUSE_MS = 10 * 60_000

/** Each sweep key's check, one at a time. `run(key, check)` starts the check unless its key is paused or its last check
 *  has not finished (a folder that does not answer holds one read, never a pile of them), and pauses it (logging once
 *  per pause) when the check took SLOW_CHECK_MS or more. Never rejects. */
export function slowGuard(now: () => number, log: (m: string) => void): { run(key: string, check: () => Promise<void>): void; forget(key: string): void } {
  const pausedUntil = new Map<string, number>()
  const inFlight = new Set<string>()
  return {
    run(key, check) {
      if (inFlight.has(key)) return
      const until = pausedUntil.get(key)
      if (until !== undefined && now() < until) return
      pausedUntil.delete(key)
      const started = now()
      inFlight.add(key)
      void check()
        .catch((err: unknown) => log(`sweep of ${key} failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          inFlight.delete(key)
          const took = now() - started
          if (took >= SLOW_CHECK_MS) {
            pausedUntil.set(key, now() + SLOW_PAUSE_MS)
            log(`${key} was slow to check (${took} ms); leaving it out of the sweep for ${SLOW_PAUSE_MS / 60_000} min`)
          }
        })
    },
    forget: (key) => {
      pausedUntil.delete(key)
      inFlight.delete(key)
    }
  }
}

export function sameStamp(a: Stamp, b: Stamp): boolean {
  return a === b || (a !== null && b !== null && a.size === b.size && a.mtimeMs === b.mtimeMs)
}

export interface DirWatch {
  armed(): boolean
  /** Starts the watch if it is not running, or restarts it when its directory is gone or replaced. A
   *  directory that cannot be watched (missing, EPERM) is logged once and left to the next arm(), which
   *  the owner's sweep calls. Never throws. */
  arm(): void
  /** arm() with the directory's identity read asynchronously (the sweep's, performance audit H3). */
  armAsync(identity?: (dir: string) => Promise<bigint | null>): Promise<void>
  close(): void
}

export function dirWatch(
  dir: string,
  onName: (name: string) => void,
  log: (m: string) => void,
  /** Test seam; node's fs.watch when left out. */
  watchFn: typeof watch = watch
): DirWatch {
  let watcher: FSWatcher | null = null
  let ino: bigint | null = null // of the directory the running watch was armed on
  let failureLogged = false
  let closed = false
  const drop = (): void => {
    try {
      watcher?.close()
    } catch {
      /* closing a watcher that already failed changes nothing */
    }
    watcher = null
  }
  const notWatchable = (why: string): void => {
    if (!failureLogged) log(`watch failed on ${dir}, relying on the sweep: ${why}`)
    failureLogged = true
  }
  /** `id`: the directory's identity now. */
  const armWith = (id: bigint | null): void => {
      if (closed) return
      if (watcher) {
        // On Linux and macOS a deleted watched directory raises no `error`: the watcher stays open on
        // a directory that is gone and a recreated one is never watched. So a directory that is missing,
        // or is not the one the watch was armed on, drops the watch here. (An inode the filesystem hands
        // back to the recreated directory goes unnoticed; the sweep still covers that case.)
        if (id === ino) return
        drop()
      }
      // Read before the watch opens, and no watch without it: a watch whose directory has no id could
      // never tell that directory going (a null id equals "gone"), and a directory replaced in between
      // leaves this id older than the one watched, which the next check reads as replaced.
      if (id === null) return notWatchable('the directory is not there')
      try {
        const w = watchFn(dir, (_event, filename) => {
          // A null filename names nothing this watch can filter on; the sweep covers that platform.
          if (!filename) return
          const name = filename.toString()
          // **The watched directory itself was removed** (a worktree's git dir after `git worktree
          // remove`, say; watchedDir.ts has the win32 measurement): the watch fires events named after
          // the directory's own path without a pause until it is closed. A directory that is no longer
          // the one armed drops the watch here, and the owner's sweep arms it again if it comes back.
          if (namesAPath(name)) {
            if (watcher === w && dirIdentity(dir) !== ino) {
              log(`watch on ${dir} closed: the directory was removed or replaced`)
              drop()
            }
            return
          }
          onName(name)
        })
        // A watched directory that is deleted errors here; drop it so the sweep re-arms it if it returns.
        w.on('error', (err) => {
          log(`watch error on ${dir}: ${err.message}`)
          if (watcher === w) drop()
        })
        // The fs.watch handle is ref'd and keeps the event loop alive until close(). That is fine for the
        // Host, a long-running process that closes its watchers when it stops.
        watcher = w
        ino = id
        failureLogged = false
      } catch (err) {
        notWatchable(err instanceof Error ? err.message : String(err))
      }
  }
  return {
    armed: () => watcher !== null,
    arm: () => armWith(dirIdentity(dir)),
    armAsync: async (identity = dirIdentityAsync) => armWith(await identity(dir)),
    close: () => {
      closed = true
      drop()
    }
  }
}
