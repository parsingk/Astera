// What the transcript and git-dir watchers share: a non-recursive `fs.watch` on one directory that
// can be re-armed by a sweep, and the size/mtime stamp the sweep compares. Built after
// core/hooks/eventWatcher.ts, without chokidar, because the Host imports these (src/host/importFence.test.ts).
import { watch, statSync, type FSWatcher } from 'node:fs'
import { dirIdentity, namesAPath } from '../../files/watchedDir'

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

export function sameStamp(a: Stamp, b: Stamp): boolean {
  return a === b || (a !== null && b !== null && a.size === b.size && a.mtimeMs === b.mtimeMs)
}

export interface DirWatch {
  armed(): boolean
  /** Starts the watch if it is not running, or restarts it when its directory is gone or replaced. A
   *  directory that cannot be watched (missing, EPERM) is logged once and left to the next arm(), which
   *  the owner's sweep calls. Never throws. */
  arm(): void
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
  return {
    armed: () => watcher !== null,
    arm() {
      if (watcher) {
        // On Linux and macOS a deleted watched directory raises no `error`: the watcher stays open on
        // a directory that is gone and a recreated one is never watched. So a directory that is missing,
        // or is not the one the watch was armed on, drops the watch here. (An inode the filesystem hands
        // back to the recreated directory goes unnoticed; the sweep still covers that case.)
        if (dirIdentity(dir) === ino) return
        drop()
      }
      // Read before the watch opens, and no watch without it: a watch whose directory has no id could
      // never tell that directory going (a null id equals "gone"), and a directory replaced in between
      // leaves this id older than the one watched, which the next check reads as replaced.
      const id = dirIdentity(dir)
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
    },
    close: drop
  }
}
