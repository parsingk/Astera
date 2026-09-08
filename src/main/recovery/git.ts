// What recovery needs to know about a worktree (P1 design §5). Main-side because it runs git; the
// judgment is pure and lives in core/recovery/decide.ts.
//
// Same conventions as gitSummary.ts: the adapter comes from core/worktrees/git.ts, it never throws,
// and a folder that is not a repository is reported rather than raised.
import path from 'node:path'
import { existsSync } from 'node:fs'
import { git } from '../../core/worktrees/git'
import type { GitFacts } from '../../core/recovery/types'

export interface GitFactsDeps {
  /** Test injection, as in GitSummaryDeps — the real git is used when this is absent. */
  git?: typeof git
}

/** Porcelain codes that mean "both sides touched it": an unresolved conflict. */
const CONFLICT = /^(DD|AU|UD|UA|DU|AA|UU)/

/** The marker files git leaves in the git dir while a multi-step operation is unfinished. */
function inProgressFrom(gitDir: string): GitFacts['inProgress'] {
  if (existsSync(path.join(gitDir, 'MERGE_HEAD'))) return 'merge'
  if (existsSync(path.join(gitDir, 'rebase-merge')) || existsSync(path.join(gitDir, 'rebase-apply')))
    return 'rebase'
  if (existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
  if (existsSync(path.join(gitDir, 'REVERT_HEAD'))) return 'revert'
  return null
}

export async function readGitFacts(cwd: string, deps: GitFactsDeps = {}): Promise<GitFacts> {
  const run = deps.git ?? git
  const absent: GitFacts = {
    exists: false,
    head: null,
    dirty: false,
    inProgress: null,
    conflicts: false,
    branch: null
  }
  const gitDir = await run(['rev-parse', '--absolute-git-dir'], { cwd })
  if (!gitDir.ok || gitDir.stdout === '') return absent

  const [head, status, branch] = await Promise.all([
    run(['rev-parse', 'HEAD'], { cwd }),
    run(['status', '--porcelain', '-uall'], { cwd }),
    run(['branch', '--show-current'], { cwd })
  ])
  // A repository with no commit yet answers nothing for HEAD; that is a null head, not a failure.
  const lines = status.ok ? status.stdout.split('\n').filter((l) => l !== '') : []
  return {
    exists: true,
    head: head.ok && head.stdout !== '' ? head.stdout : null,
    dirty: lines.length > 0,
    inProgress: inProgressFrom(path.resolve(gitDir.stdout)),
    conflicts: lines.some((l) => CONFLICT.test(l)),
    branch: branch.ok && branch.stdout !== '' ? branch.stdout : null
  }
}
