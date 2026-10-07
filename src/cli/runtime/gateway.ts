// The Remote Gateway (remote runtime design §2.3, §3.1, §3.2, §4.4): the process that faces the network. It owns
// TLS, untrusted parsing, per-connection budgets and heartbeat, and speaks to the Host over its own stdin and stdout
// (the link). It decides nothing about who a controller is: it hashes the token it was shown and the Host answers.
// Nothing here writes a frame, a token or a code to a log.
import tls, { type TLSSocket } from 'node:tls'
import path from 'node:path'
import { loadIdentity } from '../../core/remote/identity'
import { openSecretStore, SecretFileUnsafe } from '../../core/secrets/secretStore'
import type { Readable, Writable } from 'node:stream'
import { createLineReader } from '../../host/framing'
import { sha256Base64url } from '../../host/controllers'
import { createLaneWriter, type LaneWriter } from '../../core/remote/lanes'
import { CHUNK_THRESHOLD, chunksOf } from '../../core/remote/chunks'
import { FRAME_CAP, parseControllerFrame, parseLinkFrame, type HostLinkFrame } from '../../core/remote/frames'

export interface GatewayLimits {
  connections: number
  inFlight: number
  firstFrameMs: number
  pingMs: number
  silenceMs: number
  queuePerConn: number
  queueTotal: number
  redeemPerMinute: number
}

export const GATEWAY_LIMITS: GatewayLimits = {
  connections: 16,
  inFlight: 32,
  firstFrameMs: 10_000,
  pingMs: 15_000,
  silenceMs: 45_000,
  queuePerConn: 8 << 20,
  queueTotal: 64 << 20,
  redeemPerMinute: 10
}

export interface GatewayHandle {
  address: string
  port: number
  close(): Promise<void>
}

export interface GatewayIdentity {
  keyPem: string
  certPem: string
  spkiSha256: string
}

interface Conn {
  id: string
  sock: TLSSocket
  state: 'new' | 'authing' | 'redeeming' | 'ready' | 'closing'
  inFlight: Set<string>
  heard: number
  out: LaneWriter
  timers: Array<ReturnType<typeof setTimeout>>
  /** Whether the Host has been told about this connection, so it must be told when it closes. */
  announced: boolean
}

const bindCode = (e: NodeJS.ErrnoException): string => {
  if (e.code === 'EADDRINUSE') return 'BIND_IN_USE'
  if (e.code === 'EACCES' || e.code === 'EPERM') return 'BIND_DENIED'
  return 'BIND_ADDRESS'
}

