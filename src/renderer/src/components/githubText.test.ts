// The words for a GitHub lifecycle Run's facts in the app (G7b): why merge-ready was withdrawn, in every language.
import { describe, it, expect } from 'vitest'
import { CATALOGS, LANGS } from '../../../core/i18n'
import type { GitHubInvalidatedReason } from '../../../core/github/lifecycle'
import { INVALIDATED_REASONS, invalidatedReasonKey } from './githubText'

describe('invalidatedReasonKey', () => {
  // Final review M7: the list is the union's (a Record over it), so a new reason does not compile without its word
  it('names a word for every reason the Host records, in every language', () => {
    const all: readonly GitHubInvalidatedReason[] = INVALIDATED_REASONS
    expect(all).toHaveLength(15)
    for (const r of all)
      for (const lang of LANGS) expect((CATALOGS[lang].messages as Record<string, string>)[invalidatedReasonKey(r)], `${lang} ${r}`).toBeTruthy()
  })

  it('the timeline\'s GitHub labels are in every language', () => {
    for (const k of ['prBound', 'prCreated', 'pushed', 'ciStarted', 'ciFailed', 'ciRerun', 'ciPassed', 'mergeReady', 'invalidated', 'sourceChanged'])
      for (const lang of LANGS) expect((CATALOGS[lang].messages as Record<string, string>)[`jobs.event.github.${k}`], `${lang} ${k}`).toBeTruthy()
  })
})
