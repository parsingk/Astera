import { promises as fs } from 'node:fs'
import path from 'node:path'
import { buildIgnoreMatcher } from '../core/files/tree'
import { filterFilePaths } from '../core/files/fileMatch'
import { defaultCwdProbe, type Probe } from '../core/sessions/pathProbe'

/** How many files one project's list holds. A repository larger than this is answered from the first
 *  slice of its walk, which is breadth-first, so what is missing is the deepest corners rather than
 *  an arbitrary tail. Big enough for every repository on this machine, small enough that the walk and
 *  the filter both stay off anyone's critical path. */
const MAX_FILES = 20_000

/** How long a walked list is reused. Long enough that typing a name never re-walks, short enough that
 *  a file created a moment ago shows up without anyone restarting anything. */
const TTL_MS = 30_000

/** How long "unavailable" is remembered for a root whose walk failed or ran out of time, before the
 *  next ask tries again. Short: the share may come back. */
const UNAVAILABLE_TTL_MS = 10_000

/** How long `lookup` waits for a walk it started before answering with what it has. A small project
 *  finishes well inside this, so its menu never flashes "indexing"; a large one or a slow share answers
 *  at once with a partial list and says it is still indexing. */
const GRACE_MS = 150

/** How long a first walk may run before `lookup` stops saying "indexing" and says the list is
 *  unavailable: a readdir stuck on a dead share never settles, and the menu must not wait on it. The
 *  walk itself is not stopped (Node cannot cancel an fs call); if it finishes later, its list is kept. */
export const WALK_TIMEOUT_MS = 20_000
/** How many roots keep their list (performance audit M6): each holds up to MAX_FILES paths, and an app that opened a
 *  few dozen projects in a week held every one. The least recently searched goes first; it is walked again if asked. */
export const FILE_INDEX_ROOTS_KEPT = 8

/** How many entries the walk handles between turns it gives the event loop. A folder of thousands of
 *  files comes back from one readdir, and filtering it is a synchronous loop on main. */
const YIELD_EVERY = 500

