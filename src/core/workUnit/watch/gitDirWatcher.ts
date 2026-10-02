// Git-dir watcher for the Host, which cannot use the app's GitWatcher (src/main/gitWatcher.ts, chokidar;
// src/host/importFence.test.ts bans it). Tells its owner that a project's index or HEAD moved, by
// project root; what moved is read by the collector's next pass. Notices what GitWatcher notices:
//
// - <gitdir>/index and <gitdir>/HEAD: adds, commits, branch switches. The git dir is watched as a
//   directory, not the files, because git writes index.lock and renames it over index; the rename
//   shows up as an event named `index`, and a directory watch survives the swap.
// - <gitdir>/logs/HEAD, and nothing else in logs/: every HEAD move appends to it, including the ones
//   that rewrite a ref in place and touch neither index nor HEAD (commit --allow-empty, commit --amend,
//   reset --soft, update-ref; GitWatcher's header has the measurement). fetch does not touch it.
//
// Both directories are watched non-recursively, plus a sweep over the three files' size and mtime,
// which also arms a watch that could not start (a fresh repository has no logs/ yet). Never throws.
import path from 'node:path'
import { WATCH_DEBOUNCE_MS, WATCH_SWEEP_MS, dirWatch, sameStamp, stampOf, type DirWatch, type Stamp } from './dirWatch'

/** The files, relative to the git dir, whose change means a refresh. */
const SWEPT = ['index', 'HEAD', path.join('logs', 'HEAD')]

export interface GitDirWatcher {
  watch(root: string): void
  unwatch(root: string): void
  close(): void
}

interface Entry {
  dir: string | null
  stamps: Stamp[]
  watches: DirWatch[]
  timer: NodeJS.Timeout | null
}

export function createGitDirWatcher(d: {
  onChange(root: string): void
  log(m: string): void
  gitDir(root: string): Promise<string | null>
  sweepMs?: number
  debounceMs?: number
}): GitDirWatcher {
  const debounceMs = d.debounceMs ?? WATCH_DEBOUNCE_MS
  const roots = new Map<string, Entry>()
  let closed = false

  const stampsOf = (dir: string): Stamp[] => SWEPT.map((rel) => stampOf(path.join(dir, rel)))

  const fire = (root: string): void => {
    const e = roots.get(root)
    if (!e || !e.dir) return
    e.timer = null
    e.stamps = stampsOf(e.dir)
    try {
      d.onChange(root)
    } catch (err) {
      d.log(`git-dir watcher onChange failed for ${root}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const schedule = (root: string): void => {
    const e = roots.get(root)
    if (!e || e.timer) return
    e.timer = setTimeout(() => fire(root), debounceMs)
    e.timer.unref?.()
  }

  const start = (root: string, e: Entry, dir: string): void => {
    e.dir = dir
    e.stamps = stampsOf(dir)
    e.watches = [
      dirWatch(dir, (name) => (name === 'index' || name === 'HEAD') && schedule(root), d.log),
      dirWatch(path.join(dir, 'logs'), (name) => name === 'HEAD' && schedule(root), d.log)
    ]
    for (const w of e.watches) w.arm()
  }

  const sweep = (): void => {
    for (const [root, e] of roots) {
      if (!e.dir) continue
      for (const w of e.watches) w.arm()
      const now = stampsOf(e.dir)
      if (now.some((s, i) => !sameStamp(s, e.stamps[i]))) schedule(root)
    }
  }
  const sweeper = setInterval(sweep, d.sweepMs ?? WATCH_SWEEP_MS)
  sweeper.unref?.()

  return {
    // Roots are resolved, so one root spelled two ways is one entry. Case is the caller's: on Windows,
    // two spellings that differ only in case are two entries.
    watch(given) {
      const root = path.resolve(given)
      if (closed || roots.has(root)) return
      const e: Entry = { dir: null, stamps: [], watches: [], timer: null }
      roots.set(root, e)
      // Resolved once per watch, and not on the sweep. A root with no git dir (not a repository, git
      // failed) leaves no entry, so the next watch(root) asks again, as GitWatcher.watch does.
      const ours = (): boolean => !closed && roots.get(root) === e
      const fail = (err: unknown): void => {
        // Unwatched, rewatched or closed while git answered: this answer belongs to nobody.
        if (!ours()) return
        roots.delete(root)
        d.log(`git-dir watcher could not resolve the git dir of ${root}: ${err instanceof Error ? err.message : String(err)}`)
      }
      let asked: Promise<string | null>
      try {
        asked = d.gitDir(root)
      } catch (err) {
        fail(err)
        return
      }
      asked.then((dir) => {
        if (!ours()) return
        if (dir) return start(root, e, dir)
        roots.delete(root)
        d.log(`git-dir watcher: ${root} is not a git repository, not watched`)
      }, fail)
    },
    unwatch(given) {
      const root = path.resolve(given)
      const e = roots.get(root)
      if (!e) return
      if (e.timer) clearTimeout(e.timer)
      for (const w of e.watches) w.close()
      roots.delete(root)
    },
    close() {
      closed = true
      clearInterval(sweeper)
      for (const e of roots.values()) {
        if (e.timer) clearTimeout(e.timer)
        for (const w of e.watches) w.close()
      }
      roots.clear()
    }
  }
}
