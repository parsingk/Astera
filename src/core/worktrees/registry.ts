import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WorktreeInfo } from '../types'
import { renameRetrying, readFileRetrying } from '../renameRetry'
import { RepairNeeded } from '../settings/repairNeeded'
import { isSamePath } from '../files/tree'

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
 * Local writes, writer answers and pushed files all take their turn in one queue, so a push that
 * arrives during a write is held after it rather than being overwritten by it or overwriting it.
 */
export class WorktreeRegistry {
  private root: string | null = null
  private items: WorktreeInfo[] = []
  private writer: WorktreeWriter | null = null
  private listeners: ((f: RegistryFile) => void)[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private queued = 0

  constructor(
    private filePath: string,
    private defaultRoot: string,
    private log?: (m: string) => void
  ) {}

  async load(): Promise<{ recovered: boolean }> {
    // Taken before the read, so it is no newer than the bytes read — see the .bak rule below.
    const readAt = await fs.stat(this.filePath).then((st) => st.mtimeMs, () => null)
    let text: string | undefined
    try {
      text = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(text)
      if (!isRegistryFile(parsed)) throw new Error('invalid schema')
      this.root = normalRoot(parsed.root)
      this.items = parsed.items
      return { recovered: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { recovered: false }
      // **Nothing read, nothing healed.** `fs.readFile` itself can fail (EBUSY, EPERM, EACCES, …)
      // before this process ever saw a byte of the file. There is then nothing to judge a `.bak`
      // against and nothing to heal over: healing here would say a copy was kept when none was made,
      // and would replace a file this process never looked at with an empty list. Leave the file, any
      // `.bak` and memory untouched; the next load() — a process restart — tries again (final review N1).
      if (text === undefined) {
        this.log?.(`worktrees.json could not be read: ${err instanceof Error ? err.message : String(err)}`)
        return { recovered: false }
      }
      // **The .bak gets the bytes this process read**, not a copy of the file as it is by then: two
      // processes (the Host and an app) can start together and both find the damage, and the second
      // could otherwise copy the first one's healed empty list over the only record of what was lost.
      // **A .bak at least as new as the damage is already a copy of it, and is kept.** An older one
      // is from an earlier damage and is replaced. (text is defined here — the read-failed case above
      // already returned.)
      const bakAt = await fs.stat(this.filePath + '.bak').then((st) => st.mtimeMs, () => null)
      const newerBak = readAt !== null && bakAt !== null && bakAt >= readAt
      const kept =
        newerBak ||
        (await fs.writeFile(this.filePath + '.bak', text, 'utf8').then(
          () => true,
          () => false
        ))
      this.root = null
      this.items = []
      this.log?.(
        newerBak
          ? 'worktrees.json was unreadable — a newer worktrees.json.bak was already there and was kept; started an empty list'
          : 'worktrees.json was unreadable — kept it as worktrees.json.bak and started an empty list'
      )
      // The recovery is written, or every later write's re-read would find the same damaged bytes and
      // refuse, restart after restart. Only once the .bak holds the original. A failure is swallowed
      // (as SchedulerConfigStore.load does) so the app still starts, and logged; the next start retries.
      if (kept) {
        await this.save({ items: [] }).catch((e: unknown) =>
          this.log?.(`could not write the recovered worktrees.json: ${e instanceof Error ? e.message : String(e)}`)
        )
      }
      return { recovered: true }
    }
  }

  list(): WorktreeInfo[] {
    return [...this.items]
  }

  get(id: string): WorktreeInfo | null {
    return this.items.find((w) => w.id === id) ?? null
  }

  // Which way a write goes is decided when its turn comes, so a write queued before a mode switch
  // follows the mode it runs in.
  //
  // One add-or-replace, decided from the file this queued turn reads (carry 2, R23): the same id
  // already listed is a retried add (the reply of an earlier one was lost) — nothing changed, so
  // nothing is written and no listener hears it. Otherwise a different id at a path `isSamePath` to
  // `info.path` names a stale entry (the folder it named is gone, but the entry is not, M10) and is
  // replaced by this one in the same write; anything else is appended. Two identical adds started
  // together queue one after the other, so the second sees the first's write and is the no-op case —
  // never two appends.
  add(info: WorktreeInfo): Promise<void> {
    return this.enqueue(async () => {
      if (this.writer) return this.adopt(await this.writer.add(info))
      await this.mutateOrKeep((f) =>
        f.items.some((w) => w.id === info.id)
          ? null
          : { ...f, items: [...f.items.filter((w) => !isSamePath(w.path, info.path)), info] }
      )
    })
  }

  removeEntry(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.writer) return this.adopt(await this.writer.removeEntry(id))
      await this.mutate((f) => ({ ...f, items: f.items.filter((w) => w.id !== id) }))
    })
  }

  getRoot(): string {
    return this.root ?? this.defaultRoot
  }

  setRoot(root: string | null): Promise<void> {
    return this.enqueue(async () => {
      if (this.writer) return this.adopt(await this.writer.setRoot(root))
      const next = normalRoot(root)
      await this.mutate((f) => ({ ...(next ? { root: next } : {}), items: f.items }))
    })
  }

  /** Send writes to `w` from now on; null writes the file here again (re-reading it first, as always). */
  writeThrough(w: WorktreeWriter | null): void {
    this.writer = w
  }

  /**
   * Take a file the Host pushed. Not a write here: no disk write and no listener. False if malformed.
   * Held at once when nothing is queued, otherwise after the writes queued before it.
   */
  accept(file: unknown): boolean {
    if (!isRegistryFile(file)) return false
    if (this.queued === 0) this.hold(file)
    else void this.enqueue(async () => this.hold(file))
    return true
  }

  /**
   * Re-read the file into memory, in its turn after the writes queued before it. What a process
   * that is not the only writer does before it acts on the list (the Host, at the start of every
   * worktree operation, R2). No disk write and no listener: nothing changed here. A damaged file is
   * refused as a write refuses it (`RepairNeeded`) and never healed here — healing wipes the list,
   * and only load() at a process start may do that.
   */
  refresh(): Promise<void> {
    return this.enqueue(async () => this.hold(await this.readForWrite()))
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

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.queued++
    const run = this.queue.then(job).finally(() => this.queued--)
    this.queue = run.catch(() => {})
    return run
  }

  // Runs inside the queue. Memory changes only once the file on disk says so (constraint 13), and
  // listeners hear the list this write made, not whatever memory holds by then.
  private async mutate(apply: (f: RegistryFile) => RegistryFile): Promise<void> {
    await this.mutateOrKeep(apply)
  }

  // mutate's general form: `apply` may answer null for "nothing changed" — the file just read is
  // held (so a re-read that ran to get here is not wasted) and neither `save` nor a listener runs.
  private async mutateOrKeep(apply: (f: RegistryFile) => RegistryFile | null): Promise<void> {
    const f = await this.readForWrite()
    const next = apply(f)
    if (next === null) {
      this.hold(f)
      return
    }
    await this.save(next)
    this.hold(next)
    for (const cb of this.listeners) {
      try {
        cb({ ...next, items: [...next.items] })
      } catch (err) {
        this.log?.(`a worktrees.json listener threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  /**
   * The file as it is now, for a write to apply to. Unlike load(), a damaged file is not recovered
   * here: writing this one change over it would erase every entry it held, so the write is refused
   * and the file and memory stay as they were until a load() recovers it.
   */
  private async readForWrite(): Promise<RegistryFile> {
    let text: string
    try {
      text = await readFileRetrying(this.filePath)
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
      const msg =
        'worktrees.json is unreadable — refused to write over it, and left it as it is; ' +
        'quit and reopen Astera (or restart the Host) to repair it, keeping a copy as worktrees.json.bak'
      this.log?.(msg)
      // Typed, so the Host answers it as a file to repair (409 with `repair`) rather than a failure.
      throw new RepairNeeded(msg, path.basename(this.filePath))
    }
    const root = normalRoot(parsed.root)
    return { ...(root ? { root } : {}), items: parsed.items }
  }

  private async save(file: RegistryFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    // atomic write (tmp+rename) — prevents a torn write (same pattern as AccountRegistry.save). The
    // other process's re-read holds the file open for a moment, which Windows answers with EPERM, so a
    // busy rename is retried; after that the write is refused, never done in place.
    const tmp = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
      await renameRetrying(tmp, this.filePath)
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  }
}
