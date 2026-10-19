// The words for a GitHub lifecycle Run's facts in the app (G7b): the timeline's GitHub lines and the Run's GitHub block.
import type { GitHubInvalidatedReason } from '../../../core/github/lifecycle'
import type { MessageKey } from '../../../core/i18n'
import type { JobRow } from '../../../core/types'

/** Every reason the Host records for merge-ready withheld or withdrawn (lifecycle.ts), as a Record over the union so a
 *  new reason does not compile without its words (final review M7). */
const REASON_WORDS: Record<GitHubInvalidatedReason, true> = {
  'not-bound': true,
  'external-state-unavailable': true,
  'pr-not-open': true,
  'head-not-pushed': true,
  'review-of-another-head': true,
  'ci-not-passed': true,
  'question-open': true,
  'local-check-failed': true,
  'local-check-skipped': true,
  closed: true,
  merged: true,
  'head-changed': true,
  'base-changed': true,
  'ci-failed': true,
  'checks-changed': true
}
export const INVALIDATED_REASONS = Object.keys(REASON_WORDS) as GitHubInvalidatedReason[]

export const invalidatedReasonKey = (r: GitHubInvalidatedReason): MessageKey => `jobs.github.reason.${r}` as MessageKey

/** The Jobs card's GitHub chip (G7b): merge-ready, waiting on GitHub CI, or repairing a CI failure; none for the rest.
 *  A question speaks on its own row, and the other states are the detail's to say. */
export function githubChipOf(row: Pick<JobRow, 'github'>): MessageKey | null {
  switch (row.github?.state) {
    case 'merge-ready':
      return 'jobs.github.chip.ready'
    case 'ci-pending':
    case 'ci-infrastructure-failure':
      return 'jobs.github.chip.ci'
    // Repairing CI only when the repair is of CI (final review I1); a local or review repair is the node's to say
    case 'repairing':
      return row.github?.repair?.subject?.kind === 'ci' ? 'jobs.github.chip.repairing' : null
    default:
      return null
  }
}
