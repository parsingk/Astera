import { promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'
import { buildIgnoreMatcher } from '../core/files/tree'
import { filterFilePaths } from '../core/files/fileMatch'

/** How many files one project's list holds. A repository larger than this is answered from the first
 *  slice of its walk, which is breadth-first, so what is missing is the deepest corners rather than
 *  an arbitrary tail. Big enough for every repository on this machine, small enough that the walk and
 *  the filter both stay off anyone's critical path. */
const MAX_FILES = 20_000

/** How long a walked list is reused. Long enough that typing a name never re-walks, short enough that
 *  a file created a moment ago shows up without anyone restarting anything. */
const TTL_MS = 30_000

interface Entry {
  paths: string[]
  at: number
}

export interface FileIndex {
  /** The best `limit` matches for `query` under `root`, as root-relative paths with forward slashes.
   *  An unreadable root answers an empty list rather than throwing: the caller is drawing a menu. */
  search(root: string, query: string, limit: number): Promise<string[]>
}

/**
 * The list of files a project offers to `@`.
 *
 * Walked breadth-first and filtered by the same matcher the file watcher uses — the curated list of
 * heavy directories plus the root .gitignore — so what is offered is what a person would call part of
 * the project, not a `node_modules` tree twenty times its size.
 */
export function createFileIndex(now: () => number = Date.now): FileIndex {
  const cache = new Map<string, Entry>()

  const walk = async (root: string): Promise<string[]> => {
    let gitignore: string | null = null
    try {
      gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8')
    } catch {
      /* No .gitignore — the curated list only, exactly as the watcher does */
    }
    const ignored = buildIgnoreMatcher(gitignore)
    const out: string[] = []
    // Breadth-first, so a cap cuts the deepest corners rather than everything after one large folder.
    const queue: string[] = ['']
    while (queue.length > 0 && out.length < MAX_FILES) {
      const rel: string = queue.shift() ?? ''
      let entries: Dirent[]
      try {
        entries = await fs.readdir(path.join(root, rel), { withFileTypes: true })
      } catch {
        continue // a folder that vanished or cannot be read is not worth failing the whole walk for
      }
      for (const entry of entries) {
        const child = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (ignored(child)) continue
        if (entry.isDirectory()) queue.push(child)
        else if (entry.isFile()) {
          out.push(child)
          if (out.length >= MAX_FILES) break
        }
      }
    }
    return out
  }

  return {
    async search(root, query, limit) {
      if (root === '') return []
      const cached = cache.get(root)
      let paths = cached && now() - cached.at < TTL_MS ? cached.paths : null
      if (paths === null) {
        paths = await walk(root).catch(() => [])
        cache.set(root, { paths, at: now() })
      }
      return filterFilePaths(paths, query, limit)
    }
  }
}
