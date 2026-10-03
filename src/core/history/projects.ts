// Every account's known project paths, read straight off the transcript folders: no watcher, and no
// chokidar import.
//
// **Why this is its own module.** HistoryIndex (index.ts) is the app's live view of the history: it
// watches every scan root and keeps its project rows until a file event invalidates them. The Host
// needs the same list with Astera closed, to normalise a Job's `--cwd` to its project root
// (`resolveProjectRoot`), and it can take neither half of that: index.ts imports chokidar at top level,
// which would add a package to the Host bundle, and a cache that only a watcher clears would answer a
// long-lived Host with the list from its first call forever. So the file traversal the listing runs
// on lives here, HistoryIndex calls it with its own caches around it, and the Host builds
// `ProjectPathListing` below, which caches by file mtime signature instead of by watcher.
//
// The per-provider layout (claude's `projects/<slug>`, codex's `sessions/<y>/<m>/<d>` and the cwd
// read out of each rollout) stays in strategies/, which never imported a watcher either; this module
// is the `HistoryIo` they run on.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { comparablePath } from '../files/tree'
import type { Account, ProjectSummary, Provider } from '../types'
import { parseTranscriptMeta } from './parser'
import { descriptorOf, type ProviderDescriptor } from '../providers/descriptor'
import type { HistoryIo, IndexedRow, MemoFile } from './strategies/types'
import type { RolloutRow } from './sessionCwdCache'
import type { ScanHandle } from './scanProgress'

/** The part of SessionCwdCache (sessionCwdCache.ts) `cwdMemo` and `rowMemo` use. The app hands it the
 *  persisted memo; the Host hands it one opened read-only, so the app's file is never written by a
 *  second process. */
export interface CwdStore {
  get(filePath: string, mtimeMs: number, size: number): string | null | undefined
  set(filePath: string, mtimeMs: number, size: number, cwd: string | null): void
  getRow(filePath: string, mtimeMs: number, size: number): IndexedRow | undefined
  setRow(filePath: string, mtimeMs: number, size: number, cwd: string, row: RolloutRow): void
  /** Drops the entries under `root` whose file is not in `livePaths`. */
  prune(root: string, livePaths: Iterable<string>): number
  flush(): Promise<void>
}

export type JsonlFile = { name: string; mtimeMs: number; size: number }

/** Filled in by a listing that wants to know whether it saw everything. A missing directory (ENOENT)
 *  is a complete answer — there is nothing there; any other failure (EBUSY, EPERM, EMFILE…) is not,
 *  and a listing that is not complete must not be used to prune the index. */
export type ListStatus = { complete: boolean }

function noteFailure(err: unknown, status?: ListStatus): void {
  if (status && (err as NodeJS.ErrnoException)?.code !== 'ENOENT') status.complete = false
}

/** Parallel map with a concurrency ceiling (input order preserved). Overlaps I/O-bound parsing to
 *  make the first expand fast. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

/** Absolute paths of the subdirectories. Absent = no history (normal), so a read failure is `[]`. */
export async function subdirs(dir: string, status?: ListStatus): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name))
  } catch (err) {
    noteFailure(err, status)
    return []
  }
}

/** The directory's .jsonl files in descending mtime order. Files whose stat fails are excluded.
 *  size rides along because the stat is already being paid for and cwdMemo keys on it. */
export async function jsonlFilesByMtimeDesc(dir: string, status?: ListStatus): Promise<JsonlFile[]> {
  let names: string[]
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  } catch (err) {
    noteFailure(err, status)
    return []
  }
  const stats = await Promise.all(
    names.map(async (name) => {
      try {
        const st = await fs.stat(path.join(dir, name))
        return { name, mtimeMs: st.mtimeMs, size: st.size }
      } catch (err) {
        noteFailure(err, status) // gone since the readdir is fine; unreadable is not
        return null
      }
    })
  )
  return stats.filter((s): s is JsonlFile => s !== null).sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** The mtime signature of one directory's file list — what the parse caches compare against. */
export const signatureOf = (files: JsonlFile[]): string => files.map((f) => `${f.name}:${f.mtimeMs}`).join('|')

/** Reads the meta of up to 8 files, newest first, to find the real cwd. On a helper/sidechain or a
 *  missing cwd, moves to the next file. */
