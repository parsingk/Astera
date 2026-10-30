// The lines a findings report says beside its findings (lifecycle design §4, §8), read the same by the CLI and the section.
import { describe, it, expect } from 'vitest'
import { observeNote, unreadLine } from './note'

describe('observeNote', () => {
  it('says Observe is off, or how many days it has been on, until it has had 30', () => {
    expect(observeNote({ observe: { on: false, days: 0 }, unread: [] })).toEqual({ key: 'findings.observe.off' })
    expect(observeNote({ observe: { on: true, days: 0 }, unread: [] })).toEqual({ key: 'findings.observe.days', params: { days: 0 } })
    expect(observeNote({ observe: { on: true, days: 29 }, unread: ['records'] })).toEqual({ key: 'findings.observe.days', params: { days: 29 } })
    expect(observeNote({ observe: { on: true, days: 30 }, unread: [] })).toBeNull()
  })

  // Task 3's note: an unread rules file reads { on: false }, which must never be said as "Observe is off"
  it('says nothing when the rules file could not be read: the unread line does', () => {
    expect(observeNote({ observe: { on: false, days: 0 }, unread: ['policy'] })).toBeNull()
  })
})

describe('unreadLine', () => {
  it('names each source in the language asked, or is null when every one was read', () => {
    expect(unreadLine('en', [])).toBeNull()
    expect(unreadLine('en', ['profiles', 'cli-version'])).toBe('Could not read: agent profiles, Claude Code version')
    expect(unreadLine('ko', ['profiles'])).toBe('읽지 못한 것: 에이전트 프로필')
  })
})
