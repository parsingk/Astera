// The JSON-RPC 2.0 client the Host talks to a language server with (Phase 3 Part 3), over the framing in framing.ts.
// Integer request ids from 1; a request with no params writes no `params` member (TypeScript 7 refuses `"params": null`
// on `shutdown`, measured 2026-11-26). A request past its wait is cancelled with `$/cancelRequest` and its late answer
// ignored. The server's own requests (`workspace/configuration`, `client/registerCapability`, ...) are answered with what
// `onRequest` returns, or an internal error when it throws. A message over the bound closes the client.
import { LSP_MAX_MESSAGE, createMessageReader, encodeMessage } from './framing'

export class LspRequestFailed extends Error {
  constructor(
    message: string,
    readonly code: number | 'timeout' | 'closed'
  ) {
    super(message)
    this.name = 'LspRequestFailed'
  }
}

export interface LspClient {
  request(method: string, params?: unknown, o?: { timeoutMs?: number }): Promise<unknown>
  notify(method: string, params?: unknown): void
  close(reason: string): void
}

const INTERNAL_ERROR = -32603

interface Pending {
  method: string
  resolve(v: unknown): void
  reject(e: Error): void
  timer: ReturnType<typeof setTimeout>
}

export function createLspClient(
  io: { write(b: Buffer): void },
  o: {
    timeoutMs: number
    onRequest(method: string, params: unknown): unknown | Promise<unknown>
    onNotification(method: string, params: unknown): void
    onClosed(reason: string): void
    maxBytes?: number
  }
): { client: LspClient; feed(chunk: Buffer): void } {
  let nextId = 1
  let closedWith: string | null = null
  const pending = new Map<number, Pending>()

  const write = (m: Record<string, unknown>): void => {
    if (closedWith !== null) return
    try {
      io.write(encodeMessage({ jsonrpc: '2.0', ...m }))
    } catch (e) {
      close(`the server's input could not be written: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const close = (reason: string): void => {
    if (closedWith !== null) return
    closedWith = reason
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new LspRequestFailed(`${p.method}: ${reason}`, 'closed'))
    }
    pending.clear()
    o.onClosed(reason)
  }

  const answer = (id: unknown, method: string, params: unknown): void => {
    void (async () => {
      try {
        write({ id, result: (await o.onRequest(method, params)) ?? null })
      } catch (e) {
        write({ id, error: { code: INTERNAL_ERROR, message: e instanceof Error ? e.message : String(e) } })
      }
    })()
  }

  const onMessage = (raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) return
    const m = raw as Record<string, unknown>
    if (typeof m.method === 'string') {
      if ('id' in m && (typeof m.id === 'number' || typeof m.id === 'string')) answer(m.id, m.method, m.params)
      else o.onNotification(m.method, m.params)
      return
    }
    if (typeof m.id !== 'number') return
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    clearTimeout(p.timer)
    if (typeof m.error === 'object' && m.error !== null) {
      const e = m.error as Record<string, unknown>
      p.reject(new LspRequestFailed(typeof e.message === 'string' ? e.message : 'the server answered with an error', typeof e.code === 'number' ? e.code : INTERNAL_ERROR))
    } else p.resolve(m.result ?? null)
  }

  const feed = createMessageReader({ maxBytes: o.maxBytes ?? LSP_MAX_MESSAGE, onMessage, onError: (e) => close(e.message) })

  const client: LspClient = {
    request(method, params, ro) {
      if (closedWith !== null) return Promise.reject(new LspRequestFailed(`${method}: ${closedWith}`, 'closed'))
      const id = nextId++
      const waitMs = ro?.timeoutMs ?? o.timeoutMs
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return
          write({ method: '$/cancelRequest', params: { id } })
          reject(new LspRequestFailed(`${method} did not answer within ${waitMs} ms`, 'timeout'))
        }, waitMs)
        pending.set(id, { method, resolve, reject, timer })
        write(params === undefined ? { id, method } : { id, method, params })
      })
    },
    notify(method, params) {
      write(params === undefined ? { method } : { method, params })
    },
    close
  }
  return { client, feed: (chunk) => feed(chunk) }
}
