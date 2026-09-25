import { describe, it, expect } from 'vitest'
import { sessionInfoFromNote, chatInfoFromNote } from './noteInfo'

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

describe('chatInfoFromNote', () => {
  const restore = { accountId: 'a1', cwd: 'D:/p', title: 't', threadId: 'th', rollAccountIds: ['a1', 'a2'], bypassPermissions: false, slackNotify: true, rollPrompt: 'go' }
  it('reads a chat note the way ChatSessionManager.adopt always did, with kind chat', () => {
    expect(chatInfoFromNote({ kind: 'chat', id: 'c1', restore })).toEqual({
      id: 'c1', accountId: 'a1', cwd: 'D:/p', status: 'running', title: 't', kind: 'chat',
      bypassPermissions: false, threadId: 'th', resumeSessionId: 'th', slackNotify: true, rollAccountIds: ['a1', 'a2'], rollPrompt: 'go'
    })
  })
  it('is null for another kind or a note missing a field', () => {
    expect(chatInfoFromNote({ kind: 'session', id: 'c1', restore })).toBeNull()
    expect(chatInfoFromNote({ kind: 'chat', id: 'c1', restore: { cwd: 'D:/p', title: 't' } })).toBeNull()
  })
})
