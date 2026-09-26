import { describe, it, expect, vi } from 'vitest'
import { SlackNotifier } from '../core/slack/notifier'
import { createHostSlackSources } from './slackSources'
import type { Account, SessionInfo } from '../core/types'
import type { ChatEvent } from '../core/chat/types'

const claude: Account = { id: 'a1', label: 'home', configDir: 'C:\\c1', color: '#fff', createdAt: '2026-09-26T00:00:00Z' }
const codex: Account = { ...claude, id: 'x1', provider: 'codex' } as Account
const info = (id: string, over: Partial<SessionInfo> = {}): SessionInfo => ({ id, accountId: 'a1', cwd: 'D:/p', status: 'running', title: id, slackNotify: true, ...over })

/** Past the notifier's ten minute dedup window, so a second post of the same text would go out. */
const PAST_DEDUP_MS = 11 * 60_000

function rig(o: { hostChats?: string[]; hostChains?: string[]; tail?: (p: string) => string | null; chatThreadId?: string } = {}) {
  const posts: Array<{ text: string; thread_ts?: string }> = []
  let ts = 0
  let clock = 1_000_000
  const notifier = new SlackNotifier({
    getAccount: (id) => (id === 'x1' ? codex : claude),
    readStatusPayload: async () => null,
    lang: () => 'en',
    log: () => {},
    readFileTail: async (p) => o.tail?.(p) ?? null,
    wait: async () => {},
    now: () => clock,
    createPoster: () => ({ chat: { postMessage: async (m) => { posts.push(m); return { ok: true, ts: `t${++ts}` } } } })
  })
  notifier.applyConfig({ webhookUrl: null, botToken: 'xoxb-1', channelId: 'C1' })
  let emit: (sid: string, e: ChatEvent) => void = () => {}
  const hostChats = new Set(o.hostChats ?? [])
  const chats = {
    has: (id: string) => hostChats.has(id),
    info: (id: string) => (hostChats.has(id) ? info(id, { kind: 'chat', ...(o.chatThreadId ? { threadId: o.chatThreadId } : {}) }) : null),
    subscribe: (fn: typeof emit) => { emit = fn; return () => {} }
  }
  const chains = new Set(o.hostChains ?? [])
  const codexWatch = { register: vi.fn(), unregister: vi.fn() }
  const findTranscript = vi.fn(async () => 'C:\\c1\\projects\\p\\th.jsonl')
  const logs: string[] = []
  const sources = createHostSlackSources({ notifier, chats, rolling: { has: (id) => chains.has(id), account: (id) => (id === 'x1' ? codex : claude) }, codex: codexWatch, findTranscript, log: (m) => logs.push(m) })
  const settle = () => new Promise((r) => setTimeout(r, 10))
  return { notifier, sources, posts, logs, emit: (sid: string, e: ChatEvent) => emit(sid, e), codexWatch, findTranscript, settle, advance: (ms: number) => { clock += ms } }
}
const turn = (_sid: string) => [{ type: 'status', status: 'working' }, { type: 'status', status: 'idle' }] as ChatEvent[]
const fwd = (sessionId: string, event: ChatEvent, transcriptPath: string | null = null) => ({ kind: 'chat', sessionId, accountId: 'a1', event, provider: 'claude', transcriptPath })

