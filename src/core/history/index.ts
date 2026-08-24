import { promises as fs, watch as fsWatch } from 'node:fs'
import path from 'node:path'
import chokidar from 'chokidar'
import type { Account, HistoryEntry, ProjectSummary, Provider, TranscriptPreview } from '../types'
import { parseTranscriptMeta } from './parser'
import { metaOf } from '../providers/meta'
import { descriptorOf, makeDescriptors, type ProviderDescriptor } from '../providers/descriptor'
import type { HistoryIo, HistoryStrategy } from './strategies/types'
import type { SessionCwdCache } from './sessionCwdCache'

// win32 first: ignore path case and separator differences (the same rule as normalizePath in
// sessions/manager.ts)
const norm = (p: string): string => path.resolve(p).toLowerCase()

/** The renderer is notified this long after the last file event. A transcript is appended to
 *  continuously while a session runs, so coalescing is what keeps the sidebar from rebuilding the
 *  whole project list on every write. */
const UPDATE_DEBOUNCE_MS = 150
/** ...but a debounce that only ever resets never fires at all while a session keeps writing.
 *  chokidar's awaitWriteFinish used to hide that by staying silent mid-write; a native watcher emits
 *  per append, so the ceiling has to be stated. */
const UPDATE_MAX_WAIT_MS = 1000

/** Either watcher kind behind the one thing this file does with them. */
interface WatchHandle {
  close(): void | Promise<void>
}

/** Group resume forks (same rootUuid) — keep only the newest one per conversation. A null rootUuid
 *  is excluded from grouping */
function groupForks(entries: HistoryEntry[]): HistoryEntry[] {
  const latestByRoot = new Map<string, HistoryEntry>()
  const ungrouped: HistoryEntry[] = []
  for (const e of entries) {
    if (e.rootUuid === null) {
      ungrouped.push(e)
      continue
    }
    const key = `${e.accountId}:${e.rootUuid}`
    const existing = latestByRoot.get(key)
    if (!existing || e.updatedAt > existing.updatedAt) latestByRoot.set(key, e)
  }
  return [...ungrouped, ...latestByRoot.values()]
}

/** Every account rolling has passed through is left with a transcript copy of the same sessionId —
 *  the unified view exposes only the newest file (an older copy is a subset of the newest relayed
 *  one, so no information is lost). */
function dedupeBySessionId(entries: HistoryEntry[]): HistoryEntry[] {
  const best = new Map<string, HistoryEntry>()
  for (const e of entries) {
    const cur = best.get(e.sessionId)
    if (!cur || e.updatedAt > cur.updatedAt) best.set(e.sessionId, e)
  }
  return [...best.values()]
}

const byUpdatedDesc = (x: { updatedAt: string }, y: { updatedAt: string }): number =>
  x.updatedAt < y.updatedAt ? 1 : x.updatedAt > y.updatedAt ? -1 : 0

/** Parallel map with a concurrency ceiling (input order preserved). Overlaps I/O-bound parsing to
 *  make the first expand fast. */
