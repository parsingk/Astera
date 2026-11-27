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
