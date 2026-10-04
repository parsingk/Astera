// Persisted `session file → cwd` memo (main only — it uses node:fs, so it is not in tsconfig.web).
//
// Only a provider whose folder name does not carry the project needs this. claude reads the cwd off
// at most 8 files per slug folder because the folder *is* the project; codex folders are dates, so
// "which projects exist" can only be answered by opening every rollout file. That made the codex
// project list cost grow linearly with the total number of sessions, on every single app start.
//
// A session file is append-only and the cwd sits in its head, so a hit stays valid for the whole life
// of the file. (mtimeMs, size) is still the key rather than the path alone: rolling relays copy
// transcripts between accounts, and a replaced file has to miss.
//
// **It is also the codex rollout index** (stage 4). Opening a codex project used to parse every
// rollout in every date folder (head + 256 KB tail) just to throw away the ones of other projects. The
// cwd this memo already holds says which files belong to the project, so an expansion now builds only
// those — and the row it builds (sessionId, title, awaitingReply) is kept here too, under the same
// (mtimeMs, size) key, so an unchanged file is not parsed again even after a restart. A row is a
// function of the file's bytes, and the key changes whenever the bytes do, so a hit is never stale.
// ROW_VERSION guards against the parser's rules changing between builds: a row written under another
// version is dropped at load (its cwd is kept — how the cwd is read has not changed).
//
// Entries of files that no longer exist are dropped by `prune`, which the codex strategy calls with
// the complete live file set of one scan root after each full listing.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { foldPathCase, legacyFoldedKey } from '../files/paths'

// The same rule as `norm` in index.ts, so a key survives a drive-letter or separator difference
// between two runs: resolved, and case-folded where the platform ignores case (foldPathCase).
//
// Older builds folded case on every platform, so on linux the file can hold `/a/x.jsonl` for
// `/a/X.jsonl`. get also tries that key — a hit still has to match (mtimeMs, size), so a legacy row
// of a different file that only shares the lower-cased name misses as it should. set writes the exact
// key and leaves the old row alone: it is a cache, the row costs a few bytes, and MAX_ENTRIES prunes it
// in time. Nothing changes on win32 or darwin.

/** [mtimeMs, size, cwd], or with the expansion row appended: [..., ROW_VERSION, sessionId, title,
 *  awaitingReply 0|1, hidden 0|1]. A null cwd is stored too, on purpose — a non-conversation record never
 *  gains one, and leaving it out would mean re-reading exactly those files on every pass. A row of
 *  another length is from an older build: its cwd part is kept and the row is built again. */
type CwdEntry = [number, number, string | null]
type RowEntry = [number, number, string, number, string, string, 0 | 1, 0 | 1]
type Entry = CwdEntry | RowEntry

/** Bumped whenever what buildEntry derives from a rollout changes, so rows of an older build are
 *  rebuilt rather than trusted. 3: a codex child thread rollout is a hidden row (the `hidden` slot).
 *  4: codex's goal continuation note is no title, and a goal-only session takes its objective. */
export const ROW_VERSION = 4

/** What a codex project expansion shows for one rollout, besides its path and mtime. */
export interface RolloutRow {
  sessionId: string
  title: string
  awaitingReply: boolean
  /** A codex child thread: not a row of the list, but a file of the project's history. */
  hidden?: boolean
}

// Bound on the **file**, not on memory. A history larger than this writes only its newest mtimes — the
// ones a project list actually reads. The entries past the bound stay in memory, so within one run an
// old rollout is read once and never again (trimming the map itself made every pass re-read and
// re-trim the same oldest files). After a restart those are read once more, with the scan progress
// showing. Memory is bounded by the live rollouts anyway: prune drops the entries of files that are gone.
const MAX_ENTRIES = 10_000

/** How long a flush waits for more changes before writing. A running codex session changes its
 *  rollout on every append, and each change used to rewrite the whole file. */
const FLUSH_DELAY_MS = 500

function isValidCwdPart(v: unknown[]): boolean {
  return (
    typeof v[0] === 'number' &&
    Number.isFinite(v[0]) &&
    typeof v[1] === 'number' &&
    Number.isFinite(v[1]) &&
    (v[2] === null || typeof v[2] === 'string')
  )
}

/** A stored value as this build reads it: a valid row, its cwd part alone when the row is from
 *  another version or malformed, or null when not even the cwd part is usable. */
function readEntry(v: unknown): Entry | null {
  if (!Array.isArray(v) || (v.length !== 3 && v.length !== 7 && v.length !== 8) || !isValidCwdPart(v)) return null
  const cwdPart: CwdEntry = [v[0] as number, v[1] as number, v[2] as string | null]
  if (v.length === 3) return cwdPart
  const rowOk =
    v.length === 8 &&
    v[3] === ROW_VERSION &&
    typeof v[2] === 'string' &&
    typeof v[4] === 'string' &&
    typeof v[5] === 'string' &&
    (v[6] === 0 || v[6] === 1) &&
    (v[7] === 0 || v[7] === 1)
  return rowOk ? (v as RowEntry) : cwdPart
}

export class SessionCwdCache {
  private map = new Map<string, Entry>()
  private dirty = false
  /** The writes, one after another — a write never starts before the previous one has finished. */
  private chain: Promise<void> = Promise.resolve()
  /** The debounced write the next flush() calls join, until its timer fires. */
  private scheduled: Promise<void> | null = null
  private seq = 0

  constructor(
    private filePath: string,
    private platform: string = process.platform,
    /** **Read-only: the file is read at load and never written** — neither by flush nor by the
     *  `.bak` a corrupt file gets. For the Host (host/projectRoots.ts), which lists the same projects
     *  with Astera closed: the file is the app's, and a second writer could interleave with the app's
     *  own flush. A miss is still parsed and remembered in memory, for the life of this object. */
    private opts: { readOnly?: boolean; flushDelayMs?: number } = {}
  ) {}

