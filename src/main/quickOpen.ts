import path from 'node:path'
import type { FileIndex } from './fileIndex'

/** How many files Quick Open lists for one query. More than the composer's `@` menu (30): this box is the whole way to
 *  a file, not a hint beside a sentence. Past a screen of rows a person types another letter rather than scrolls. */
export const QUICK_OPEN_MATCHES = 50

/** The longest query looked up. File names are far shorter, so anything longer matches nothing and is answered so
 *  without walking a list. */
const MAX_QUERY = 256

export interface QuickOpenAnswer {
  /** Absolute paths, named the way the explorer names them (path.join in main), best match first. */
  paths: string[]
  /** The first walk of this root is still under way: `paths` is what it has found so far. */
  indexing: boolean
  /** The root did not answer or could not be read: there is no list to wait for. */
  unavailable?: true
  /** The rows come from the list held while the project is walked again: ask again shortly for the fresh one. */
  refreshing?: true
  /** The project holds more files than the index lists: the rows come from its shallow part only. */
  truncated?: true
}

export interface QuickOpenDeps {
  /** The project file list the composer's `@` menu also reads, keyed by the root string (main/fileIndex.ts). */
  index: Pick<FileIndex, 'lookup' | 'expire'>
  /** The files IPC's path guard: resolves for a session's folder, a registered worktree or a known project, and for
   *  anything below one; rejects everything else. */
  allowedRoot: (p: string) => Promise<string>
}

/**
 * Quick Open's question to main: which files under this project match what was typed (spec W2, audit §4).
 *
 * The root comes from the renderer, so it passes the same guard as every other files IPC before anything is read. The
 * answer is absolute paths made the way `files.list` makes them, so opening one lands on the tab the explorer would have
 * opened, not a second tab for the same file under a differently spelled path.
 *
 * `refresh` (true) is the box's first ask as it opens: the project is walked again, the list held so far answering
 * meanwhile. The explorer's watcher keeps the list current only while the explorer is open; this covers what changed
 * with it closed, at the cost of one walk per opening (about 0.1 s for 10,000 files, measured).
 */
export function createQuickOpen(
  deps: QuickOpenDeps
): (root: unknown, query: unknown, refresh?: unknown) => Promise<QuickOpenAnswer> {
  return async (root, query, refresh) => {
    if (typeof root !== 'string' || root === '' || typeof query !== 'string') {
      throw new Error('files.quickOpen takes a project folder and a query')
    }
    await deps.allowedRoot(root)
    if (query.length > MAX_QUERY) return { paths: [], indexing: false }
    if (refresh === true) deps.index.expire(root)
    const found = await deps.index.lookup(root, query, QUICK_OPEN_MATCHES)
    return {
      paths: found.paths.map((rel) => path.join(root, ...rel.split('/'))),
      indexing: found.indexing,
      ...(found.unavailable === true ? { unavailable: true as const } : {}),
      ...(found.refreshing === true ? { refreshing: true as const } : {}),
      ...(found.truncated === true ? { truncated: true as const } : {})
    }
  }
}
