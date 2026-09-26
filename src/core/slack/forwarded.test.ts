import { describe, it, expect } from 'vitest'
import { isForwardedChatEvent, parseSlackForwarded } from './forwarded'

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
