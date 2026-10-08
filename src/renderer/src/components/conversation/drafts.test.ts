import { describe, it, expect } from 'vitest'
import { draftOf, forgetDrafts, keepDraft } from './drafts'

// Performance audit (renderer, small): a draft was forgotten only when sent, so a closed session's half-typed text
// stayed for the app's life.
describe('forgetDrafts', () => {
  it('forgets the drafts of sessions that went and keeps the others', () => {
    keepDraft('a', 'one')
    keepDraft('b', 'two')
    forgetDrafts(new Set(['a']))
    expect(draftOf('a')).toBe('')
    expect(draftOf('b')).toBe('two')
  })
})