export async function startGateway(o: {
  identity: GatewayIdentity
  listen: string
  port: number
  link: { input: Readable; output: Writable }
  limits?: Partial<GatewayLimits>
  now?(): number
}): Promise<GatewayHandle | { error: { code: string; message: string } }> {
  const lim = { ...GATEWAY_LIMITS, ...o.limits }
  const now = o.now ?? Date.now
  const conns = new Map<string, Conn>()
  const redeems = new Map<string, number[]>()
  let seq = 0

  const toHost = (m: unknown): void => {
    o.link.output.write(`${JSON.stringify(m)}\n`)
  }

  const sendTo = (c: Conn, m: unknown): void => {
    if (c.sock.destroyed) return
    const line = JSON.stringify(m)
    if (Buffer.byteLength(line) > CHUNK_THRESHOLD) for (const f of chunksOf(`r${++seq}`, line)) c.out.control(`${JSON.stringify(f)}\n`)
    else c.out.control(`${line}\n`)
    // The whole Gateway's budget: past it, the connection holding the most goes.
    let total = 0
    let largest: Conn | null = null
    for (const x of conns.values()) {
      const q = x.out.queued()
      total += q
      if (!largest || q > largest.out.queued()) largest = x
    }
    if (total > lim.queueTotal && largest) closeConn(largest, 'RUNTIME_BUSY')
  }

  const closeConn = (c: Conn, code: string): void => {
    if (c.state === 'closing') return
    c.state = 'closing'
    sendTo(c, { t: 'closing', code })
    c.sock.end()
    // A peer that never reads would keep the socket open on `end`; it goes for good shortly after.
    c.timers.push(setTimeout(() => c.sock.destroy(), 2000).unref())
  }

  const refuse = (c: Conn, code: string, message: string): void => {
    sendTo(c, { t: 'error', code, message })
    closeConn(c, code)
  }

  const onControllerFrame = (c: Conn, v: unknown): void => {
    c.heard = now()
    const f = parseControllerFrame(v)
    if ('error' in f) return refuse(c, 'REMOTE_BAD_FRAME', f.error)
    if (f.t === 'ping') return sendTo(c, { t: 'pong' })
    if (f.t === 'pong') return
    if (c.state === 'new' && f.t === 'auth') {
      c.state = 'authing'
      c.announced = true
      return toHost({ t: 'auth', conn: c.id, tokenHash: sha256Base64url(f.token) })
    }
    if (c.state === 'new' && f.t === 'redeem') {
      const from = c.sock.remoteAddress ?? '?'
      const recent = (redeems.get(from) ?? []).filter((t) => now() - t < 60_000)
      if (recent.length >= lim.redeemPerMinute) return refuse(c, 'RUNTIME_BUSY', 'too many pairing attempts from this address; wait a minute')
      redeems.set(from, [...recent, now()])
      c.state = 'redeeming'
      return toHost({ t: 'redeem', conn: c.id, code: f.code, name: f.name })
    }
    if (f.t === 'call') {
      if (c.state !== 'ready') return refuse(c, 'RUNTIME_AUTH_FAILED', 'authenticate before calling')
      if (c.inFlight.has(f.id)) return sendTo(c, { t: 'error', code: 'REMOTE_BAD_FRAME', message: 'that call id is already in flight', id: f.id })
      if (c.inFlight.size >= lim.inFlight)
        return sendTo(c, { t: 'error', code: 'RUNTIME_BUSY', message: `at most ${lim.inFlight} calls in flight per connection`, id: f.id })
      c.inFlight.add(f.id)
      return toHost({ t: 'call', conn: c.id, id: f.id, cmd: f.cmd, args: f.args, ...(f.request ? { request: f.request } : {}), ...(f.retry ? { retry: true } : {}) })
    }
    return refuse(c, 'REMOTE_BAD_FRAME', `${f.t} is not expected now`)
  }

  const onHostFrame = (f: HostLinkFrame): void => {
    const c = conns.get(f.conn)
    if (!c) return
    switch (f.t) {
      case 'authed':
        if (c.state !== 'authing') return
        if (!f.ok || !f.hello) return refuse(c, 'RUNTIME_AUTH_FAILED', 'this token is not paired with this Runtime')
        c.state = 'ready'
        return sendTo(c, f.hello)
      case 'redeemed':
        if (c.state !== 'redeeming') return
        if (!f.ok || !f.clientId || !f.token) return refuse(c, 'RUNTIME_AUTH_FAILED', `pairing refused (${f.reason ?? 'unknown'})`)
        // The token goes to this controller once and is not kept here; it reconnects with `auth`.
        sendTo(c, { t: 'paired', clientId: f.clientId, token: f.token })
        return closeConn(c, 'PAIRED')
      case 'result':
        if (!c.inFlight.delete(f.id)) return
        return sendTo(c, { t: 'result', id: f.id, status: f.status, body: f.body, ...(f.replayed ? { replayed: true } : {}), ...(f.observed ? { observed: true } : {}) })
      case 'close-conn':
        return closeConn(c, f.code)
    }
  }

  o.link.input.setEncoding('utf8')
  o.link.input.on(
    'data',
    createLineReader({
      maxLine: FRAME_CAP + 1024,
      onMessage: (v) => {
        const f = parseLinkFrame(v, 'host')
        if (!('error' in f)) onHostFrame(f)
      },
      onBadLine: () => {},
      onHandlerError: () => {},
      onOverflow: () => {}
    })
  )

  const server = tls.createServer({ key: o.identity.keyPem, cert: o.identity.certPem, minVersion: 'TLSv1.3' }, (sock) => {
    sock.setEncoding('utf8')
    sock.on('error', () => {})
    const c: Conn = {
      id: `c${++seq}`,
      sock,
      state: 'new',
      inFlight: new Set(),
      heard: now(),
      timers: [],
      announced: false,
      out: createLaneWriter(sock, { hardCap: lim.queuePerConn, onHardCap: () => sock.destroy() })
    }
    if (conns.size >= lim.connections) {
      c.out.control(`${JSON.stringify({ t: 'error', code: 'RUNTIME_BUSY', message: `at most ${lim.connections} controllers at once` })}\n`)
      sock.end()
      setTimeout(() => sock.destroy(), 2000).unref()
      return
    }
    conns.set(c.id, c)
    c.timers.push(
      setTimeout(() => {
        if (c.state === 'new') refuse(c, 'REMOTE_TIMEOUT', 'no auth or redeem frame arrived in time')
      }, lim.firstFrameMs).unref()
    )
    const beat = setInterval(() => {
      if (now() - c.heard > lim.silenceMs) return refuse(c, 'REMOTE_TIMEOUT', 'the controller stopped answering')
      if (c.state === 'ready') sendTo(c, { t: 'ping' })
    }, lim.pingMs)
    beat.unref()
    c.timers.push(beat)
    sock.on(
      'data',
      createLineReader({
        maxLine: FRAME_CAP,
        onMessage: (v) => onControllerFrame(c, v),
        onBadLine: () => refuse(c, 'REMOTE_BAD_FRAME', 'a frame is one JSON object per line'),
        onHandlerError: () => refuse(c, 'REMOTE_BAD_FRAME', 'that frame could not be handled'),
        onOverflow: () => refuse(c, 'REMOTE_BAD_FRAME', 'a frame is at most 1 MiB')
      })
    )
    sock.once('close', () => {
      for (const t of c.timers) clearTimeout(t)
      c.out.destroy()
      conns.delete(c.id)
      if (c.announced) toHost({ t: 'conn-closed', conn: c.id })
    })
  })
  server.on('tlsClientError', () => {})

  return new Promise((resolve) => {
    const onError = (e: NodeJS.ErrnoException): void => {
      const error = { code: bindCode(e), message: e.message }
      toHost({ t: 'gateway-failed', ...error })
      resolve({ error })
    }
    server.once('error', onError)
    server.listen(o.port, o.listen, () => {
      server.off('error', onError)
      server.on('error', () => {})
      const port = (server.address() as { port: number }).port
      toHost({ t: 'gateway-ready', port, address: o.listen, fingerprint: o.identity.spkiSha256 })
      resolve({
        address: o.listen,
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const c of conns.values()) c.sock.destroy()
            server.close(() => done())
          })
      })
    })
  })
}

