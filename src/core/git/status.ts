import { parentDir } from '../files/paths'

/** The git state shown in the tree — porcelain's two XY characters folded into four levels.
 *  staged and unstaged are not distinguished (they do not fit into a single-character slot). */
export type GitState = 'new' | 'modified' | 'deleted' | 'conflict'

export interface GitEntry {
  /** Path relative to the repository root — exactly as git printed it (POSIX separators) */
  relPath: string
  state: GitState
}

const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** Priority: conflict > deleted > new > modified. When one file matches several, the more dangerous one is shown. */
export function foldStatus(xy: string): GitState {
  if (UNMERGED.has(xy)) return 'conflict'
  const x = xy[0]
  const y = xy[1]
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === '?' || x === 'A') return 'new'
  return 'modified'
}

/**
 * Parses `git status --porcelain -z` output.
 *
 * A record is `XY<space>path` and ends with NUL. X or Y can be a space, so it must be split
 * **by fixed offset only** — looking for the first space gets " M path" wrong.
 *
 * For rename/copy (R/C) the original path follows in the next field, so one more field is consumed.
 * Without consuming it, the original path is misread as the status code of the next record.
 */
export function parsePorcelainZ(stdout: string): GitEntry[] {
  const fields = stdout.split('\0')
  const out: GitEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i]
    // Drops the trailing empty field, and broken records with no separating space (trimmed input and so on).
    // No guessing to recover — better to paint no status at all than to paint it on the wrong path.
    if (rec.length < 4 || rec[2] !== ' ') continue
    const xy = rec.slice(0, 2)
    if (xy[0] === 'R' || xy[0] === 'C') i++ // consume the original-path field
    out.push({ relPath: rec.slice(3), state: foldStatus(xy) })
  }
  return out
}

/** Whether p is root itself or below it — a sibling prefix (D:\proj vs D:\proj2) is filtered out at the separator boundary. */
function isUnder(p: string, root: string): boolean {
  if (p === root) return true
  if (!p.startsWith(root)) return false
  const c = p[root.length]
  return c === '/' || c === '\\'
}

/**
 * Counts, for every ancestor folder of the changed files, how many changes it holds — so a collapsed
 * folder gets a badge too.
 *
 * The status map holds the whole repository, so the count is accurate even for folders that have not
 * been expanded yet. absPaths and root are assumed to agree in case, since main builds both absolute
 * paths the same way.
 */
export function folderCounts(absPaths: string[], root: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const p of absPaths) {
    let dir = parentDir(p)
    while (isUnder(dir, root)) {
      counts[dir] = (counts[dir] ?? 0) + 1
      if (dir === root) break
      const up = parentDir(dir)
      if (up === dir) break // a drive root or similar, where there is nowhere further up
      dir = up
    }
  }
  return counts
}
