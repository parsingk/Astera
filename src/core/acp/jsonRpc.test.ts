import { describe, it, expect } from 'vitest'
import { createJsonRpcPeer, JsonRpcError, JsonRpcTimeout, type LineTransport } from './jsonRpc'

/** An in-memory line transport: `out` is what the peer wrote, `feed` is what the other side says. */
function memory(): { t: LineTransport; out: string[]; feed(line: string): void } {
  let cb: (line: string) => void = () => {}
  const out: string[] = []
  return {
    t: { write: (l) => out.push(l), onLine: (c) => { cb = c } },
    out,
    feed: (l) => cb(l)
  }
}
const sent = (m: { out: string[] }, i: number): Record<string, unknown> => JSON.parse(m.out[i]) as Record<string, unknown>
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('createJsonRpcPeer', () => {
  it('numbers requests from 1 and resolves one by its result', async () => {
    const m = memory()
    const peer = createJsonRpcPeer(m.t)
    const a = peer.request('a', { x: 1 })
    const b = peer.request('b', {})
    expect(sent(m, 0)).toEqual({ jsonrpc: '2.0', id: 1, method: 'a', params: { x: 1 } })
    expect(sent(m, 1).id).toBe(2)
    m.feed(JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'B' }))
    m.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'A' }))
    await expect(a).resolves.toBe('A')
    await expect(b).resolves.toBe('B')
  })

  it('matches a response by String(id), so an agent that echoes "1" for 1 still answers', async () => {
    const m = memory()
    const peer = createJsonRpcPeer(m.t)
    const a = peer.request('a', {})
    m.feed(JSON.stringify({ jsonrpc: '2.0', id: '1', result: 'ok' }))
    await expect(a).resolves.toBe('ok')
  })

  it('rejects with a JsonRpcError carrying code, message and data', async () => {
    const m = memory()
    const peer = createJsonRpcPeer(m.t)
    const a = peer.request('a', {})
    m.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'sign in', data: { d: 1 } } }))
    const e = await a.catch((x: unknown) => x)
    expect(e).toBeInstanceOf(JsonRpcError)
    expect(e).toMatchObject({ code: -32000, message: 'sign in', data: { d: 1 } })
  })

  it('skips a line that is not JSON, or not an object, and logs it', async () => {
    const m = memory()
    const logs: string[] = []
    const peer = createJsonRpcPeer(m.t, { log: (l) => logs.push(l) })
    const a = peer.request('a', {})
    m.feed('Loaded cached credentials.')
    m.feed('42')
    m.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1 }))
    await expect(a).resolves.toBe(1)
    expect(logs).toEqual(['ignored a line that is not JSON', 'ignored a line that is not JSON'])
  })

  it('ignores a response nobody is waiting for', () => {
    const m = memory()
    createJsonRpcPeer(m.t)
    expect(() => m.feed(JSON.stringify({ jsonrpc: '2.0', id: 9, result: 1 }))).not.toThrow()
  })

  it('answers the other side request with the handler result, echoing its id as sent', async () => {
    const m = memory()
    const peer = createJsonRpcPeer(m.t)
    peer.onRequest((method, params) => ({ method, params }))
    m.feed(JSON.stringify({ jsonrpc: '2.0', id: 'abc', method: 'm', params: { p: 1 } }))
    await tick()
    expect(sent(m, 0)).toEqual({ jsonrpc: '2.0', id: 'abc', result: { method: 'm', params: { p: 1 } } })
  })

  it('answers a thrown JsonRpcError with that error and any other throw with -32603', async () => {
    const m = memory()
    const peer = createJsonRpcPeer(m.t)
    peer.onRequest((method) => {
      if (method === 'a') throw new JsonRpcError(-32601, 'nope')
      throw new Error('boom')
    })
    m.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'a' }))
    m.feed(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'b' }))
    await tick()
    expect(sent(m, 0)).toMatchObject({ id: 1, error: { code: -32601, message: 'nope' } })
    expect(sent(m, 1)).toMatchObject({ id: 2, error: { code: -32603 } })
  })

  it('answers -32601 to a request when no handler is installed', async () => {
    const m = memory()
    createJsonRpcPeer(m.t)
    m.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x' }))
    await tick()
    expect(sent(m, 0)).toMatchObject({ id: 1, error: { code: -32601 } })
  })

  it('delivers notifications to the handler and never answers them', () => {
    const m = memory()
    const peer = createJsonRpcPeer(m.t)
    const seen: Array<[string, unknown]> = []
    peer.onNotification((method, params) => seen.push([method, params]))
    m.feed(JSON.stringify({ jsonrpc: '2.0', method: 'n', params: { a: 1 } }))
    expect(seen).toEqual([['n', { a: 1 }]])
    expect(m.out).toEqual([])
  })

  // Final fix wave D1: third-party input reaches these on the Host's thread
  it('a notification handler that throws does not break the next line, and the throw is logged', async () => {
    const m = memory()
    const logs: string[] = []
    const peer = createJsonRpcPeer(m.t, { log: (l) => logs.push(l) })
    peer.onNotification(() => {
      throw new Error('handler broke')
    })
    const a = peer.request('a', {})
    expect(() => m.feed(JSON.stringify({ jsonrpc: '2.0', method: 'n', params: {} }))).not.toThrow()
    m.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'still here' }))
    await expect(a).resolves.toBe('still here')
    expect(logs.join('\n')).toContain('handler broke')
  })

  it('an answer whose send throws, and whose error answer throws too, is logged and leaves nothing unhandled', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => void unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      const logs: string[] = []
      let cb: (line: string) => void = () => {}
      const peer = createJsonRpcPeer(
        {
          write: () => {
            throw new Error('pipe closed')
          },
          onLine: (c) => {
            cb = c
          }
        },
        { log: (l) => logs.push(l) }
      )
      peer.onRequest(() => 'ok')
      expect(() => cb(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'm' }))).not.toThrow()
      await new Promise((r) => setTimeout(r, 50))
      expect(unhandled).toEqual([])
      expect(logs.join('\n')).toContain('pipe closed')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('notify writes a message with no id', () => {
    const m = memory()
    createJsonRpcPeer(m.t).notify('n', { a: 1 })
    expect(sent(m, 0)).toEqual({ jsonrpc: '2.0', method: 'n', params: { a: 1 } })
  })

  it('rejects with JsonRpcTimeout after timeoutMs and forgets the request', async () => {
    const m = memory()
    const peer = createJsonRpcPeer(m.t)
    const a = peer.request('slow', {}, { timeoutMs: 20 })
    await expect(a).rejects.toBeInstanceOf(JsonRpcTimeout)
    expect(() => m.feed(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1 }))).not.toThrow()
  })

  it('close rejects every pending request with the reason, rejects a later one at once, and is idempotent', async () => {
    const m = memory()
    const peer = createJsonRpcPeer(m.t)
    const a = peer.request('a', {})
    peer.close('gone')
    peer.close('again')
    await expect(a).rejects.toThrow('gone')
    await expect(peer.request('b', {})).rejects.toThrow('gone')
    expect(m.out).toHaveLength(1)
  })
})
