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
import { CHUNK_THRESHOLD, chunksOf, createReassembler } from '../../core/remote/chunks'
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
  /** What the Gateway is holding, for tests: how many addresses it keeps redeem attempts for. */
  stats(): { redeemAddresses: number }
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
  /** Subscriptions this Gateway ended for falling behind (§3.7): their output is dropped until the controller
   *  subscribes again under the same id. */
  ended: Set<string>
}

export const bindCode = (e: NodeJS.ErrnoException): string => {
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
  /** The link can no longer be read (an over-cap line). The command exits non-zero; the supervisor restarts it. */
  onLinkBroken?(): void
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
    checkTotal()
  }

  /** A subscription's frame on the connection's stream lane (§3.7): output, and a checkpoint admitted whole (Phase 8
   *  review I3), in chunks when it is large. Nothing goes to a connection that is closing. */
  const streamTo = (c: Conn, sub: string, m: unknown, last: number, admit: boolean): void => {
    if (c.sock.destroyed || c.state === 'closing') return
    const line = JSON.stringify(m)
    const parts = Buffer.byteLength(line) > CHUNK_THRESHOLD ? chunksOf(`r${++seq}`, line).map((f) => JSON.stringify(f)) : [line]
    for (const part of parts) c.out.stream(sub, `${part}\n`, last, { admit })
    checkTotal()
  }

  /** The whole Gateway's budget, control and streams alike: past it, the connection holding the most goes. */
  const checkTotal = (): void => {
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
    if (f.t === 'subscribe' || f.t === 'unsubscribe') {
      if (c.state !== 'ready') return refuse(c, 'RUNTIME_AUTH_FAILED', 'authenticate before subscribing')
      // A new subscription under an id this Gateway ended is a resubscribe: its output flows again.
      c.ended.delete(f.sub)
      if (f.t === 'unsubscribe') c.out.dropStream(f.sub)
      return toHost({ ...f, conn: c.id })
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
      case 'chunk':
        return
      // A subscription's frames (§3.7) go to that connection alone, without the connection id. Output goes on the
      // connection's stream lane, so one controller that stops reading fills only its own queue.
      case 'pty-out': {
        if (c.ended.has(f.sub)) return
        const { conn: _conn, ...frame } = f
        return streamTo(c, f.sub, frame, f.events[f.events.length - 1]?.seq ?? 0, false)
      }
      case 'checkpoint': {
        if (c.ended.has(f.sub)) return
        const { conn: _conn, ...frame } = f
        return streamTo(c, f.sub, frame, f.checkpoint.watermark, true)
      }
      case 'subscribed':
      case 'output-gap':
      case 'sub-error': {
        if (f.t === 'output-gap' || f.t === 'sub-error') c.out.dropStream(f.sub)
        const { conn: _conn, ...frame } = f
        return sendTo(c, frame)
      }
    }
  }

  /** The Host's large results arrive in pieces (§3.1); put back together, each is handled like any other frame. */
  const fromHost = createReassembler()
  const onHostLine = (v: unknown): void => {
    const f = parseLinkFrame(v, 'host')
    if ('error' in f) return
    if (f.t !== 'chunk') return onHostFrame(f)
    const whole = fromHost.add(f)
    if (typeof whole !== 'string') return
    try {
      onHostLine(JSON.parse(whole))
    } catch {
      /* a broken reassembly is dropped; its call stays unanswered until the controller gives up on it */
    }
  }

  o.link.input.setEncoding('utf8')
  o.link.input.on(
    'data',
    createLineReader({
      maxLine: FRAME_CAP + 1024,
      onMessage: onHostLine,
      onBadLine: () => {},
      onHandlerError: () => {},
      // The reader stops for good after an overflow, so a Gateway that cannot hear its Host must not stay up: it
      // exits and the supervisor starts a fresh one.
      onOverflow: () => o.onLinkBroken?.()
    })
  )

  // A peer that never finishes the handshake holds no connection slot (those are taken after it), so it is bounded
  // here instead: the same time as a first frame, and a ceiling on open sockets of any kind. `handshakeTimeout` alone
  // does not do it: measured, it never fires for a peer that sends nothing at all.
  const handshaking = new Map<string, ReturnType<typeof setTimeout>>()
  const peerKey = (s: { remoteAddress?: string; remotePort?: number }): string => `${s.remoteAddress ?? '?'}|${s.remotePort ?? 0}`
  const server = tls.createServer({ key: o.identity.keyPem, cert: o.identity.certPem, minVersion: 'TLSv1.3', handshakeTimeout: lim.firstFrameMs }, (sock) => {
    const pending = handshaking.get(peerKey(sock))
    if (pending) clearTimeout(pending)
    handshaking.delete(peerKey(sock))
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
      ended: new Set(),
      // Control and bulk past the cap mean a peer that reads nothing at all: it goes. Stream output past its share is
      // dropped per subscription instead (§3.1): the controller hears OUTPUT_GAP and the Host stops sending it.
      out: createLaneWriter(sock, {
        hardCap: lim.queuePerConn,
        onHardCap: () => sock.destroy(),
        streamPerKey: lim.queuePerConn,
        streamTotal: lim.queuePerConn,
        onStreamOverflow: (sub, lost) => {
          c.ended.add(sub)
          toHost({ t: 'unsubscribe', conn: c.id, sub })
          sendTo(c, { t: 'output-gap', sub, firstSeq: lost.firstSeq, lastSeq: lost.lastSeq, code: 'OUTPUT_GAP' })
        }
      })
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
  server.maxConnections = lim.connections * 4
  server.on('connection', (raw) => {
    // An address whose attempts are all over a minute old is forgotten (Phase 3 minor), so a stream of addresses that
    // each try once does not grow the record for the Gateway's whole life.
    for (const [addr, times] of redeems) if (times.every((t) => now() - t >= 60_000)) redeems.delete(addr)
    const key = peerKey(raw)
    const t = setTimeout(() => {
      handshaking.delete(key)
      raw.destroy()
    }, lim.firstFrameMs)
    t.unref()
    handshaking.set(key, t)
    raw.once('close', () => {
      clearTimeout(t)
      if (handshaking.get(key) === t) handshaking.delete(key)
    })
  })

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
          }),
        stats: () => ({ redeemAddresses: redeems.size })
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
  let broken = false
  let stop = (): void => {}
  const stopped = new Promise<void>((resolve) => (stop = resolve))
  // A Host that is gone closes the pipe, and the next write fails with EPIPE (Phase 3 minor): the Gateway leaves with 1
  // instead of crashing on an unhandled 'error'.
  o.stdout.on('error', () => {
    broken = true
    stop()
  })
  const gw = await startGateway({
    identity,
    listen,
    port,
    link: { input: o.stdin, output: o.stdout },
    onLinkBroken: () => {
      broken = true
      stop()
    }
  })
  if ('error' in gw) return 1
  // The Host may already be gone by now: its end of stdin closed while this was still binding.
  if (o.stdin.readableEnded || o.stdin.destroyed) stop()
  o.stdin.once('end', stop)
  o.stdin.once('close', stop)
  o.onStop?.(stop)
  o.stdin.resume()
  await stopped
  await gw.close()
  return broken ? 1 : 0
}
