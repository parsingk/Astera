// The words for a GitHub lifecycle Run's facts in the app (G7b): the timeline's GitHub lines and the Run's GitHub block.
import type { GitHubInvalidatedReason } from '../../../core/github/lifecycle'
import type { MessageKey } from '../../../core/i18n'

/** Every reason the Host records for merge-ready withheld or withdrawn (lifecycle.ts), each with its words. */
export const INVALIDATED_REASONS: readonly GitHubInvalidatedReason[] = [
  'not-bound',
  'external-state-unavailable',
  'pr-not-open',
  'head-not-pushed',
  'review-of-another-head',
  'ci-not-passed',
  'question-open',
  'local-check-failed',
  'local-check-skipped',
  'closed',
  'merged',
  'head-changed',
  'base-changed',
  'ci-failed',
  'checks-changed'
]

export const invalidatedReasonKey = (r: GitHubInvalidatedReason): MessageKey => `jobs.github.reason.${r}` as MessageKey
