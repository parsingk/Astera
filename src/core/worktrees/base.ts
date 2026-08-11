import type { BranchRef } from '../types'

/**
 * The base branch a worktree should start out selected on, or null when no worktree can be created at all.
 *
 * Three cases, in order:
 * - the automatic detection found something → use it, so leaving the picker alone behaves as it always did
 * - detection found nothing but branches exist → the newest one. A repo whose branches are neither
 *   main/master nor pushed to origin (only `develop`, say) is perfectly forkable, and returning an empty
 *   selection there would let creation proceed and die on NO_BASE with the picker sitting right there
 * - neither → null. A repo with no commits yet (a fresh `git init`) has no ref to fork from, and the
 *   caller has to refuse before starting rather than let the attempt fail mid-flight
 *
 * The order of `branches` is trusted as given: listBranches sorts newest commit first.
 */
export function resolveInitialBase(opts: {
  branches: BranchRef[]
  detected: string | null
}): string | null {
  if (opts.detected) return opts.detected
  return opts.branches[0]?.name ?? null
}

/**
 * Orders branches for the picker: the current branch, then every remote-tracking one, then the rest of the
 * locals. Within each run the incoming order is kept, and listBranches hands them over newest commit first.
 *
 * Needed because listBranches sorts the whole set by commit date, which interleaves remotes and locals. The
 * picker groups by kind, and a heading is emitted wherever the group changes — so an interleaved list
 * produced "Remote / Local / Remote / Local" repeating down the menu instead of two blocks.
 *
 * Partitioning here rather than in listBranches keeps that function a plain view of the refs: date order is
 * the useful primitive, and how the picker groups them is the picker's business. Nor does it belong in
 * groupRowsOf, which renders the order it is given on purpose so every other Select stays predictable.
 *
 * The current branch is dropped from the local run so it cannot appear twice — it leads the list on its own.
 */
export function orderBranchesForPicker(branches: BranchRef[]): BranchRef[] {
  return [
    ...branches.filter((b) => b.current),
    ...branches.filter((b) => b.remote),
    ...branches.filter((b) => !b.remote && !b.current)
  ]
}
