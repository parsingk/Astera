// A session's facts as the Host can source them (remote runtime design Phase 9, X1-06): status, the waiting prompt,
// usage and model, each from the source its provider and kind allow, and `unknown` where there is none. Never idle
// for lack of a signal.
import { describe, it, expect } from 'vitest'
import { createSessionFacts, type SessionFactsDeps } from './sessionFacts'
import type { HostSession } from '../core/orchestration/command'
import { sourcesOf } from './sessions'

const row = (over: Partial<HostSession> & Pick<HostSession, 'id' | 'kind'>): HostSession => ({
  title: null,
  accountId: 'a',
  cwd: 'D:/repo',
  alive: true,
  state: 'unknown',
  ...over,
  sources: sourcesOf(over.kind, over.provider)
})

const deps = (over: Partial<SessionFactsDeps> = {}): SessionFactsDeps => ({
  sessionById: async () => null,
  sessionTurn: async () => null,
  statusLinePayload: async () => null,
  rolloutOf: () => null,
  lastWrite: () => null,
  chats: null,
  readTail: async () => null,
  ...over
})

const line = (o: unknown): string => JSON.stringify(o)
const ev = (type: string, at: string, extra: Record<string, unknown> = {}): string => line({ timestamp: at, type: 'event_msg', payload: { type, ...extra } })

