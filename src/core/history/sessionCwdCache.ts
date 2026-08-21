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
import { promises as fs } from 'node:fs'
import path from 'node:path'

// win32 first: the same rule as `norm` in index.ts, so a key survives a drive-letter or separator
// difference between two runs.
const keyOf = (p: string): string => path.resolve(p).toLowerCase()

/** [mtimeMs, size, cwd]. A null cwd is stored too, on purpose — a non-conversation record never gains
 *  one, and leaving it out would mean re-reading exactly those files on every pass. */
type Entry = [number, number, string | null]

// Bound on the file. Only a history larger than this is pruned, and the pruning keeps the newest
// mtimes — the ones a project list actually reads.
const MAX_ENTRIES = 10_000

function isValidEntry(v: unknown): v is Entry {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    typeof v[0] === 'number' &&
    Number.isFinite(v[0]) &&
    typeof v[1] === 'number' &&
    Number.isFinite(v[1]) &&
    (v[2] === null || typeof v[2] === 'string')
  )
}

export class SessionCwdCache {
  private map = new Map<string, Entry>()
  private dirty = false

  constructor(private filePath: string) {}

  /** Same contract as the other stores: absent = empty, corrupt = keep a .bak and start empty. A
   *  cache is not worth failing startup over, so neither case throws. */
  async load(): Promise<{ recovered: boolean }> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('invalid schema')
      }
      for (const [k, v] of Object.entries(parsed)) {
        if (isValidEntry(v)) this.map.set(k, v) // a single bad row is dropped, not fatal
      }
      return { recovered: false }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { recovered: false }
      await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
      this.map.clear()
      return { recovered: true }
    }
  }

  /** The memoized cwd, or undefined on a miss. A hit can legitimately be null (no cwd in the file),
   *  which is why a miss is undefined rather than null. */
  get(filePath: string, mtimeMs: number, size: number): string | null | undefined {
    const hit = this.map.get(keyOf(filePath))
    if (!hit || hit[0] !== mtimeMs || hit[1] !== size) return undefined
    return hit[2]
  }

  set(filePath: string, mtimeMs: number, size: number, cwd: string | null): void {
    this.map.set(keyOf(filePath), [mtimeMs, size, cwd])
    this.dirty = true
  }

  /** Writes once per pass, and only when something was actually added. A write failure is swallowed —
   *  the next start just pays the parse again. */
  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    if (this.map.size > MAX_ENTRIES) {
      const kept = [...this.map.entries()].sort((a, b) => b[1][0] - a[1][0]).slice(0, MAX_ENTRIES)
      this.map = new Map(kept)
    }
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      await fs.writeFile(this.filePath, JSON.stringify(Object.fromEntries(this.map)), 'utf8')
    } catch {
      /* a cache write failure must not break the project list */
    }
  }
}
