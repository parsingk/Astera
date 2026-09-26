import { describe, it, expect } from 'vitest'
import { hearForwarded, isForwardedChatEvent, parseSlackForwarded } from './forwarded'

const info = { id: 's2', accountId: 'a1', cwd: 'D:/p', status: 'running', title: 't', slackNotify: true }

describe('parseSlackForwarded (Slack in the Host Task 3, spec §3.3)', () => {
  it('reads the three kinds, and keeps dest on a rolled', () => {
    const chat = { kind: 'chat', sessionId: 'c1', accountId: 'a1', event: { type: 'status', status: 'idle' }, provider: 'claude', transcriptPath: null }
    expect(parseSlackForwarded(chat)).toEqual(chat)
    expect(parseSlackForwarded({ kind: 'roll-state', event: { sessionId: 's1', state: 'nudged' } })?.kind).toBe('roll-state')
    expect(parseSlackForwarded({ kind: 'rolled', oldSessionId: 's1', info, dest: 'D:/r.jsonl' })).toEqual({ kind: 'rolled', oldSessionId: 's1', info, dest: 'D:/r.jsonl' })
  })

  it('drops anything else, and a chat event the notifier does not read', () => {
    const chat = (event: unknown, over: Record<string, unknown> = {}) => ({ kind: 'chat', sessionId: 'c1', accountId: 'a1', event, provider: 'claude', transcriptPath: null, ...over })
    for (const bad of [
      null, 1, 'x', {}, { kind: 'chat' },
      chat({ type: 'exit', code: 0, errorDetail: null }),
      chat({ type: 'status' }),
      chat({ type: 'status', status: 'idle' }, { provider: 'gemini' }),
      chat({ type: 'status', status: 'idle' }, { accountId: 7 }),
      chat({ type: 'ready', threadId: 'th', rolloutPath: 3 }),
      { kind: 'roll-state', event: { state: 'nudged' } },
      { kind: 'rolled', oldSessionId: 's1', info: { id: 's2' } }
    ])
      expect(parseSlackForwarded(bad), JSON.stringify(bad)).toBeNull()
  })

  it('forwards the four chat events the notifier reads, and never an exit (P6)', () => {
    expect(isForwardedChatEvent({ type: 'status', status: 'idle' })).toBe(true)
    expect(isForwardedChatEvent({ type: 'request', request: null })).toBe(true)
    expect(isForwardedChatEvent({ type: 'ready', threadId: 't', rolloutPath: null })).toBe(true)
    expect(isForwardedChatEvent({ type: 'exit', code: 0, errorDetail: null })).toBe(false)
  })
})

// Final review M2: what an app held while the Host was away is told to its own notifier when it takes Slack.
describe('hearForwarded', () => {
  it('tells each kind to the notifier input it came from, with the chat transcript path as a getter', () => {
    const calls: unknown[] = []
    const notifier = {
      onChatEvent: (sid: string, e: unknown, at: { provider: string; transcriptPath: () => string | null }) => calls.push(['chat', sid, e, at.provider, at.transcriptPath()]),
      onRolled: (old: string, i: unknown) => calls.push(['rolled', old, i]),
      onRollState: (e: unknown) => calls.push(['roll-state', e])
    }
    hearForwarded(notifier, { kind: 'chat', sessionId: 'c1', accountId: 'a1', event: { type: 'status', status: 'idle' }, provider: 'claude', transcriptPath: 'D:/t.jsonl' })
    hearForwarded(notifier, { kind: 'rolled', oldSessionId: 's1', info: info as never })
    hearForwarded(notifier, { kind: 'roll-state', event: { sessionId: 's1', state: 'nudged' } })
    expect(calls).toEqual([
      ['chat', 'c1', { type: 'status', status: 'idle' }, 'claude', 'D:/t.jsonl'],
      ['rolled', 's1', info],
      ['roll-state', { sessionId: 's1', state: 'nudged' }]
    ])
  })
})
