import { promises as fs } from 'node:fs'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { Account, HistoryEntry, ProjectSummary, Provider, TranscriptPreview } from '../types'
import { parseTranscriptMeta } from './parser'
import { metaOf } from '../providers/meta'
import { descriptorOf, makeDescriptors, type ProviderDescriptor } from '../providers/descriptor'
import type { HistoryIo, HistoryStrategy } from './strategies/types'

// win32 first: ignore path case and separator differences (the same rule as normalizePath in
// sessions/manager.ts)
const norm = (p: string): string => path.resolve(p).toLowerCase()

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
  // entryId → entry (for preview lookups; page/preview fill it)
  private entryById = new Map<string, HistoryEntry>()
  // Cache of the project summary list (all accounts, sorted). Invalidated on a watcher event/refresh/reload
  private projectsCache: ProjectSummary[] | null = null
  private watcher: FSWatcher | null = null
  private updateTimer: ReturnType<typeof setTimeout> | null = null
  private reloading: Promise<void> = Promise.resolve()
  onUpdated?: () => void

  constructor(
    private getAccounts: () => Account[],
    private descriptors: Record<Provider, ProviderDescriptor> = makeDescriptors(process.platform)
  ) {}

  // The narrow interface handed to a strategy — ownership of the cache and file traversal stays here
  private readonly io: HistoryIo = {
    parseDir: (account, dir) => this.parseDir(account, dir),
    jsonlByMtimeDesc: (dir) => this.jsonlFilesByMtimeDesc(dir),
    subdirs: (dir) => this.subdirs(dir),
    resolveProjectCwd: (dir, files) => this.resolveProjectCwd(dir, files),
    samePath: (a, b) => norm(a) === norm(b),
    pathKey: (p) => norm(p),
    cacheDirForProject: (accountId, projectPath, dir) =>
      this.dirByProject.set(accountId + '\0' + norm(projectPath), dir)
  }

  private strategyFor(account: { provider?: Provider }): HistoryStrategy {
    return descriptorOf(this.descriptors, account).history
  }

  /** Heavy init — turns on the file watcher only (no full scan). Call in the background after the
   *  window and IPC are ready. */
  async startBackground(): Promise<void> {
    await this.startWatcher()
  }

  async stop(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
    if (this.updateTimer) clearTimeout(this.updateTimer)
  }

  /** On adding/removing an account — clears the caches and rebuilds the watcher. Serialized even
   *  when calls overlap. */
  reload(): Promise<void> {
    this.reloading = this.reloading.then(() => this.doReload())
    return this.reloading
  }

  private async doReload(): Promise<void> {
    await this.watcher?.close()
    this.watcher = null
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
    this.dirCache.clear()
    this.dirByProject.clear()
    this.entryById.clear()
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
    const projects: ProjectSummary[] = []
    for (const account of this.getAccounts()) {
      projects.push(...(await this.strategyFor(account).projectSummaries(account, this.io)))
    }
    projects.sort(byUpdatedDesc)
    this.projectsCache = projects
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

  /** On expanding a project — parses only that project's (or those projects') transcripts to build
   *  the session list. */
  async page(req?: { accountId?: string; projectPath?: string; offset?: number; limit?: number }): Promise<{
    entries: HistoryEntry[]
    total: number
  }> {
    const accounts = this.getAccounts().filter((a) => !req?.accountId || a.id === req.accountId)
    let all: HistoryEntry[] = []
    for (const account of accounts) {
      for (const dir of await this.dirsForProject(account, req?.projectPath)) {
        const entries = await this.parseDir(account, dir)
        all.push(
          ...(req?.projectPath
            ? entries.filter((e) => norm(e.projectPath) === norm(req.projectPath as string))
            : entries)
        )
      }
    }
    all = dedupeBySessionId(groupForks(all)).sort(byUpdatedDesc)
    const offset = req?.offset ?? 0
    const limit = req?.limit ?? 50
    return { entries: all.slice(offset, offset + limit), total: all.length }
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

  /** The directory's .jsonl files in descending mtime order. Files whose stat fails are excluded. */
  private async jsonlFilesByMtimeDesc(dir: string): Promise<{ name: string; mtimeMs: number }[]> {
    let names: string[]
    try {
      names = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      return []
    }
    const stats = await Promise.all(
      names.map(async (name) => {
        try {
          return { name, mtimeMs: (await fs.stat(path.join(dir, name))).mtimeMs }
        } catch {
          return null
        }
      })
    )
    return stats.filter((s): s is { name: string; mtimeMs: number } => s !== null).sort((a, b) => b.mtimeMs - a.mtimeMs)
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

  /** Resolves once watch registration is done (chokidar `ready`). A failure before ready does not
   *  wait forever either. */
  private startWatcher(): Promise<void> {
    const dirs = this.getAccounts().map((a) => this.scanRoot(a))
    if (dirs.length === 0) return Promise.resolve()
    this.watcher = chokidar.watch(dirs, {
      ignoreInitial: true,
      // claude projects/<slug>/<file>=2, codex sessions/YYYY/MM/DD/<file>=3
      depth: 3,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
    })
    const onChange = (filePath: string): void => {
      if (!filePath.endsWith('.jsonl')) return
      // Invalidate only the changed file's project cache, plus the project list cache (the next
      // lookup reads again)
      this.dirCache.delete(this.dirCacheKeyForFile(filePath))
      this.projectsCache = null
      this.emitUpdated()
    }
    this.watcher.on('add', onChange)
    this.watcher.on('change', onChange)
    this.watcher.on('unlink', onChange)
    this.watcher.on('error', () => {
      /* watcher failure → fall back to the UI's manual refresh. The app keeps working */
    })
    return new Promise<void>((resolve) => {
      this.watcher?.once('ready', () => resolve())
      this.watcher?.once('error', () => resolve())
    })
  }

  private dirCacheKeyForFile(filePath: string): string {
    const dir = path.dirname(filePath)
    const account = this.getAccounts().find((a) => filePath.startsWith(this.scanRoot(a)))
    return (account?.id ?? '') + '\0' + norm(dir)
  }

  private emitUpdated(): void {
    if (this.updateTimer) clearTimeout(this.updateTimer)
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null
      this.onUpdated?.()
    }, 150)
  }
}