/**
 * The hidden `astera runtime gateway --listen <addr> --port <n>` the Host spawns (design §2.3). It reads the
 * identity, never makes one (`astera runtime start` does), serves until its stdin ends or it is told to stop, and
 * answers through the link only: its stdout is the link, so nothing else may be printed there.
 */
export async function runRuntimeGateway(o: {
  argv: string[]
  profileDir: string
  stdin: Readable
  stdout: Writable
  onStop?(stop: () => void): void
}): Promise<number> {
  const flag = (name: string): string | undefined => {
    const i = o.argv.indexOf(name)
    return i >= 0 ? o.argv[i + 1] : undefined
  }
  const listen = flag('--listen') ?? '127.0.0.1'
  const port = Number(flag('--port') ?? '47831')
  if (!Number.isInteger(port) || port < 0 || port > 65535 || listen === '') return 2
  const failed = (code: string, message: string): number => {
    o.stdout.write(`${JSON.stringify({ t: 'gateway-failed', code, message })}\n`)
    return 1
  }
  let identity: Awaited<ReturnType<typeof loadIdentity>>
  try {
    identity = await loadIdentity(openSecretStore({ dir: path.join(o.profileDir, 'remote'), profileDir: o.profileDir }))
  } catch (e) {
    if (e instanceof SecretFileUnsafe) return failed('IDENTITY_UNSAFE', e.message)
    return failed('IDENTITY_UNREADABLE', e instanceof Error ? e.message : String(e))
  }
  if (!identity) return failed('IDENTITY_UNREADABLE', 'this machine has no Runtime identity yet; run `astera runtime start`')
  const gw = await startGateway({ identity, listen, port, link: { input: o.stdin, output: o.stdout } })
  if ('error' in gw) return 1
  await new Promise<void>((resolve) => {
    o.stdin.once('end', resolve)
    o.stdin.once('close', resolve)
    o.onStop?.(resolve)
    o.stdin.resume()
  })
  await gw.close()
  return 0
}
