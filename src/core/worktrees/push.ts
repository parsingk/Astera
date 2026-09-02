import { git, gitVersionAtLeast, remoteExists } from './git'
import type { GitResult } from './git'
import type { BranchPushState } from '../types'

/** The --format argument, with `%(ahead-behind:<base>)` left for the caller to fill in. Exported so
 *  the reader and the tests read the same contract; `<base>` is substituted, not concatenated by
 *  each caller. */
export const PUSH_STATE_FORMAT =
  '%(refname:short)|%(ahead-behind:<base>)|%(upstream:short)|%(upstream:track,nobracket)'

/** Parses `git for-each-ref` output in PUSH_STATE_FORMAT into a branch -> state map.
 *  A malformed line is skipped rather than sinking the whole repository's read. */
export function parsePushState(stdout: string): Record<string, BranchPushState> {
  const out: Record<string, BranchPushState> = {}
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('|')
    if (parts.length !== 4) continue // not our format — skip, do not guess
    const [name, aheadBehind, upstream, track] = parts
    if (name === '') continue
    // "3 0" when the base resolved, empty when it did not. Two numbers or nothing.
    const nums = aheadBehind.trim().split(/\s+/).filter((s) => s !== '')
    const resolved = nums.length === 2 && nums.every((n) => /^\d+$/.test(n))
    out[name] = {
      ahead: resolved ? Number(nums[0]) : null,
      behind: resolved ? Number(nums[1]) : null,
      hasUpstream: upstream !== '',
      upstreamGone: track.trim() === 'gone'
    }
  }
  return out
}

/** Injectable seams so the tests need neither a repository nor a git binary. Production callers
 *  pass nothing. */
export interface PushStateDeps {
  run?: (args: string[], cwd: string) => Promise<GitResult>
  versionOk?: () => Promise<boolean>
}

/** `%(ahead-behind:)` landed in git 2.41. Below that this whole read is skipped. */
const AHEAD_BEHIND_GIT = { major: 2, minor: 41 }

/** Push state for every branch of one repository, one `for-each-ref` per distinct base.
 *  Worktrees of a repository may carry different bases; in practice there is one.
 *  Returns an empty map rather than throwing when git is too old or a call fails — not knowing
 *  the count is no reason to withhold the action that depends on it. */
export async function readPushState(
  repoPath: string,
  bases: string[],
  deps: PushStateDeps = {}
): Promise<Record<string, BranchPushState>> {
  const run = deps.run ?? ((args: string[], cwd: string) => git(args, { cwd }))
  const versionOk =
    deps.versionOk ?? (() => gitVersionAtLeast(AHEAD_BEHIND_GIT.major, AHEAD_BEHIND_GIT.minor))
  if (!(await versionOk())) return {}
  const out: Record<string, BranchPushState> = {}
  for (const base of [...new Set(bases)]) {
    const r = await run(
      ['for-each-ref', `--format=${PUSH_STATE_FORMAT.replace('<base>', base)}`, 'refs/heads/'],
      repoPath
    )
    if (!r.ok) continue // one unreadable base must not sink the others
    Object.assign(out, parsePushState(r.stdout))
  }
  return out
}

/** Turns a stored baseRef into the branch name `gh pr create --base` expects.
 *
 *  **Remote-ness is decided by the remote list, never by the name's shape.** A local branch can
 *  contain a slash too — `parsingk/maple` looks exactly like `origin/main`, and astera names its
 *  own branches `<user>/<slug>`, so that is the ordinary case here rather than an edge one.
 *  fetchBaseRef in ./git records what shape-splitting cost the last time. */
export async function normalizeBaseForGh(
  repoPath: string,
  baseRef: string,
  isRemote: (repo: string, name: string) => Promise<boolean> = remoteExists
): Promise<string> {
  const slash = baseRef.indexOf('/')
  if (slash === -1) return baseRef
  const head = baseRef.slice(0, slash)
  return (await isRemote(repoPath, head)) ? baseRef.slice(slash + 1) : baseRef
}
