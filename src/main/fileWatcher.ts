import chokidar, { type FSWatcher } from 'chokidar'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { buildIgnoreMatcher } from '../core/files/tree'

export type FileChangeKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
export interface FileChange {
  path: string
  kind: FileChangeKind
}

/** Recursively watches one explorer root and emits changes. The watch exclusions are language-neutral
 *  (buildIgnoreMatcher). Follows HistoryIndex's chokidar usage pattern. */
export class FileWatcher {
  private watcher: FSWatcher | null = null
  private root: string | null = null
  // watch/unwatch serialisation chain — even when the calls overlap (fire-and-forget IPC, StrictMode double
  // invocation), it stops this.watcher being overwritten and leaking the previous chokidar instance without a close. Same pattern as HistoryIndex.reloading.
  private ops: Promise<void> = Promise.resolve()

  constructor(
    private emit: (change: FileChange) => void,
    private log: (m: string) => void = () => {}
  ) {}

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

  private async doWatch(root: string): Promise<void> {
    if (this.root === root && this.watcher) return // A repeat request for the same root is ignored
    await this.close()
    this.root = root
    let gitignore: string | null = null
    try {
      gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8')
    } catch {
      /* No .gitignore — the curated list only */
    }
    const ignored = buildIgnoreMatcher(gitignore)
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
      ignored: (p: string) => ignored(path.relative(root, p))
    })
    const kinds: FileChangeKind[] = ['add', 'change', 'unlink', 'addDir', 'unlinkDir']
    for (const kind of kinds) this.watcher.on(kind, (p: string) => this.emit({ path: p, kind }))
    this.watcher.on('error', (e) => this.log(`watch error: ${e instanceof Error ? e.message : String(e)}`))
  }

  async close(): Promise<void> {
    await this.watcher?.close().catch(() => {})
    this.watcher = null
    this.root = null
  }
}
