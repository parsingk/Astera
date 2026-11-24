import { promises as fs } from 'node:fs'
import path from 'node:path'
import { buildIndexIgnoreMatcher, isPathWithin } from '../core/files/tree'
import { filterFilePaths } from '../core/files/fileMatch'
import type { FileChange } from '../core/files/changeBatch'
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

/** The root files that decide what the walk leaves out (buildIndexIgnoreMatcher): the project's .gitignore, and the
 *  .ignore a person writes to keep folders out of search. A change to either makes the next ask walk again. */
const IGNORE_FILES = ['.gitignore', '.ignore'] as const

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
  /** The walk stopped at MAX_FILES: `paths` is the shallow part of a larger project. */
  truncated: boolean
  /** What the walk left out, so a file the watcher reports is added only where the walk would have kept it. */
  ignored: (relPath: string) => boolean
  /** A folder came, the root's .gitignore or .ignore changed, or Quick Open opened (expire): the list still answers while
   *  the next ask walks again. */
  changed?: true
}

/** What one walk produced. */
interface WalkResult {
  paths: string[]
  unavailable: boolean
  truncated: boolean
  ignored: (relPath: string) => boolean
}

/** A walk under way: `found` grows as it goes (the partial list `lookup` answers with), `done` settles
 *  once with the whole list and never rejects. `overdue` turns true once it has run past
 *  WALK_TIMEOUT_MS; `doneOrOverdue` settles at whichever comes first. */
interface Walk {
  found: string[]
  done: Promise<WalkResult>
  doneOrOverdue: Promise<WalkResult>
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
  /** The list answering is the one held while a fresh walk runs (a stale or changed list): ask again shortly to see
   *  the fresh one. The composer's `@` menu does not; Quick Open does. */
  refreshing?: true
  /** The project holds more files than MAX_FILES: the answer comes from its shallow part only. */
  truncated?: true
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
  /** The whole list under `root`, for text search (main/textSearch.ts), which reads every file on it. Waits for a current
   *  list as `search` does, and says whether it is only the shallow part of a larger project (`truncated`) and whether the
   *  root could be read at all (`unavailable`, with no paths). Never rejects. */
  list(root: string): Promise<{ paths: string[]; truncated: boolean; unavailable: boolean }>
  /** What the explorer's file watcher saw (one batch, absolute paths). A deleted file or folder leaves every list below
   *  it, and a new file joins it, at once; a new folder, whose contents are not reported file by file, or a change to the
   *  root's .gitignore or .ignore makes the next ask walk again. A content change alone changes no list. A walk under way when the
   *  batch arrives gets it applied to its result, since it may have read the folder before the change. */
  noteChanges(changes: readonly FileChange[]): void
  /** Makes the next ask of `root` walk again, its current list answering meanwhile. Quick Open asks for this as it opens:
   *  the watcher runs only while the explorer is open, so what changed with the explorer closed reaches no list. */
  expire(root: string): void
}

/** The walk could not start or could not read its root. */
class IndexUnavailable extends Error {}

/** What one watcher batch means for one root's list. */
interface RootChanges {
  gone: Set<string>
  goneDirs: Set<string>
  added: string[]
  rewalk: boolean
}

/** The part of a watcher batch below `root`, as root-relative paths; null when nothing there changed in a way a list
 *  could show. */
function changesUnder(root: string, changes: readonly FileChange[]): RootChanges | null {
  let rc: RootChanges | null = null
  const get = (): RootChanges => (rc ??= { gone: new Set(), goneDirs: new Set(), added: [], rewalk: false })
  for (const c of changes) {
    if (!isPathWithin(root, c.path)) continue
    const rel = path.relative(root, c.path).split(path.sep).join('/')
    // The root's .gitignore and .ignore decide what the walk leaves out, however they changed
    if ((IGNORE_FILES as readonly string[]).includes(rel)) get().rewalk = true
    if (c.kind === 'unlink') get().gone.add(rel)
    else if (c.kind === 'unlinkDir') get().goneDirs.add(rel)
    else if (c.kind === 'add') get().added.push(rel)
    // A folder that came (made, or moved in with its contents) is reported alone, not file by file
    else if (c.kind === 'addDir') get().rewalk = true
  }
  return rc
}