export async function resolveProjectCwd(dir: string, filesNewestFirst: string[]): Promise<string | null> {
  const cap = Math.min(filesNewestFirst.length, 8)
  for (let i = 0; i < cap; i++) {
    let meta
    try {
      meta = await parseTranscriptMeta(path.join(dir, filesNewestFirst[i]))
    } catch {
      continue
    }
    if (meta.isSidechain || meta.isHelper) continue
    if (meta.cwd) return meta.cwd
  }
  return null
}

/** Resolves the cwd of many session files at once. A hit in the memo skips the parse entirely, which
 *  is what takes the codex project list off the startup path from the second run on — see
 *  sessionCwdCache.ts for why only codex needs it. Runs at the same concurrency as parseDir. */
export async function cwdMemo(
  files: MemoFile[],
  parse: (filePath: string) => Promise<string | null>,
  store?: CwdStore,
  opts: {
    /** `files` is the complete live file set under this root: entries of files gone from it are pruned. */
    scope?: string
    /** Told how many files miss the memo before any is parsed, then once per parsed file. */
    progress?: (misses: number) => ScanHandle
  } = {}
): Promise<(string | null)[]> {
  const out = new Array<string | null>(files.length)
  const misses: number[] = []
  files.forEach((f, i) => {
    const hit = store?.get(f.path, f.mtimeMs, f.size)
    if (hit === undefined) misses.push(i)
    else out[i] = hit
  })
  const scan = misses.length > 0 ? opts.progress?.(misses.length) : undefined
  try {
    await mapWithConcurrency(misses, 24, async (i) => {
      const f = files[i]
      let cwd: string | null = null
      try {
        cwd = await parse(f.path)
      } catch {
        cwd = null // unreadable or broken = no project, the same rule buildEntry applies
      }
      store?.set(f.path, f.mtimeMs, f.size, cwd)
      out[i] = cwd
      scan?.tick()
    })
  } finally {
    scan?.end()
  }
  if (opts.scope !== undefined) store?.prune(opts.scope, files.map((f) => f.path))
  return out
}

/** The expansion rows of many rollouts at once, through the same index: a hit on (mtimeMs, size)
 *  skips `build` entirely, a miss builds and remembers. A null build (noise) is not remembered: it is
 *  rare, and the cwd memo already keeps an exec rollout out of every project. Input order is kept. */
export async function rowMemo(
  files: MemoFile[],
  build: (f: MemoFile) => Promise<IndexedRow | null>,
  store?: CwdStore
): Promise<(IndexedRow | null)[]> {
  const out = await mapWithConcurrency(files, 24, async (f) => {
    const hit = store?.getRow(f.path, f.mtimeMs, f.size)
    if (hit !== undefined) return hit
    let row: IndexedRow | null = null
    try {
      row = await build(f)
    } catch {
      row = null
    }
    if (row) store?.setRow(f.path, f.mtimeMs, f.size, row.cwd, row)
    return row
  })
  return out
}

/** One account's project rows, by that account's provider strategy. */
export function projectSummariesOf(
  account: Account,
  descriptors: Record<Provider, ProviderDescriptor>,
  io: HistoryIo
): Promise<ProjectSummary[]> {
  return descriptorOf(descriptors, account).history.projectSummaries(account, io)
}

type MemoryEntry = { mtimeMs: number; size: number; cwd: string | null; row?: RolloutRow }

/** A `CwdStore` that lives only in memory. What the Host uses when it has no memo file to read, and
 *  what HistoryIndex falls back to when it is given no persisted one (tests). */
export class MemoryCwdStore implements CwdStore {
  private map = new Map<string, MemoryEntry>()
  private hit(filePath: string, mtimeMs: number, size: number): MemoryEntry | undefined {
    const hit = this.map.get(comparablePath(filePath))
    return hit && hit.mtimeMs === mtimeMs && hit.size === size ? hit : undefined
  }
  get(filePath: string, mtimeMs: number, size: number): string | null | undefined {
    return this.hit(filePath, mtimeMs, size)?.cwd
  }
  set(filePath: string, mtimeMs: number, size: number, cwd: string | null): void {
    const cur = this.hit(filePath, mtimeMs, size)
    if (cur && cur.cwd === cwd) return // keep a row built for these same bytes
    this.map.set(comparablePath(filePath), { mtimeMs, size, cwd })
  }
  getRow(filePath: string, mtimeMs: number, size: number): IndexedRow | undefined {
    const hit = this.hit(filePath, mtimeMs, size)
    return hit?.row && hit.cwd !== null ? { cwd: hit.cwd, ...hit.row } : undefined
  }
  setRow(filePath: string, mtimeMs: number, size: number, cwd: string, row: RolloutRow): void {
    this.map.set(comparablePath(filePath), {
      mtimeMs,
      size,
      cwd,
      row: {
        sessionId: row.sessionId,
        title: row.title,
        awaitingReply: row.awaitingReply,
        ...(row.hidden ? { hidden: true } : {})
      }
    })
  }
  prune(root: string, livePaths: Iterable<string>): number {
    const base = comparablePath(root)
    const live = new Set<string>()
    for (const p of livePaths) live.add(comparablePath(p))
    let dropped = 0
    for (const key of [...this.map.keys()]) {
      if (live.has(key) || !isUnder(key, base)) continue
      this.map.delete(key)
      dropped++
    }
    return dropped
  }
  async flush(): Promise<void> {}
}

