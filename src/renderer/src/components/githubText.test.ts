// The words for a GitHub lifecycle Run's facts in the app (G7b): why merge-ready was withdrawn, in every language.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from '../../../core/i18n'
import type { GitHubInvalidatedReason } from '../../../core/github/lifecycle'
import { INVALIDATED_REASONS, invalidatedReasonKey } from './githubText'

describe('invalidatedReasonKey', () => {
  it('names a word for every reason the Host records, in every language', () => {
    const all: GitHubInvalidatedReason[] = [
      'not-bound', 'external-state-unavailable', 'pr-not-open', 'head-not-pushed', 'review-of-another-head', 'ci-not-passed',
      'question-open', 'local-check-failed', 'local-check-skipped', 'closed', 'merged', 'head-changed', 'base-changed',
      'ci-failed', 'checks-changed'
    ]
    expect([...INVALIDATED_REASONS].sort()).toEqual([...all].sort())
    for (const r of all)
      for (const lang of LANGS) expect((CATALOGS[lang].messages as Record<string, string>)[invalidatedReasonKey(r)], `${lang} ${r}`).toBeTruthy()
  })

  it('the timeline\'s GitHub labels are in every language', () => {
    for (const k of ['prBound', 'prCreated', 'pushed', 'ciStarted', 'ciFailed', 'ciRerun', 'ciPassed', 'mergeReady', 'invalidated', 'sourceChanged'])
      for (const lang of LANGS) expect((CATALOGS[lang].messages as Record<string, string>)[`jobs.event.github.${k}`], `${lang} ${k}`).toBeTruthy()
  })
})
