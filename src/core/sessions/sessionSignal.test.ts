// Plugin Phase 3 (events and notifications design N3): what an app forwards so the Host can record the session events
// of the sessions only the app sees. Parsed at the Host's socket; anything malformed is dropped, not trusted.
import { describe, it, expect } from 'vitest'
import { parseSessionSignal } from './sessionSignal'

const session = { id: 's1', kind: 'chat', title: 't', provider: 'claude', cwd: 'D:\p' }

describe('parseSessionSignal', () => {
  it('takes a chat status, a chat request and a roll state', () => {
    expect(parseSessionSignal({ kind: 'chat', session, event: { type: 'status', status: 'waiting' } })).toEqual({ kind: 'chat', session, event: { type: 'status', status: 'waiting' } })
    expect(parseSessionSignal({ kind: 'chat', session, event: { type: 'request', request: 'approval' } })).toEqual({ kind: 'chat', session, event: { type: 'request', request: 'approval' } })
    expect(parseSessionSignal({ kind: 'chat', session, event: { type: 'request', request: null } })).toEqual({ kind: 'chat', session, event: { type: 'request', request: null } })
    const roll = { sessionId: 's1', state: 'waiting', nextRetryAt: 'R', scope: 'weekly' }
    expect(parseSessionSignal({ kind: 'roll-state', session: { id: 's1', kind: 'terminal' }, event: roll })).toEqual({ kind: 'roll-state', session: { id: 's1', kind: 'terminal' }, event: roll })
  })

  it('keeps only the session fields it knows', () => {
    expect(parseSessionSignal({ kind: 'chat', session: { ...session, accountId: 'a1' }, event: { type: 'status', status: 'idle' } })).toEqual({ kind: 'chat', session, event: { type: 'status', status: 'idle' } })
  })

  // Review Focus 4: a malformed or mismatched signal is dropped, never recorded
  it('refuses what is malformed or does not agree with itself', () => {
    const bad: unknown[] = [
      null,
      'x',
      { kind: 'other', session, event: {} },
      { kind: 'chat', session: { id: '', kind: 'chat' }, event: { type: 'status', status: 'idle' } },
      { kind: 'chat', session: { id: 's1', kind: 'pty' }, event: { type: 'status', status: 'idle' } },
      { kind: 'chat', session: { ...session, title: 3 }, event: { type: 'status', status: 'idle' } },
      { kind: 'chat', session: { ...session, provider: 'gemini' }, event: { type: 'status', status: 'idle' } },
      { kind: 'chat', session, event: { type: 'status', status: 'busy' } },
      { kind: 'chat', session, event: { type: 'request', request: { kind: 'approval' } } },
      { kind: 'chat', session, event: { type: 'ready' } },
      { kind: 'chat', session },
      // Final review m5: a chat signal names a chat
      { kind: 'chat', session: { ...session, kind: 'terminal' }, event: { type: 'status', status: 'waiting' } },
      { kind: 'roll-state', session, event: { sessionId: 's2', state: 'waiting' } },
      { kind: 'roll-state', session, event: { sessionId: 's1' } },
      { kind: 'roll-state', session, event: { sessionId: 's1', state: 'switching', accountLabel: 5 } },
      { kind: 'roll-state', session, event: { sessionId: 's1', state: 'waiting', scope: 'monthly' } },
      { kind: 'roll-state', session, event: { sessionId: 's1', state: 'waiting', nextRetryAt: 7 } },
      { kind: 'roll-state', session, event: { sessionId: 's1', state: 'waiting', reattach: 'yes' } },
      { kind: 'roll-state', session, event: { sessionId: 's1', state: 'waiting', manual: 'yes' } }
    ]
    for (const v of bad) expect(parseSessionSignal(v), JSON.stringify(v)).toBeNull()
  })
})
