import path from 'node:path'
import ignore from 'ignore'

/** A directory entry. path is the absolute path main joined and sent down — the renderer never has to join paths. */
export interface DirEntry {
  name: string
  path: string
  isDir: boolean
}

/** Folders first, then by name (case-insensitive). Does not mutate the input. */
export function sortEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

// win32-first: ignore differences in path case and separators (the same rule as normalizePath in sessions/manager.ts)
const normalizePath = (p: string): string => path.resolve(p).toLowerCase()

/** Whether target is base itself or a path below it — the path guard for the files IPC.
 *  Requiring a separator boundary blocks false positives from sibling prefixes (D:\proj vs D:\proj2). */
export function isPathWithin(base: string, target: string): boolean {
  const b = normalizePath(base)
  const t = normalizePath(target)
  return t === b || t.startsWith(b + path.sep)
}

/** Whether a and b are the same path — ownership, not containment. isPathWithin's "at or below"
 *  is right for a guard (the files IPC must not escape a root), but wrong for "does this Run belong
 *  to this project": isPathWithin(project, run.cwd) is also true for a nested repository below the
 *  project root, which silently pulls in a Run that belongs to a different, nested project. Shares
 *  normalizePath with isPathWithin, so it inherits the same win32-first case-insensitivity. */
export function isSamePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
}

// Excluded from the watcher — language-neutral, cross-language heavy/generated directories.
// Under gitignore semantics a name with no slash matches at any depth.
const CURATED_IGNORE = [
  '.git', '.hg', '.svn',
  'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', '.ruff_cache',
  'target', 'build', 'dist', 'out', 'bin', 'obj', '.gradle', 'vendor',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.idea'
]

/** The watcher's ignore matcher. Combines the curated list with the root .gitignore (when there is
 *  one) and reports whether a root-relative path is excluded. The exclusion is watcher-only — it has
 *  no effect on what the tree displays. */
export function buildIgnoreMatcher(gitignoreText: string | null): (relPath: string) => boolean {
  const ig = ignore()
  ig.add(CURATED_IGNORE)
  if (gitignoreText) ig.add(gitignoreText)
  return (relPath: string): boolean => {
    if (!relPath) return false // the root itself
    return ig.ignores(relPath.replace(/\\/g, '/'))
  }
}