describe('createHostSlackSources (Slack in the Host Task 6, spec S3, §3.3)', () => {
  // Review Focus 2.
  it('a forwarded event for a session the Host sources is dropped: the turn is announced once', async () => {
    const h = rig({ hostChats: ['c1'] })
    h.notifier.register(info('c1', { kind: 'chat' }))
    for (const e of turn('c1')) h.emit('c1', e)
    for (const e of turn('c1')) h.sources.forwarded(fwd('c1', e))
    await h.settle()
    expect(h.posts.filter((p) => p.text.includes('Response complete'))).toHaveLength(1)
  })

  // Review Focus 2, with the notifier's dedup out of the way: the drop rule alone keeps it to one.
  it('one event seen by the Host and forwarded by the app is posted once, even past the dedup window', async () => {
    const h = rig({ hostChats: ['c1'], hostChains: ['h1'] })
    h.notifier.register(info('c1', { kind: 'chat' }))
    h.notifier.register(info('h1'))
    await h.settle()
    for (const e of turn('c1')) h.emit('c1', e)
    h.sources.onRollEvent({ t: 'roll-state', event: { sessionId: 'h1', state: 'nudged' } })
    await h.settle()
    h.advance(PAST_DEDUP_MS)
    for (const e of turn('c1')) h.sources.forwarded(fwd('c1', e))
    h.sources.forwarded({ kind: 'roll-state', event: { sessionId: 'h1', state: 'nudged' } })
    await h.settle()
    expect(h.posts.filter((p) => p.text.includes('Response complete'))).toHaveLength(1)
    expect(h.posts.filter((p) => p.text.includes('Limit reset'))).toHaveLength(1)
    // Logged once per session and kind, however many are dropped.
    expect(h.logs.filter((m) => m.includes('chat event of c1 dropped'))).toHaveLength(1)
    expect(h.logs.filter((m) => m.includes('roll state of h1 dropped'))).toHaveLength(1)
  })

  it('a forwarded chat event of a session the app decodes is announced, read against the path it carried', async () => {
    const h = rig({ tail: (p) => (p === 'D:/t.jsonl' ? JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done it' }] } }) : null) })
    h.notifier.register(info('c2', { kind: 'chat' }))
    h.sources.forwarded(fwd('c2', { type: 'status', status: 'working' }, 'D:/t.jsonl'))
    h.sources.forwarded(fwd('c2', { type: 'status', status: 'idle' }, 'D:/t.jsonl'))
    await h.settle()
    expect(h.posts.at(-1)?.text).toMatch(/Response complete[\s\S]*done it/)
  })

  it('a forwarded roll of a Host chain is dropped; one of an app chain moves the record into the same thread', async () => {
    const h = rig({ hostChains: ['h1'] })
    h.notifier.register(info('h1'))
    h.notifier.register(info('s1'))
    await h.settle()
    h.sources.forwarded({ kind: 'roll-state', event: { sessionId: 'h1', state: 'nudged' } })
    h.sources.forwarded({ kind: 'rolled', oldSessionId: 's1', info: info('s2') })
    h.sources.forwarded({ kind: 'roll-state', event: { sessionId: 's2', state: 'nudged' } })
    await h.settle()
    const nudges = h.posts.filter((p) => p.text.includes('Limit reset'))
    expect(nudges).toHaveLength(1)
    expect(nudges[0].thread_ts).toBe(h.posts.find((p) => p.text.includes('s1') && !p.thread_ts)?.thread_ts ?? 't2')
  })

  it('a forwarded roll into or out of a Host chain is dropped, and the record stays where it was', () => {
    const h = rig({ hostChains: ['h2'] })
    h.notifier.register(info('h1'))
    h.sources.forwarded({ kind: 'rolled', oldSessionId: 'h1', info: info('h2') })
    expect(h.notifier.has('h1')).toBe(true)
    expect(h.notifier.has('h2')).toBe(false)
  })

  it('the Host\'s own roll moves the record, and a codex terminal chain follows its dest', () => {
    const h = rig()
    h.sources.sessionRegistered(info('k1', { accountId: 'x1' }), { rolloutPath: 'D:/r1.jsonl', codexSessionId: 'cx' })
    expect(h.codexWatch.register).toHaveBeenCalledWith(expect.objectContaining({ id: 'k1' }), 'D:/r1.jsonl', 'cx')
    h.notifier.register(info('k1', { accountId: 'x1' }))
    h.sources.onRollEvent({ t: 'session-rolled', oldSessionId: 'k1', info: info('k2', { accountId: 'x1' }), dest: 'D:/r2.jsonl' })
    expect(h.codexWatch.unregister).toHaveBeenCalledWith('k1')
    expect(h.codexWatch.register).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'k2' }), 'D:/r2.jsonl')
    expect(h.notifier.has('k1')).toBe(false)
    expect(h.notifier.has('k2')).toBe(true)
  })

  it('does not watch a codex chat session, nor a claude one (P12)', () => {
    const h = rig()
    h.sources.sessionRegistered(info('kc', { accountId: 'x1', kind: 'chat' }), {})
    h.sources.sessionRegistered(info('cl'), {})
    expect(h.codexWatch.register).not.toHaveBeenCalled()
  })

  it('a codex terminal session whose note has no rollout yet is watched once the note names it, never by a scan', () => {
    const h = rig()
    h.sources.sessionRegistered(info('k3', { accountId: 'x1' }), {})
    expect(h.codexWatch.register).not.toHaveBeenCalled()
    h.sources.sessionNoted(info('k3', { accountId: 'x1' }), { rolloutPath: 'D:/r3.jsonl', codexSessionId: 'cx3' })
    h.sources.sessionNoted(info('k3', { accountId: 'x1' }), { rolloutPath: 'D:/r3.jsonl', codexSessionId: 'cx3' })
    expect(h.codexWatch.register).toHaveBeenCalledTimes(1)
    expect(h.codexWatch.register).toHaveBeenCalledWith(expect.objectContaining({ id: 'k3' }), 'D:/r3.jsonl', 'cx3')
    h.sources.sessionEnded('k3')
    expect(h.codexWatch.unregister).toHaveBeenCalledWith('k3')
  })

  it('finds a claude chat transcript by its thread when no path came with the event (P11)', async () => {
    const h = rig({ tail: (p) => (p.endsWith('th.jsonl') ? JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) : null) })
    h.notifier.register(info('c3', { kind: 'chat' }))
    h.sources.forwarded(fwd('c3', { type: 'ready', threadId: 'th', rolloutPath: null }))
    for (const e of turn('c3')) h.sources.forwarded(fwd('c3', e))
    await h.settle()
    expect(h.findTranscript).toHaveBeenCalledWith('C:\\c1', 'th')
    expect(h.findTranscript).toHaveBeenCalledTimes(1)
    expect(h.posts.at(-1)?.text).toMatch(/hi/)
  })

  it('a Host chat adopted after its ready is looked up by the thread its info carries (P11)', async () => {
    const h = rig({ hostChats: ['c4'], chatThreadId: 'th', tail: (p) => (p.endsWith('th.jsonl') ? JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'late' }] } }) : null) })
    h.notifier.register(info('c4', { kind: 'chat' }))
    for (const e of turn('c4')) h.emit('c4', e)
    await h.settle()
    expect(h.findTranscript).toHaveBeenCalledWith('C:\\c1', 'th')
    expect(h.posts.at(-1)?.text).toMatch(/late/)
  })

  it('a malformed forwarded body is ignored and throws nothing', () => {
    const h = rig()
    for (const bad of [null, 'x', { kind: 'chat' }]) expect(() => h.sources.forwarded(bad)).not.toThrow()
    expect(h.posts).toHaveLength(0)
  })

  it('a notifier that throws costs no caller anything', () => {
    const h = rig({ hostChains: [] })
    const boom = () => { throw new Error('boom') }
    h.notifier.onHookEvent = boom
    h.notifier.onRollState = boom
    h.notifier.onRolled = boom
    h.notifier.onChatEvent = boom
    expect(() => h.sources.onHookEvent('s1', { hook_event_name: 'Stop' })).not.toThrow()
    expect(() => h.sources.onRollEvent({ t: 'roll-state', event: { sessionId: 's1', state: 'nudged' } })).not.toThrow()
    expect(() => h.sources.onRollEvent({ t: 'session-rolled', oldSessionId: 's1', info: info('s2') })).not.toThrow()
    expect(() => h.sources.forwarded(fwd('s9', { type: 'status', status: 'working' }))).not.toThrow()
  })

  it('dispose stops every watch it started', () => {
    const h = rig()
    h.sources.sessionRegistered(info('k1', { accountId: 'x1' }), { rolloutPath: 'D:/r1.jsonl' })
    h.sources.dispose()
    expect(h.codexWatch.unregister).toHaveBeenCalledWith('k1')
  })
})
