// Phase 9b review M2: the remote sessions dialog speaks of the Runtime as "that computer"; "this computer" is the one
// the app runs on, so a read-only note that said "this computer" told the person the wrong machine.
import { describe, it, expect } from 'vitest'
import { ko } from './messages/ko'

describe('remote sessions copy (ko)', () => {
  it('a read-only pairing cannot start sessions on that computer, not this one', () => {
    expect(ko['remote.sessions.readOnly']).toContain('그 컴퓨터에서')
    expect(ko['remote.sessions.readOnly']).not.toContain('이 컴퓨터에서')
  })
})
