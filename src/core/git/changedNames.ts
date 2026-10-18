// The files changed from a head to HEAD in a folder: the suspicious-files pass's diff (convergence design §8.3), read by
// the app and the Host alike (GitHub lifecycle G3c1: a lifecycle Task's checks run on the Host too). Pure over the runner.
import type { GitResult } from '../worktrees/git'

export type ChangedNamesGit = (args: string[], opts: { cwd: string }) => Promise<GitResult>

/** `git diff --name-only <fromHead> HEAD` in `cwd`; null when git fails, so the caller falls back to what the Task
 *  reported. */
export async function changedNames(run: ChangedNamesGit, cwd: string, fromHead: string): Promise<string[] | null> {
  const r = await run(['diff', '--name-only', fromHead, 'HEAD'], { cwd })
  return r.ok ? r.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : null
}
