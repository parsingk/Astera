import type { PrInfo } from '../../../core/github/types'
import type { BranchPushState } from '../../../core/types'

/** What a worktree row draws between its name and its actions. **One thing or nothing** — a row
 *  with both a PR and unpushed commits shows the PR, because that is the further-along fact.
 *  Kept out of the row's JSX so "only one of these" is a rule with a test rather than a ternary. */
export function rowSlot(
  pr: PrInfo | undefined,
  push: BranchPushState | undefined
):
  | { kind: 'pr'; pr: PrInfo }
  | { kind: 'push'; ahead: number | null }
  | null {
  if (pr) return { kind: 'pr', pr }
  if (!push) return null
  // ahead === 0 is nothing to push; ahead === null is unknown, and unknown still offers the
  // action rather than hiding a branch whose base simply could not be resolved.
  if (push.ahead === 0) return null
  return { kind: 'push', ahead: push.ahead }
}
