import type { Account, HistoryEntry, ProjectSummary, TranscriptPreview } from '../../types'

// There are two HistoryEntry types — session history (core/types.ts) and local file history
// (core/files/localHistory.ts, the delete-recovery snapshot). They are unrelated. This is the former.

/** HistoryIndex exposing its own helpers narrowly.
 *  The owner of the caches (dirCache, entryById) and of the file traversal is still the single
 *  HistoryIndex — duplicating a cache per strategy would just be a new surface for bugs. */
export interface HistoryIo {
  /** Owns the mtime signature cache (dirCache), entryById registration, and parsing in parallel at concurrency 24 */
  parseDir(account: Account, dir: string): Promise<HistoryEntry[]>
  jsonlByMtimeDesc(dir: string): Promise<{ name: string; mtimeMs: number }[]>
  /** Absolute paths of the subdirectories. The codex strategy assembles the three-level date walk
   *  (y/m/d) out of this itself — the knowledge that "the date is three levels" belongs to the side
   *  that knows the layout */
  subdirs(dir: string): Promise<string[]>
  /** Resolves a directory's real cwd (the cwd of the newest non-helper session). Both strategies use it */
  resolveProjectCwd(dir: string, filesNewestFirst: string[]): Promise<string | null>
  /** Normalization for path comparison — the same rule as `norm` in index.ts */
  samePath(a: string, b: string): boolean
  /** Normalized key for path comparison/hashing — the same rule as `norm` in index.ts.
   *  Use this when it is a Map key. samePath is only for comparing two paths directly. */
  pathKey(p: string): string
  /** Loads the projectPath→directory cache. HistoryIndex owns the map; a strategy only puts into it */
  cacheDirForProject(accountId: string, projectPath: string, dir: string): void
}

/** Per-provider interpretation of the history layout.
 *  For claude a disk directory maps 1:1 to a project; for codex it maps 1:1 to a date — that
 *  difference is gathered here. */
export interface HistoryStrategy {
  /** The account's scan root (shared by the watcher and cache keys) */
  scanRoot(account: Account): string
  /** Whether **directories** can be filtered by projectPath. claude=true, codex=false.
   *  When false, the caller takes allDirs and filters per entry instead */
  filtersByProject: boolean
  /** Every directory of the account to be scanned */
  allDirs(account: Account, io: HistoryIo): Promise<string[]>
  /** The directories corresponding to projectPath. Not called when filtersByProject is false */
  dirsMatchingProject(account: Account, projectPath: string, io: HistoryIo): Promise<string[]>
  projectSummaries(account: Account, io: HistoryIo): Promise<ProjectSummary[]>
  buildEntry(
    account: Account,
    filePath: string,
    mtimeMs: number | undefined,
    io: HistoryIo
  ): Promise<HistoryEntry | null>
  /** Finds the entry by sessionId. Loading entryById is done by the caller (HistoryIndex.locateEntry) */
  locate(account: Account, sessionId: string, io: HistoryIo): Promise<HistoryEntry | null>
  /** entryId is filled in by the caller (HistoryIndex.preview) — a strategy knows only filePath */
  preview(filePath: string): Promise<Omit<TranscriptPreview, 'entryId'>>
  /** Source session file path + the target account's configDir → the target path. Used by resuming
   *  into a different account and by the rolling transcript relay. It is the same kind of layout
   *  knowledge as scanRoot and allDirs, so it lives in the same file — core/rolling/transcript.ts
   *  used to know it separately. */
  mapTargetPath(srcPath: string, targetConfigDir: string): string
}
