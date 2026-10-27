// The `astera` CLI's way to the Host from inside a sandbox that cannot open the Host's pipe but can reach 127.0.0.1
// (sandbox design §6): a `HostConnection` whose calls are `POST /astera/call` on the Host's loopback endpoint, carrying
// the session's workload token. The caller reads the answer as it reads one from the pipe, an `orch-result`.
//
// `node:http`, not fetch: fetch adds headers of its own, and the endpoint refuses any request that carries an `Origin`.
import http from 'node:http'
import type { ConnectionClientMessage, ConnectionHostMessage, HostConnection } from './connect.js'

/** How long the TCP connect may take. The answer itself has no limit here: a `wait` runs for as long as the caller's own
 *  deadline allows. */
const CONNECT_MS = 5_000

export function connectLoopback(a: { url: string; token: string; timeoutMs?: number }): HostConnection {
  const messages = new Set<(m: ConnectionHostMessage) => void>()
  const closers = new Set<() => void>()
  let closed = false
  const inflight = new Set<http.ClientRequest>()
  const end = (): void => {
    if (closed) return
    closed = true
    for (const r of inflight) r.destroy()
    for (const cb of [...closers]) cb()
  }
  const deliver = (m: ConnectionHostMessage): void => {
    for (const cb of [...messages]) cb(m)
  }

  const send = (m: Extract<ConnectionClientMessage, { t: 'orch-call' }>): void => {
    // Only what the route reads. The session is the token's, so `session` and `token` are not in the body.
    const body = JSON.stringify({ cmd: m.cmd, args: m.args, ...(m.request === undefined ? {} : { request: m.request }) })
    const req = http.request(
      new URL('/astera/call', a.url),
      {
        method: 'POST',
        // A new connection per call: the CLI asks one thing and exits
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${a.token}` }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (text += c))
        res.on('error', end)
        res.on('end', () => {
          inflight.delete(req)
          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch {
            return end()
          }
          const r = parsed as { status?: unknown; body?: unknown; replayed?: unknown; observed?: unknown; error?: unknown } | null
          if (res.statusCode === 200 && typeof r?.status === 'number') {
            deliver({
              t: 'orch-result',
              call: m.call,
              status: r.status,
              body: r.body,
              ...(r.replayed === true ? { replayed: true as const } : {}),
              ...(r.observed === true ? { observed: true as const } : {})
            })
          } else if (res.statusCode !== undefined && res.statusCode !== 200 && r !== null && typeof r === 'object') {
            // The endpoint's own refusal (a token it does not know, a body it cannot read) is the answer to this call
            deliver({ t: 'orch-result', call: m.call, status: res.statusCode, body: r })
          } else end()
        })
      }
    )
    inflight.add(req)
    // Nobody listening, or not at that address: the same as a pipe that cannot be opened
    req.on('error', end)
    req.on('socket', (socket) => {
      if (!socket.connecting) return
      const timer = setTimeout(() => req.destroy(), a.timeoutMs ?? CONNECT_MS)
      timer.unref?.()
      socket.once('connect', () => clearTimeout(timer))
      socket.once('close', () => clearTimeout(timer))
    })
    req.end(body)
  }

  return {
    hello: { host: 'loopback', pid: 0, startedAt: '', features: ['orch', 'requests'] },
    call: (m) => {
      if (m.t === 'orch-call' && !closed) send(m)
    },
    onMessage: (cb) => {
      messages.add(cb)
      return () => void messages.delete(cb)
    },
    onClose: (cb) => {
      closers.add(cb)
      return () => void closers.delete(cb)
    },
    // Nothing is held between calls, so nothing keeps Node running beyond the request itself
    ref: () => {},
    unref: () => {},
    close: () => {
      closed = true
      for (const r of inflight) r.destroy()
    }
  }
}
