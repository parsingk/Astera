// What recovery needs to know about a worktree (P1 design §5). It runs git (in the app and in the Host); the
// judgment is pure and lives in core/recovery/decide.ts.
//
// Same conventions as gitSummary.ts: the adapter comes from core/worktrees/git.ts, it never throws,
// and a folder that is not a repository is reported rather than raised.
//
// **Nothing here looks at the disk synchronously** (stage 4 T1). The worktree can sit on an offline
// share, and a sync existsSync there froze the Electron main thread for 20 to 60 s. The folder is asked
// through the budgeted session-folder probe before git is spawned in it (spawning with a dead cwd looks
// into it synchronously too), and the marker files through the same probe. An answer that did not come
// is "cannot say" — `exists: null`, `inProgress: 'unknown'` — which recovery reads as a reason to stop,
// never as "gone" or "nothing in progress".
import path from 'node:path'
import { git } from '../worktrees/git'
import { defaultCwdProbe, type Probe } from '../sessions/pathProbe'
import type { GitFacts } from './types'

export interface GitFactsDeps {
  /** Test injection, as in GitSummaryDeps — the real git is used when this is absent. */
  git?: typeof git
  /** Test injection: the probe the folder and the marker files are asked through (defaultCwdProbe). */
  probe?: Probe
}

/** Porcelain codes that mean "both sides touched it": an unresolved conflict. */
const CONFLICT = /^(DD|AU|UD|UA|DU|AA|UU)/

/** The marker files git leaves in the git dir while a multi-step operation is unfinished, in the order
 *  they are reported. */
const MARKERS: Array<[string, NonNullable<GitFacts['inProgress']>]> = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert']
]

/** Which operation is unfinished. A marker that is there answers; failing that, one that did not
 *  answer makes it `unknown` — not null, which would claim nothing is in progress. */
async function inProgressFrom(gitDir: string, probe: Probe): Promise<GitFacts['inProgress']> {
  const answers = await Promise.all(MARKERS.map(([name]) => probe(path.join(gitDir, name))))
  const at = answers.indexOf('present')
  if (at >= 0) return MARKERS[at][1]
  return answers.includes('timeout') ? 'unknown' : null
}

export async function readGitFacts(cwd: string, deps: GitFactsDeps = {}): Promise<GitFacts> {
  const run = deps.git ?? git
  const probe = deps.probe ?? defaultCwdProbe
  if ((await probe(cwd)) === 'timeout')
    return { exists: null, head: null, dirty: null, inProgress: 'unknown', conflicts: null, branch: null }
  const absent: GitFacts = {
    exists: false,
    head: null,
    dirty: null,
    inProgress: null,
    conflicts: null,
    branch: null
  }
  const gitDir = await run(['rev-parse', '--absolute-git-dir'], { cwd })
  if (!gitDir.ok || gitDir.stdout === '') return absent

  const [head, status, branch] = await Promise.all([
    run(['rev-parse', 'HEAD'], { cwd }),
    // trim: false preserves the leading space of fixed-width XY porcelain codes; whole-string trim corrupts them
    run(['status', '--porcelain', '-uall'], { cwd, trim: false }),
    run(['branch', '--show-current'], { cwd })
  ])
  // A repository with no commit yet answers nothing for HEAD; that is a null head, not a failure.
  // When status fails, both dirty and conflicts are null to signal that recovery cannot trust them.
  if (!status.ok) {
    return {
      exists: true,
      head: head.ok && head.stdout !== '' ? head.stdout : null,
      dirty: null,
      inProgress: await inProgressFrom(path.resolve(gitDir.stdout), probe),
      conflicts: null,
      branch: branch.ok && branch.stdout !== '' ? branch.stdout : null
    }
  }
  const lines = status.stdout.split('\n').filter((l) => l !== '')
  return {
    exists: true,
    head: head.ok && head.stdout !== '' ? head.stdout : null,
    dirty: lines.length > 0,
    inProgress: await inProgressFrom(path.resolve(gitDir.stdout), probe),
    conflicts: lines.some((l) => CONFLICT.test(l)),
    branch: branch.ok && branch.stdout !== '' ? branch.stdout : null
  }
}
