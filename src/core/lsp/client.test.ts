import { describe, it, expect, vi, afterEach } from 'vitest'
import { LspRequestFailed, createLspClient } from './client'
import { createMessageReader, encodeMessage } from './framing'

// Phase 3 Part 3: the JSON-RPC client the Host talks to a language server with. The test plays the server: it reads what
// the client writes and feeds the client what the server would say.
function pair(o: { timeoutMs?: number; maxBytes?: number; onRequest?: (m: string, p: unknown) => unknown } = {}) {
  const written: Array<Record<string, unknown>> = []
  const reader = createMessageReader({ maxBytes: 1 << 20, onMessage: (m) => written.push(m as Record<string, unknown>), onError: (e) => { throw e } })
  const notes: Array<[string, unknown]> = []
  const closed: string[] = []
  const { client, feed } = createLspClient(
    { write: (b) => reader(b) },
    {
      timeoutMs: o.timeoutMs ?? 1000,
      onRequest: o.onRequest ?? (() => null),
      onNotification: (m, p) => notes.push([m, p]),
      onClosed: (r) => closed.push(r),
      ...(o.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {})
    }
  )
  const say = (m: unknown): void => feed(encodeMessage(m))
  return { client, written, notes, closed, say, feed }
}

afterEach(() => vi.useRealTimers())

describe('createLspClient', () => {
  it('omits params when a request has none, and resolves with the result', async () => {
    const p = pair()
    const answer = p.client.request('shutdown')
    expect(p.written[0]).toEqual({ jsonrpc: '2.0', id: 1, method: 'shutdown' })
    expect('params' in p.written[0]).toBe(false)
    p.say({ jsonrpc: '2.0', id: 1, result: null })
    await expect(answer).resolves.toBeNull()
    p.client.notify('exit')
    expect(p.written[1]).toEqual({ jsonrpc: '2.0', method: 'exit' })
  })

  it('rejects with the server’s error', async () => {
    const p = pair()
    const answer = p.client.request('initialize', { processId: 1 })
    p.say({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'InvalidParams' } })
    await expect(answer).rejects.toMatchObject({ code: -32602, message: 'InvalidParams' })
  })

  it('answers a server request with onRequest’s value, and an error for one that throws or is unknown', async () => {
    const p = pair({
      onRequest: (m) => {
        if (m === 'workspace/configuration') return [{ pythonPath: '/py' }, null]
        throw new Error('nope')
      }
    })
    p.say({ jsonrpc: '2.0', id: 7, method: 'workspace/configuration', params: { items: [{ section: 'python' }, { section: 'pyright' }] } })
    p.say({ jsonrpc: '2.0', id: 'x', method: 'window/showDocument', params: {} })
    await vi.waitFor(() => expect(p.written).toHaveLength(2))
    // Answers to the server's requests go out as each is ready, in no promised order
    expect(p.written.find((m) => m.id === 7)).toEqual({ jsonrpc: '2.0', id: 7, result: [{ pythonPath: '/py' }, null] })
    expect(p.written.find((m) => m.id === 'x')).toMatchObject({ jsonrpc: '2.0', id: 'x', error: { code: -32603 } })
    p.say({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 3, message: 'hi' } })
    expect(p.notes).toEqual([['window/logMessage', { type: 3, message: 'hi' }]])
  })

  it('times out a request, sends $/cancelRequest, and ignores its late answer', async () => {
    vi.useFakeTimers()
    const p = pair({ timeoutMs: 500 })
    const answer = p.client.request('textDocument/diagnostic', { textDocument: { uri: 'file:///a.ts' } })
    const caught = answer.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(501)
    const e = await caught
    expect(e).toBeInstanceOf(LspRequestFailed)
    expect((e as LspRequestFailed).code).toBe('timeout')
    expect(p.written[1]).toEqual({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } })
    p.say({ jsonrpc: '2.0', id: 1, result: { kind: 'full', items: [] } })
    expect(p.closed).toEqual([])
    // A per-request wait overrides the default
    const long = p.client.request('initialize', {}, { timeoutMs: 2000 })
    await vi.advanceTimersByTimeAsync(1000)
    p.say({ jsonrpc: '2.0', id: 2, result: { capabilities: {} } })
    await expect(long).resolves.toEqual({ capabilities: {} })
  })

  it('fails every pending request when closed, and any later one at once', async () => {
    const p = pair()
    const a = p.client.request('initialize', {})
    const b = p.client.request('shutdown')
    p.client.close('the server exited')
    await expect(a).rejects.toMatchObject({ code: 'closed' })
    await expect(b).rejects.toMatchObject({ code: 'closed' })
    await expect(p.client.request('shutdown')).rejects.toMatchObject({ code: 'closed' })
    expect(p.closed).toEqual(['the server exited'])
  })

  it('closes on a message over the bound', async () => {
    const p = pair({ maxBytes: 64 })
    const a = p.client.request('initialize', {})
    p.say({ jsonrpc: '2.0', id: 1, result: { big: 'x'.repeat(200) } })
    await expect(a).rejects.toMatchObject({ code: 'closed' })
    expect(p.closed[0]).toMatch(/longer than 64/)
  })
})
