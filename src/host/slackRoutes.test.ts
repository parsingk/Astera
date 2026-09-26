import { describe, it, expect, vi } from 'vitest'
import { hostInboxRoutes } from './slackRoutes'

function rig(o: { hostWrites?: boolean; hostHolds?: boolean; app?: boolean; appAnswer?: unknown } = {}) {
  const writes: Array<[string, string]> = []
  const act = vi.fn(async (name: string) => (name === 'chatSend' ? { sent: true } : (o.appAnswer ?? { answered: true })))
  const chats = {
    has: (id: string) => id === 'c1' && (o.hostHolds ?? true),
    isWriter: (id: string) => id === 'c1' && (o.hostWrites ?? true),
    send: vi.fn(async () => {}),
    requests: () => [{ id: 'r1', kind: 'approval' as const, about: { tool: 'Bash', lines: [] }, decisions: ['accept' as const, 'decline' as const] }],
    answerCard: vi.fn(async () => {})
  }
  const routes = hostInboxRoutes({
    registry: { sessionPty: (id) => (id === 's1' ? 'p1' : null), write: (p, data) => { writes.push([p, data]) } },
    procs: { list: () => [{ id: 'q1', pid: 1, alive: true, meta: { kind: 'chat', id: 'c1', restore: {} } }, { id: 'q2', pid: 2, alive: true, meta: { kind: 'chat', id: 'c2', restore: {} } }] },
    chats,
    notifier: { chatRequestOf: (id) => (id === 'c2' ? { id: 'r9', kind: 'approval', about: { tool: 'Edit', lines: [] }, decisions: ['accept', 'decline'] } : null) },
    server: () => ({ hasApp: () => o.app ?? true, act })
  })
  return { routes, writes, act, chats }
}

describe('hostInboxRoutes (Slack in the Host Task 7, spec §3.4)', () => {
  it('types a terminal reply into the session\'s live pty, and answers false for a session with none', () => {
    const h = rig()
    expect(h.routes.write('s1', 'hi')).toBe(true)
    expect(h.routes.write('gone', 'hi')).toBe(false)
    expect(h.writes).toEqual([['p1', 'hi']])
    expect(h.routes.isChat!('c1')).toBe(true)
    expect(h.routes.isChat!('s1')).toBe(false)
  })

  // Review Focus 3.
  it('a reply to a chat the app writes goes to the app\'s chatSend, never to the Host adapter', async () => {
    const h = rig({ hostWrites: false })
    await h.routes.deliverChat!('c1', 'next turn')
    expect(h.act).toHaveBeenCalledWith('chatSend', ['c1', 'next turn'])
    expect(h.chats.send).not.toHaveBeenCalled()
    const w = rig()
    await w.routes.deliverChat!('c1', 'next turn')
    expect(w.chats.send).toHaveBeenCalledWith('c1', 'next turn')
    expect(w.act).not.toHaveBeenCalled()
  })

  it('a card answer follows the writer rule: the Host adapter, else the app\'s slackChatAnswer', async () => {
    const h = rig()
    await h.routes.answerChat!('c1', 'r1', { kind: 'approval', decision: 'accept' })
    expect(h.chats.answerCard).toHaveBeenCalledWith('c1', 'r1', { kind: 'approval', decision: 'accept' })
    const a = rig({ hostWrites: false })
    await a.routes.answerChat!('c1', 'r1', { kind: 'question', answers: [] })
    expect(a.act).toHaveBeenCalledWith('slackChatAnswer', ['c1', 'r1', { kind: 'question', answers: [] }])
    const refused = rig({ hostWrites: false, appAnswer: { answered: false, reason: 'not-open' } })
    await expect(refused.routes.answerChat!('c1', 'r1', { kind: 'approval', decision: 'accept' })).rejects.toThrow(/not-open/)
  })

  it('refuses a chat reply when nobody holds the session, and reads the card from where it lives (P18)', async () => {
    const h = rig({ hostWrites: false, app: false })
    await expect(h.routes.deliverChat!('c1', 'x')).rejects.toThrow(/nobody/)
    expect(h.routes.pendingRequest!('c1')?.id).toBe('r1')
    expect(h.routes.pendingRequest!('c2')?.id).toBe('r9')
  })
})
