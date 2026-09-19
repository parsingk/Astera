import { describe, it, expect, vi } from 'vitest'
import { createAdapterCore, isRequestError, type AdapterCore, type AdapterMode, type RequestError } from './adapterCore'
import type { ProcLike } from '../../core/sessions/proc'
import type { ChatEvent } from '../../core/chat/types'
import type { DecodedRequest } from '../../core/chat/codexProtocol'

// The same fake the Codex adapter's test uses, minus the parts only a protocol needs: the core never
// reads a line and never registers for one — its owner (an adapter) does, and calls onExit() here.
function fakeProc(): ProcLike & { written: string[]; outlivesApp?: boolean } {
  const p = {
    pid: 7,
    written: [] as string[],
    outlivesApp: undefined as boolean | undefined,
    onLine: () => {},
    onExit: () => {},
    write: (line: string) => { p.written.push(line) },
    kill: vi.fn()
  }
  return p
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0))

function made(mode: AdapterMode = { mode: 'fresh' }, requestTimeoutMs?: number): {
  p: ReturnType<typeof fakeProc>
  c: AdapterCore
  events: ChatEvent[]
} {
  const p = fakeProc()
  const c = createAdapterCore({ proc: p, log: () => {}, requestTimeoutMs }, mode)
  const events: ChatEvent[] = []
  c.on((e) => events.push(e))
  return { p, c, events }
}

/** A decoded server request, shaped like the ones the codecs hand the core but built by hand — the core
 *  never looks inside one beyond `request` and `toolUseId`. */
const approval = (id: string, line: string, toolUseId?: string): DecodedRequest => ({
  request: { id, kind: 'approval', about: { tool: 'shell', lines: [line] }, decisions: ['accept', 'decline'] },
  questionIds: null,
  ...(toolUseId === undefined ? {} : { toolUseId })
})

describe('createAdapterCore — client requests', () => {
  it('a request that is never answered rejects at its timeout and is no longer waiting for a reply', async () => {
    const { p, c } = made({ mode: 'fresh' }, 5)
    const asked = c.request('x-1', () => p.write('line'), undefined, 'initialize')
    expect(p.written).toEqual(['line'])
    await expect(asked).rejects.toThrow('timeout: initialize')
    // The entry is gone, so a late answer settles nothing rather than resolving a promise no one holds.
    expect(c.settle('x-1', { ok: true, value: 1 })).toBe(false)
  })
  it('settle resolves by id, reports an error as a rejection, and returns false for an id it never sent', async () => {
    const { p, c } = made()
    const ok = c.request<{ v: number }>('x-1', () => p.write('a'))
    expect(c.settle('x-1', { ok: true, value: { v: 3 } })).toBe(true)
    await expect(ok).resolves.toEqual({ v: 3 })
    const bad = c.request('x-2', () => p.write('b'))
    expect(c.settle('x-2', { ok: false, error: 'too old' })).toBe(true)
    await expect(bad).rejects.toThrow('too old')
    expect(c.settle('x-2', { ok: true, value: 1 })).toBe(false)   // already settled
    expect(c.settle('never-sent', { ok: true, value: 1 })).toBe(false)
  })
  it('ids carry a per-instance prefix and count up, so two cores never collide', () => {
    const { c } = made()
    const { c: other } = made()
    const mine = [c.nextId(), c.nextId()]
    expect(mine[0]).not.toBe(mine[1])
    expect(mine.map((id) => id.split('-').at(-1))).toEqual(['1', '2'])
    expect(other.nextId().split('-')[0]).not.toBe(mine[0].split('-')[0])
  })
  it('honours the timeout it is handed rather than the one the core was built with', async () => {
    const { p, c } = made({ mode: 'fresh' }, 30_000)
    const asked = c.request('x-1', () => p.write('line'), 5, 'set_model')
    await expect(asked).rejects.toThrow('timeout: set_model')
  })
  it('both of its own refusals name a reason, so a caller can tell them from an error the CLI sent back', async () => {
    const { p, c } = made({ mode: 'fresh' }, 5)
    const timedOut = await c.request('x-1', () => p.write('a')).catch((e: unknown) => e)
    expect(isRequestError(timedOut)).toBe(true)
    expect((timedOut as RequestError).reason).toBe('timeout')
    const { p: p2, c: c2 } = made()
    const dying = c2.request('x-2', () => p2.write('b')).catch((e: unknown) => e)
    c2.onExit(0)
    expect((await dying as RequestError).reason).toBe('exit')
    expect(((await c2.request('x-3', () => {}).catch((e: unknown) => e)) as RequestError).reason).toBe('exit')
    // An error the CLI itself replied with is not one of the two — it carries no reason at all.
    const { c: c3 } = made()
    const refused = c3.request('x-4', () => {}).catch((e: unknown) => e)
    c3.settle('x-4', { ok: false, error: 'No conversation in progress' })
    expect(isRequestError(await refused)).toBe(false)
  })
  it('exit rejects everything in flight and refuses every later request at once, not after the timeout', async () => {
    const { p, c, events } = made()
    const asked = c.request('x-1', () => p.write('a'))
    c.onExit(3)
    await expect(asked).rejects.toThrow('process ended')
    expect(c.ended).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'exit', code: 3 })
    const after = c.request('x-2', () => p.write('b'))
    await expect(after).rejects.toThrow('process ended')
    expect(p.written).toEqual(['a'])   // nothing was written to a process that has gone
  })
})

