// A review issue's file as a diff names it (Phase 3 Part 4): the reviewer writes a path relative to the folder it read,
// sometimes with backslashes, a leading ./ or as an absolute path; git names a path relative to the repo with forward
// slashes. The Host's anchor recorder and the diff's placement compare them the same way.
import { isPathWithin } from '../files/tree'

/** The file relative to the repo with forward slashes and no leading ./; an absolute path outside the repo stays
 *  absolute (with forward slashes), and so matches nothing in the diff. */
export function repoPathOf(file: string, repo: string, platform: string = process.platform): string {
  const slashed = file.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  const absolute = /^[A-Za-z]:\//.test(slashed) || slashed.startsWith('/')
  if (!absolute || !isPathWithin(repo, file, platform)) return slashed
  const base = repo.replace(/\\/g, '/').replace(/\/+$/, '')
  return slashed.slice(base.length).replace(/^\/+/, '')
}

/** Two repo-relative paths name the same file: case folded on win32, where the file system folds it. */
export function sameRepoPath(a: string, b: string, platform: string = process.platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** A review issue's file names the diff's path: the same path, or, for a project in a subfolder of its repository
 *  (where the reviewer names files from the folder and git from the repository), the diff's path ending in it at a
 *  folder boundary (final review M13). */
export function repoPathMatches(file: string, diffPath: string, repo: string, platform: string = process.platform): boolean {
  const rel = repoPathOf(file, repo, platform)
  if (sameRepoPath(rel, diffPath, platform)) return true
  if (/^[A-Za-z]:\//.test(rel) || rel.startsWith('/') || rel === '') return false
  const fold = (x: string): string => (platform === 'win32' ? x.toLowerCase() : x)
  return fold(diffPath).endsWith(`/${fold(rel)}`)
}