async function mapWithConcurrency<T, R>(
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

/**
 * History index (lazy).
 *
 * It does not scan every transcript at startup. The project list is built cheaply from directory
 * enumeration + file mtime + the newest file's meta (its real cwd) alone (projectsPage), and the
 * session list parses only that one project when the project is expanded (page). The file watcher is
 * turned on in the background with startBackground() once the window is up, which gives live updates.
 */
export class HistoryIndex {
  // Parse cache for project (slug) directories: dirKey → { entries before grouping, file mtime signature }
  private dirCache = new Map<string, { entries: HistoryEntry[]; sig: string }>()
  // projectPath(cwd) → slug directory (projectsPage fills it so page does not re-resolve directories)
  private dirByProject = new Map<string, string>()
  // The inverse: dirKey → projectPath. A changed directory has to be able to say which row it used to
  // represent, or a directory whose cwd moved would leave its old row behind forever.
  private projectByDir = new Map<string, string>()
  // entryId → entry (for preview lookups; page/preview fill it)
  private entryById = new Map<string, HistoryEntry>()
  // Per-account project rows. The unit of invalidation is one account (or one directory inside it, see
  // flushPendingDirs) rather than the whole list — one changed transcript used to discard every row,
  // and a running session changes one about once a second.
  private projectsByAccount = new Map<string, ProjectSummary[]>()
  // Directories whose row needs recomputing before the next notification: dirKey → what to recompute
  private pendingDirs = new Map<string, { account: Account; dir: string }>()
  // Cache of the project summary list (all accounts, sorted). Rebuilt from projectsByAccount, so
  // dropping it costs a concat and a sort, not a disk pass
  private projectsCache: ProjectSummary[] | null = null
  // Bumped by every invalidate, so a build that started before it does not write its stale result back
  private generation = 0
  // One handle per scan root (native), or one chokidar watcher per root on the fallback path
  private watchers: WatchHandle[] = []
  private updateTimer: ReturnType<typeof setTimeout> | null = null
  private updateDeadline = 0
  private reloading: Promise<void> = Promise.resolve()
  onUpdated?: () => void

  constructor(
    private getAccounts: () => Account[],
    private descriptors: Record<Provider, ProviderDescriptor> = makeDescriptors(process.platform),
    // Absent (tests, and any caller that has no userData) simply means every cwd is parsed each pass
    private cwdCache?: SessionCwdCache
  ) {}

  // The narrow interface handed to a strategy — ownership of the cache and file traversal stays here
  private readonly io: HistoryIo = {
    parseDir: (account, dir) => this.parseDir(account, dir),
    jsonlByMtimeDesc: (dir) => this.jsonlFilesByMtimeDesc(dir),
    subdirs: (dir) => this.subdirs(dir),
    resolveProjectCwd: (dir, files) => this.resolveProjectCwd(dir, files),
    cwdMemo: (files, parse) => this.cwdMemo(files, parse),
    samePath: (a, b) => norm(a) === norm(b),
    pathKey: (p) => norm(p),
    cacheDirForProject: (accountId, projectPath, dir) => {
      this.dirByProject.set(accountId + '\0' + norm(projectPath), dir)
      this.projectByDir.set(accountId + '\0' + norm(dir), projectPath)
    }
  }

  /** The account a path under a scan root belongs to. */
  private ownerOf(filePath: string): Account | undefined {
    return this.getAccounts().find((a) => filePath.startsWith(this.scanRoot(a)))
  }

  private strategyFor(account: { provider?: Provider }): HistoryStrategy {
    return descriptorOf(this.descriptors, account).history
  }

  /** Turns on the file watcher (no scan). Cheap on the native path — a handle per scan root — but
   *  still called in the background after the window and IPC are ready, because the chokidar fallback
   *  is not. */
  async startBackground(): Promise<void> {
    await this.startWatcher()
  }

  async stop(): Promise<void> {
    await this.closeWatchers()
    if (this.updateTimer) clearTimeout(this.updateTimer)
    this.updateTimer = null
  }

  /** On adding/removing an account — clears the caches and rebuilds the watcher. Serialized even
   *  when calls overlap. */
  reload(): Promise<void> {
    this.reloading = this.reloading.then(() => this.doReload())
    return this.reloading
  }

  private async doReload(): Promise<void> {
    await this.closeWatchers()
    this.invalidate()
    await this.startWatcher()
    this.emitUpdated()
  }

  /** Manual refresh — clears the caches so the next lookup reads the disk again (the fallback for a
   *  watcher failure) */
  async refresh(): Promise<void> {
    this.invalidate()
    this.emitUpdated()
  }

  private invalidate(): void {
    this.generation++
    this.dirCache.clear()
    this.dirByProject.clear()
    this.projectByDir.clear()
    this.entryById.clear()
    this.projectsByAccount.clear()
    this.pendingDirs.clear() // the whole list is being reread, so a per-directory patch is moot
    this.projectsCache = null
  }

  /** An account's scan root — claude=projects/, codex=sessions/ (shared by the watcher and cache keys) */
  private scanRoot(account: Account): string {
    return this.strategyFor(account).scanRoot(account)
  }

  private async subdirs(dir: string): Promise<string[]> {
    try {
      return (await fs.readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => path.join(dir, e.name))
    } catch {
      return [] // absent = no history (normal)
    }
  }

  /** Per-project summary list — built cheaply from directory enumeration + mtime + the newest file's
   *  meta (cwd) alone (sessions are not parsed). */
  async projectsPage(req?: {
    accountId?: string
    offset?: number
    limit?: number
    hiddenPaths?: string[]
  }): Promise<{
    projects: ProjectSummary[]
    total: number
  }> {
    const all = await this.buildProjects()
    const byAccount = req?.accountId ? all.filter((p) => p.accountId === req.accountId) : all
    // Hidden projects drop out here rather than in the renderer: total comes from this list, and a
    // renderer-side filter would leave it counting hidden rows, so the infinite-scroll sentinel would
    // never resolve. norm() is the one comparison rule (Windows case and separators).
    const hidden = new Set((req?.hiddenPaths ?? []).map(norm))
    const filtered = hidden.size ? byAccount.filter((p) => !hidden.has(norm(p.projectPath))) : byAccount
    // The same folder used by several accounts produces one entry per account, so merge by
    // normalized path (the newest one represents them) — in the unified view a project is one row
    // per folder. With an accountId filter it is a single account, so this is effectively a no-op
    const deduped = this.dedupeByProjectPath(filtered)
    const offset = req?.offset ?? 0
    const limit = req?.limit ?? 50
    return { projects: deduped.slice(offset, offset + limit), total: deduped.length }
  }

  /** For the file explorer guard — the project path list across all accounts. Reuses projectsCache
   *  and builds it if it has not been built. The basis list for allowing a project that shows up in
   *  the history to be browsed even when it has no sessions. */
  async knownProjectPaths(): Promise<string[]> {
    return (await this.buildProjects()).map((p) => p.projectPath)
  }

  /** Builds and caches the project summaries across all accounts (sorted). Reused until the watcher
   *  or refresh invalidates it. */
  private async buildProjects(): Promise<ProjectSummary[]> {
    if (this.projectsCache) return this.projectsCache
    const gen = this.generation
    const projects: ProjectSummary[] = []
    for (const account of this.getAccounts()) {
      // Only an account whose rows are actually gone is read from disk again
      const cached = this.projectsByAccount.get(account.id)
      if (cached) {
        projects.push(...cached)
        continue
      }
      const rows = await this.strategyFor(account).projectSummaries(account, this.io)
      if (gen === this.generation) this.projectsByAccount.set(account.id, rows)
      projects.push(...rows)
    }
    projects.sort(byUpdatedDesc)
    // A build that started before an invalidate must not write its result back. At startup the first
    // projectsPage is still in flight when the ghost scan lands, and caching that ghost-less list here
    // made the history:updated re-query hand back exactly the list it was meant to replace.
    if (gen === this.generation) this.projectsCache = projects
    return projects
  }

  /** Merge projects whose normalized path is the same (one folder used from several accounts) into
   *  one — keeping the newest updatedAt as the representative. */
  private dedupeByProjectPath(list: ProjectSummary[]): ProjectSummary[] {
    const byPath = new Map<string, ProjectSummary>()
    for (const p of list) {
      const key = norm(p.projectPath)
      const cur = byPath.get(key)
      if (!cur || p.updatedAt > cur.updatedAt) byPath.set(key, p)
    }
    return [...byPath.values()].sort(byUpdatedDesc)
  }

  /** Every entry matching the filters, **before** forks and rolling copies are merged — one per file
   *  on disk. page() merges this down for display; deletionTargets() must not, because a merged-away
   *  entry is still a file that would survive the delete and reappear in the list. */
  private async rawEntries(accountId?: string, projectPath?: string): Promise<HistoryEntry[]> {
    const accounts = this.getAccounts().filter((a) => !accountId || a.id === accountId)
    const all: HistoryEntry[] = []
    for (const account of accounts) {
      for (const dir of await this.dirsForProject(account, projectPath)) {
        const entries = await this.parseDir(account, dir)
        all.push(
          ...(projectPath ? entries.filter((e) => norm(e.projectPath) === norm(projectPath)) : entries)
        )
      }
    }
    return all
  }

  /** On expanding a project — parses only that project's (or those projects') transcripts to build
   *  the session list. */
  async page(req?: { accountId?: string; projectPath?: string; offset?: number; limit?: number }): Promise<{
    entries: HistoryEntry[]
    total: number
  }> {
    const all = dedupeBySessionId(groupForks(await this.rawEntries(req?.accountId, req?.projectPath))).sort(
      byUpdatedDesc
    )
    const offset = req?.offset ?? 0
    const limit = req?.limit ?? 50
    return { entries: all.slice(offset, offset + limit), total: all.length }
  }

  /**
   * What deleting one project's history would have to touch — every transcript file, the directories
   * holding them, and each account's scan root.
   *
   * **Only reports; deletes nothing.** The verdict on what may be removed lives in deletion.ts and
   * the removal itself in main (shell.trashItem), because this layer reaches disk through io alone.
   * scanRoots travels with the list so the caller can check each path against the boundary rather
   * than trusting these paths — a wrong path here is a file in the bin that cannot be reasoned back.
   *
   * Built from rawEntries, so forks and per-account rolling copies are all present: page() would have
   * merged them away, and each merged-away entry is a file that would outlive the delete.
   */
  async deletionTargets(projectPath: string): Promise<{
    files: string[]
    dirs: string[]
    scanRoots: string[]
  }> {
    const files = [...new Set((await this.rawEntries(undefined, projectPath)).map((e) => e.filePath))]
    return {
      files,
      dirs: [...new Set(files.map((f) => path.dirname(f)))],
      scanRoots: [...new Set(this.getAccounts().map((a) => this.scanRoot(a)))]
    }
  }

  async preview(entryId: string): Promise<TranscriptPreview> {
    const entry = this.entryById.get(entryId) ?? (await this.locateEntry(entryId))
    if (!entry) throw new Error(`unknown history entry: ${entryId}`)
    const account = this.getAccounts().find((a) => a.id === entry.accountId)
    const { messages, truncated } = await this.strategyFor(account ?? {}).preview(entry.filePath)
    return { entryId, messages, truncated }
  }

  /** The most recent transcript file for (accountId, cwd) — for computing the active session's
   *  context (usageContext). */
  async latestFilePathFor(accountId: string, cwd: string): Promise<string | null> {
    const account = this.getAccounts().find((a) => a.id === accountId)
    if (!account) return null
    // Usage context is based on the statusLine payload, so it exists only for a provider that uses
    // that mechanism
    if (!metaOf(account).usesStatusLine) return null
    let best: { path: string; mtimeMs: number } | null = null
    for (const dir of await this.dirsForProject(account, cwd)) {
      for (const f of await this.jsonlFilesByMtimeDesc(dir)) {
        if (!best || f.mtimeMs > best.mtimeMs) best = { path: path.join(dir, f.name), mtimeMs: f.mtimeMs }
      }
    }
    return best?.path ?? null
  }

  // ---- internal helpers ------------------------------------------------

  /** The directory's .jsonl files in descending mtime order. Files whose stat fails are excluded.
   *  size rides along because the stat is already being paid for and cwdMemo keys on it. */
  private async jsonlFilesByMtimeDesc(
    dir: string
  ): Promise<{ name: string; mtimeMs: number; size: number }[]> {
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
    return stats
      .filter((s): s is { name: string; mtimeMs: number; size: number } => s !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  /** Resolves the cwd of many session files at once. A hit in the persisted memo skips the parse
   *  entirely, which is what takes the codex project list off the startup path from the second run
   *  on — see sessionCwdCache.ts for why only codex needs it. Runs at the same concurrency as
   *  parseDir; the codex summary loop used to be sequential. */
  private async cwdMemo(
    files: { path: string; mtimeMs: number; size: number }[],
    parse: (filePath: string) => Promise<string | null>
  ): Promise<(string | null)[]> {
    const out = await mapWithConcurrency(files, 24, async (f) => {
      const hit = this.cwdCache?.get(f.path, f.mtimeMs, f.size)
      if (hit !== undefined) return hit
      let cwd: string | null = null
      try {
        cwd = await parse(f.path)
      } catch {
        cwd = null // unreadable or broken = no project, the same rule buildEntry applies
      }
      this.cwdCache?.set(f.path, f.mtimeMs, f.size, cwd)
      return cwd
    })
    await this.cwdCache?.flush()
    return out
  }

  /** Reads the meta of up to 8 files, newest first, to find the real cwd. On a helper/sidechain or a
   *  missing cwd, moves to the next file. */
  private async resolveProjectCwd(dir: string, filesNewestFirst: string[]): Promise<string | null> {
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

  /** The slug directories corresponding to projectPath. The dirByProject cache first; on a miss,
   *  found by enumeration + cwd resolution. With projectPath unspecified, every project directory of
   *  the account (when page is called with no filter). */
  private async dirsForProject(account: Account, projectPath?: string): Promise<string[]> {
    const s = this.strategyFor(account)
    if (!projectPath || !s.filtersByProject) return s.allDirs(account, this.io)
    const cached = this.dirByProject.get(account.id + '\0' + norm(projectPath))
    if (cached) return [cached]
    return s.dirsMatchingProject(account, projectPath, this.io)
  }

  /** Parses every session in one slug directory (before grouping). Cached by the file mtime signature. */
  private async parseDir(account: Account, dir: string): Promise<HistoryEntry[]> {
    const files = await this.jsonlFilesByMtimeDesc(dir)
    const sig = files.map((f) => `${f.name}:${f.mtimeMs}`).join('|')
    const cacheKey = account.id + '\0' + norm(dir)
    const cached = this.dirCache.get(cacheKey)
    if (cached && cached.sig === sig) return cached.entries
    // Per-file parsing (meta + a 256KB tail) in parallel up to the concurrency ceiling — sequential
    // parsing was what made the first expand slow. The input is in descending mtime order so the
    // results are too, but page() does the final sort, so the order itself does not matter.
    const built = await mapWithConcurrency(files, 24, (f) =>
      this.buildEntry(account, path.join(dir, f.name), f.mtimeMs)
    )
    const entries = built.filter((e): e is HistoryEntry => e !== null)
    for (const e of entries) this.entryById.set(e.id, e)
    this.dirCache.set(cacheKey, { entries, sig })
    return entries
  }

  /** One transcript file → HistoryEntry. Noise (helper/sidechain) is null. The per-provider body
   *  lives in the strategy. */
  private async buildEntry(account: Account, filePath: string, mtimeMs?: number): Promise<HistoryEntry | null> {
    return this.strategyFor(account).buildEntry(account, filePath, mtimeMs, this.io)
  }

  /** On an entryById miss — delegates to the strategy (strategyFor) to find the entry by sessionId.
   *  Loading the cache (entryById.set) is done here (the caller), not by the strategy. */
  private async locateEntry(entryId: string): Promise<HistoryEntry | null> {
    const idx = entryId.indexOf(':')
    if (idx < 0) return null
    const accountId = entryId.slice(0, idx)
    const sessionId = entryId.slice(idx + 1)
    const account = this.getAccounts().find((a) => a.id === accountId)
    if (!account) return null
    const entry = await this.strategyFor(account).locate(account, sessionId, this.io)
    if (entry) this.entryById.set(entry.id, entry)
    return entry
  }

  /**
   * Registers the watch on every scan root — one native recursive handle each.
   *
   * This used to be a single chokidar watcher at depth 3, and it was the reason the first history
   * list felt slow. chokidar walks the tree and tracks every file individually: on a 3400-file
   * history that measured 5.5s and 6944 tracked entries, against 2.5ms here for the same roots. The
   * walk is fully async, but it runs on the same event loop and libuv threadpool as the first
   * `projectsPage` — which went from 197ms to 5576ms next to it. Nothing about awaiting it differently
   * helps; the fix is not doing the work.
   *
   * chokidar stays as the fallback for a platform without recursive support, where the per-directory
   * cost is unavoidable either way.
   *
   * A root that does not exist yet is skipped. chokidar did not pick up files created under a missing
   * root either (measured), so no behaviour is lost, and reload() re-registers whenever accounts change.
   */
  private async startWatcher(): Promise<void> {
    // Two accounts can share a configDir; chokidar deduped its own paths, a handle per root does not
    const roots = [...new Set(this.getAccounts().map((a) => this.scanRoot(a)))]
    for (const root of roots) {
      try {
        const w = fsWatch(root, { recursive: true }, (_type, filename) => {
          // filename is relative to the root, and null when the platform cannot name the entry
          if (filename !== null) this.onFileEvent(path.join(root, String(filename)))
        })
        w.on('error', () => {
          /* watcher failure → fall back to the UI's manual refresh. The app keeps working */
        })
        this.watchers.push(w)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue // no history yet
        await this.startChokidarWatcher(root) // no recursive support (older linux), EMFILE, EPERM…
      }
    }
  }

  /** The fallback path. Resolves once registration is done (chokidar `ready`); a failure before ready
   *  does not wait forever either. */
  private startChokidarWatcher(root: string): Promise<void> {
    const w = chokidar.watch(root, {
      ignoreInitial: true,
      // claude projects/<slug>/<file>=2, codex sessions/YYYY/MM/DD/<file>=3
      depth: 3,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
    })
    const onChange = (filePath: string): void => this.onFileEvent(filePath)
    w.on('add', onChange)
    w.on('change', onChange)
    w.on('unlink', onChange)
    w.on('error', () => {
      /* watcher failure → fall back to the UI's manual refresh. The app keeps working */
    })
    this.watchers.push(w)
    return new Promise<void>((resolve) => {
      w.once('ready', () => resolve())
      w.once('error', () => resolve())
    })
  }

  /** A file event under a scan root. Non-.jsonl entries (and the directory names a native watcher also
   *  reports) drop out here. */
  private onFileEvent(filePath: string): void {
    if (!filePath.endsWith('.jsonl')) return
    const dir = path.dirname(filePath)
    const account = this.ownerOf(filePath)
    // The session cache is per directory and keyed on the file mtimes, so dropping the one directory
    // is all it needs
    this.dirCache.delete((account?.id ?? '') + '\0' + norm(dir))
    // The project row is repaired in flushPendingDirs, just before the notification goes out. Doing it
    // here would mean a disk read per event, and a busy session emits one per append.
    if (account) this.pendingDirs.set(account.id + '\0' + norm(dir), { account, dir })
    else this.projectsCache = null // outside every scan root: no idea what to patch, so reread it all
    this.emitUpdated()
  }

  /**
   * Repairs the project rows the pending directories affect, then lets the notification go out.
   *
   * This is what stops one changed transcript from costing a whole disk pass. A row is derived from a
   * single directory, so for a provider whose directory maps 1:1 to a project (claude) only that
   * directory is reread — a few milliseconds against a rebuild that grows with the entire history, once
   * a second for as long as a session is writing. codex offers no per-directory recompute (its folder
   * is a date, and the newest mtime for one cwd can live in another folder), so its rows are dropped
   * per account — still leaving the other accounts' rows standing.
   */
  private async flushPendingDirs(): Promise<void> {
    if (this.pendingDirs.size === 0) return
    const pending = [...this.pendingDirs.values()]
    this.pendingDirs.clear()
    const gen = this.generation
    for (const { account, dir } of pending) {
      const rows = this.projectsByAccount.get(account.id)
      if (!rows) continue // nothing cached for this account: the next build reads it whole anyway
      const forDir = this.strategyFor(account).projectSummaryForDir
      if (!forDir) {
        this.projectsByAccount.delete(account.id)
        continue
      }
      const dirKey = account.id + '\0' + norm(dir)
      const was = this.projectByDir.get(dirKey)
      const next = await forDir(account, dir, this.io)
      if (gen !== this.generation) return // a full invalidate cut in; its reread wins
      // The row this directory used to stand for goes first — its cwd may have moved, or the directory
      // may have stopped being a project at all
      let updated = was ? rows.filter((p) => norm(p.projectPath) !== norm(was)) : rows
      if (next) {
        updated = [...updated, next] // forDir already refreshed both directory maps
      } else {
        // Drop both directions, or dirsForProject would keep handing page() a directory that no
        // longer holds that project
        this.projectByDir.delete(dirKey)
        if (was) this.dirByProject.delete(account.id + '\0' + norm(was))
      }
      this.projectsByAccount.set(account.id, updated)
    }
    this.projectsCache = null // a concat and a sort over the rows already in memory
  }

  private async closeWatchers(): Promise<void> {
    const open = this.watchers
    this.watchers = []
    for (const w of open) {
      try {
        await w.close()
      } catch {
        /* already gone */
      }
    }
  }

  /** Coalesces a burst of file events into one notification, but never past UPDATE_MAX_WAIT_MS from
   *  the first one — a plain resetting debounce would stay silent for as long as a session keeps
   *  appending, which is exactly when the sidebar most needs to move. */
  private emitUpdated(): void {
    const now = Date.now()
    if (this.updateTimer === null) this.updateDeadline = now + UPDATE_MAX_WAIT_MS
    else clearTimeout(this.updateTimer)
    this.updateTimer = setTimeout(
      () => {
        this.updateTimer = null
        // The rows are repaired before the renderer is told to re-query, so its fetch is a cache hit
        void this.flushPendingDirs().then(() => this.onUpdated?.())
      },
      Math.max(0, Math.min(UPDATE_DEBOUNCE_MS, this.updateDeadline - now))
    )
  }
}