describe('createAdapterCore — the server-request queue', () => {
  it('shows the first, holds the second until the first is resolved, and emits one request event per change', async () => {
    const { c, events } = made()
    c.setTurn('t1')
    c.openRequest('0', { decoded: approval('0', 'git log'), wireId: 0 })
    c.openRequest('1', { decoded: approval('1', 'ls -la'), wireId: 1 })
    await tick()
    expect(c.state.request).toMatchObject({ id: '0', about: { lines: ['git log'] } })
    expect(c.state.status).toBe('waiting')
    expect(events.filter((e) => e.type === 'request').length).toBe(1)   // the second one changed nothing
    c.resolveRequest('0')
    await tick()
    expect(c.state.request).toMatchObject({ id: '1', about: { lines: ['ls -la'] } })
    expect(c.state.status).toBe('waiting')
    c.resolveRequest('1')
    await tick()
    expect(c.state).toMatchObject({ request: null, status: 'working' })   // a turn is running
    expect(events.filter((e) => e.type === 'request').length).toBe(3)
  })
  it('the empty slot goes back to idle when no turn is running', async () => {
    const { c } = made()
    c.openRequest('0', { decoded: approval('0', 'git log'), wireId: 0 })
    await tick()
    c.resolveRequest('0')
    await tick()
    expect(c.state).toMatchObject({ request: null, status: 'idle' })
    expect(c.turnId()).toBeNull()
  })
  it('resolving an id that is not open settles nothing — a replayed resolution for an answered request', async () => {
    const { c, events } = made()
    c.openRequest('0', { decoded: approval('0', 'git log'), wireId: 0 })
    await tick()
    c.resolveRequest('99')
    await tick()
    expect(c.state.request).toMatchObject({ id: '0' })
    expect(events.filter((e) => e.type === 'request').length).toBe(1)
  })
  it('takeRequest writes the answer, hands the entry over, promotes the next, and returns undefined for an id it does not hold', async () => {
    const { c } = made()
    const sent: string[] = []
    c.setTurn('t1')
    c.openRequest('0', { decoded: approval('0', 'git log'), wireId: 0 })
    c.openRequest('1', { decoded: approval('1', 'ls -la'), wireId: 7 })
    await tick()
    expect(c.takeRequest('nope', () => sent.push('nope'))).toBeUndefined()
    expect(sent).toEqual([])   // nothing is written for a request that is not open
    const taken = c.takeRequest('0', (e) => sent.push(String(e.wireId)))
    expect(taken?.wireId).toBe(0)
    expect(sent).toEqual(['0'])
    await tick()
    expect(c.state.request).toMatchObject({ id: '1' })
    expect(c.takeRequest('0', () => {})).toBeUndefined()   // taken once, gone
    expect(c.takeRequest('1', () => {})?.wireId).toBe(7)
    await tick()
    expect(c.state).toMatchObject({ request: null, status: 'working' })
  })
  it('a write that throws leaves the card where it was — nothing reached the CLI, so nothing was answered', async () => {
    const { c } = made()
    c.openRequest('0', { decoded: approval('0', 'git log'), wireId: 0 })
    await tick()
    expect(() => c.takeRequest('0', () => { throw new Error('write EPIPE') })).toThrow('write EPIPE')
    await tick()
    expect(c.state).toMatchObject({ request: { id: '0' }, status: 'waiting' })
    // Still answerable: the person can press again once the pipe is back.
    expect(c.takeRequest('0', () => {})?.wireId).toBe(0)
  })
  it('a second openRequest for an id already open is refused, so the queue can never hold it twice', async () => {
    const { c } = made()
    c.openRequest('0', { decoded: approval('0', 'git log'), wireId: 0 })
    c.openRequest('0', { decoded: approval('0', 'rm -rf /'), wireId: 9 })
    await tick()
    expect(c.state.request).toMatchObject({ about: { lines: ['git log'] } })
    expect(c.takeRequest('0', () => {})?.wireId).toBe(0)
    await tick()
    expect(c.state).toMatchObject({ request: null, status: 'working' })
    // The proof that the second one took no slot: a queue holding a leftover '0' would keep the next
    // request off the screen for ever, since the head would never be its id.
    c.openRequest('1', { decoded: approval('1', 'ls -la'), wireId: 1 })
    await tick()
    expect(c.state.request).toMatchObject({ id: '1' })
  })
  it('resolveByToolUse finds the open request by the tool call it is about, and says so when nothing matches', async () => {
    const { c } = made()
    c.openRequest('r1', { decoded: approval('r1', 'git log', 'toolu_01'), wireId: 'r1' })
    c.openRequest('r2', { decoded: approval('r2', 'ls -la', 'toolu_02'), wireId: 'r2' })
    await tick()
    expect(c.resolveByToolUse('toolu_99')).toBe(false)
    expect(c.state.request).toMatchObject({ id: 'r1' })
    expect(c.resolveByToolUse('toolu_01')).toBe(true)
    await tick()
    expect(c.state.request).toMatchObject({ id: 'r2' })
    expect(c.resolveByToolUse('toolu_01')).toBe(false)   // resolved once
  })
  it('exit clears the queue so a rebuilt pane is not left showing a question no one can answer', async () => {
    const { c } = made()
    c.openRequest('0', { decoded: approval('0', 'git log'), wireId: 0 })
    await tick()
    c.onExit(0)
    expect(c.takeRequest('0', () => {})).toBeUndefined()
    expect(c.resolveByToolUse('toolu_01')).toBe(false)
  })
})