describe('createSessionFacts', () => {
  it('a Claude terminal: status and prompt from its hooks, usage and model from its statusline', async () => {
    const s = row({ id: 'c1', kind: 'terminal', provider: 'claude', ptyId: 'p1' })
    const f = createSessionFacts(
      deps({
        sessionById: async (id) => (id === s.id ? s : null),
        sessionTurn: async () => ({ alive: true, state: 'waiting', prompt: 'permission' }),
        statusLinePayload: async () => ({ model: { display_name: 'Opus' }, context_window: { used_percentage: 40, context_window_size: 200000 } })
      })
    )
    const got = await f.factsOf('c1')
    expect(got).toMatchObject({ id: 'c1', alive: true, status: 'waiting', prompt: 'permission', sources: s.sources })
    expect(got?.model).toBe('Opus')
  })

  it('a Codex terminal before any turn is unknown, never idle; its prompt is unknown', async () => {
    const s = row({ id: 'x1', kind: 'terminal', provider: 'codex', ptyId: 'p2' })
    const f = createSessionFacts(deps({ sessionById: async (id) => (id === s.id ? s : null), rolloutOf: () => 'D:/r.jsonl', readTail: async () => ({ lines: [], mtimeMs: 0 }) }))
    expect(await f.factsOf('x1')).toMatchObject({ status: 'unknown', prompt: 'unknown' })
  })

  it('a Codex terminal is waiting after a completed turn, unknown after input since, working once a turn started', async () => {
    const s = row({ id: 'x1', kind: 'terminal', provider: 'codex', ptyId: 'p2' })
    const done = '2026-10-08T01:00:00.000Z'
    const lines = [ev('task_started', '2026-10-08T00:59:00.000Z'), ev('task_complete', done)]
    let wrote: number | null = null
    const f = createSessionFacts(deps({ sessionById: async (id) => (id === s.id ? s : null), rolloutOf: () => 'D:/r.jsonl', readTail: async () => ({ lines, mtimeMs: Date.parse(done) }), lastWrite: () => wrote }))
    expect((await f.factsOf('x1'))?.status).toBe('waiting')
    // Input since may be a turn or a few keys and nothing more: the rollout has not said, so the Host does not guess.
    wrote = Date.parse(done) + 5_000
    expect((await f.factsOf('x1'))?.status).toBe('unknown')
    wrote = null
    lines.push(ev('task_started', '2026-10-08T01:01:00.000Z'))
    expect((await f.factsOf('x1'))?.status).toBe('working')
  })

  it('a Codex terminal reads its usage and model from the rollout', async () => {
    const s = row({ id: 'x1', kind: 'terminal', provider: 'codex', ptyId: 'p2' })
    const lines = [
      line({ timestamp: 't', type: 'turn_context', payload: { model: 'gpt-5-codex' } }),
      ev('token_count', 't', { info: { total_token_usage: { total_tokens: 1000 }, last_token_usage: { total_tokens: 500 }, model_context_window: 100000 } })
    ]
    const f = createSessionFacts(deps({ sessionById: async (id) => (id === s.id ? s : null), rolloutOf: () => 'D:/r.jsonl', readTail: async () => ({ lines, mtimeMs: 0 }) }))
    const got = await f.factsOf('x1')
    expect(got?.model).toBe('gpt-5-codex')
    expect(got?.usage?.context).not.toBeNull()
  })

  it('a chat: status from its turn, prompt from its open request', async () => {
    const s = row({ id: 'h1', kind: 'chat', provider: 'claude', procId: 'q1' })
    const chats = {
      turnOf: () => ({ alive: true, status: 'waiting' as const, error: null }),
      requests: () => [{ id: 'r1', kind: 'approval' as const, about: { tool: 'Bash' }, decisions: ['allow', 'deny'] }],
      chosenModelOf: () => 'sonnet',
      subscribe: () => () => {}
    }
    const f = createSessionFacts(deps({ sessionById: async (id) => (id === s.id ? s : null), chats: chats as never }))
    expect(await f.factsOf('h1')).toMatchObject({ status: 'waiting', prompt: 'permission', model: 'sonnet' })
    // The open request itself rides along, so a controller can show the card and answer it (sessions-answer).
    expect((await f.factsOf('h1'))?.requests).toEqual([{ id: 'r1', kind: 'approval', about: { tool: 'Bash' }, decisions: ['allow', 'deny'] }])
  })

  it('a chat with no turn record says unknown; an idle one says idle', async () => {
    const s = row({ id: 'h1', kind: 'chat', provider: 'codex', procId: 'q1' })
    let turn: { alive: boolean; status: 'idle' | 'working' | 'waiting'; error: null } | null = null
    const chats = { turnOf: () => turn, requests: () => [], chosenModelOf: () => null, subscribe: () => () => {} }
    const f = createSessionFacts(deps({ sessionById: async (id) => (id === s.id ? s : null), chats: chats as never }))
    expect((await f.factsOf('h1'))?.status).toBe('unknown')
    turn = { alive: true, status: 'idle', error: null }
    expect((await f.factsOf('h1'))?.status).toBe('idle')
  })

  it('an ended session is not alive and its status unknown; an id never here is null', async () => {
    const s = row({ id: 'c1', kind: 'terminal', provider: 'claude', ptyId: 'p1', alive: false })
    const f = createSessionFacts(deps({ sessionById: async (id) => (id === s.id ? s : null), sessionTurn: async () => ({ alive: false, state: 'unknown', prompt: null }) }))
    expect(await f.factsOf('c1')).toMatchObject({ alive: false, status: 'unknown' })
    expect(await f.factsOf('nobody')).toBeNull()
  })

  it('a session whose account is gone has no sources and every fact unknown', async () => {
    const s = row({ id: 'c1', kind: 'terminal', ptyId: 'p1' })
    const f = createSessionFacts(deps({ sessionById: async (id) => (id === s.id ? s : null) }))
    expect(await f.factsOf('c1')).toMatchObject({ status: 'unknown', prompt: 'unknown', usage: null, model: null })
  })

  // Phase 9a review I1: an interrupted turn ends the turn; a write with no turn mark after it says nothing certain.
  it('a Codex turn interrupted (turn_aborted) is waiting; a write after the last turn mark is unknown, not working', async () => {
    const s = row({ id: 'x1', kind: 'terminal', provider: 'codex', ptyId: 'p2' })
    const aborted = '2026-10-08T01:00:00.000Z'
    const lines = [ev('task_started', '2026-10-08T00:59:00.000Z'), ev('turn_aborted', aborted)]
    let wrote: number | null = null
    const f = createSessionFacts(deps({ sessionById: async (id) => (id === s.id ? s : null), rolloutOf: () => 'D:/r.jsonl', readTail: async () => ({ lines, mtimeMs: 0 }), lastWrite: () => wrote }))
    expect((await f.factsOf('x1'))?.status).toBe('waiting')
    wrote = Date.parse(aborted) + 1_000
    expect((await f.factsOf('x1'))?.status).toBe('unknown')
    lines.length = 0
    expect((await f.factsOf('x1'))?.status).toBe('unknown')
  })
  // Phase 9a review M3: an ended chat says nothing about a prompt either.
  it('an ended chat with a turn record left has an unknown prompt', async () => {
    const s = row({ id: 'h1', kind: 'chat', provider: 'claude', procId: 'q1', alive: false })
    const chats = { turnOf: () => ({ alive: false, status: 'idle' as const, error: null }), requests: () => [], chosenModelOf: () => null, subscribe: () => () => {} }
    const f = createSessionFacts(deps({ sessionById: async (id) => (id === s.id ? s : null), chats: chats as never }))
    expect(await f.factsOf('h1')).toMatchObject({ status: 'unknown', prompt: 'unknown' })
  })
  // Phase 9a review M6: a Claude chat's usage comes from its usage events alone. One the Host has not seen since these
  // facts began (a Host restarted under a running chat) is null, never a stale figure, until the chat's next turn ends.
  it('a Claude chat has no usage until a usage event, then the last one; its exit forgets it', async () => {
    const s = row({ id: 'h1', kind: 'chat', provider: 'claude', procId: 'q1' })
    let emit: (sid: string, e: unknown) => void = () => {}
    const chats = {
      turnOf: () => ({ alive: true, status: 'idle' as const, error: null }),
      requests: () => [],
      chosenModelOf: () => 'claude-sonnet-4-5',
      subscribe: (fn: (sid: string, e: unknown) => void) => {
        emit = fn
        return () => {}
      }
    }
    const f = createSessionFacts(deps({ sessionById: async (id) => (id === s.id ? s : null), chats: chats as never }))
    expect((await f.factsOf('h1'))?.usage).toBeNull()
    emit('h1', { type: 'usage', context: { usedTokens: 50_000, windowByModel: { 'claude-sonnet-4-5': 200_000 } } })
    expect((await f.factsOf('h1'))?.usage?.context).not.toBeNull()
    emit('h1', { type: 'exit' })
    expect((await f.factsOf('h1'))?.usage).toBeNull()
  })
})