/** The part of a Dirent the walk reads — what a test's in-memory tree has to provide. */
export interface DirEntry {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

export interface FileIndexDeps {
  readdir?: (abs: string) => Promise<DirEntry[]>
  readFile?: (abs: string) => Promise<string>
  /** Whether the root answers, asked before the walk starts: the budgeted session-folder probe
   *  (sessions/pathProbe.ts) by default, so a dead share costs one bounded call rather than a readdir
   *  that holds a libuv thread for as long as SMB takes. */
  probe?: Probe
  /** See GRACE_MS. */
  graceMs?: number
  /** See WALK_TIMEOUT_MS. */
  walkTimeoutMs?: number
}

interface Entry {
  paths: string[]
  at: number
  /** The walk failed (the root did not answer, or could not be read): kept for UNAVAILABLE_TTL_MS. */
  unavailable: boolean
}

/** A walk under way: `found` grows as it goes (the partial list `lookup` answers with), `done` settles
 *  once with the whole list and never rejects. `overdue` turns true once it has run past
 *  WALK_TIMEOUT_MS; `doneOrOverdue` settles at whichever comes first. */
interface Walk {
  found: string[]
  done: Promise<{ paths: string[]; unavailable: boolean }>
  doneOrOverdue: Promise<{ paths: string[]; unavailable: boolean }>
  overdue: boolean
}

export interface FileIndexAnswer {
  paths: string[]
  /** True while the first walk of this root is still under way and `paths` is only what it has found
   *  so far. A refresh of a stale list is not "indexing": the stale list answers in the meantime. */
  indexing: boolean
  /** Set (true) only when there is no list to wait for: the root did not answer, could not be read, or
   *  its walk ran past WALK_TIMEOUT_MS. The menu then stops asking and says so. */
  unavailable?: true
}

export interface FileIndex {
  /** The best `limit` matches for `query` under `root`, as root-relative paths with forward slashes.
   *  An unreadable root answers an empty list rather than throwing: the caller is drawing a menu.
   *  Waits for a current list (joining a walk already under way), but not past WALK_TIMEOUT_MS. */
  search(root: string, query: string, limit: number): Promise<string[]>
  /** The same matches, answered now for a menu that is open: a current list if there is one; else the
   *  stale list while a refresh runs; else, when the first walk has not finished within a short grace
   *  period, what it has found so far with `indexing` set; or `unavailable` when the walk failed or
   *  ran out of time. Never rejects. */
  lookup(root: string, query: string, limit: number): Promise<FileIndexAnswer>
}

/** The walk could not start or could not read its root. */
class IndexUnavailable extends Error {}

/**
 * The list of files a project offers to `@`.
 *
 * Walked breadth-first and filtered by the same matcher the file watcher uses — the curated list of
 * heavy directories plus the root .gitignore — so what is offered is what a person would call part of
 * the project, not a `node_modules` tree twenty times its size.
 *
 * One walk per root at a time: a search that arrives while one is under way awaits that walk rather
 * than starting its own.
 */
export function createFileIndex(now: () => number = Date.now, deps: FileIndexDeps = {}): FileIndex {
  const readdir =
    deps.readdir ?? ((abs: string) => fs.readdir(abs, { withFileTypes: true }) as Promise<DirEntry[]>)
  const readFile = deps.readFile ?? ((abs: string) => fs.readFile(abs, 'utf8'))
  const probe = deps.probe ?? defaultCwdProbe
  const graceMs = deps.graceMs ?? GRACE_MS
  const walkTimeoutMs = deps.walkTimeoutMs ?? WALK_TIMEOUT_MS
  const cache = new Map<string, Entry>()
  const inflight = new Map<string, Walk>()
  /** Into the cache as the most recently used, past FILE_INDEX_ROOTS_KEPT the oldest out. */
  const keep = (root: string, e: Entry): void => {
    cache.delete(root)
    cache.set(root, e)
    for (const old of cache.keys()) {
      if (cache.size <= FILE_INDEX_ROOTS_KEPT) break
      cache.delete(old)
    }
  }

  const walk = async (root: string, out: string[]): Promise<void> => {
    // The root is asked about first, within the probe budget. One that does not answer (a dead share)
    // or is not there has no list to wait for.
    if ((await probe(root)) !== 'present') throw new IndexUnavailable(root)
    let gitignore: string | null = null
    try {
      gitignore = await readFile(path.join(root, '.gitignore'))
    } catch {
      /* No .gitignore — the curated list only, exactly as the watcher does */
    }
    const ignored = buildIgnoreMatcher(gitignore)
    // Breadth-first, so a cap cuts the deepest corners rather than everything after one large folder.
    // Read by an index, never shifted: shift() moves the whole array each time, which made the walk
    // quadratic in the folder count. The folders already read stay in the array — strings, and at
    // most as many as the tree has folders.
    const queue: string[] = ['']
    let next = 0
    let sinceYield = 0
    while (next < queue.length && out.length < MAX_FILES) {
      const rel = queue[next++]
      let entries: DirEntry[]
      try {
        entries = await readdir(path.join(root, rel))
      } catch {
        // A folder that vanished or cannot be read is not worth failing the whole walk for — but the
        // root itself not reading means there is no list at all.
        if (rel === '') throw new IndexUnavailable(root)
        continue
      }
      for (const entry of entries) {
        if (++sinceYield >= YIELD_EVERY) {
          sinceYield = 0
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        const child = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (ignored(child)) continue
        if (entry.isDirectory()) queue.push(child)
        else if (entry.isFile()) {
          out.push(child)
          if (out.length >= MAX_FILES) break
        }
      }
    }
  }

  /** The walk of this root under way, or a new one. Its `done` never rejects; on settling it fills the
   *  cache and leaves `inflight`. */
  const walkOf = (root: string): Walk => {
    const running = inflight.get(root)
    if (running) return running
    const found: string[] = []
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = walk(root, found)
      .then(
        () => ({ paths: found, unavailable: false }),
        () => ({ paths: [] as string[], unavailable: true })
      )
      .then((r) => {
        if (timer) clearTimeout(timer)
        keep(root, { paths: r.paths, at: now(), unavailable: r.unavailable })
        inflight.delete(root)
        return r
      })
    const overdue = new Promise<{ paths: string[]; unavailable: boolean }>((resolve) => {
      timer = setTimeout(() => {
        w.overdue = true
        resolve({ paths: [...found], unavailable: true })
      }, walkTimeoutMs)
      timer.unref?.()
    })
    const w: Walk = { found, done, doneOrOverdue: Promise.race([done, overdue]), overdue: false }
    inflight.set(root, w)
    return w
  }

  const fresh = (root: string): Entry | null => {
    const cached = cache.get(root)
    if (!cached) return null
    if (now() - cached.at >= (cached.unavailable ? UNAVAILABLE_TTL_MS : TTL_MS)) return null
    keep(root, cached)
    return cached
  }

  const answer = (paths: string[], query: string, limit: number, unavailable: boolean): FileIndexAnswer =>
    unavailable
      ? { paths: filterFilePaths(paths, query, limit), indexing: false, unavailable: true }
      : { paths: filterFilePaths(paths, query, limit), indexing: false }

  return {
    async search(root, query, limit) {
      if (root === '') return []
      const current = fresh(root)
      const paths = current ? current.paths : (await walkOf(root).doneOrOverdue).paths
      return filterFilePaths(paths, query, limit)
    },
    async lookup(root, query, limit) {
      if (root === '') return { paths: [], indexing: false }
      const current = fresh(root)
      if (current) return answer(current.paths, query, limit, current.unavailable)
      const w = walkOf(root)
      if (w.overdue) return answer(w.found, query, limit, true)
      let timer: ReturnType<typeof setTimeout> | null = null
      const grace = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), graceMs)
      })
      const finished = await Promise.race([w.done, grace])
      if (timer) clearTimeout(timer)
      if (finished) return answer(finished.paths, query, limit, finished.unavailable)
      const stale = cache.get(root)
      if (stale && !stale.unavailable) return answer(stale.paths, query, limit, false)
      return { paths: filterFilePaths(w.found, query, limit), indexing: true }
    }
  }
}
