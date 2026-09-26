// The Host's path guard (R10, design §5.1). The app's assertAllowedPath allows every project the
// person has opened; the Host has no such list and needs none: a validation or a review it starts
// runs in a Job's cwd, a Run's worktree, or a worktree its own worktrees.json lists, so those three
// are all it allows. No electron, and no fs but one guarded realpath (below), so both the Host and a
// test build it over plain lists.
//
// Containment is isPathWithin's (core/files/tree.ts): a separator boundary, so D:\proj does not
// allow D:\proj2, and case folded on win32 and darwin only, exact on linux.
//
// A Job cwd that is a filesystem root or the home folder allows nothing (S45-11): a Job pointed at a
// drive root or at ~ would otherwise let a validation or a review run anywhere below it. Only the Job
// list is judged this way; a Run worktree and a registered worktree are folders Astera made itself.
//
// **A bare drive and a symlinked home** (final review M6). On win32 `C:` names the drive, but resolves
// to the Host's working folder on that drive, which is no root, so it is refused by its spelling. A home
// folder reached through a symlink (`/home/me` → `/data/me`) is the same folder under either name, so
// both the cwd and the home are compared as written and through realpath. A realpath that throws (the
// folder is gone, or unreadable) leaves the path as written.
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isPathWithin } from '../files/tree'
import { foldPathCase } from '../files/paths'

/** A drive letter and its colon, nothing more: win32's drive-relative spelling of the drive itself. */
const BARE_DRIVE = /^[a-zA-Z]:$/

const realpathOrSelf = (p: string, realpath: (p: string) => string): string => {
  try {
    return realpath(p)
  } catch {
    return p
  }
}

/** Whether a Job cwd is too broad to be a root: a filesystem root, or the home folder itself. The
 *  platform and realpath are seams, so a test runs the other platform's rules too. */
export function tooBroadJobCwd(
  cwd: string,
  home: string = os.homedir(),
  o: { platform?: string; realpath?: (p: string) => string } = {}
): boolean {
  const platform = o.platform ?? process.platform
  const P = platform === 'win32' ? path.win32 : path.posix
  if (platform === 'win32' && BARE_DRIVE.test(cwd.trim())) return true
  const abs = P.resolve(cwd)
  if (abs === P.parse(abs).root) return true
  if (home === '') return false
  const realpath = o.realpath ?? ((x: string): string => realpathSync.native(x))
  const key = (x: string): string => foldPathCase(P.resolve(x), platform)
  const homeAbs = P.resolve(home)
  const homes = new Set([key(homeAbs), key(realpathOrSelf(homeAbs, realpath))])
  return homes.has(key(abs)) || homes.has(key(realpathOrSelf(abs, realpath)))
}

export function hostPathGuard(a: {
  jobCwds(): string[]
  runWorktrees(): string[]
  registeredWorktrees(): string[]
  refusal: string
  /** The home folder a Job cwd must not be (defaults to os.homedir()). */
  home?: string
}): (p: string) => Promise<string> {
  return async (p) => {
    // Read at each call: a Job, a Run worktree or a registered worktree can appear between two checks.
    // In this order, the first root that holds `p` is the answer. **An empty root is skipped** — a
    // Job whose cwd is '' would otherwise resolve to the Host's own working directory and allow it.
    // A Job cwd that is a filesystem root or the home folder is dropped here, before containment.
    const jobs = a.jobCwds().filter((c) => c && !tooBroadJobCwd(c, a.home))
    for (const roots of [jobs, a.runWorktrees(), a.registeredWorktrees()])
      for (const root of roots) if (root && isPathWithin(root, p)) return root
    throw new Error(a.refusal)
  }
}
