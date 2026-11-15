// JSON-RPC 2.0 over lines: one JSON object per line, both directions. Just the framing the ACP client
// needs (spec 3.3): numeric request ids from 1, responses matched by String(id) because some agents echo
// a number as a string, and a line that is not JSON skipped instead of breaking the stream.

export interface LineTransport {
  write(line: string): void
  onLine(cb: (line: string) => void): void
}

export class JsonRpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message)
    this.name = 'JsonRpcError'
  }
}

export class JsonRpcTimeout extends Error {
  constructor(method: string, ms: number) {
    super(`${method} did not answer within ${ms} ms`)
    this.name = 'JsonRpcTimeout'
  }
}

export interface JsonRpcPeer {
  request<T = unknown>(method: string, params: unknown, o?: { timeoutMs?: number }): Promise<T>
  notify(method: string, params: unknown): void
  /** One handler for the other side's requests. Throw JsonRpcError to answer with that error; any other throw answers -32603. */
  onRequest(h: (method: string, params: unknown) => Promise<unknown> | unknown): void
  onNotification(h: (method: string, params: unknown) => void): void
  /** Rejects every pending request with `reason`; a later request rejects at once. Idempotent. */
  close(reason: string): void
}

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
  timer: NodeJS.Timeout | null
}

const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603

export function createJsonRpcPeer(t: LineTransport, o: { log?(m: string): void } = {}): JsonRpcPeer {
  const pending = new Map<string, Pending>()
  let nextId = 1
  let closedReason: string | null = null
  let requestHandler: (method: string, params: unknown) => Promise<unknown> | unknown = () => {
    throw new JsonRpcError(METHOD_NOT_FOUND, 'method not found')
  }
  let notificationHandler: (method: string, params: unknown) => void = () => {}

  const send = (msg: Record<string, unknown>): void => t.write(JSON.stringify({ jsonrpc: '2.0', ...msg }))

  const answer = async (id: unknown, method: string, params: unknown): Promise<void> => {
    try {
      const result = await requestHandler(method, params)
      send({ id, result: result ?? null })
    } catch (e) {
      if (e instanceof JsonRpcError) send({ id, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } })
      else send({ id, error: { code: INTERNAL_ERROR, message: e instanceof Error ? e.message : 'internal error' } })
    }
  }

  t.onLine((line) => {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      msg = undefined
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      o.log?.('ignored a line that is not JSON')
      return
    }
    const m = msg as Record<string, unknown>
    const hasId = m.id !== undefined && m.id !== null
    if (typeof m.method === 'string') {
      if (hasId) void answer(m.id, m.method, m.params)
      else notificationHandler(m.method, m.params)
      return
    }
    if (!hasId) return
    const key = String(m.id)
    const p = pending.get(key)
    if (!p) return
    pending.delete(key)
    if (p.timer) clearTimeout(p.timer)
    const err = m.error
    if (typeof err === 'object' && err !== null) {
      const e = err as Record<string, unknown>
      p.reject(new JsonRpcError(typeof e.code === 'number' ? e.code : INTERNAL_ERROR, typeof e.message === 'string' ? e.message : 'error', e.data))
    } else p.resolve(m.result)
  })

  return {
    request<T = unknown>(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<T> {
      if (closedReason !== null) return Promise.reject(new Error(closedReason))
      const id = nextId++
      return new Promise<T>((resolve, reject) => {
        const key = String(id)
        const timer =
          opts?.timeoutMs === undefined
            ? null
            : setTimeout(() => {
                pending.delete(key)
                reject(new JsonRpcTimeout(method, opts.timeoutMs as number))
              }, opts.timeoutMs)
        pending.set(key, { resolve: resolve as (v: unknown) => void, reject, timer })
        try {
          send({ id, method, params })
        } catch (e) {
          pending.delete(key)
          if (timer) clearTimeout(timer)
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      })
    },
    notify: (method, params) => send({ method, params }),
    onRequest: (h) => {
      requestHandler = h
    },
    onNotification: (h) => {
      notificationHandler = h
    },
    close(reason) {
      if (closedReason !== null) return
      closedReason = reason
      for (const p of pending.values()) {
        if (p.timer) clearTimeout(p.timer)
        p.reject(new Error(reason))
      }
      pending.clear()
    }
  }
}