  private keyOf(p: string): string {
    return foldPathCase(path.resolve(p), this.platform)
  }

  /** Same contract as the other stores: absent = empty, corrupt = keep a .bak and start empty. A
   *  cache is not worth failing startup over, so neither case throws. */
  async load(): Promise<{ recovered: boolean }> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('invalid schema')
      }
      for (const [k, v] of Object.entries(parsed)) {
        const entry = readEntry(v)
        if (entry) this.map.set(k, entry) // a single bad row is dropped, not fatal
      }
      return { recovered: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { recovered: false }
      if (!this.opts.readOnly) await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.map.clear()
      return { recovered: true }
    }
  }

  /** The memoized cwd, or undefined on a miss. A hit can legitimately be null (no cwd in the file),
   *  which is why a miss is undefined rather than null. */
  get(filePath: string, mtimeMs: number, size: number): string | null | undefined {
    return this.hit(filePath, mtimeMs, size)?.[2]
  }

  private hit(filePath: string, mtimeMs: number, size: number): Entry | undefined {
    const key = this.keyOf(filePath)
    const legacy = legacyFoldedKey(key, this.platform)
    const hit = this.map.get(key) ?? (legacy === null ? undefined : this.map.get(legacy))
    if (!hit || hit[0] !== mtimeMs || hit[1] !== size) return undefined
    return hit
  }

  /** Records the cwd. A row already stored under the same key and the same cwd is kept — the codex
   *  listing re-reports cwds it did not have to parse, and must not undo what an expansion built. */
  set(filePath: string, mtimeMs: number, size: number, cwd: string | null): void {
    const key = this.keyOf(filePath)
    const cur = this.map.get(key)
    if (cur && cur[0] === mtimeMs && cur[1] === size && cur[2] === cwd) return
    this.map.set(key, [mtimeMs, size, cwd])
    this.dirty = true
  }

  /** The expansion row, or undefined when the file changed or only its cwd is known. */
  getRow(filePath: string, mtimeMs: number, size: number): (RolloutRow & { cwd: string }) | undefined {
    const hit = this.hit(filePath, mtimeMs, size)
    if (!hit || hit.length !== 8) return undefined
    return {
      cwd: hit[2],
      sessionId: hit[4],
      title: hit[5],
      awaitingReply: hit[6] === 1,
      ...(hit[7] === 1 ? { hidden: true } : {})
    }
  }

  setRow(filePath: string, mtimeMs: number, size: number, cwd: string, row: RolloutRow): void {
    this.map.set(this.keyOf(filePath), [
      mtimeMs,
      size,
      cwd,
      ROW_VERSION,
      row.sessionId,
      row.title,
      row.awaitingReply ? 1 : 0,
      row.hidden ? 1 : 0
    ])
    this.dirty = true
  }

  /** Drops every entry under `root` whose file is not in `livePaths` — the complete set of files a
   *  listing of that root just found. Entries under other roots (another account, the other provider)
   *  are left alone. Returns how many were dropped. In memory only when read-only, like everything. */
  prune(root: string, livePaths: Iterable<string>): number {
    const base = this.keyOf(root)
    const prefix = base.endsWith(path.sep) ? base : base + path.sep
    const live = new Set<string>()
    for (const p of livePaths) live.add(this.keyOf(p))
    let dropped = 0
    for (const key of [...this.map.keys()]) {
      if (!key.startsWith(prefix) || live.has(key)) continue
      this.map.delete(key)
      dropped++
    }
    if (dropped > 0) this.dirty = true
    return dropped
  }

  /**
   * Asks for the file to be written, and resolves once a write covering everything set so far is done.
   * Never rejects: a cache write failure must not break the project list.
   *
   * - **Debounced** (FLUSH_DELAY_MS): calls within the window share one write, so a running session's
   *   appends and the listing's and the expansion's requests become one rewrite.
   * - **Serialized**: a write starts only after the previous one ended, and each writes the map as it
   *   is then, so the latest state wins and two writes never interleave in the file.
   * - **Atomic**: the JSON goes to a temp file beside it, which is then renamed over the old one. A
   *   reader (the Host's read-only load, another process) sees the old file or the new one, never a
   *   torn one — a torn file is invalid JSON, and load() answers that by dropping the whole cache.
   * - A failed write leaves the cache dirty, so the next flush tries again.
   *
   * The callers (the codex strategy, once per pass) do not await it. A caller that must see the file
   * written — a test, a quit — awaits it.
   */
  flush(): Promise<void> {
    if (this.opts.readOnly) return Promise.resolve()
    if (this.scheduled) return this.scheduled
    if (!this.dirty) return this.chain
    this.scheduled = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.scheduled = null
        this.chain = this.chain.then(() => this.write())
        void this.chain.then(resolve)
      }, this.opts.flushDelayMs ?? FLUSH_DELAY_MS)
      // A pending cache write must not keep a process (the Host, a test worker) alive
      ;(timer as { unref?: () => void }).unref?.()
    })
    return this.scheduled
  }

  /** One write of the map as it is now. Never rejects. */
  private async write(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    const entries =
      this.map.size > MAX_ENTRIES
        ? [...this.map.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, MAX_ENTRIES)
        : this.map.entries()
    const text = JSON.stringify(Object.fromEntries(entries))
    const tmp = `${this.filePath}.${process.pid}.${++this.seq}.tmp`
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      await fs.writeFile(tmp, text, 'utf8')
      await fs.rename(tmp, this.filePath)
    } catch {
      this.dirty = true // the next flush tries again
      await fs.rm(tmp, { force: true }).catch(() => undefined)
    }
  }
}
