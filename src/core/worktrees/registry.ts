import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WorktreeInfo } from '../types'

export interface RegistryFile {
  root?: string
  items: WorktreeInfo[]
}

export function isRegistryFile(obj: unknown): obj is RegistryFile {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false
  const f = obj as Record<string, unknown>
  if (f.root !== undefined && typeof f.root !== 'string') return false
  if (!Array.isArray(f.items)) return false
  return f.items.every(
    (w) =>
      w !== null &&
      typeof w === 'object' &&
      ['id', 'repoPath', 'path', 'name', 'branch', 'baseRef', 'createdAt'].every(
        (k) => typeof (w as Record<string, unknown>)[k] === 'string'
      )
  )
}

/** The root the app has always defaulted to (core.ts). One function so the Host cannot drift from it. */
export function defaultWorktreeRoot(homeDir: string): string {
  return path.join(homeDir, 'astera-worktrees')
}

/** What createWorktree, removeWorktree and listWithStatus need — the class, or anything shaped like it. */
export type WorktreeStore = Pick<WorktreeRegistry, 'list' | 'get' | 'add' | 'removeEntry' | 'getRoot' | 'setRoot'>

/** Where writes go while the Host owns the file (R1). Each answers the whole file as the Host wrote it. */
export interface WorktreeWriter {
  add(info: WorktreeInfo): Promise<RegistryFile>
  removeEntry(id: string): Promise<RegistryFile>
  setRoot(root: string | null): Promise<RegistryFile>
}

// an empty root falls back to the default — the one rule load, setRoot and a pushed file share
const normalRoot = (root: string | null | undefined): string | null =>
  root && root.trim() !== '' ? root : null

/**
 * Persistent registry of the worktrees the app created — being listed here is what authorizes deletion.
 * More than one process may write the file (the Host and an app, D3), so a local write re-reads it
 * first and applies its one change to what it found; the writes of one instance run one at a time.
 * With a writer set, writes go there instead and this instance holds only what the writer answered.
 */
export class WorktreeRegistry {
  private root: string | null = null
  private items: WorktreeInfo[] = []
  private writer: WorktreeWriter | null = null
  private listeners: ((f: RegistryFile) => void)[] = []
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private filePath: string,
    private defaultRoot: string,
    private log?: (m: string) => void
  ) {}

  async load(): Promise<{ recovered: boolean }> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      if (!isRegistryFile(parsed)) throw new Error('invalid schema')
      this.root = normalRoot(parsed.root)
      this.items = parsed.items
      return { recovered: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { recovered: false }
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.root = null
      this.items = []
      this.log?.('worktrees.json was unreadable — kept it as worktrees.json.bak and started an empty list')
      return { recovered: true }
    }
  }

  list(): WorktreeInfo[] {
    return [...this.items]
  }

  get(id: string): WorktreeInfo | null {
    return this.items.find((w) => w.id === id) ?? null
  }

  async add(info: WorktreeInfo): Promise<void> {
    if (this.writer) return this.adopt(await this.writer.add(info))
    await this.mutate((f) => ({ ...f, items: [...f.items, info] }))
  }

  async removeEntry(id: string): Promise<void> {
    if (this.writer) return this.adopt(await this.writer.removeEntry(id))
    await this.mutate((f) => ({ ...f, items: f.items.filter((w) => w.id !== id) }))
  }

  getRoot(): string {
    return this.root ?? this.defaultRoot
  }

  async setRoot(root: string | null): Promise<void> {
    if (this.writer) return this.adopt(await this.writer.setRoot(root))
    const next = normalRoot(root)
    await this.mutate((f) => ({ ...(next ? { root: next } : {}), items: f.items }))
  }

  /** Send writes to `w` from now on; null writes the file here again (re-reading it first, as always). */
  writeThrough(w: WorktreeWriter | null): void {
    this.writer = w
  }

  /** Take a file the Host pushed. Not a write here: no disk write and no listener. False if malformed. */
  accept(file: unknown): boolean {
    if (!isRegistryFile(file)) return false
    this.hold(file)
    return true
  }

  /** What save() would write. */
  file(): RegistryFile {
    return { ...(this.root ? { root: this.root } : {}), items: [...this.items] }
  }

  /** Called after every local write. A listener that throws is logged and costs nothing else. */
  onChange(cb: (f: RegistryFile) => void): void {
    this.listeners.push(cb)
  }

  private adopt(file: unknown): void {
    if (!isRegistryFile(file)) throw new Error('the worktrees.json the writer answered is malformed')
    this.hold(file)
  }

  private hold(file: RegistryFile): void {
    this.root = normalRoot(file.root)
    this.items = [...file.items]
  }

  private mutate(apply: (f: RegistryFile) => RegistryFile): Promise<void> {
    const run = this.queue.then(async () => {
      this.hold(apply(await this.readForWrite()))
      await this.save()
      const snapshot = this.file()
      for (const cb of this.listeners) {
        try {
          cb(snapshot)
        } catch (err) {
          this.log?.(`a worktrees.json listener threw: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    })
    this.queue = run.catch(() => {})
    return run
  }

  /**
   * The file as it is now, for a write to apply to. Unlike load(), a damaged file is not recovered
   * here: writing this one change over it would erase every entry it held, so the write is refused
   * and the file and memory stay as they were until a load() recovers it.
   */
  private async readForWrite(): Promise<RegistryFile> {
    let text: string
    try {
      text = await fs.readFile(this.filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { items: [] }
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (!isRegistryFile(parsed)) {
      const msg = 'worktrees.json is unreadable — refused to write over it, and left it as it is'
      this.log?.(msg)
      throw new Error(msg)
    }
    const root = normalRoot(parsed.root)
    return { ...(root ? { root } : {}), items: parsed.items }
  }

  private async save(): Promise<void> {
    const file = this.file()
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    // atomic write (tmp+rename) — prevents a torn write (same pattern as AccountRegistry.save)
    const tmp = `${this.filePath}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
