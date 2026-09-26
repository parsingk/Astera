// The Host's path guard (R10, design §5.1). The app's assertAllowedPath allows every project the
// person has opened; the Host has no such list and needs none: a validation or a review it starts
// runs in a Job's cwd, a Run's worktree, or a worktree its own worktrees.json lists, so those three
// are all it allows. Pure — no fs, no electron — so both the Host and a test build it over plain lists.
//
// Containment is isPathWithin's (core/files/tree.ts): a separator boundary, so D:\proj does not
// allow D:\proj2, and case folded on win32 and darwin only, exact on linux.
//
// A Job cwd that is a filesystem root or the home folder allows nothing (S45-11): a Job pointed at a
// drive root or at ~ would otherwise let a validation or a review run anywhere below it. Only the Job
// list is judged this way; a Run worktree and a registered worktree are folders Astera made itself.
import os from 'node:os'
import path from 'node:path'
import { isPathWithin, isSamePath } from '../files/tree'

/** Whether a Job cwd is too broad to be a root: a filesystem root, or the home folder itself. */
export function tooBroadJobCwd(cwd: string, home: string = os.homedir()): boolean {
  const abs = path.resolve(cwd)
  return abs === path.parse(abs).root || (home !== '' && isSamePath(abs, path.resolve(home)))
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
