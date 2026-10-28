// The `astera` CLI's way to the Host from inside a sandbox that cannot open the Host's pipe but can reach 127.0.0.1
// (sandbox design §6): a `HostConnection` whose calls are `POST /astera/call` on the Host's loopback endpoint, carrying
// the session's workload token. The caller reads the answer as it reads one from the pipe, an `orch-result`.
//
// **The Host is proved before anything is run**, as on the pipe (hostKey.ts): the connection starts with `POST
// /astera/hello` and a fresh nonce, and the proof in the answer is checked against the Host key of the profile the
// caller means to reach. A port that something else holds, or another profile's Host, is `impostor`, and the command
// is never sent to it.
//
// `node:http`, not fetch: fetch adds headers of its own, and the endpoint refuses any request that carries an `Origin`.
import http from 'node:http'
import type { ConnectFailure, ConnectionClientMessage, ConnectionHostMessage, HostConnection } from './connect.js'
import { newHostNonce, proofMatches, readHostKey } from './hostKey.js'
import { HOST_FEATURE_ORCH, HOST_FEATURE_REQUESTS } from './protocol.js'

/** What a loopback connection serves of the Host's features: it carries `orch-call` and nothing else, so it offers the
 *  commands and their receipts, and never `ping` (a keepalive's would go unanswered and read as a silent Host) nor the
 *  pty or proc messages (final fix pass, minor 3). */
const LOOPBACK_FEATURES: readonly string[] = [HOST_FEATURE_ORCH, HOST_FEATURE_REQUESTS]

/** How long the TCP connect may take, and then how long the hello may. The answer to a command has no limit here: a `wait`
 *  runs for as long as the caller's own deadline allows. */
const CONNECT_MS = 5_000

/** The one form the Host writes `ASTERA_LOOPBACK` in: `http://127.0.0.1:<port>`. Anything else (another host, a path, a
 *  scheme, a port out of range) is not this Host's address and is treated as unset. */
export function loopbackUrl(value: string | undefined): string | null {
  const m = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value ?? '')
  return m && Number(m[1]) <= 65535 ? value! : null
}

type Posted = { status: number; json: unknown } | { error: 'unreachable' | 'timeout' | 'lost' }

/** One JSON POST. `unreachable` before the request was on the wire (nothing listened, the connect timed out), `timeout`
 *  when it connected and the answer did not come in time (when a time is given), `lost` after that for any other failure. */
function post(a: { url: string; path: string; token: string; body: unknown; connectMs: number; answerMs?: number; track?: (r: http.ClientRequest) => void }): Promise<Posted> {
  return new Promise((resolve) => {
    const body = JSON.stringify(a.body)
    let sent = false
    const req = http.request(
      new URL(a.path, a.url),
      {
        method: 'POST',
        // A new connection per request: the CLI asks one thing and exits
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), authorization: `Bearer ${a.token}` }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => (text += c))
        res.on('error', () => resolve({ error: 'lost' }))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) })
          } catch {
            resolve({ error: 'lost' })
          }
        })
      }
    )
    a.track?.(req)
    let timer: NodeJS.Timeout | undefined
    const arm = (ms: number, error: 'unreachable' | 'timeout'): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        resolve({ error })
        req.destroy()
      }, ms)
      timer.unref?.()
    }
    req.on('error', () => {
      clearTimeout(timer)
      resolve({ error: sent ? 'lost' : 'unreachable' })
    })
    req.on('close', () => clearTimeout(timer))
    req.on('socket', (socket) => {
      arm(a.connectMs, 'unreachable')
      const connected = (): void => {
        sent = true
        if (a.answerMs !== undefined) arm(a.answerMs, 'timeout')
        else clearTimeout(timer)
      }
      if (socket.connecting) socket.once('connect', connected)
      else connected()
    })
    req.end(body)
  })
}

export async function connectLoopback(a: { url: string; token: string; profileDir: string; timeoutMs?: number }): Promise<HostConnection | ConnectFailure> {
  // Read before connecting, as the pipe does: a Host makes its key before it listens, so no key means no Host of this
  // profile, whatever answers at the address
  const key = await readHostKey(a.profileDir)
  const nonce = newHostNonce()
  const ms = a.timeoutMs ?? CONNECT_MS
  const hello = await post({ url: a.url, path: '/astera/hello', token: a.token, body: { nonce }, connectMs: ms, answerMs: ms })
  if ('error' in hello) return { error: hello.error === 'lost' ? 'unreachable' : hello.error }
  const h = hello.json as { host?: unknown; pid?: unknown; startedAt?: unknown; features?: unknown; proof?: unknown; error?: unknown } | null
  // The endpoint's refusal of the token (or of the request) carries no proof and is shown as the answer to the command: it
  // is an error message, and no command was sent to whatever said it
  let refusal: { status: number; body: unknown } | null = null
  if (hello.status !== 200) {
    if (h === null || typeof h !== 'object' || typeof h.error !== 'string') return { error: 'impostor' }
    refusal = { status: hello.status, body: h }
  } else if (key === null || h === null || typeof h.host !== 'string' || typeof h.pid !== 'number' || typeof h.startedAt !== 'string' || !Array.isArray(h.features) || !proofMatches(key, nonce, h.proof)) {
    return { error: 'impostor' }
  }

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
    if (refusal) {
      const r = refusal
      return void queueMicrotask(() => deliver({ t: 'orch-result', call: m.call, status: r.status, body: r.body }))
    }
    // Only what the route reads. The session is the token's, so `session` and `token` are not in the body.
    void post({
      url: a.url,
      path: '/astera/call',
      token: a.token,
      body: { cmd: m.cmd, args: m.args, ...(m.request === undefined ? {} : { request: m.request }) },
      connectMs: ms,
      track: (r) => inflight.add(r)
    }).then((r) => {
      if ('error' in r) return end()
      const j = r.json as { status?: unknown; body?: unknown; replayed?: unknown; observed?: unknown } | null
      if (r.status === 200 && typeof j?.status === 'number') {
        deliver({
          t: 'orch-result',
          call: m.call,
          status: j.status,
          body: j.body,
          ...(j.replayed === true ? { replayed: true as const } : {}),
          ...(j.observed === true ? { observed: true as const } : {})
        })
      } else if (r.status !== 200 && j !== null && typeof j === 'object') {
        // The endpoint's own refusal (a body it cannot read) is the answer to this call
        deliver({ t: 'orch-result', call: m.call, status: r.status, body: j })
      } else end()
    })
  }

  return {
    hello: {
      host: typeof h?.host === 'string' ? h.host : 'loopback',
      pid: typeof h?.pid === 'number' ? h.pid : 0,
      startedAt: typeof h?.startedAt === 'string' ? h.startedAt : '',
      features: Array.isArray(h?.features) ? (h.features as string[]).filter((f) => LOOPBACK_FEATURES.includes(f)) : [...LOOPBACK_FEATURES]
    },
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
