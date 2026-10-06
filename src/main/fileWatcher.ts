import chokidar, { type FSWatcher } from 'chokidar'
import { promises as fs, watch as fsWatch } from 'node:fs'
import type { EventEmitter } from 'node:events'
import path from 'node:path'
import { buildIgnoreMatcher } from '../core/files/tree'
import { dirIdentity, namesAPath } from '../core/files/watchedDir'
import { createChangeBatcher, type ChangeBatcher, type FileChangeBatch, type FileChangeKind } from '../core/files/changeBatch'

export type { FileChange, FileChangeKind } from '../core/files/changeBatch'

/** One native recursive handle — fs.watch(root, { recursive: true }, listener), injectable for tests. */
export type NativeWatch = (
  root: string,
  listener: (type: string, filename: string | null) => void
) => EventEmitter & { close: () => void }

const defaultNativeWatch: NativeWatch = (root, listener) =>
  fsWatch(root, { recursive: true }, (type, filename) => listener(type, filename === null ? null : String(filename)))

export interface FileWatcherDeps {
  platform?: NodeJS.Platform
  watchNative?: NativeWatch
}

/** Recursively watches one explorer root and emits changes. The watch exclusions are language-neutral
 *  (buildIgnoreMatcher).
 *
 *  **Windows: one native recursive handle.** chokidar puts an fs.watch on every file, and on Windows a
 *  file's watch is its folder's, so one change in a folder of thousands wakes thousands of handles —
 *  the cost grows with the square of the folder: deleting 1,500 files took 3.5s, 6,000 took 290s,
 *  against 0.16s with nothing watching, and the explorer's own delete ran at about 12 files a second
 *  (measured 2026-09-29). HistoryIndex made the same move for its own reasons. A native watcher only
 *  says rename or change, so a rename is looked up: there now → add/addDir, gone → both unlinkDir and
 *  unlink, since what it was is no longer knowable and the renderer handles each kind right for a path
 *  that was the other (a folder has no open tab, a file no cached listing).
 *
 *  **Elsewhere chokidar stays**: Node's recursive watch on Linux walks the whole tree itself, ignored
 *  folders like node_modules included, and macOS was not measured.
 *
 *  **quietWhile**: even one native handle makes a bulk copy several times slower (3,000 files 4s → 19s,
 *  measured), and a delete or copy the app does itself needs no watcher to learn what changed. So the
 *  handle is closed for its duration and each touched path's state is reported once afterwards.
 *
 *  Events leave in batches (createChangeBatcher, FILE_CHANGE_BATCH_MS): one IPC message per window
 *  instead of one per event, so a git checkout or npm install in the watched folder is a handful of
 *  messages rather than thousands. */
export class FileWatcher {
  private watcher: FSWatcher | null = null
  private native: (EventEmitter & { close: () => void }) | null = null
  private root: string | null = null
  private ignored: ((relPath: string) => boolean) | null = null
  // watch/unwatch serialisation chain — even when the calls overlap (fire-and-forget IPC, StrictMode double
  // invocation), it stops this.watcher being overwritten and leaking the previous chokidar instance without a close. Same pattern as HistoryIndex.reloading.
  private ops: Promise<void> = Promise.resolve()
  /** quietWhile calls running, and the paths they touch — reported once the last one ends. */
  private quiet = 0
  private quietPaths: string[] = []

  private batcher: ChangeBatcher
  private platform: NodeJS.Platform
  private watchNative: NativeWatch

  constructor(
    emit: (batch: FileChangeBatch) => void,
    private log: (m: string) => void = () => {},
    deps: FileWatcherDeps = {}
  ) {
    this.batcher = createChangeBatcher(emit)
    this.platform = deps.platform ?? process.platform
    this.watchNative = deps.watchNative ?? defaultNativeWatch
  }

  watch(root: string): Promise<void> {
    const p = this.ops.then(() => this.doWatch(root))
    this.ops = p.catch(() => {}) // Keeps the chain uncontaminated — one failed operation must not block later watch/unwatch calls
    return p
  }

  unwatch(): Promise<void> {
    const p = this.ops.then(() => this.close())
    this.ops = p.catch(() => {})
    return p
  }

