import { describe, it, expect } from 'vitest'
import { sessionInfoFromNote, chatInfoFromNote, agentProfileIdOf } from './noteInfo'

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

// An agent-started session's tab closes when it ends (2026-10-20): the mark rides the note, so a session the Host hands
// back after a restart, or carries on for an app, still says who started it
describe('who started a session, read from its note', () => {
  const base = { accountId: 'a1', cwd: 'D:/p', title: 't' }
  it('keeps startedBy agent for a terminal and a chat note', () => {
    expect(sessionInfoFromNote({ kind: 'session', id: 's1', restore: { ...base, startedBy: 'agent' } })?.startedBy).toBe('agent')
    expect(chatInfoFromNote({ kind: 'chat', id: 'c1', restore: { ...base, startedBy: 'agent' } })?.startedBy).toBe('agent')
  })
  it('leaves a note without it, or with any other value, as a person’s', () => {
    expect(sessionInfoFromNote({ kind: 'session', id: 's1', restore: base })).not.toHaveProperty('startedBy')
    expect(sessionInfoFromNote({ kind: 'session', id: 's1', restore: { ...base, startedBy: 'person' } })).not.toHaveProperty('startedBy')
    expect(chatInfoFromNote({ kind: 'chat', id: 'c1', restore: { ...base, startedBy: true } })).not.toHaveProperty('startedBy')
  })
})

// Agent Profiles (ledger Ruling P2): the profile a session was started from rides the note like startedBy, so a session
// the Host hands back or carries on still resolves the same profile; the Host's delete check reads it the same way
describe('the agent profile a session was started from, read from its note', () => {
  const base = { accountId: 'a1', cwd: 'D:/p', title: 't' }
  it('keeps a profile id', () => {
    expect(sessionInfoFromNote({ kind: 'session', id: 's1', restore: { ...base, agentProfileId: 'ap_000000000001' } })?.agentProfileId).toBe('ap_000000000001')
    expect(agentProfileIdOf({ ...base, agentProfileId: 'ap_000000000001' })).toBe('ap_000000000001')
  })
  it('leaves a note without one, or with a value that is not a string, without one', () => {
    expect(sessionInfoFromNote({ kind: 'session', id: 's1', restore: base })).not.toHaveProperty('agentProfileId')
    expect(sessionInfoFromNote({ kind: 'session', id: 's1', restore: { ...base, agentProfileId: 3 } })).not.toHaveProperty('agentProfileId')
    expect(sessionInfoFromNote({ kind: 'session', id: 's1', restore: { ...base, agentProfileId: '' } })).not.toHaveProperty('agentProfileId')
    expect(agentProfileIdOf(undefined)).toBeUndefined()
  })
})

// Agent Profiles design §5: a chat session's profile rides its note as a terminal session's does
describe('a chat session’s agent profile, read from its note', () => {
  const base = { accountId: 'a1', cwd: 'D:/p', title: 't' }
  it('keeps a non-empty id, and nothing otherwise', () => {
    expect(chatInfoFromNote({ kind: 'chat', id: 'c1', restore: { ...base, agentProfileId: 'ap_1' } })?.agentProfileId).toBe('ap_1')
    expect(chatInfoFromNote({ kind: 'chat', id: 'c1', restore: base })).not.toHaveProperty('agentProfileId')
    expect(chatInfoFromNote({ kind: 'chat', id: 'c1', restore: { ...base, agentProfileId: '' } })).not.toHaveProperty('agentProfileId')
  })
})

