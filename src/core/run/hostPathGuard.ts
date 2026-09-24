// The Host's path guard (R10, design §5.1). The app's assertAllowedPath allows every project the
// person has opened; the Host has no such list and needs none: a validation or a review it starts
// runs in a Job's cwd, a Run's worktree, or a worktree its own worktrees.json lists, so those three
// are all it allows. Pure — no fs, no electron — so both the Host and a test build it over plain lists.
//
// Containment is isPathWithin's (core/files/tree.ts): a separator boundary, so D:\proj does not
// allow D:\proj2, and case folded on win32 and darwin only, exact on linux.
import { isPathWithin } from '../files/tree'

export function hostPathGuard(a: {
  jobCwds(): string[]
  runWorktrees(): string[]
  registeredWorktrees(): string[]
  refusal: string
}): (p: string) => Promise<string> {
  return async (p) => {
    // Read at each call: a Job, a Run worktree or a registered worktree can appear between two checks.
    // In this order, the first root that holds `p` is the answer. **An empty root is skipped** — a
    // Job whose cwd is '' would otherwise resolve to the Host's own working directory and allow it.
    for (const roots of [a.jobCwds(), a.runWorktrees(), a.registeredWorktrees()])
      for (const root of roots) if (root && isPathWithin(root, p)) return root
    throw new Error(a.refusal)
  }
}