/** `key` lies strictly inside `base` (both comparablePath'd). A sibling that only shares the prefix
 *  (`sessions-old` next to `sessions`) does not. */
function isUnder(key: string, base: string): boolean {
  if (!key.startsWith(base) || key.length === base.length) return false
  return base.endsWith('/') || base.endsWith('\\') || key[base.length] === '/' || key[base.length] === '\\'
}

/**
 * **The project paths of a set of accounts, with no watcher to say when they changed.**
 *
 * What is cached, and on what:
 * - claude: one directory is one project, and its cwd is read from the heads of its newest files.
 *   That read is memoised per directory on the directory's mtime signature (`signatureOf`, the key
 *   HistoryIndex's own `dirCache` uses), so a directory whose files did not change is listed and
 *   stat'ed but not parsed again.
 * - codex: one folder is a date, so the cwd of every rollout is read; `cwdMemo` keys each file on
 *   (mtimeMs, size) through `store`.
 *
 * The listing and the stats are paid on every call: they are what tells a changed directory from an
 * unchanged one without a watcher. A call is one `jobs create`, not a sidebar repaint.
 */
export class ProjectPathListing {
  /** dirKey → the file list `jsonlByMtimeDesc` last answered for it, so `resolveProjectCwd` can key
   *  its memo on the signature of exactly the list the strategy is resolving from. This relies on a
   *  strategy calling `jsonlByMtimeDesc` for a directory before `resolveProjectCwd` for it, as the
   *  claude strategy does; one that does not only loses the memo (it re-parses), it is never wrong. */
  private lastFiles = new Map<string, JsonlFile[]>()
  /** dirKey → the cwd resolved for that directory at signature `sig`. */
  private cwdByDir = new Map<string, { sig: string; cwd: string | null }>()

  constructor(
    private descriptors: Record<Provider, ProviderDescriptor>,
    private store: CwdStore = new MemoryCwdStore()
  ) {}

  private readonly io: HistoryIo = {
    parseDir: async () => {
      throw new Error('a project listing does not parse sessions')
    },
    jsonlByMtimeDesc: async (dir, status) => {
      const files = await jsonlFilesByMtimeDesc(dir, status)
      this.lastFiles.set(comparablePath(dir), files)
      return files
    },
    subdirs: (dir, status) => subdirs(dir, status),
    resolveProjectCwd: async (dir, names) => {
      const key = comparablePath(dir)
      const files = this.lastFiles.get(key)
      // Only a list that is the one just read is keyed; anything else is resolved uncached.
      const sig =
        files && files.length === names.length && files.every((f, i) => f.name === names[i]) ? signatureOf(files) : null
      const hit = this.cwdByDir.get(key)
      if (sig !== null && hit && hit.sig === sig) return hit.cwd
      const cwd = await resolveProjectCwd(dir, names)
      if (sig !== null) this.cwdByDir.set(key, { sig, cwd })
      return cwd
    },
    cwdMemo: (files, parse, scope) => cwdMemo(files, parse, this.store, { scope }),
    rowMemo: (files, build) => rowMemo(files, build, this.store),
    flushIndex: () => void this.store.flush().catch(() => undefined),
    samePath: (a, b) => comparablePath(a) === comparablePath(b),
    pathKey: (p) => comparablePath(p),
    cacheDirForProject: () => {}
  }

  /** Every project path the accounts' transcripts name, one per folder (the first spelling met). */
  async projectPaths(accounts: Account[]): Promise<string[]> {
    const seen = new Set<string>()
    const out: string[] = []
    for (const account of accounts) {
      for (const row of await projectSummariesOf(account, this.descriptors, this.io)) {
        const key = comparablePath(row.projectPath)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(row.projectPath)
      }
    }
    return out
  }
}
