/** How a branch sits against its base and its upstream. */
export interface BranchPushState {
  /** Commits on this branch that the base does not have. **null means unknown** — the base ref
   *  could not be resolved — and must never be treated as 0. A branch with work on it would
   *  otherwise render as having nothing to push. */
  ahead: number | null
  behind: number | null
  hasUpstream: boolean
  /** The upstream is configured but no longer exists on the remote (git prints `gone`). */
  upstreamGone: boolean
}

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
    if (parts.length < 4) continue // not our format — skip, do not guess
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
