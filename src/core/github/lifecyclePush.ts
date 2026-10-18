// The git and gh steps the Host takes to carry a lifecycle round to GitHub (GitHub lifecycle G3b1, design §4.2-4.3):
// push the Run branch to origin, never forced (L24), telling a push GitHub refused because the branch moved from one
// that failed for another reason; read HEAD; open a draft pull request (L5) that refers to its issue (L25). Pure over
// the injected runners.
import { ghFailureSentence, type GhFailed, type GhRunner } from './gh'
import { repoOf } from './issue'
import { ghRepoArg, repoSlug, type GitHubRepo } from './remote'
import type { JobSourceRef } from '../orchestration/types'
import type { GitResult } from '../worktrees/git'

export type RunGit = (args: string[], opts: { cwd: string; timeoutMs?: number }) => Promise<GitResult>

/** As long as createPullRequest gives its push: a large first push over a slow line. */
const PUSH_TIMEOUT_MS = 180_000

/** git's words for a push the remote refused because the branch moved on it. */
const REJECTED = /\[rejected\]|non-fast-forward|fetch first/i
const AUTH = /permission denied|permission to .* denied|authentication failed|could not read username|returned error: 40[13]/i
const NETWORK = /could not resolve host|connection (timed out|refused|reset)|unable to connect|failed to connect|network is unreachable|operation timed out/i

export type PushFailure = { ok: false; kind: 'rejected' | 'auth' | 'network' | 'other'; detail: string }

/** `git push -u origin <branch>`. A push of a head the remote already has is a success ("Everything up-to-date"). */
export async function pushBranch(run: RunGit, cwd: string, branch: string): Promise<{ ok: true } | PushFailure> {
  const r = await run(['push', '-u', 'origin', branch], { cwd, timeoutMs: PUSH_TIMEOUT_MS })
  if (r.ok) return { ok: true }
  const text = r.stderr
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  // git's first line names the remote ("To https://…", measured): the line that says why is the refusal or the error
  const telling = lines.find((l) => /\[rejected\]|^(error|fatal|remote):|denied|could not|unable to/i.test(l)) ?? lines[0]
  const detail = telling ?? (r.timedOut ? 'the push ran out of time' : 'the push failed')
  const kind = REJECTED.test(text) ? 'rejected' : AUTH.test(text) ? 'auth' : NETWORK.test(text) || r.timedOut ? 'network' : 'other'
  return { ok: false, kind, detail }
}

/** The commit HEAD names, or null when git cannot say. */
export async function headOf(run: RunGit, cwd: string): Promise<string | null> {
  const r = await run(['rev-parse', 'HEAD'], { cwd })
  const sha = r.stdout.trim()
  return r.ok && /^[0-9a-f]{40}$/i.test(sha) ? sha : null
}

/** `Refs #<n>` for an issue of the repository the pull request is in, compared without case; null for any other
 *  source. Never a closing keyword (L25): closing the issue stays a person's decision. */
export function refsLine(source: JobSourceRef | undefined, repo: GitHubRepo): string | null {
  if (source?.id !== 'github' || source.url === undefined) return null
  return repoOf(source.url).toLowerCase() === repoSlug(repo).toLowerCase() ? `Refs #${source.itemId}` : null
}

/** The number of a pull request URL, or null. */
export function prNumberOf(url: string): number | null {
  const m = url.match(/\/pull\/(\d+)\b/)
  return m ? Number(m[1]) : null
}

const PR_URL = /https?:\/\/\S+\/pull\/\d+/

/** `gh pr create --draft` in `repo`, from `head` into `base`. A pull request that already exists for the branch is read
 *  from gh's words (`existed`), so a create that timed out and is tried again binds the one it made. */
export async function createDraftPr(
  run: GhRunner,
  cwd: string,
  repo: GitHubRepo,
  pr: { base: string; head: string; title: string; body: string }
): Promise<{ ok: true; number: number; url: string; existed?: true } | GhFailed> {
  const r = await run(['pr', 'create', '--draft', '--repo', ghRepoArg(repo), '--base', pr.base, '--head', pr.head, '--title', pr.title, '--body', pr.body], cwd)
  const said = (r.ok ? r.stdout : r.stderr).match(PR_URL)?.[0]
  const number = said === undefined ? null : prNumberOf(said)
  if (said !== undefined && number !== null) {
    if (r.ok) return { ok: true, number, url: said }
    if (/already exists/i.test(r.stderr)) return { ok: true, number, url: said, existed: true }
  }
  if (r.ok) return { ok: false, kind: 'other', message: 'gh pr create answered without a pull request URL' }
  return { ok: false, ...ghFailureSentence(r) }
}
