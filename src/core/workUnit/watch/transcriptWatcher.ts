// Transcript watcher for the Host, which cannot use the app's chokidar watcher (core/history imports
// chokidar; src/host/importFence.test.ts bans it). Tells its owner that a session's transcript file
// changed, by path; what changed is read by the collector itself (tail.ts, from its own cursor).
//
// One non-recursive fs.watch per directory, filtered to the watched file names, plus a sweep that
// compares each file's size and mtime: fs.watch sometimes drops events, and a transcript's directory
// may not exist yet when its session starts (the sweep then arms the watch). Never throws.
import path from 'node:path'
import { WATCH_DEBOUNCE_MS, WATCH_SWEEP_MS, dirWatch, sameStamp, slowGuard, stampOf, type DirWatch, type Stamp } from './dirWatch'

export interface TranscriptWatcher {
  watch(path: string): void
  unwatch(path: string): void
  close(): void
}

export function createTranscriptWatcher(d: {
  onChange(path: string): void
  log(m: string): void
  sweepMs?: number
  debounceMs?: number
  /** Milliseconds, for timing the sweep's checks; `performance.now` when left out. */
  now?: () => number
}): TranscriptWatcher {
  const slow = slowGuard(d.now ?? (() => performance.now()), d.log)
  const debounceMs = d.debounceMs ?? WATCH_DEBOUNCE_MS
  const files = new Map<string, { dir: string; name: string; stamp: Stamp; timer: NodeJS.Timeout | null }>()
  // dir -> its watch and the watched basenames in it, each with its full path
  const dirs = new Map<string, { w: DirWatch; names: Map<string, string> }>()
  let closed = false

  const fire = (p: string): void => {
    const f = files.get(p)
    if (!f) return
    f.timer = null
    // Taken when the call goes out, so the sweep does not report again what this call reported.
    f.stamp = stampOf(p)
    try {
      d.onChange(p)
    } catch (err) {
      d.log(`transcript watcher onChange failed for ${p}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // A fixed window from the first event, not a reset per event: a session that writes without pause
  // must still be reported every debounceMs.
  const schedule = (p: string): void => {
    const f = files.get(p)
    if (!f || f.timer) return
    f.timer = setTimeout(() => fire(p), debounceMs)
    f.timer.unref?.()
  }

  // Per directory, so one folder that stopped answering pauses its own files and nothing else (audit H3).
  const sweep = (): void => {
    for (const [dir, { w, names }] of dirs)
      slow.run(dir, () => {
        w.arm()
        for (const p of names.values()) {
          const f = files.get(p)
          if (f && !sameStamp(stampOf(p), f.stamp)) schedule(p)
        }
      })
  }
  // unref: a timer whose only job is to catch up must never be the reason the process stays alive.
  const sweeper = setInterval(sweep, d.sweepMs ?? WATCH_SWEEP_MS)
  sweeper.unref?.()

  return {
    // Paths are resolved, so one file spelled two ways is one entry. Case is the caller's: on Windows,
    // two spellings that differ only in case are two entries.
    watch(given) {
      const p = path.resolve(given)
      if (closed || files.has(p)) return
      const dir = path.dirname(p)
      const name = path.basename(p)
      files.set(p, { dir, name, stamp: stampOf(p), timer: null })
      const known = dirs.get(dir)
      if (known) {
        known.names.set(name, p)
        return
      }
      const names = new Map([[name, p]])
      const w = dirWatch(
        dir,
        (n) => {
          const fp = names.get(n)
          if (fp) schedule(fp)
        },
        d.log
      )
      dirs.set(dir, { w, names })
      w.arm()
    },
    unwatch(given) {
      const p = path.resolve(given)
      const f = files.get(p)
      if (!f) return
      if (f.timer) clearTimeout(f.timer)
      files.delete(p)
      const entry = dirs.get(f.dir)
      if (!entry) return
      entry.names.delete(f.name)
      if (entry.names.size > 0) return
      entry.w.close()
      dirs.delete(f.dir)
    },
    close() {
      closed = true
      clearInterval(sweeper)
      for (const f of files.values()) if (f.timer) clearTimeout(f.timer)
      files.clear()
      for (const { w } of dirs.values()) w.close()
      dirs.clear()
    }
  }
}
