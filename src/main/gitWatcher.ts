import chokidar, { type FSWatcher } from 'chokidar'
import path from 'node:path'
import { gitDir } from '../core/worktrees/git'

/** The git files that require a status refresh — index writes (add, commit) and HEAD moves (branch switch, commit). */
const WATCHED = new Set(['index', 'HEAD'])

/**
 * Watches narrowly: only index and HEAD inside the git dir.
 *
 * When an agent commits from a session terminal inside the app, the file watcher sees nothing — .git is on the
 * watcher's exclude list (CURATED_IGNORE in tree.ts) and the commit itself does not touch working tree files.
 * Watching all of .git instead would explode into events from object and log writes.
 *
 * The git dir is watched at depth 0 and filtered by name rather than watching the individual files — git writes
 * index.lock and swaps it in with a rename, and on some platforms watching the file itself loses the watch after that swap.
 *
 * Follows FileWatcher's serialisation-chain pattern exactly.
 */
export class GitWatcher {
  private watcher: FSWatcher | null = null
  private dir: string | null = null
  private ops: Promise<void> = Promise.resolve()
  // Releases a doWatch that is still waiting for chokidar's `ready` — see close(). Resolving an
  // already-settled promise is a no-op, so a stale call costs nothing.
  private releaseWait: () => void = () => {}

  constructor(
    private emit: () => void,
    private log: (m: string) => void = () => {}
  ) {}

  watch(treeRoot: string): Promise<void> {
    const p = this.ops.then(() => this.doWatch(treeRoot))
    this.ops = p.catch(() => {})
    return p
  }

  unwatch(): Promise<void> {
    const p = this.ops.then(() => this.close())
    this.ops = p.catch(() => {})
    return p
  }

  private async doWatch(treeRoot: string): Promise<void> {
    const dir = await gitDir(treeRoot)
    if (!dir) {
      await this.close() // Not a repository — tear down the previous watch only and return quietly
      return
    }
    if (this.dir === dir && this.watcher) return // A repeat request for the same git dir is ignored
    await this.close()
    this.dir = dir
    const watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 0, // Only the git dir's immediate children — the object and log subtrees are not watched
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }
    })
    this.watcher = watcher
    for (const kind of ['add', 'change', 'unlink'] as const) {
      watcher.on(kind, (p: string) => {
        if (WATCHED.has(path.basename(p))) this.emit()
      })
    }
    watcher.on('error', (e) =>
      this.log(`git watch error: ${e instanceof Error ? e.message : String(e)}`)
    )
    // chokidar registers its watches asynchronously and emits `ready` only once the initial scan has
    // registered them; until then the watcher object exists but nothing is listening, so a write in
    // that gap produces no event at all. Returning here without waiting would report a watcher that
    // is not yet watching — an agent that commits in the first moments after a project opens gets no
    // status refresh, and this file's own tests lost that race on Linux CI, whose per-directory
    // inotify registration is the slowest of the three platforms.
    //
    // Two things other than `ready` have to end the wait, or watch() never settles: an initial scan
    // that fails emits `error` and never reaches `ready`, and close() drops every listener on the
    // watcher (chokidar's close() calls removeAllListeners), which is why it releases the wait
    // itself rather than relying on an event that can no longer arrive.
    await new Promise<void>((resolve) => {
      this.releaseWait = resolve
      const done = (): void => {
        watcher.off('ready', done)
        watcher.off('error', done)
        resolve()
      }
      watcher.on('ready', done)
      watcher.on('error', done)
    })
  }

  async close(): Promise<void> {
    this.releaseWait()
    await this.watcher?.close().catch(() => {})
    this.watcher = null
    this.dir = null
  }
}