// Sandbox design §6: a session started in the sandbox says so in its note, so a roll after a Host hands it back keeps it
describe('whether a session runs in the sandbox, read from its note', () => {
  const base = { accountId: 'a1', cwd: 'D:/p', title: 't' }
  it('keeps sandboxed true for a terminal and a chat note', () => {
    expect(sessionInfoFromNote({ kind: 'session', id: 's1', restore: { ...base, sandboxed: true } })?.sandboxed).toBe(true)
    expect(chatInfoFromNote({ kind: 'chat', id: 'c1', restore: { ...base, sandboxed: true } })?.sandboxed).toBe(true)
  })
  it('leaves a note without it, or with any other value, without it', () => {
    for (const restore of [base, { ...base, sandboxed: false }, { ...base, sandboxed: 'true' }]) {
      expect(sessionInfoFromNote({ kind: 'session', id: 's1', restore })).not.toHaveProperty('sandboxed')
      expect(chatInfoFromNote({ kind: 'chat', id: 'c1', restore })).not.toHaveProperty('sandboxed')
    }
  })

  // Task 8 fix round 1: which kind of protection the session has (a CLI's sandbox, or Claude Code's deny rules only on
  // Windows) rides the note beside `sandboxed`, so a tab taken back after a restart says the same as before
  it('keeps the sandbox kind beside it, and only a kind it knows on a sandboxed note', () => {
    for (const sandboxKind of ['sandbox', 'deny-only'] as const) {
      const restore = { ...base, sandboxed: true, sandboxKind }
      expect(sessionInfoFromNote({ kind: 'session', id: 's1', restore }), sandboxKind).toMatchObject({ sandboxed: true, sandboxKind })
      expect(chatInfoFromNote({ kind: 'chat', id: 'c1', restore }), sandboxKind).toMatchObject({ sandboxed: true, sandboxKind })
    }
    for (const restore of [{ ...base, sandboxed: true, sandboxKind: 'other' }, { ...base, sandboxKind: 'sandbox' }, { ...base, sandboxed: true }]) {
      expect(sessionInfoFromNote({ kind: 'session', id: 's1', restore })).not.toHaveProperty('sandboxKind')
      expect(chatInfoFromNote({ kind: 'chat', id: 'c1', restore })).not.toHaveProperty('sandboxKind')
    }
  })

  // Task E fix round 3: a sandboxed start's warnings ride the note beside the kind, so a Host worker's tab and a tab taken
  // back after a restart show them; only the warnings this build knows, only on a sandboxed note, each once
  it('keeps the start warnings beside it, and only known ones on a sandboxed note', () => {
    const restore = { ...base, sandboxed: true, sandboxKind: 'sandbox', sandboxWarnings: ['claudeUserns', 'homeInWorkFolder'] }
    expect(sessionInfoFromNote({ kind: 'session', id: 's1', restore })).toMatchObject({ sandboxWarnings: ['claudeUserns', 'homeInWorkFolder'] })
    expect(chatInfoFromNote({ kind: 'chat', id: 'c1', restore })).toMatchObject({ sandboxWarnings: ['claudeUserns', 'homeInWorkFolder'] })
    const mixed = { ...base, sandboxed: true, sandboxWarnings: ['homeInWorkFolder', 'other', 7, 'homeInWorkFolder'] }
    expect(sessionInfoFromNote({ kind: 'session', id: 's1', restore: mixed })).toMatchObject({ sandboxWarnings: ['homeInWorkFolder'] })
    // Task E fix round 5: the link warning too, in its place before the home warning
    const linked = { ...base, sandboxed: true, sandboxWarnings: ['homeInWorkFolder', 'linkInWorkFolder'] }
    expect(sessionInfoFromNote({ kind: 'session', id: 's1', restore: linked })).toMatchObject({ sandboxWarnings: ['linkInWorkFolder', 'homeInWorkFolder'] })
    for (const r of [{ ...base, sandboxWarnings: ['homeInWorkFolder'] }, { ...base, sandboxed: true, sandboxWarnings: [] }, { ...base, sandboxed: true, sandboxWarnings: 'homeInWorkFolder' }]) {
      expect(sessionInfoFromNote({ kind: 'session', id: 's1', restore: r })).not.toHaveProperty('sandboxWarnings')
      expect(chatInfoFromNote({ kind: 'chat', id: 'c1', restore: r })).not.toHaveProperty('sandboxWarnings')
    }
  })
})
