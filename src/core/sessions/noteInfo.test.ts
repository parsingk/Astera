import { describe, it, expect } from 'vitest'
import { sessionInfoFromNote } from './noteInfo'

describe('sessionInfoFromNote', () => {
  it('rebuilds a session from its note, keeping only well-typed optional keys', () => {
    expect(
      sessionInfoFromNote({ kind: 'session', id: 's1', restore: { accountId: 'a1', cwd: 'D:/p', title: 't', rollAccountIds: ['a1', 'a2'], rollPrompt: 'go', bypassPermissions: true, slackNotify: 'x' } })
    ).toEqual({ id: 's1', accountId: 'a1', cwd: 'D:/p', status: 'running', title: 't', rollAccountIds: ['a1', 'a2'], rollPrompt: 'go', bypassPermissions: true })
  })
  it('refuses another kind and a note missing its required fields', () => {
    expect(sessionInfoFromNote({ kind: 'run', id: 'r', restore: { accountId: 'a', cwd: 'c', title: 't' } })).toBeNull()
    expect(sessionInfoFromNote({ kind: 'session', id: 's', restore: { accountId: 'a', cwd: 'c' } })).toBeNull()
    expect(sessionInfoFromNote({ kind: 'session', id: 's', restore: { accountId: 'a', cwd: 'c', title: 't', rollAccountIds: ['a', 3] } })?.rollAccountIds).toBeUndefined()
  })
})
