import { describe, it, expect, beforeEach } from 'vitest'
import { keepDraft, draftOf, forgetDraft } from './drafts'

describe('composer drafts', () => {
  beforeEach(() => {
    forgetDraft('a')
    forgetDraft('b')
  })

  it('gives back what a session had in its composer', () => {
    keepDraft('a', '이어서 쓸 문장')
    expect(draftOf('a')).toBe('이어서 쓸 문장')
  })

  // Coming back twice has to find it both times — the pane mounts and unmounts on every view switch.
  it('does not consume what it gives back', () => {
    keepDraft('a', '두 번')
    expect(draftOf('a')).toBe('두 번')
    expect(draftOf('a')).toBe('두 번')
  })

  it('keeps one session’s text out of another’s', () => {
    keepDraft('a', 'A')
    keepDraft('b', 'B')
    expect(draftOf('a')).toBe('A')
    expect(draftOf('b')).toBe('B')
  })

  // An empty composer is not a draft, and neither is one holding only spaces — restoring either would
  // put a stray blank line or nothing at all into a composer someone had just cleared.
  it('holds nothing for an empty composer', () => {
    keepDraft('a', 'something')
    keepDraft('a', '   \n ')
    expect(draftOf('a')).toBe('')
  })

  it('answers the empty string for a session it has never seen', () => {
    expect(draftOf('never')).toBe('')
  })

  it('forgets one that was sent', () => {
    keepDraft('a', '보냄')
    forgetDraft('a')
    expect(draftOf('a')).toBe('')
  })
})