  /** Runs a delete or copy the app itself does, with the native handle closed (see the class note).
   *  Overlapping calls reopen once, when the last ends — a failed one too. Paths outside the watched
   *  root are not reported. On chokidar it only runs `run`. */
  async quietWhile<T>(paths: string[], run: () => Promise<T>): Promise<T> {
    if (!this.native && this.quiet === 0) return run()
    this.quiet++
    this.quietPaths.push(...paths)
    this.closeNative()
    try {
      return await run()
    } finally {
      this.quiet--
      if (this.quiet === 0) {
        const touched = this.quietPaths
        this.quietPaths = []
        // Unwatched meanwhile (a root switch or the explorer closing): nothing to reopen or report
        if (this.root !== null) {
          this.openNative()
          await Promise.all(touched.map((p) => this.reportNow(p)))
        }
      }
    }
  }

  private async doWatch(root: string): Promise<void> {
    if (this.root === root && (this.watcher || this.native || this.quiet > 0)) return // A repeat request for the same root is ignored
    await this.close()
    let gitignore: string | null = null
    try {
      gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8')
    } catch {
      /* No .gitignore — the curated list only */
    }
    const ignored = buildIgnoreMatcher(gitignore)
    this.root = root
    this.ignored = ignored
    if (this.platform === 'win32') {
      if (this.quiet > 0) return // quietWhile opens it when the work ends
      if (this.openNative()) return
    }
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignored: (p: string) => ignored(path.relative(root, p))
    })
    const kinds: FileChangeKind[] = ['add', 'change', 'unlink', 'addDir', 'unlinkDir']
    for (const kind of kinds) this.watcher.on(kind, (p: string) => this.batcher.push({ path: p, kind }))
    this.watcher.on('error', (e) => this.log(`watch error: ${e instanceof Error ? e.message : String(e)}`))
  }

  /** Opens the native handle on the current root. False when it cannot be had (a missing root, no
   *  recursive support): the caller falls back to chokidar, as HistoryIndex does. */
  private openNative(): boolean {
    const root = this.root
    if (!root || this.native) return this.native !== null
    // Read before the handle opens (watchedDir.ts): a root replaced in between reads as replaced.
    const rootId = dirIdentity(root)
    try {
      const h = this.watchNative(root, (type, filename) => {
        // null when the platform cannot name the entry — nothing to point the tree at
        if (filename === null || this.native !== h) return
        // **The root itself was removed** (an open project folder deleted outside the app): win32 then
        // fires events named after the root's own path without a pause, and each one would become an
        // lstat. Never an entry, so never reported; a root that is no longer the one opened closes the
        // handle, and the explorer's next watch of it opens a new one.
        if (namesAPath(filename)) {
          if (rootId === null || dirIdentity(root) !== rootId) {
            this.log(`watch on ${root} closed: the folder was removed or replaced`)
            this.closeNative()
          }
          return
        }
        if (this.ignored?.(filename)) return
        const full = path.join(root, filename)
        if (type === 'change') this.batcher.push({ path: full, kind: 'change' })
        else void this.reportNow(full)
      })
      h.on('error', (e) => {
        this.log(`watch error: ${e instanceof Error ? e.message : String(e)}`)
        if (this.native === h) this.closeNative()
      })
      this.native = h
      return true
    } catch (e) {
      this.log(`native watch failed, using chokidar: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  private closeNative(): void {
    const h = this.native
    this.native = null
    try {
      h?.close()
    } catch {
      /* already closed */
    }
  }

  /** Reports what a path is now: add/addDir when it exists, unlinkDir + unlink when it is gone. */
  private async reportNow(full: string): Promise<void> {
    const root = this.root
    if (!root) return
    const rel = path.relative(root, full)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return
    try {
      const st = await fs.lstat(full)
      if (this.root !== root) return
      this.batcher.push({ path: full, kind: st.isDirectory() ? 'addDir' : 'add' })
    } catch (e) {
      if (this.root !== root || (e as NodeJS.ErrnoException).code !== 'ENOENT') return
      this.batcher.push({ path: full, kind: 'unlinkDir' })
      this.batcher.push({ path: full, kind: 'unlink' })
    }
  }

  async close(): Promise<void> {
    // What the closing watcher already saw still goes out — an open buffer must not miss its last change
    this.batcher.flush()
    this.closeNative()
    await this.watcher?.close().catch(() => {})
    this.watcher = null
    this.root = null
    this.ignored = null
  }
}
