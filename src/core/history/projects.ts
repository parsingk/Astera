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
import type { HistoryIo } from './strategies/types'

/** The part of SessionCwdCache (sessionCwdCache.ts) `cwdMemo` uses. The app hands it the persisted
 *  memo; the Host hands it one opened read-only, so the app's file is never written by a second
 *  process. */
export interface CwdStore {
  get(filePath: string, mtimeMs: number, size: number): string | null | undefined
  set(filePath: string, mtimeMs: number, size: number, cwd: string | null): void
  flush(): Promise<void>
}

export type JsonlFile = { name: string; mtimeMs: number; size: number }

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
export async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name))
  } catch {
    return []
  }
}

/** The directory's .jsonl files in descending mtime order. Files whose stat fails are excluded.
 *  size rides along because the stat is already being paid for and cwdMemo keys on it. */
export async function jsonlFilesByMtimeDesc(dir: string): Promise<JsonlFile[]> {
  let names: string[]
  try {
    names = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return []
  }
  const stats = await Promise.all(
    names.map(async (name) => {
      try {
        const st = await fs.stat(path.join(dir, name))
        return { name, mtimeMs: st.mtimeMs, size: st.size }
      } catch {
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
  files: { path: string; mtimeMs: number; size: number }[],
  parse: (filePath: string) => Promise<string | null>,
  store?: CwdStore
): Promise<(string | null)[]> {
  const out = await mapWithConcurrency(files, 24, async (f) => {
    const hit = store?.get(f.path, f.mtimeMs, f.size)
    if (hit !== undefined) return hit
    let cwd: string | null = null
    try {
      cwd = await parse(f.path)
    } catch {
      cwd = null // unreadable or broken = no project, the same rule buildEntry applies
    }
    store?.set(f.path, f.mtimeMs, f.size, cwd)
    return cwd
  })
  await store?.flush()
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

/** A `CwdStore` that lives only in memory. What the Host uses when it has no memo file to read. */
export class MemoryCwdStore implements CwdStore {
  private map = new Map<string, [number, number, string | null]>()
  get(filePath: string, mtimeMs: number, size: number): string | null | undefined {
    const hit = this.map.get(comparablePath(filePath))
    return hit && hit[0] === mtimeMs && hit[1] === size ? hit[2] : undefined
  }
  set(filePath: string, mtimeMs: number, size: number, cwd: string | null): void {
    this.map.set(comparablePath(filePath), [mtimeMs, size, cwd])
  }
  async flush(): Promise<void> {}
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
    jsonlByMtimeDesc: async (dir) => {
      const files = await jsonlFilesByMtimeDesc(dir)
      this.lastFiles.set(comparablePath(dir), files)
      return files
    },
    subdirs,
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
    cwdMemo: (files, parse) => cwdMemo(files, parse, this.store),
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
