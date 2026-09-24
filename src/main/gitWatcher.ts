import chokidar, { type FSWatcher } from 'chokidar'
import path from 'node:path'
import { gitDir } from '../core/worktrees/git'

/** The git files that require a status refresh — index writes (add, commit) and HEAD moves (branch switch, commit). */
const WATCHED = new Set(['index', 'HEAD'])

/** The one path inside logs/ that is admitted — see the header comment for why. */
const LOGS_HEAD = path.join('logs', 'HEAD')

/**
 * Watches narrowly: index, HEAD, and logs/HEAD inside the git dir.
 *
 * When an agent commits from a session terminal inside the app, the file watcher sees nothing — .git is on the
 * watcher's exclude list (CURATED_IGNORE in tree.ts) and the commit itself does not touch working tree files.
 * Watching all of .git instead would explode into events from object and log writes.
 *
 * The git dir is watched by directory rather than by watching the individual files — git writes index.lock and
 * swaps it in with a rename, and on some platforms watching the file itself loses the watch after that swap.
 *
 * **logs/HEAD is admitted too, and nothing else in logs/.** index and top-level HEAD alone miss every HEAD move
 * that rewrites the ref in place instead of replacing a watched file: measured with git 2.45.1, `commit
 * --allow-empty`, `commit --amend -m` (message only), `reset --soft`, the re-commit right after a soft reset,
 * and `update-ref` each move HEAD's commit while touching neither <gitdir>/index nor <gitdir>/HEAD. All five
 * append a line to <gitdir>/logs/HEAD (the reflog) — as does every other HEAD move — while `fetch`, which must
 * not trigger a refresh, never touches it. `stash` also appends to it, which is harmless: a stash is as worth
 * noticing as any other index/HEAD change. The `ignored` predicate below is what keeps this narrow — it admits
 * only the git dir's immediate children plus the single path logs/HEAD, so logs/refs and every other file under
 * logs/ (and all of objects/ and refs/) are pruned before chokidar ever descends into them, exactly as before.
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
      // Admits only the git dir itself, its top-level index/HEAD, the logs/ dir (so chokidar can descend one
      // level into it), and logs/HEAD. This replaces a flat `depth: 0` because logs/HEAD sits one level deeper
      // than the top-level files, but the predicate still prunes recursion into every other directory
      // (objects, refs, logs/refs, worktrees, hooks, ...) — including watching them at all — exactly as
      // `depth: 0` used to leave their contents unwatched. Admitting 'logs' before it exists is what lets a
      // fresh repo's later-created reflog still be picked up (see the header comment).
      ignored: (p: string) => {
        const rel = path.relative(dir, p)
        if (rel === '' || rel === 'logs' || rel === LOGS_HEAD) return false
        return !(!rel.includes(path.sep) && WATCHED.has(rel))
      },
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
