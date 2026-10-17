// The checks before a Job may carry the GitHub lifecycle (design 2026-10-17 §7.2): the folder's origin is a GitHub
// repository, gh works and is logged in, and the person may push and rerun CI there. One gh call answers the last three.
// The origin URL is never repeated: it can carry a token.
import { ghFailureSentence, type GhRunner } from './gh'
import { ghRepoArg, parseGitHubRemote, type GitHubRepo } from './remote'

/** The repository permissions that can push a branch and rerun a workflow. */
export const WRITE_PERMISSIONS = ['WRITE', 'MAINTAIN', 'ADMIN'] as const

export type PreflightResult = { ok: true; repo: GitHubRepo } | { ok: false; reason: string }

export async function lifecyclePreflight(
  d: { gh: GhRunner; originOf(cwd: string): Promise<string | null> },
  cwd: string
): Promise<PreflightResult> {
  const origin = await d.originOf(cwd)
  if (origin === null) return { ok: false, reason: 'this folder has no git remote named origin' }
  const repo = parseGitHubRemote(origin)
  if (repo === null) return { ok: false, reason: 'origin is not a GitHub repository' }
  const r = await d.gh(['repo', 'view', ghRepoArg(repo), '--json', 'nameWithOwner,viewerPermission'], cwd)
  if (!r.ok) return { ok: false, reason: ghFailureSentence(r).message }
  let permission: unknown
  try {
    permission = (JSON.parse(r.stdout) as { viewerPermission?: unknown } | null)?.viewerPermission
  } catch {
    permission = undefined
  }
  if (typeof permission !== 'string') return { ok: false, reason: 'gh repo view answered without a permission' }
  if (!(WRITE_PERMISSIONS as readonly string[]).includes(permission))
    return {
      ok: false,
      reason: `your permission on ${ghRepoArg(repo)} is ${permission}; pushing and rerunning CI need WRITE, MAINTAIN or ADMIN`
    }
  return { ok: true, repo }
}
