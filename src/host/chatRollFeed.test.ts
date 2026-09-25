import { describe, it, expect, vi } from 'vitest'
import { createChatRollFeed } from './chatRollFeed'
import type { Account } from '../core/types'

const account: Account = { id: 'a1', label: 'a1', configDir: 'C:\\c1', color: '#fff', createdAt: '2026-09-26T00:00:00Z' }
const coordinators = () => ({
  claude: { onChatMeta: vi.fn(), onChatStatus: vi.fn(), onChatLimit: vi.fn(), handleExit: vi.fn() },
  codex: { attachChat: vi.fn(), onChatStatus: vi.fn(), handleExit: vi.fn() }
})

describe('createChatRollFeed (chat takeover spec §3.3)', () => {
  it('hands a claude ready its thread now and its transcript once the lookup lands', async () => {
    const c = coordinators()
    const feed = createChatRollFeed({ ...c, providerOf: () => 'claude', accountOf: () => account, threadOf: () => 'th', findTranscript: async () => 'C:\\c1\\projects\\x\\th.jsonl', log: () => {} })
    feed('c1', { type: 'ready', threadId: 'th', rolloutPath: null })
    expect(c.claude.onChatMeta).toHaveBeenCalledWith('c1', { claudeSessionId: 'th', transcriptPath: null })
    await vi.waitFor(() => expect(c.claude.onChatMeta).toHaveBeenLastCalledWith('c1', { claudeSessionId: 'th', transcriptPath: 'C:\\c1\\projects\\x\\th.jsonl' }))
  })
  it('drops a lookup whose thread is no longer the session’s', async () => {
    const c = coordinators()
    let thread = 'th'
    const feed = createChatRollFeed({ ...c, providerOf: () => 'claude', accountOf: () => account, threadOf: () => thread, findTranscript: async () => { thread = 'th2'; return 'C:\\old.jsonl' }, log: () => {} })
    feed('c1', { type: 'ready', threadId: 'th', rolloutPath: null })
    await new Promise((r) => setTimeout(r, 0))
    expect(c.claude.onChatMeta).toHaveBeenCalledTimes(1)
  })
  it('hands a codex ready to attachChat, a status to both, a limit to claude, an exit to both', () => {
    const c = coordinators()
    const feed = createChatRollFeed({ ...c, providerOf: () => 'codex', accountOf: () => account, threadOf: () => 'th', findTranscript: async () => null, log: () => {} })
    feed('c1', { type: 'ready', threadId: 'th', rolloutPath: 'C:\\r.jsonl' })
    feed('c1', { type: 'status', status: 'working' })
    feed('c1', { type: 'rateLimit', info: { status: 'rejected', resetsAt: null, utilization: null, window: null, source: 'event' } })
    feed('c1', { type: 'exit', code: 0, errorDetail: null })
    expect(c.codex.attachChat).toHaveBeenCalledWith('c1', 'th', 'C:\\r.jsonl')
    expect(c.claude.onChatStatus).toHaveBeenCalledWith('c1', 'working')
    expect(c.codex.onChatStatus).toHaveBeenCalledWith('c1', 'working')
    expect(c.claude.onChatLimit).toHaveBeenCalled()
    expect(c.claude.handleExit).toHaveBeenCalledWith({ sessionId: 'c1' })
    expect(c.codex.handleExit).toHaveBeenCalledWith({ sessionId: 'c1' })
  })
  it('a coordinator that throws and a lookup that rejects are logged, never thrown (R3)', async () => {
    const c = coordinators()
    c.claude.onChatMeta.mockImplementation(() => { throw new Error('boom') })
    const logs: string[] = []
    const feed = createChatRollFeed({ ...c, providerOf: () => 'claude', accountOf: () => account, threadOf: () => 'th', findTranscript: async () => { throw new Error('EACCES') }, log: (m) => logs.push(m) })
    expect(() => feed('c1', { type: 'ready', threadId: 'th', rolloutPath: null })).not.toThrow()
    await vi.waitFor(() => expect(logs.join('\n')).toMatch(/EACCES/))
    expect(logs.join('\n')).toMatch(/boom/)
  })
})
