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