describe('createAdapterCore — emission', () => {
  it('coalesces one flush into request, then status, then model, with truncated riding on the status', async () => {
    const { c, events } = made({ mode: 'adopt', threadId: 't', rolloutPath: null, truncated: true })
    expect(c.state.truncated).toBe(true)
    c.patch({ request: approval('0', 'git log').request, status: 'working', model: { model: 'm', effort: 'high', permissionMode: 'default' }, truncated: false })
    await tick()
    expect(events.map((e) => e.type)).toEqual(['request', 'status', 'model'])
    expect(events[1]).toEqual({ type: 'status', status: 'working', truncated: false })
    expect(events[2]).toEqual({ type: 'model', model: { model: 'm', effort: 'high', permissionMode: 'default' } })
  })
  it('emits only what changed, by value — a field patched back to what was already emitted says nothing', async () => {
    const { c, events } = made()
    c.patch({ status: 'working' })
    await tick()
    expect(events).toEqual([{ type: 'status', status: 'working', truncated: false }])
    c.patch({ status: 'working', model: { model: null, effort: null, permissionMode: 'default' }, request: null })
    await tick()
    expect(events.length).toBe(1)
  })
  it('a subscriber that patches synchronously inside a request emission still gets the follow-up event', async () => {
    const { c, events } = made()
    // What the pane does when it answers the card the moment it is drawn — the answer lands while this
    // very flush is still running, and the clearing event must not be swallowed by it (see flush()).
    c.on((e) => {
      if (e.type === 'request' && e.request) c.takeRequest(e.request.id, () => {})
    })
    c.openRequest('0', { decoded: approval('0', 'git log'), wireId: 0 })
    await tick()
    const requests = events.filter((e) => e.type === 'request')
    expect(requests.length).toBe(2)
    expect(requests.at(-1)).toEqual({ type: 'request', request: null })
  })
  it('a listener that throws neither escapes nor stops the ones after it', async () => {
    const { c } = made()
    const seen: string[] = []
    c.on(() => { throw new Error('boom') })
    c.on((e) => seen.push(e.type))
    c.patch({ status: 'working' })
    await tick()
    expect(seen).toEqual(['status'])
  })
  it('on() hands back an unsubscribe that stops the events', async () => {
    const { c, events } = made()
    const off = c.on(() => {})
    off()
    c.patch({ status: 'working' })
    await tick()
    expect(events.length).toBe(1)   // the one registered in made(), not the one just removed
  })
  it('fail remembers the error on the state as well as announcing it', () => {
    const { c, events } = made()
    c.fail('no such thread')
    expect(c.state.error).toBe('no such thread')
    expect(events).toEqual([{ type: 'error', message: 'no such thread' }])
  })
  it('ready is emitted once per thread id, however many times the same one is announced', () => {
    const { c, events } = made()
    c.emitReady('thread-1', 'D:/rollout.jsonl')
    c.emitReady('thread-1', 'D:/rollout.jsonl')
    expect(events).toEqual([{ type: 'ready', threadId: 'thread-1', rolloutPath: 'D:/rollout.jsonl' }])
  })
  it('a thread id that differs from the last one emitted is announced again — a /clear starts a new session', () => {
    const { c, events } = made()
    c.emitReady('thread-1', 'D:/rollout.jsonl')
    c.emitReady('thread-2', null)
    c.emitReady('thread-2', null)
    expect(events).toEqual([
      { type: 'ready', threadId: 'thread-1', rolloutPath: 'D:/rollout.jsonl' },
      { type: 'ready', threadId: 'thread-2', rolloutPath: null }
    ])
  })
})

describe('createAdapterCore — the state it hands out', () => {
  it('snapshot copies the model, so a caller cannot write into the live session', () => {
    const { c } = made()
    c.patch({ model: { model: 'gpt-6-astra', effort: 'xhigh', permissionMode: 'default' } })
    const first = c.snapshot()
    first.model.model = 'tampered'
    expect(c.snapshot().model.model).toBe('gpt-6-astra')
    expect(c.state.model.model).toBe('gpt-6-astra')
  })
  it('snapshot reads outlivesApp live off the process, not from a value stamped at construction', () => {
    const { p, c } = made()
    expect(c.snapshot().outlivesApp).toBe(false)
    p.outlivesApp = true
    expect(c.snapshot().outlivesApp).toBe(true)
  })
  it('remembers which CLI it is for whoever asks', () => {
    expect(made().c.provider).toBe('codex')
    const p = fakeProc()
    expect(createAdapterCore({ proc: p, log: () => {} }, { mode: 'fresh' }, 'claude').provider).toBe('claude')
  })
})