/** `paths` with one batch applied: what was deleted taken out, new files the walk would have kept added at the end,
 *  never past `cap`. Applying a batch twice changes nothing more, so it is safe on a list that already saw it. */
function withChanges(paths: string[], rc: RootChanges, ignored: (relPath: string) => boolean, cap: number): string[] {
  let out = paths
  if (rc.gone.size > 0 || rc.goneDirs.size > 0) {
    // One pass, each path's folders looked up in a set: a checkout deleting a thousand folders costs the list's length
    // times its depth, not times the thousand. '' is the root itself, deleted with everything.
    const under = (p: string): boolean => {
      if (rc.goneDirs.has('')) return true
      for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) if (rc.goneDirs.has(p.slice(0, i))) return true
      return false
    }
    out = out.filter((p) => !rc.gone.has(p) && !rc.goneDirs.has(p) && !under(p))
  }
  if (rc.added.length > 0 && out.length < cap) {
    const have = new Set(out)
    const extra = rc.added.filter((rel) => !have.has(rel) && !ignored(rel))
    if (extra.length > 0) out = [...out, ...extra].slice(0, cap)
  }
  return out
}

/**
 * The list of files a project offers to `@` and to Quick Open (main/quickOpen.ts).
 *
 * Walked breadth-first and filtered by buildIndexIgnoreMatcher: the project's own .gitignore plus the folders that are
 * never source (version control, installed dependencies, caches), or the watcher's curated list when there is no
 * .gitignore. So what is offered is what a person would call part of the project, not a `node_modules` tree twenty
 * times its size, and a tracked `build/` or `bin/` folder stays findable.
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
  /** The batches the watcher reported below a root while its walk was under way: that walk may have read a folder
   *  before a change, so each is applied to its result when it is stored, and its deletions to what it answers early. */
  const pendingDuringWalk = new Map<string, RootChanges[]>()
  /** Into the cache as the most recently used, past FILE_INDEX_ROOTS_KEPT the oldest out. */
  const keep = (root: string, e: Entry): void => {
    cache.delete(root)
    cache.set(root, e)
    for (const old of cache.keys()) {
      if (cache.size <= FILE_INDEX_ROOTS_KEPT) break
      cache.delete(old)
    }
  }
  const noIgnore = (): boolean => false

  const walk = async (root: string, out: string[]): Promise<{ ignored: (relPath: string) => boolean; truncated: boolean }> => {
    // The root is asked about first, within the probe budget. One that does not answer (a dead share)
    // or is not there has no list to wait for.
    if ((await probe(root)) !== 'present') throw new IndexUnavailable(root)
    // No .gitignore: the curated list, exactly as the watcher does. No .ignore: nothing more left out.
    const [gitignore, ignoreFile] = await Promise.all(
      IGNORE_FILES.map((name) => readFile(path.join(root, name)).catch(() => null))
    )
    const ignored = buildIndexIgnoreMatcher(gitignore, ignoreFile)
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
    return { ignored, truncated: out.length >= MAX_FILES }
  }

  /** What a walk under way has found, without what the watcher has since reported deleted. */
  const visible = (root: string, found: string[]): string[] => {
    let out = found
    for (const rc of pendingDuringWalk.get(root) ?? []) out = withChanges(out, { ...rc, added: [] }, noIgnore, MAX_FILES)
    return out
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
        (w): WalkResult => ({ paths: found, unavailable: false, truncated: w.truncated, ignored: w.ignored }),
        (): WalkResult => ({ paths: [], unavailable: true, truncated: false, ignored: noIgnore })
      )
      .then((r) => {
        if (timer) clearTimeout(timer)
        const pending = pendingDuringWalk.get(root) ?? []
        pendingDuringWalk.delete(root)
        let paths = r.paths
        let rewalk = false
        if (!r.unavailable) {
          for (const rc of pending) {
            paths = withChanges(paths, rc, r.ignored, MAX_FILES)
            rewalk ||= rc.rewalk
          }
        }
        keep(root, {
          paths,
          at: now(),
          unavailable: r.unavailable,
          truncated: r.truncated,
          ignored: r.ignored,
          ...(rewalk ? { changed: true as const } : {})
        })
        inflight.delete(root)
        return { ...r, paths }
      })
    const overdue = new Promise<WalkResult>((resolve) => {
      timer = setTimeout(() => {
        w.overdue = true
        resolve({ paths: visible(root, found), unavailable: true, truncated: false, ignored: noIgnore })
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
    if (cached.changed || now() - cached.at >= (cached.unavailable ? UNAVAILABLE_TTL_MS : TTL_MS)) return null
    keep(root, cached)
    return cached
  }

  const answer = (
    paths: string[],
    query: string,
    limit: number,
    f: { unavailable?: boolean; truncated?: boolean; refreshing?: boolean }
  ): FileIndexAnswer => ({
    paths: filterFilePaths(paths, query, limit),
    indexing: false,
    ...(f.unavailable ? { unavailable: true as const } : {}),
    ...(f.refreshing ? { refreshing: true as const } : {}),
    ...(f.truncated ? { truncated: true as const } : {})
  })

  return {
    async search(root, query, limit) {
      if (root === '') return []
      const current = fresh(root)
      const paths = current ? current.paths : (await walkOf(root).doneOrOverdue).paths
      return filterFilePaths(paths, query, limit)
    },
    async list(root) {
      if (root === '') return { paths: [], truncated: false, unavailable: true }
      const r = fresh(root) ?? (await walkOf(root).doneOrOverdue)
      // A walk past its time has a part of a list, which is not a scope a search can say it covered
      return r.unavailable ? { paths: [], truncated: false, unavailable: true } : { paths: r.paths, truncated: r.truncated, unavailable: false }
    },
    async lookup(root, query, limit) {
      if (root === '') return { paths: [], indexing: false }
      const current = fresh(root)
      if (current) return answer(current.paths, query, limit, current)
      const w = walkOf(root)
      if (w.overdue) return answer(visible(root, w.found), query, limit, { unavailable: true })
      let timer: ReturnType<typeof setTimeout> | null = null
      const grace = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), graceMs)
      })
      const finished = await Promise.race([w.done, grace])
      if (timer) clearTimeout(timer)
      if (finished) return answer(finished.paths, query, limit, finished)
      const stale = cache.get(root)
      if (stale && !stale.unavailable) return answer(stale.paths, query, limit, { truncated: stale.truncated, refreshing: true })
      return { paths: filterFilePaths(visible(root, w.found), query, limit), indexing: true }
    },
    noteChanges(changes) {
      for (const root of new Set([...cache.keys(), ...inflight.keys()])) {
        const rc = changesUnder(root, changes)
        if (!rc) continue
        if (inflight.has(root)) pendingDuringWalk.set(root, [...(pendingDuringWalk.get(root) ?? []), rc])
        const e = cache.get(root)
        if (!e) continue
        // set, not keep: a change is not a search, so this root does not move up the most-recently-searched order. A
        // root that could not be read and now reports changes is tried again.
        if (e.unavailable) cache.set(root, { ...e, changed: true })
        else {
          const paths = withChanges(e.paths, rc, e.ignored, MAX_FILES)
          cache.set(root, { ...e, paths, ...(rc.rewalk ? { changed: true as const } : {}) })
        }
      }
    },
    expire(root) {
      const e = cache.get(root)
      if (e) cache.set(root, { ...e, changed: true })
    }
  }
}
