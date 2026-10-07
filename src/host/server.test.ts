import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { hostAddress } from './address'
import { encodeLine, createLineReader } from './framing'
import { startHostServer, ADDRESS_TAKEN, UNSAFE_ADDRESS_DIR, type HostServer, type HostServerDeps } from './server'
import { createHostOrch } from './orch'
import { hostFeatures } from './features'
import { HOST_PROTOCOL, HOST_YIELD_ORCH_STATE_LATEST, ORCH_STATE_PUSH_MS, type ClientMessage, type HostMessage } from '../core/host/protocol'
import { emptyState } from '../core/orchestration/state'
import { versionOnlyOrchCall, AppUnreachable } from '../core/host/orchProtocol'
import { HOST_UNRESPONSIVE_MS } from '../core/host/unresponsive'
import { hostProof } from '../core/host/hostKey'

let dir: string
let open: HostServer[] = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-host-'))
  open = []
})
afterEach(async () => {
  for (const s of open) await s.close().catch(() => {})
  await fs.rm(dir, { recursive: true, force: true })
})

/** A server at an address of this test's own, with everything injectable. */
const server = async (
  over: {
    idleMs?: number
    helloMs?: number
    onIdle?: () => void
    profile?: string
    onMessage?: HostServerDeps['onMessage']
    liveCounts?: HostServerDeps['liveCounts']
    orch?: HostServerDeps['orch']
    features?: HostServerDeps['features']
    onClientGone?: HostServerDeps['onClientGone']
    onAppsChanged?: HostServerDeps['onAppsChanged']
    onAppGreeted?: HostServerDeps['onAppGreeted']
    pidLives?: HostServerDeps['pidLives']
    stateClock?: HostServerDeps['stateClock']
    hostKey?: HostServerDeps['hostKey']
    maxLine?: HostServerDeps['maxLine']
  } = {}
): Promise<{
  s: HostServer
  address: string
  logs: string[]
  version: string
}> => {
  const logs: string[] = []
  const version = '9.9.9'
  const addr = hostAddress({
    profileDir: path.join(dir, over.profile ?? 'profile'),
    platform: process.platform,
    tmpDir: dir,
    protocol: HOST_PROTOCOL
  })
  const s = await startHostServer({
    address: addr.address,
    dirToPrepare: addr.dirToPrepare,
    version,
    idleMs: over.idleMs ?? 60_000,
    helloMs: over.helloMs,
    onIdle: over.onIdle ?? ((): void => {}),
    onMessage: over.onMessage,
    liveCounts: over.liveCounts,
    orch: over.orch ?? versionOnlyOrchCall({ version }),
    features: over.features,
    onClientGone: over.onClientGone,
    onAppsChanged: over.onAppsChanged,
    onAppGreeted: over.onAppGreeted,
    // Every pid lives unless a test says otherwise: the tests' made-up pids must not be forgotten by a
    // real probe of whatever this machine runs under them.
    pidLives: over.pidLives ?? ((): boolean => true),
    stateClock: over.stateClock,
    hostKey: over.hostKey,
    maxLine: over.maxLine,
    log: { write: (m) => logs.push(m), close: () => {} }
  })
  open.push(s)
  return { s, address: addr.address, logs, version }
}

/** Connects, sends the given lines, and resolves with everything the server said back. */
const talk = (address: string, lines: unknown[], waitFor = 1): Promise<unknown[]> =>
  new Promise((resolve, reject) => {
    const got: unknown[] = []
    const sock = net.connect(address)
    const read = createLineReader({ onMessage: (v) => { got.push(v); if (got.length >= waitFor) { sock.end(); resolve(got) } }, onBadLine: () => {}, onHandlerError: () => {} })
    sock.setEncoding('utf8')
    sock.on('data', read)
    sock.on('error', reject)
    sock.on('connect', () => { for (const l of lines) sock.write(encodeLine(l)) })
    setTimeout(() => { sock.destroy(); resolve(got) }, 3000)
  })

/** One socket's messages, queued for `next()` so a reply that arrives before anyone asked for it is
 *  not lost — the same reason `talk()`'s `got` array exists, just not tied to a fixed message count. */
const messageChannel = (sock: net.Socket): { send(m: ClientMessage): void; next(waitMs?: number): Promise<unknown> } => {
  const queue: unknown[] = []
  const waiters: Array<(v: unknown) => void> = []
  const read = createLineReader({
    onMessage: (v) => {
      const w = waiters.shift()
      if (w) w(v)
      else queue.push(v)
    },
    onBadLine: () => {},
    onHandlerError: () => {}
  })
  sock.setEncoding('utf8')
  sock.on('data', read)
  return {
    send: (m) => sock.write(encodeLine(m)),
    next: (waitMs = 2000) =>
      new Promise((resolve) => {
        if (queue.length > 0) {
          resolve(queue.shift())
          return
        }
        // A waiter that timed out leaves the queue: left in, it would swallow the next message and the
        // caller who asks for it after the timeout would never see it.
        const waiter = (v: unknown): void => {
          clearTimeout(timer)
          resolve(v)
        }
        const timer = setTimeout(() => {
          const i = waiters.indexOf(waiter)
          if (i >= 0) waiters.splice(i, 1)
          resolve(undefined)
        }, waitMs)
        waiters.push(waiter)
      })
  }
}

/**
 * The named harness the retire-refusal tests below need, built once here because the next task's
 * tests need the same two pieces (task-4-brief.md's controller ruling 1): a server with its deps
 * injected, and a way to tell whether it actually left.
 *
 * `stopped` is `true` once `onIdle` has fired — a caller does not have to wire its own flag for
 * that, which is the one thing every retire test otherwise repeats.
 */
const start = async (
  over: {
    liveCounts?: HostServerDeps['liveCounts']
    /** The default is the version-only stub, which is what almost every test here wants. Overridden
     *  by the one test that has to talk to the real command layer over a real socket. */
    orch?: HostServerDeps['orch']
    onMessage?: HostServerDeps['onMessage']
    onClientGone?: HostServerDeps['onClientGone']
    onAppsChanged?: HostServerDeps['onAppsChanged']
  } = {}
): Promise<{
  address: string
  stopped: boolean
  /** The server itself — `act` and `hasApp` are asked of it directly, the way `host/index.ts` does. */
  s: HostServer
  /** The version this Host was started with — the same one its `orch-call version` answers with. */
  version: string
  /** Connects, completes the handshake, and hands back something to send with and read replies from.
   *  `role` is what the handshake announces — the Host sends `orch-act` only to `'app'`, and a hello
   *  with no role at all is read as a CLI (design F12), which the default here leaves testable. */
  connect(role?: 'app' | 'cli' | 'mcp'): Promise<{
    send(m: ClientMessage): void
    next(waitMs?: number): Promise<unknown>
    socket: net.Socket
  }>
  /** Connects and says nothing — the peer the next task's tests need, that never says hello. */
  connectSilent(): Promise<net.Socket>
}> => {
  const state = { stopped: false }
  const h = await server({ ...over, onIdle: () => { state.stopped = true } })
  const rawConnect = (): Promise<net.Socket> =>
    new Promise((resolve, reject) => {
      const sock = net.connect(h.address)
      sock.once('connect', () => resolve(sock))
      sock.once('error', reject)
    })
  return {
    address: h.address,
    version: h.version,
    s: h.s,
    get stopped() {
      return state.stopped
    },
    connect: async (role) => {
      const sock = await rawConnect()
      const chan = messageChannel(sock)
      chan.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', ...(role ? { role } : {}) })
      await chan.next() // the hello reply — consumed here so next() starts on whatever comes after it.
      return { ...chan, socket: sock }
    },
    connectSilent: rawConnect
  }
}

describe('startHostServer', () => {
  it('answers a hello on the same protocol with its own version and pid', async () => {
    const h = await server()
    const [reply] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    expect(reply).toMatchObject({ t: 'hello', protocol: HOST_PROTOCOL, host: '9.9.9', pid: process.pid, features: ['proc', 'ping', 'orch', 'requests', 'mcp'] })
    expect((reply as { startedAt: string }).startedAt).toMatch(/^\d{4}-/)
  })

  // The heartbeat the app judges a stuck Host by. Answered by the server itself rather than through
  // `onMessage`, because the question it asks is whether this event loop is still turning — which is
  // exactly what a pty spawn stuck inside node-pty stops (2026-09-22, design F2).
  it('answers a ping with a pong carrying the same seq', async () => {
    const h = await server()
    const got = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }, { t: 'ping', seq: 7 }], 2)
    expect(got[1]).toEqual({ t: 'pong', seq: 7 })
    expect(h.logs.some((l) => l.startsWith('unknown message'))).toBe(false)
  })

  // Protocol 4 (core/host/hostKey.ts): the client's nonce is answered with an HMAC of the profile's key,
  // which is how the app and `astera` tell this account's Host from a squatter on the address.
  it('answers a nonce with the proof of its key, and sends none for a hello without one', async () => {
    const key = 'c'.repeat(64)
    const h = await server({ hostKey: key })
    const [reply] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', nonce: 'ab12' }])
    expect((reply as { proof?: string }).proof).toBe(hostProof(key, 'ab12'))
    const [bare] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    expect((bare as { proof?: string }).proof).toBeUndefined()
  })

  it('answers a hello on another protocol with a mismatch, and does not hang up', async () => {
    const h = await server()
    const [reply] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL + 1, app: '1.0.0' }])
    expect(reply).toEqual({ t: 'protocol-mismatch', protocol: HOST_PROTOCOL })
  })

  it('answers a second client with the same identity', async () => {
    const h = await server()
    const [first] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    const [second] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    expect((first as { pid: number }).pid).toBe((second as { pid: number }).pid)
  })

  // Losing the race must not cost the winner its address: a second Host that unlinked the socket it
  // found would take a working Host offline.
  it('refuses to start when the address is already served, and leaves it working', async () => {
    const h = await server()
    await expect(
      startHostServer({
        address: h.address,
        dirToPrepare: null,
        version: '9.9.9',
        idleMs: 60_000,
        onIdle: () => {},
        log: { write: () => {}, close: () => {} }
      })
    ).rejects.toThrow(ADDRESS_TAKEN)
    const [reply] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    expect(reply).toMatchObject({ t: 'hello', host: '9.9.9' })
  })

  // Fix round I3: a Host that is leaving waits for its spawns in flight with the address still
  // bound, and an app replacing it must not reconnect to it in that time. It keeps the clients it has.
  it('stops accepting new clients, and keeps serving the ones it has', async () => {
    const h = await start()
    const app = await h.connect('app')
    h.s.stopAccepting()
    const refused = await new Promise<'refused' | 'answered' | 'hung'>((resolve) => {
      setTimeout(() => resolve('hung'), 2000)
      const sock = net.connect(h.address)
      const read = createLineReader({ onMessage: () => { sock.destroy(); resolve('answered') }, onBadLine: () => {}, onHandlerError: () => {} })
      sock.setEncoding('utf8')
      sock.on('data', read)
      sock.on('connect', () => sock.write(encodeLine({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' })))
      sock.on('error', () => resolve('refused'))
      sock.on('close', () => resolve('refused'))
    })
    expect(refused).toBe('refused')
    h.s.broadcast({ t: 'pty-data', id: 'p1', data: 'still here' })
    expect(await app.next()).toEqual({ t: 'pty-data', id: 'p1', data: 'still here' })
  })

  it('retire asks the caller to leave', async () => {
    let retired = false
    const h = await server({ onIdle: () => { retired = true } })
    await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }, { t: 'retire' }])
    await new Promise((r) => setTimeout(r, 200))
    expect(retired).toBe(true)
  })

  // 명세 §12: 사람이 요청한(reason: 'user') retire 는 일하는 것이 있으면 거절되고 그 수가 실린다.
  it('일하는 것이 있으면 사람의 retire 를 거절하고 수를 말한다', async () => {
    const h = await start({ liveCounts: () => ({ sessions: 2, runs: 1 }) })
    const client = await h.connect()
    client.send({ t: 'retire', reason: 'user' })
    const m = await client.next()
    expect(m).toEqual({ t: 'retire-refused', sessions: 2, runs: 1 })
    expect(h.stopped).toBe(false)
  })

  it('일하는 것이 없으면 사람의 retire 를 그대로 받아들인다', async () => {
    const h = await start({ liveCounts: () => ({ sessions: 0, runs: 0 }) })
    const client = await h.connect()
    client.send({ t: 'retire', reason: 'user' })
    await new Promise((r) => setTimeout(r, 100))
    expect(h.stopped).toBe(true)
  })

  // ruling 3: `reason` 이 없는(=`'protocol'`) retire 는 이 거절을 받지 않는다 — 앱이 프로토콜이
  // 다른 Host 를 찾았을 때 보내는 것이 이 경우이고, 그 Host 의 세션은 이미 그 앱에게 닿지 않는다.
  it('reason 이 없는(protocol) retire 는 일하는 것이 있어도 거절하지 않는다', async () => {
    const h = await start({ liveCounts: () => ({ sessions: 2, runs: 1 }) })
    const client = await h.connect()
    client.send({ t: 'retire' })
    await new Promise((r) => setTimeout(r, 100))
    expect(h.stopped).toBe(true)
  })

  // `close()` destroys the sockets it still holds, and each one's 'close' event arrives after
  // `close()` has returned. Without a guard that deferred event re-arms the idle timer and the Host
  // is told to leave a second time, on a server that has already gone.
  it('does not ask to leave again when it is closed with a client still connected', async () => {
    let asked = 0
    const h = await server({ idleMs: 50, onIdle: () => { asked += 1 } })
    await new Promise<void>((resolve) => {
      const sock = net.connect(h.address)
      sock.setEncoding('utf8')
      sock.on('connect', () => {
        sock.write(encodeLine({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }))
        sock.write(encodeLine({ t: 'retire' }))
        resolve()
      })
    })
    await new Promise((r) => setTimeout(r, 100))
    expect(asked).toBe(1)
    await h.s.close()
    await new Promise((r) => setTimeout(r, 300))
    expect(asked).toBe(1)
    await expect(h.s.close()).resolves.toBeUndefined()
  })

  // The idle timer is injected rather than waited out: a test that sleeps sixty seconds is a test
  // nobody runs.
  it('calls back when nobody has been connected for the idle time', async () => {
    let idle = false
    const h = await server({ idleMs: 50, onIdle: () => { idle = true } })
    await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    await new Promise((r) => setTimeout(r, 300))
    expect(idle).toBe(true)
    expect(h.s.clients()).toBe(0)
  })

  // A peer that connects and never speaks holds the live count above zero for good, which defeats the
  // idle shutdown — slice 1's only lifecycle rule. The deadline is injected for the same reason the
  // idle time is.
  it('drops a connection that never says hello', async () => {
    const h = await server({ helloMs: 60 })
    const closed = await new Promise<boolean>((resolve) => {
      const sock = net.connect(h.address)
      sock.on('close', () => resolve(true))
      setTimeout(() => {
        sock.destroy()
        resolve(false)
      }, 3000)
    })
    expect(closed).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(h.s.clients()).toBe(0)
    expect(h.logs.some((l) => l.includes('did not say hello'))).toBe(true)
  })

  it('leaves a connection alone once it has said hello', async () => {
    const h = await server({ helloMs: 60 })
    const [reply] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    expect(reply).toMatchObject({ t: 'hello' })
    // Well past the deadline: the handshake happened, so nothing should have dropped it.
    await new Promise((r) => setTimeout(r, 200))
    expect(h.logs.some((l) => l.includes('did not say hello'))).toBe(false)
  })

  // **Measured on win32, 2026-09-21**: a pipe created the way this server creates one carries the
  // default security descriptor, and that grants FILE_GENERIC_READ to Everyone and to ANONYMOUS
  // LOGON — `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)(A;;FR;;;WD)(A;;FR;;;AN)`. So any local user
  // can open the address and be handed a socket. They cannot write, so they can never say hello, and
  // what the Host broadcasts is every terminal's output. Nothing may go to a peer that has not
  // completed the handshake.
  it('does not broadcast to a peer that has not said hello', async () => {
    // Well past the length of this test, so what keeps the peer from hearing anything is the
    // broadcast rule and not the handshake deadline hanging up on it first.
    const h = await server({ helloMs: 60_000 })
    const got: unknown[] = []
    const sock = net.connect(h.address)
    const read = createLineReader({ onMessage: (v) => got.push(v), onBadLine: () => {}, onHandlerError: () => {} })
    sock.setEncoding('utf8')
    sock.on('data', read)
    await new Promise<void>((resolve) => sock.on('connect', () => resolve()))
    // The client's own `connect` fires before the server has necessarily run its connection handler,
    // and a broadcast sent in that gap goes out to an empty set — which makes this pass for a reason
    // that has nothing to do with the rule under test. Wait for the server to have the peer.
    for (let i = 0; i < 100 && h.s.clients() === 0; i++) await new Promise((r) => setTimeout(r, 10))
    expect(h.s.clients()).toBe(1)
    h.s.broadcast({ t: 'pty-data', id: 'p1', data: 'what somebody else is typing' })
    await new Promise((r) => setTimeout(r, 100))
    sock.destroy()
    expect(got).toEqual([])
  })

  // The other half of the rule above: filtering must not become "broadcast to nobody".
  it('broadcasts to a peer that has said hello', async () => {
    const h = await server()
    const got: unknown[] = []
    const sock = net.connect(h.address)
    const read = createLineReader({ onMessage: (v) => got.push(v), onBadLine: () => {}, onHandlerError: () => {} })
    sock.setEncoding('utf8')
    sock.on('data', read)
    await new Promise<void>((resolve) => sock.on('connect', () => resolve()))
    sock.write(encodeLine({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }))
    // The handshake has to be answered before the broadcast goes out, or a pass here proves nothing.
    await new Promise((r) => setTimeout(r, 100))
    expect(got).toHaveLength(1)
    h.s.broadcast({ t: 'pty-data', id: 'p1', data: 'output' })
    await new Promise((r) => setTimeout(r, 100))
    sock.destroy()
    expect(got[1]).toEqual({ t: 'pty-data', id: 'p1', data: 'output' })
  })

  // A client on another protocol is told so and nothing else. The same rule the address's version
  // suffix exists for (core/host/protocol.ts): an app that cannot speak this protocol must not be
  // handed this protocol's messages.
  it('does not broadcast to a client that answered with the wrong protocol', async () => {
    const h = await server({ helloMs: 60_000 })
    const got: unknown[] = []
    const sock = net.connect(h.address)
    const read = createLineReader({ onMessage: (v) => got.push(v), onBadLine: () => {}, onHandlerError: () => {} })
    sock.setEncoding('utf8')
    sock.on('data', read)
    await new Promise<void>((resolve) => sock.on('connect', () => resolve()))
    sock.write(encodeLine({ t: 'hello', protocol: HOST_PROTOCOL + 1, app: '1.0.0' }))
    await new Promise((r) => setTimeout(r, 100))
    expect(got).toEqual([{ t: 'protocol-mismatch', protocol: HOST_PROTOCOL }])
    h.s.broadcast({ t: 'pty-data', id: 'p1', data: 'output' })
    await new Promise((r) => setTimeout(r, 100))
    sock.destroy()
    expect(got).toHaveLength(1)
  })

  it('a line that is not JSON is logged and the connection survives it', async () => {
    const h = await server()
    const got = await new Promise<unknown[]>((resolve) => {
      const out: unknown[] = []
      const sock = net.connect(h.address)
      const read = createLineReader({ onMessage: (v) => { out.push(v); sock.end(); resolve(out) }, onBadLine: () => {}, onHandlerError: () => {} })
      sock.setEncoding('utf8')
      sock.on('data', read)
      sock.on('connect', () => {
        sock.write('not json\n')
        sock.write(encodeLine({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }))
      })
      setTimeout(() => { sock.destroy(); resolve(out) }, 3000)
    })
    expect(got).toHaveLength(1)
    expect(h.logs.some((l) => l.includes('not json'))).toBe(true)
  })

  // The server owns the handshake and nothing else; anything it does not recognise goes to the hook,
  // which is where slice 2's pty messages live.
  it('offers an unknown message to the extra handler before calling it unknown', async () => {
    const seen: string[] = []
    const h = await server({
      onMessage: (m, send) => {
        seen.push(m.t)
        if (m.t !== 'pty-list') return false
        send({ t: 'pty-listed', entries: [] })
        return true
      }
    })
    // After a hello: a socket that has not said one reaches no handler at all (Phase 0, `hardening` below).
    const [, reply] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'cli' }, { t: 'pty-list' } as never], 2)
    expect(reply).toEqual({ t: 'pty-listed', entries: [] })
    expect(seen).toContain('pty-list')
  })

  // MCP design §2: a socket that said role 'mcp' may send hello, ping and orch-call, and nothing else.
  // Remote runtime Phase 0 (design §5.1, N12 as amended): the Host's own holes, closed before any of it
  // is reachable from a network.
  describe('hardening', () => {
    it('hands nothing from a socket that has not said hello to onMessage, while a greeted one still reaches it', async () => {
      const seen: string[] = []
      const h = await start({ onMessage: (m) => { seen.push(m.t); return true } })
      const silent = await h.connectSilent()
      silent.write(encodeLine({ t: 'pty-list' }) + encodeLine({ t: 'proc-list' }) + encodeLine({ t: 'pty-write', id: 'p', data: 'x' }))
      await new Promise((r) => setTimeout(r, 150))
      expect(seen).toEqual([])
      const cli = await h.connect('cli')
      cli.send({ t: 'pty-list' } as never)
      await new Promise((r) => setTimeout(r, 150))
      expect(seen).toEqual(['pty-list'])
      silent.destroy()
    })

    // An MCP socket that says hello again as the app would be sent orch-act and count as attached.
    it('keeps a socket at the role its first hello named', async () => {
      const seen: string[] = []
      const h = await start({ onMessage: (m) => { seen.push(m.t); return true } })
      const mcp = await h.connect('mcp')
      mcp.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'app' })
      expect(await mcp.next(300)).toBeUndefined()
      expect(h.s.hasApp()).toBe(false)
      mcp.send({ t: 'pty-list' } as never)
      await new Promise((r) => setTimeout(r, 150))
      expect(seen).toEqual([])
    })
    it('answers a second hello that names the same role, as before', async () => {
      const h = await start()
      const cli = await h.connect('cli')
      cli.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'cli' })
      expect(await cli.next()).toMatchObject({ t: 'hello', protocol: HOST_PROTOCOL })
    })

    // X1-10 measured a whole-state `state-put` of 9,005,354 bytes on a real profile; the default cap must
    // let one through, which is why it is 64 MiB and not the 8 MiB first proposed.
    it('reads a 9 MB line under the default cap, as a large profile sends', async () => {
      const sizes: number[] = []
      const h = await start({ onMessage: (m) => { sizes.push(JSON.stringify(m).length); return true } })
      const cli = await h.connect('cli')
      cli.send({ t: 'blocks', records: {}, cleared: [], pad: 'x'.repeat(9_100_000) } as never)
      await vi.waitFor(() => expect(sizes).toHaveLength(1), { timeout: 5000 })
      expect(sizes[0]).toBeGreaterThan(9_000_000)
      expect(cli.socket.destroyed).toBe(false)
    })

    it('closes a connection whose line runs past the inbound cap', async () => {
      const h = await server({ maxLine: 64 })
      const sock = net.connect(h.address)
      await new Promise((r) => sock.once('connect', r))
      const closed = new Promise((r) => sock.once('close', r))
      sock.write('x'.repeat(65))
      await closed
      expect(h.logs.some((l) => l.includes('past the inbound cap'))).toBe(true)
    })
  })

  describe('an MCP socket reaches only hello, ping and orch-call', () => {
    it("its retire does not stop the Host", async () => {
      const h = await start({ liveCounts: () => ({ sessions: 0, runs: 0 }) })
      const client = await h.connect('mcp')
      client.send({ t: 'retire' })
      await new Promise((r) => setTimeout(r, 150))
      expect(h.stopped).toBe(false)
    })
    it('its pty message is not handed to onMessage, while a cli socket still reaches it', async () => {
      const seen: string[] = []
      const h = await start({ onMessage: (m) => { seen.push(m.t); return true } })
      const mcp = await h.connect('mcp')
      mcp.send({ t: 'pty-list' } as never)
      await new Promise((r) => setTimeout(r, 150))
      expect(seen).toEqual([])
      const cli = await h.connect('cli')
      cli.send({ t: 'pty-list' } as never)
      await new Promise((r) => setTimeout(r, 150))
      expect(seen).toEqual(['pty-list'])
    })
    it('still answers its ping', async () => {
      const h = await start()
      const mcp = await h.connect('mcp')
      mcp.send({ t: 'ping', seq: 7 })
      expect(await mcp.next()).toEqual({ t: 'pong', seq: 7 })
    })
    // An MCP link lives for hours; it reads nothing pushed, so it is sent no terminal output and no state.
    it('is sent no broadcast, while a cli socket is', async () => {
      const h = await start()
      const mcp = await h.connect('mcp')
      const cli = await h.connect('cli')
      h.s.broadcast({ t: 'pty-data', id: 'p1', data: 'a terminal line' })
      expect(await cli.next()).toEqual({ t: 'pty-data', id: 'p1', data: 'a terminal line' })
      expect(await mcp.next(150)).toBeUndefined()
    })
    it("is sent no other caller's state push, and still gets its own orch-result", async () => {
      const h = await start({
        orch: {
          call: async ({ from }) => {
            from?.toOthers({ t: 'pty-data', id: 'p1', data: 'pushed to the others' })
            return { status: 200, body: { ok: true } }
          }
        }
      })
      const mcp = await h.connect('mcp')
      const cli = await h.connect('cli')
      cli.send({ t: 'orch-call', call: 'c1', cmd: 'version', args: {} })
      expect(await cli.next()).toMatchObject({ t: 'orch-result', call: 'c1', status: 200 })
      expect(await mcp.next(150)).toBeUndefined()
      mcp.send({ t: 'orch-call', call: 'c2', cmd: 'version', args: {} })
      expect(await mcp.next()).toMatchObject({ t: 'orch-result', call: 'c2', status: 200 })
      expect(await cli.next()).toEqual({ t: 'pty-data', id: 'p1', data: 'pushed to the others' })
    })
  })

  // A Host holding a terminal must not leave when the app closes: that terminal is the whole reason
  // the Host exists (slice 2 design §2.2).
  it('does not leave on the idle timer while something is holding it', async () => {
    let idle = false
    let holding = true
    const h = await server({
      idleMs: 50,
      onIdle: () => { idle = true },
      liveCounts: () => ({ sessions: holding ? 1 : 0, runs: 0 })
    })
    await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    await new Promise((r) => setTimeout(r, 300))
    expect(idle).toBe(false)
    holding = false
    await new Promise((r) => setTimeout(r, 300))
    expect(idle).toBe(true)
  })

  // Conformance audit #100: a Host `astera host start` started left after 60s with a run in flight,
  // and the next write command exited 3. The idle timer now asks the question `host stop`'s refusal
  // asks (`liveCounts`), so the two cannot disagree about whether this Host holds work.
  it('does not leave on the idle timer while a run is in flight, even with no session', async () => {
    let idle = false
    let runs = 1
    const h = await server({
      idleMs: 50,
      onIdle: () => { idle = true },
      liveCounts: () => ({ sessions: 0, runs })
    })
    await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    await new Promise((r) => setTimeout(r, 300))
    expect(idle).toBe(false)
    runs = 0
    await new Promise((r) => setTimeout(r, 300))
    expect(idle).toBe(true)
  })

  // Advertising a feature and being able to serve it must be the same fact. `server()`'s default
  // always supplies a working `orch`, which is right for the orch-call tests below but would hide
  // this one — so this test goes straight to `startHostServer`, the way the address-taken and
  // socket-file tests already do, with no `orch` in its deps at all.
  it('orch 를 안 준 서버는 features 에 orch 를 넣지 않는다', async () => {
    const addr = hostAddress({
      profileDir: path.join(dir, 'no-orch'),
      platform: process.platform,
      tmpDir: dir,
      protocol: HOST_PROTOCOL
    })
    const s = await startHostServer({
      address: addr.address,
      dirToPrepare: addr.dirToPrepare,
      version: '9.9.9',
      idleMs: 60_000,
      onIdle: () => {},
      log: { write: () => {}, close: () => {} }
    })
    open.push(s)
    const [reply] = await talk(addr.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    expect((reply as { features: string[] }).features).not.toContain('orch')
    // 영수증도 같은 사실을 탄다 — 명령에 답하지 못하는 Host 는 그 명령을 답했다는 기록도 쥘 수 없다.
    // 이것을 무조건 알리면, 부르는 쪽은 아무도 답하지 않을 호출이 보호받는다고 믿는다.
    expect((reply as { features: string[] }).features).not.toContain('requests')
  })

  it('announces the mcp feature when it answers orch-call', async () => {
    const h = await server()
    const [reply] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'cli' }])
    expect((reply as { features: string[] }).features).toContain('mcp')
  })

  it('hands an mcp hello to the command layer as role mcp', async () => {
    const roles: (string | undefined)[] = []
    const base = versionOnlyOrchCall({ version: '9.9.9' })
    const h = await start({
      orch: {
        ...base,
        call: async (c) => {
          roles.push(c.from?.role)
          return base.call(c)
        }
      }
    })
    const client = await h.connect('mcp')
    client.send({ t: 'orch-call', call: 'c1', cmd: 'version', args: {} })
    await client.next()
    expect(roles).toEqual(['mcp'])
  })

  // MCP spec §29: the client an MCP hello names reaches the command layer, cleaned again here (the
  // wire is not trusted), and only from an mcp socket.
  it("hands an mcp hello's client to the command layer, cleaned, and no client from a cli hello", async () => {
    const clients: unknown[] = []
    const base = versionOnlyOrchCall({ version: '9.9.9' })
    const h = await start({
      orch: {
        ...base,
        call: async (c) => {
          clients.push(c.from?.client)
          return base.call(c)
        }
      }
    })
    const hello = async (extra: Record<string, unknown>): Promise<{ send(m: ClientMessage): void; next(waitMs?: number): Promise<unknown> }> => {
      const sock = await h.connectSilent()
      const chan = messageChannel(sock)
      chan.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', ...extra } as ClientMessage)
      await chan.next()
      return chan
    }
    const named = await hello({ role: 'mcp', client: { name: 'claude-code\n<x>', version: '1.2.3', extra: 'dropped' } })
    named.send({ t: 'orch-call', call: 'c1', cmd: 'version', args: {} })
    await named.next()
    const junk = await hello({ role: 'mcp', client: { name: 7 } })
    junk.send({ t: 'orch-call', call: 'c2', cmd: 'version', args: {} })
    await junk.next()
    const cli = await hello({ role: 'cli', client: { name: 'claude-code' } })
    cli.send({ t: 'orch-call', call: 'c3', cmd: 'version', args: {} })
    await cli.next()
    expect(clients).toEqual([{ name: 'claude-codex', version: '1.2.3' }, undefined, undefined])
  })

  // MCP HTTP design §5: the HTTP caller's address an mcp hello carries reaches the command layer, cleaned,
  // and only from an mcp socket.
  it("hands an mcp hello's remote to the command layer, and no remote from a cli hello or a stdio mcp hello", async () => {
    const remotes: unknown[] = []
    const base = versionOnlyOrchCall({ version: '9.9.9' })
    const h = await start({
      orch: {
        ...base,
        call: async (c) => {
          remotes.push(c.from?.remote)
          return base.call(c)
        }
      }
    })
    const call = async (extra: Record<string, unknown>, id: string): Promise<void> => {
      const sock = await h.connectSilent()
      const chan = messageChannel(sock)
      chan.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', ...extra } as ClientMessage)
      await chan.next()
      chan.send({ t: 'orch-call', call: id, cmd: 'version', args: {} })
      await chan.next()
    }
    await call({ role: 'mcp', client: { name: 'c' }, remote: '192.168.0.7\n' }, 'c1')
    await call({ role: 'mcp', client: { name: 'c' } }, 'c2')
    await call({ role: 'cli', remote: '192.168.0.7' }, 'c3')
    expect(remotes).toEqual(['192.168.0.7', undefined, undefined])
  })

  it('announces the extra features it was given, after the built-in ones', async () => {
    const h = await server({ features: ['spawn'] })
    const [reply] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    expect((reply as { features: string[] }).features).toEqual(['proc', 'ping', 'orch', 'requests', 'mcp', 'spawn'])
  })
  // MCP HTTP §3 (Ruling 2): the hello of a Host built as index.ts builds it tells the app it answers mcp-http-*.
  // One Host per test (one address); features.test.ts covers the spawner half.
  it('announces mcp-http in the hello of a Host without a spawner', async () => {
    const h = await server({ features: hostFeatures({ spawns: false }) })
    const [reply] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'app' }])
    expect((reply as { features: string[] }).features).toContain('mcp-http')
  })
  it('tells onMessage which client sent it, by role and a per-connection number', async () => {
    const seen: Array<{ t: string; role: string; socket: number }> = []
    const h = await start({ onMessage: (m, _send, from) => { seen.push({ t: m.t, ...from }); return true } })
    const app = await h.connect('app'); const cli = await h.connect('cli')
    app.send({ t: 'pty-list' }); cli.send({ t: 'pty-list' })
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen.map((x) => x.role).sort()).toEqual(['app', 'cli'])
    expect(seen[0].socket).not.toBe(seen[1].socket)
  })
  it('tells onClientGone when a greeted client closes, with its role', async () => {
    const gone: Array<{ role: string }> = []
    const h = await start({ onClientGone: (from) => gone.push(from) })
    const app = await h.connect('app')
    app.socket.end()
    await vi.waitFor(() => expect(gone).toEqual([expect.objectContaining({ role: 'app' })]))
  })
  // I2: the hook runs inside the socket's 'close' event. A throw there is uncaught and ends the Host,
  // and even caught it would skip the idle arming that follows it.
  it('survives an onClientGone that throws, and still arms the idle timer', async () => {
    let idled = false
    const h = await server({
      idleMs: 50,
      onIdle: () => { idled = true },
      onClientGone: () => { throw new Error('hook broke') }
    })
    await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    await vi.waitFor(() => expect(idled).toBe(true))
    expect(h.logs.some((l) => l.includes('hook broke'))).toBe(true)
    const [reply] = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    expect(reply).toMatchObject({ t: 'hello' })
  })
  it('does not report a peer that never said hello', async () => {
    const gone: unknown[] = []
    const h = await start({ onClientGone: (from) => gone.push(from) })
    const silent = await h.connectSilent(); silent.end()
    await new Promise((r) => setTimeout(r, 100))
    expect(gone).toEqual([])
  })

  describe('orch-call', () => {
    it('orch-call 에 그 call 로 답한다', async () => {
      const h = await start({})
      const client = await h.connect()
      client.send({ t: 'orch-call', call: 'c1', cmd: 'version', args: {} })
      expect(await client.next()).toEqual({
        t: 'orch-result',
        call: 'c1',
        status: 200,
        body: { version: h.version, protocol: HOST_PROTOCOL }
      })
    })

    // 두 호출이 겹쳐도 각자 제 call 로 돌아와야 한다 — 소켓 하나에 여러 요청이 오간다.
    it('겹친 호출이 섞이지 않는다', async () => {
      const h = await start({})
      const client = await h.connect()
      client.send({ t: 'orch-call', call: 'a', cmd: 'version', args: {} })
      client.send({ t: 'orch-call', call: 'b', cmd: 'version', args: {} })
      const got = [await client.next(), await client.next()]
      expect(got.map((m) => (m as { call: string }).call).sort()).toEqual(['a', 'b'])
    })

    // hello 를 안 한 소켓은 아무것도 못 듣는다(설계 §9) — orch 응답도 마찬가지다. 이 성질이 win32
    // 파이프의 열린 ACL 을 대신한다. 여기 쓰는 orch 스텁은 진짜로 응답을 만들어내므로(server()의
    // 기본값), greeted 체크가 옮겨지거나 지워지면 이 테스트는 조용히 통과하는 대신 시끄럽게 실패한다
    // — got[0] 이 undefined 아닌 실제 orch-result 가 되어 toBeUndefined() 가 깨진다.
    it('인사 안 한 소켓은 orch 답도 못 받는다', async () => {
      const h = await start({})
      const raw = await h.connectSilent() // hello 를 보내지 않는다
      const chan = messageChannel(raw)
      chan.send({ t: 'orch-call', call: 'c1', cmd: 'version', args: {} })
      expect(await chan.next(300)).toBeUndefined()
    })

    /**
     * **`requests show` 를 Host 가 정말로 답한다**(요청 영수증 설계 §13 단계 4). 아직 CLI 쪽 표면이
     * 없으므로, 그 명령이 도는지를 증명할 수 있는 곳은 여기 — 진짜 `orch-call` 이 지나가는 그 길 —
     * 뿐이다. 이 묶음의 다른 시험들이 쓰는 version 스텁으로는 501 이 나온다.
     *
     * **그리고 hostStartedAt 이 hello 의 그것과 같은 문자열인지가 여기서만 증명된다.** 설계가 이
     * 값을 싣는 이유가 "보낸 때보다 이 Host 가 늦게 섰다면 그 요청은 여기 온 적이 없다" 이고,
     * 호출자가 견줄 값은 악수에서 받은 그 값이다(§6). Host 가 제 시계로 따로 하나를 만들었다면 한
     * 질문에 답이 둘이 되고, 그 비교는 조용히 뜻을 잃는다.
     */
    it('requests-show 를 진짜 명령 층이 답하고, hostStartedAt 은 hello 의 그것이다', async () => {
      // `host/index.ts` 가 하는 그대로다 — orch 는 서버보다 먼저 만들어지고, 물어볼 때는 이미 있다.
      let live: HostServer | null = null
      const orch = createHostOrch({
        profileDir: path.join(dir, 'orch-profile'),
        version: '9.9.9',
        now: () => '2026-09-23T00:00:00.000Z',
        hostStartedAt: () => live!.startedAt,
        runningSessions: () => 0,
        aliveSessionIds: () => new Set<string>(),
        act: async () => ({}),
        hasApp: () => false,
        onState: () => {},
        log: () => {},
        sessions: { listSessions: async () => [], readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }), sendSession: async () => {}, readChat: async () => [], sendChat: async () => {}, serial: (_id, run) => run() }
      })
      const h = await start({ orch })
      live = h.s
      // connect() 는 hello 답을 삼킨다 — 여기서는 그 답 자체가 판정의 절반이므로 직접 인사한다.
      const chan = messageChannel(await h.connectSilent())
      chan.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' })
      const hello = (await chan.next()) as { startedAt: string }
      chan.send({ t: 'orch-call', call: 'c1', cmd: 'requests-show', args: { id: 'req-1' }, session: 'sesA' })
      const got = (await chan.next()) as {
        t: string
        call: string
        status: number
        body: { state: string; hostStartedAt: string; interpretation: string }
      }
      expect(got).toMatchObject({ t: 'orch-result', call: 'c1', status: 200 })
      expect(got.body.state).toBe('absent')
      expect(got.body.hostStartedAt, '악수가 말한 시각과 다른 시각을 답했다').toBe(hello.startedAt)
      expect(got.body.interpretation).toContain('not proof that nothing happened')
    })
  })

  // 설계 §5: Host 가 못 하는 일은 앱에 맡긴다. 누가 앱인지는 hello 의 role 이 말한다 — `app` 칸은
  // 양쪽 다 버전 문자열이라 구별에 쓸 수 없다(F12).
  describe('orch-act', () => {
    it('앱에게 묻고 그 답을 돌려준다', async () => {
      const h = await start({})
      const app = await h.connect('app')
      const answer = h.s.act('startWorker', { dispatchId: 'd1' })
      const asked = (await app.next()) as { t: string; call: string; act: string; args: unknown }
      expect(asked).toMatchObject({ t: 'orch-act', act: 'startWorker', args: { dispatchId: 'd1' } })
      app.send({ t: 'orch-acted', call: asked.call, ok: true, value: { sessionId: 's1' } })
      expect(await answer).toEqual({ sessionId: 's1' })
    })

    it('앱이 실패로 답하면 그 이유로 거절한다', async () => {
      const h = await start({})
      const app = await h.connect('app')
      const answer = h.s.act('startWorker', {})
      const asked = (await app.next()) as { call: string }
      app.send({ t: 'orch-acted', call: asked.call, ok: false, error: 'no account' })
      await expect(answer).rejects.toThrow(/no account/)
    })

    // 남은 한계 Task 5: role 없는 hello 는 옛 앱(1.3.25 이하)이다. 출시된 앱은 모두 role 도 yields 도
    // 보내지 않고, Host 에 말을 거는 CLI 는 그 뒤에 나왔다. 그 앱은 제 일을 모두 제가 하므로 hasApp 과
    // appsKeep 에 들어간다(S6-6, SL-11). 그러나 orch-act 는 답할 줄 모르니 보내지 않고 APP_REQUIRED 로
    // 거절한다(F12) — 부른 쪽이 영영 기다리지 않게.
    it('role 을 안 밝힌 클라이언트는 옛 앱이다: 앱으로 세되 orch-act 는 보내지 않는다', async () => {
      const changed: boolean[] = []
      const roles: string[] = []
      const h = await server({
        onAppsChanged: () => changed.push(h.s.hasApp()),
        // 옛 앱의 메시지는 cli 로 간다: 앱만 보낼 수 있는 문(state-put 등)은 그 앱에게 닫혀 있다.
        onMessage: (m, _send, from) => {
          if (m.t === 'pty-list') roles.push(from.role)
          return m.t === 'pty-list'
        }
      })
      const sock = net.connect(h.address)
      await new Promise((r) => sock.once('connect', r))
      const old = messageChannel(sock)
      old.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.3.25' })
      expect(await old.next()).toMatchObject({ t: 'hello' })
      expect(h.s.hasApp()).toBe(true)
      expect(h.s.appsKeep('slack')).toBe(true)
      expect(h.s.appsKeep('dispatch')).toBe(true)
      expect(h.s.appKeeps('worktrees')).toBe(true)
      expect(h.s.hasCurrentApp()).toBe(false)
      const err = await h.s.act('startWorker', {}).catch((e: Error) => e)
      expect(err).toBeInstanceOf(AppUnreachable)
      expect(String(err)).toMatch(/APP_REQUIRED/)
      expect(String(err)).toMatch(/1\.3\.25 or older/)
      expect(await old.next(200), '옛 앱에게 orch-act 가 나갔다').toBeUndefined()
      expect(h.logs.filter((l) => l.includes('Astera 1.3.25 or older is attached; update it'))).toHaveLength(1)
      old.send({ t: 'pty-list' })
      await vi.waitFor(() => expect(roles).toEqual(['cli']))
      sock.end()
      await vi.waitFor(() => expect(h.s.hasApp()).toBe(false))
      expect(changed).toEqual([true, false])
    })

    it('옛 앱과 새 앱이 함께 붙으면 orch-act 는 새 앱에게 가고, 옛 앱은 여전히 모든 일을 쥔다', async () => {
      const h = await start({})
      await h.connect() // role 없이: 옛 앱
      const app = await h.connect('app')
      expect(h.s.hasCurrentApp()).toBe(true)
      expect(h.s.appKeeps('worktrees')).toBe(true)
      const answer = h.s.act('startWorker', {})
      const asked = (await app.next()) as { t: string; call: string }
      expect(asked.t).toBe('orch-act')
      app.send({ t: 'orch-acted', call: asked.call, ok: true, value: 1 })
      expect(await answer).toBe(1)
    })

    it('옛 앱이 붙어 있는 동안 hello 답이 그것을 말한다 (astera host status)', async () => {
      const h = await start({})
      const before = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'cli' }])
      expect(before[0]).not.toHaveProperty('legacyApp')
      const old = await h.connect()
      const during = await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'cli' }])
      expect(during[0]).toMatchObject({ t: 'hello', legacyApp: true })
      old.socket.end()
      await vi.waitFor(() => expect(h.s.hasApp()).toBe(false))
    })

    it('CLI 는 옛 앱이 아니다', async () => {
      const h = await start({})
      await h.connect('cli')
      expect(h.s.hasApp()).toBe(false)
      await expect(h.s.act('startWorker', {})).rejects.toThrow(/APP_REQUIRED: startWorker needs the Astera app running/)
    })

    it('앱이 붙어 있으면 hasApp 이 참이다', async () => {
      const h = await start({})
      expect(h.s.hasApp()).toBe(false)
      await h.connect('app')
      expect(h.s.hasApp()).toBe(true)
    })

    it('says an attached app keeps a duty it did not yield, and not one it did (ruling R4)', async () => {
      const h = await server()
      expect(h.s.appKeeps('worktrees')).toBe(false) // no app at all: nothing is kept
      const hello = async (extra: Record<string, unknown>): Promise<net.Socket> => {
        const sock = net.connect(h.address)
        await new Promise((r) => sock.once('connect', r))
        const ch = messageChannel(sock)
        ch.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'app', ...extra } as ClientMessage)
        await ch.next()
        return sock
      }
      const old = await hello({}) // an S2 app: yields nothing
      expect(h.s.appKeeps('worktrees')).toBe(true)
      old.end()
      await vi.waitFor(() => expect(h.s.hasApp()).toBe(false))
      const fresh = await hello({ yields: ['worktrees', 42] }) // junk entries are ignored
      expect(h.s.appKeeps('worktrees')).toBe(false)
      expect(h.s.appKeeps('dispatch')).toBe(true)
      fresh.end()
    })

    // Final review M4: a push only an app that yields a duty can read goes to those apps alone.
    it('broadcasts with a yields filter only to the greeted sockets that pass it', async () => {
      const h = await server()
      const hello = async (yields: string[]) => {
        const sock = net.connect(h.address)
        await new Promise((r) => sock.once('connect', r))
        const ch = messageChannel(sock)
        ch.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'app', yields } as ClientMessage)
        await ch.next()
        return { sock, ch }
      }
      const fresh = await hello(['rolling', 'chat-takeover'])
      const older = await hello(['rolling'])
      h.s.broadcast({ t: 'pty-data', id: 'p1', data: 'chat only' }, (y) => y.has('chat-takeover'))
      h.s.broadcast({ t: 'pty-data', id: 'p1', data: 'everyone' })
      expect(await fresh.ch.next()).toEqual({ t: 'pty-data', id: 'p1', data: 'chat only' })
      expect(await fresh.ch.next()).toEqual({ t: 'pty-data', id: 'p1', data: 'everyone' })
      expect(await older.ch.next()).toEqual({ t: 'pty-data', id: 'p1', data: 'everyone' })
      fresh.sock.end()
      older.sock.end()
    })

    it('answers what a greeted socket yielded, by its number, and null once it is gone (S6 R1)', async () => {
      const seen: number[] = []
      const h = await server({
        onMessage: (m, _send, from) => {
          if (m.t === 'pty-list') seen.push(from.socket)
          return false
        }
      })
      const sock = net.connect(h.address)
      await new Promise((r) => sock.once('connect', r))
      const ch = messageChannel(sock)
      ch.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'app', yields: ['worktrees', 'rolling', 3] } as ClientMessage)
      await ch.next()
      ch.send({ t: 'pty-list' })
      await vi.waitFor(() => expect(seen).toHaveLength(1))
      expect([...(h.s.yieldsOf(seen[0]) ?? [])].sort()).toEqual(['rolling', 'worktrees'])
      expect(h.s.yieldsOf(seen[0] + 1000)).toBeNull()
      sock.end()
      await vi.waitFor(() => expect(h.s.yieldsOf(seen[0])).toBeNull())
    })

    // Leftovers Task 1 (S6-3): the app's pid from its hello, kept after its socket closes so the app-gone
    // rule can still ask whether that process lives when app.pid could not be written.
    it('keeps the last pid an app gave in its hello, past its close, and ignores a CLI or a junk pid', async () => {
      const h = await server()
      const hello = async (m: Record<string, unknown>) => {
        const sock = net.connect(h.address)
        await new Promise((r) => sock.once('connect', r))
        const ch = messageChannel(sock)
        ch.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', ...m } as ClientMessage)
        await ch.next()
        return sock
      }
      expect(h.s.lastAppPid()).toBeNull()
      const old = await hello({ role: 'app' }) // an app from before this field: nothing to keep
      expect(h.s.lastAppPid()).toBeNull()
      const a = await hello({ role: 'app', pid: 4242 })
      expect(h.s.lastAppPid()).toBe(4242)
      const cli = await hello({ role: 'cli', pid: 777 })
      const junk = await hello({ role: 'app', pid: -3 })
      const junk2 = await hello({ role: 'app', pid: '5' })
      expect(h.s.lastAppPid()).toBe(4242)
      a.end()
      await vi.waitFor(() => expect(h.s.hasApp()).toBe(true)) // the old app is still there
      old.end()
      junk.end()
      junk2.end()
      await vi.waitFor(() => expect(h.s.hasApp()).toBe(false))
      expect(h.s.lastAppPid()).toBe(4242)
      cli.end()
    })

    // Final review I1: a clean quit leaves no app.pid, and Windows can hand the kept pid to another
    // process later. The first probe that finds it dead forgets it for good.
    it('forgets the last app pid once a probe finds it dead, and a later live process under it does not bring it back', async () => {
      const lives = { value: true }
      const h = await server({ pidLives: () => lives.value })
      const sock = net.connect(h.address)
      await new Promise((r) => sock.once('connect', r))
      const ch = messageChannel(sock)
      ch.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'app', pid: 4242 } as ClientMessage)
      await ch.next()
      sock.destroy()
      await vi.waitFor(() => expect(h.s.hasApp()).toBe(false))
      expect(h.s.lastAppPid()).toBe(4242)
      lives.value = false
      expect(h.s.lastAppPid()).toBeNull()
      lives.value = true // an unrelated process now holds 4242
      expect(h.s.lastAppPid()).toBeNull()
    })

    // Controller ruling on I1: a close forgets nothing. An app that gave up on a stalled Host closes
    // cleanly and lives on, and with no app.pid its hello pid is all that says it is there.
    it('keeps the last app pid through a clean close while the app process is still alive', async () => {
      const h = await server({ pidLives: () => true })
      const sock = net.connect(h.address)
      await new Promise((r) => sock.once('connect', r))
      const ch = messageChannel(sock)
      ch.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'app', pid: 4242 } as ClientMessage)
      await ch.next()
      sock.end()
      await vi.waitFor(() => expect(h.s.clients()).toBe(0))
      expect(h.s.lastAppPid()).toBe(4242)
    })

    // Review of Task 1 told onMessage whether the sender had said hello. Since Phase 0 a socket that has
    // not reaches onMessage not at all, so what it is told is always yes.
    it('hands onMessage only what a greeted socket sent, and says so', async () => {
      const seen: boolean[] = []
      const h = await server({
        onMessage: (m, _send, from) => {
          if (m.t === 'pty-list') seen.push(from.greeted)
          return false
        }
      })
      const sock = net.connect(h.address)
      await new Promise((r) => sock.once('connect', r))
      const ch = messageChannel(sock)
      ch.send({ t: 'pty-list' })
      await new Promise((r) => setTimeout(r, 150))
      expect(seen).toEqual([])
      ch.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'app' } as ClientMessage)
      await ch.next()
      ch.send({ t: 'pty-list' })
      await vi.waitFor(() => expect(seen).toHaveLength(1))
      expect(seen).toEqual([true])
      sock.end()
    })

    it('forgets a socket by its number when it closes, greeted or not (S6 R1, review of Task 1)', async () => {
      const h = await server()
      expect(h.s.knownSockets()).toBe(0)
      const greetedSock = net.connect(h.address)
      await new Promise((r) => greetedSock.once('connect', r))
      const ch = messageChannel(greetedSock)
      ch.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'app', yields: ['rolling'] } as ClientMessage)
      await ch.next()
      const silent = net.connect(h.address)
      await new Promise((r) => silent.once('connect', r))
      await vi.waitFor(() => expect(h.s.knownSockets()).toBe(2))
      greetedSock.end()
      silent.end()
      await vi.waitFor(() => expect(h.s.knownSockets()).toBe(0))
    })

    it('answers null for every socket once the server has closed (S6 R1, review of Task 1)', async () => {
      const seen: number[] = []
      const h = await server({
        onMessage: (m, _send, from) => {
          if (m.t === 'pty-list') seen.push(from.socket)
          return false
        }
      })
      const sock = net.connect(h.address)
      sock.on('error', () => {})
      await new Promise((r) => sock.once('connect', r))
      const ch = messageChannel(sock)
      ch.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'app', yields: ['rolling'] } as ClientMessage)
      await ch.next()
      ch.send({ t: 'pty-list' })
      await vi.waitFor(() => expect(seen).toHaveLength(1))
      expect(h.s.yieldsOf(seen[0])?.has('rolling')).toBe(true)
      await h.s.close()
      expect(h.s.yieldsOf(seen[0])).toBeNull()
      expect(h.s.knownSockets()).toBe(0)
    })

    it('does not count a CLI as an app that keeps anything', async () => {
      const h = await start()
      await h.connect('cli')
      expect(h.s.appKeeps('worktrees')).toBe(false)
    })

    it('says any attached app keeps a duty when even one of them did not yield it (R1)', async () => {
      const changed: string[] = []
      const h = await server({ onAppsChanged: () => changed.push(String(h.s.appsKeep('dispatch'))) })
      const hello = async (extra: Record<string, unknown>): Promise<net.Socket> => {
        const sock = net.connect(h.address)
        await new Promise((r) => sock.once('connect', r))
        const ch = messageChannel(sock)
        ch.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'app', ...extra } as ClientMessage)
        await ch.next()
        return sock
      }
      expect(h.s.appsKeep('dispatch')).toBe(false)
      const fresh = await hello({ yields: ['worktrees', 'dispatch'] })
      expect(h.s.appsKeep('dispatch')).toBe(false)
      const old = await hello({ yields: ['worktrees'] }) // second socket, an S3 app
      expect(h.s.appsKeep('dispatch')).toBe(true)
      expect(h.s.appKeeps('dispatch')).toBe(false) // the S3 question is still about the first app only
      old.end()
      await vi.waitFor(() => expect(h.s.appsKeep('dispatch')).toBe(false))
      fresh.end()
      await vi.waitFor(() => expect(h.s.hasApp()).toBe(false))
      // Told on each app hello and each app close, in the same turn (§4.3): two hellos, two closes.
      expect(changed).toEqual(['false', 'true', 'false', 'false'])
    })

    it('says whether any attached app yields a duty, the question the workspace pushes ask (P6)', async () => {
      const h = await server()
      const hello = async (extra: Record<string, unknown>): Promise<net.Socket> => {
        const sock = net.connect(h.address)
        await new Promise((r) => sock.once('connect', r))
        const ch = messageChannel(sock)
        ch.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', ...extra } as ClientMessage)
        await ch.next()
        return sock
      }
      expect(h.s.appsYield('workspace')).toBe(false)
      const cli = await hello({ role: 'cli', yields: ['workspace'] })
      expect(h.s.appsYield('workspace')).toBe(false)
      const old = await hello({ role: 'app', yields: ['worktrees'] })
      expect(h.s.appsYield('workspace')).toBe(false)
      const fresh = await hello({ role: 'app', yields: ['worktrees', 'workspace'] })
      expect(h.s.appsYield('workspace')).toBe(true)
      fresh.end()
      await vi.waitFor(() => expect(h.s.appsYield('workspace')).toBe(false))
      old.end()
      cli.end()
    })

    it('does not tell anyone about a CLI coming or going', async () => {
      const onAppsChanged = vi.fn()
      const h = await start({ onAppsChanged })
      const cli = await h.connect('cli')
      cli.socket.end()
      await new Promise((r) => setTimeout(r, 100))
      expect(onAppsChanged).not.toHaveBeenCalled()
    })

    it('a throwing onAppsChanged is logged and costs the handshake nothing', async () => {
      const h = await server({ onAppsChanged: () => { throw new Error('boom') } })
      const sock = net.connect(h.address)
      await new Promise((r) => sock.once('connect', r))
      const ch = messageChannel(sock)
      ch.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', role: 'app' } as ClientMessage)
      expect(await ch.next()).toMatchObject({ t: 'hello' })
      expect(h.logs.join('\n')).toMatch(/boom/)
      sock.end()
    })

    // call 은 세는 수라 누구나 맞힐 수 있다 — 물어본 소켓이 아닌 곳의 답을 받으면 앱이 내지도
    // 않은 결과 위에서 명령 층이 움직인다.
    it('물어본 소켓이 아닌 곳의 답은 받지 않는다', async () => {
      const h = await start({})
      const app = await h.connect('app')
      const cli = await h.connect('cli')
      const answer = h.s.act('startWorker', {})
      const asked = (await app.next()) as { call: string }
      cli.send({ t: 'orch-acted', call: asked.call, ok: true, value: { sessionId: 'forged' } })
      // 진짜 답이 오기 전까지는 아무 일도 일어나지 않는다.
      expect(await Promise.race([answer, new Promise((r) => setTimeout(() => r('still waiting'), 200))])).toBe('still waiting')
      app.send({ t: 'orch-acted', call: asked.call, ok: true, value: { sessionId: 's1' } })
      expect(await answer).toEqual({ sessionId: 's1' })
    })

    /**
     * **붙어 있으면서 답을 안 하는 앱** — 세 가지(앱 없음·끊김·Host 종료)가 못 덮는 네 번째다.
     * 소켓은 멀쩡하므로 아무도 깨우러 오지 않고, 이 서버의 악수 시한은 hello *전*의 침묵에 대한
     * 것이다. 침묵한 상대를 재는 수는 이미 하나 있다(unresponsive.ts) — 두 번째 수를 만들면 둘이
     * 갈라진다.
     */
    it('앱이 붙어만 있고 답하지 않으면 시한을 넘길 때 거절한다', async () => {
      vi.useFakeTimers()
      try {
        const h = await start({})
        const app = await h.connect('app')
        const answer = h.s.act('startWorker', {})
        const caught = answer.catch((e: Error) => e)
        await vi.advanceTimersByTimeAsync(HOST_UNRESPONSIVE_MS + 10)
        const err = await caught
        expect(err).toBeInstanceOf(AppUnreachable)
        // 앱이 아예 없는 경우와 문구가 달라야 한다 — 사람이 읽고 무엇을 할지 갈린다.
        expect(String(err)).toMatch(/attached but did not answer/)
        expect(String(err)).not.toMatch(/APP_REQUIRED/)
        app.socket.destroy()
      } finally {
        vi.useRealTimers()
      }
    })

    // 답을 못 받는 약속을 남겨 두면 그 뒤의 CLI 호출이 Host 가 사는 내내 매달린다.
    it('앱이 답하기 전에 끊으면 그 자리에서 거절한다', async () => {
      const h = await start({})
      const app = await h.connect('app')
      const answer = h.s.act('startWorker', {})
      await app.next() // orch-act 가 나간 것을 본 뒤에 끊는다
      app.socket.destroy()
      await expect(answer).rejects.toThrow(/disconnected/)
    })
  })
})

// posix only: on win32 a pipe name disappears with the process that made it, so there is nothing
// stale to find.
describe.runIf(process.platform !== 'win32')('a socket file left behind', () => {
  it('is replaced when nobody is listening on it', async () => {
    const addr = hostAddress({ profileDir: path.join(dir, 'stale'), platform: process.platform, tmpDir: dir, protocol: HOST_PROTOCOL })
    await fs.mkdir(addr.dirToPrepare!, { recursive: true, mode: 0o700 })
    await fs.writeFile(addr.address, '')
    const s = await startHostServer({
      address: addr.address,
      dirToPrepare: addr.dirToPrepare,
      version: '9.9.9',
      idleMs: 60_000,
      onIdle: () => {},
      log: { write: () => {}, close: () => {} }
    })
    open.push(s)
    const [reply] = await talk(addr.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    expect(reply).toMatchObject({ t: 'hello' })
  })

  it('puts the socket in a directory only this user can open', async () => {
    const h = await server({ profile: 'perms' })
    const st = await fs.stat(path.dirname(h.address))
    expect(st.mode & 0o777).toBe(0o700)
  })

  // The test above only covers the directory this Host made. `mkdir` with `recursive: true` neither
  // errors nor changes the mode of a directory that is already there, so on linux — where the parent
  // is /tmp at 1777 and the address key is a hash of a guessable profile path — another local user
  // can create the name first and leave it open to everyone. Binding inside it would put the channel
  // where anybody can reach it, so the Host refuses the address instead.
  it('refuses an address whose directory is open to everyone', async () => {
    const logs: string[] = []
    const addr = hostAddress({ profileDir: path.join(dir, 'loose'), platform: process.platform, tmpDir: dir, protocol: HOST_PROTOCOL })
    await fs.mkdir(addr.dirToPrepare!, { recursive: true })
    // chmod rather than mkdir's `mode`, which the umask trims.
    await fs.chmod(addr.dirToPrepare!, 0o777)
    await expect(
      startHostServer({
        address: addr.address,
        dirToPrepare: addr.dirToPrepare,
        version: '9.9.9',
        idleMs: 60_000,
        onIdle: () => {},
        log: { write: (m) => logs.push(m), close: () => {} }
      })
    ).rejects.toThrow(UNSAFE_ADDRESS_DIR)
    expect(logs.some((l) => l.includes(addr.dirToPrepare!))).toBe(true)
    // Nothing was bound: the refusal happens before listen.
    await expect(fs.stat(addr.address)).rejects.toThrow()
  })
})

// S6 Task 3 (D4): the Host sends a newly greeted app its whole block registry, right after the hello.
describe('onAppGreeted', () => {
  const hello = async (address: string, role?: 'app' | 'cli') => {
    const sock = net.connect(address)
    await new Promise((r) => sock.once('connect', r))
    const ch = messageChannel(sock)
    ch.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', ...(role ? { role } : {}) } as ClientMessage)
    return { sock, ch }
  }

  it('an app hears what it sends after its own hello, and only that socket does', async () => {
    const h = await server({ onAppGreeted: (send) => send({ t: 'blocks', records: {}, cleared: [{ accountId: 'a', at: 1 }] }) })
    const cli = await hello(h.address, 'cli')
    expect(await cli.ch.next()).toMatchObject({ t: 'hello' })
    const app = await hello(h.address, 'app')
    expect(await app.ch.next()).toMatchObject({ t: 'hello' })
    expect(await app.ch.next()).toEqual({ t: 'blocks', records: {}, cleared: [{ accountId: 'a', at: 1 }] })
    expect(await cli.ch.next(200)).toBeUndefined()
    cli.sock.end()
    app.sock.end()
  })

  it('is not called for a CLI, nor for a hello with no role', async () => {
    const onAppGreeted = vi.fn()
    const h = await server({ onAppGreeted })
    for (const role of ['cli', undefined] as const) {
      const c = await hello(h.address, role)
      expect(await c.ch.next()).toMatchObject({ t: 'hello' })
      c.sock.end()
    }
    expect(onAppGreeted).not.toHaveBeenCalled()
  })

  it('a throwing onAppGreeted is logged and costs the handshake nothing', async () => {
    const h = await server({ onAppGreeted: () => { throw new Error('greet boom') } })
    const app = await hello(h.address, 'app')
    expect(await app.ch.next()).toMatchObject({ t: 'hello' })
    expect(h.logs.join(' ')).toMatch(/greet boom/)
    expect(h.s.hasApp()).toBe(true)
    app.sock.end()
  })
})

// Stage 3 T4: the whole state goes out on every commit, and it grows. A client that reads it as "the
// latest" (HOST_YIELD_ORCH_STATE_LATEST) gets at most one push per ORCH_STATE_PUSH_MS, always the
// newest, and never a held push behind a message that follows it.
//
// The clock and the trailing timer are injected (`stateClock`), so nothing here waits out a real
// 100 ms: a trailing push goes out when the test fires it. The only real waits are the short ones that
// check nothing more arrived.
describe('orch-state pushes to a client that reads the latest', () => {
  const QUIET_MS = 60
  const st = (version: number): HostMessage => ({ t: 'orch-state', state: emptyState(), version })
  const versionOf = (m: unknown): number | undefined =>
    (m as { t?: string } | undefined)?.t === 'orch-state' ? (m as { version: number }).version : undefined
  /** A monotonic clock the test moves, and the trailing timers the server asked for. */
  const fakeClock = (): {
    clock: NonNullable<HostServerDeps['stateClock']>
    at: { now: number }
    timers: Array<{ ms: number; fn: () => void; cancelled: boolean }>
    live(): number
    fire(): void
  } => {
    const at = { now: 1_000_000 }
    const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = []
    return {
      at,
      timers,
      clock: {
        now: () => at.now,
        after: (ms, fn) => {
          const t = { ms, fn, cancelled: false }
          timers.push(t)
          return () => {
            t.cancelled = true
          }
        }
      },
      live: () => timers.filter((t) => !t.cancelled).length,
      fire: () => {
        for (const t of timers.splice(0)) if (!t.cancelled) t.fn()
      }
    }
  }
  const connectAs = async (
    address: string,
    hello: { role?: 'app' | 'cli'; yields?: string[] }
  ): Promise<{ sock: net.Socket; ch: ReturnType<typeof messageChannel> }> => {
    const sock = net.connect(address)
    await new Promise((r) => sock.once('connect', r))
    const ch = messageChannel(sock)
    ch.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0', ...hello } as ClientMessage)
    await ch.next()
    return { sock, ch }
  }
  const latest = { role: 'app' as const, yields: [HOST_YIELD_ORCH_STATE_LATEST] }
  /** An orch whose every call is a state-put from the caller: it pushes `version` to the others. */
  const putOrch = (version: number): HostServerDeps['orch'] => ({
    call: async ({ from }) => {
      from?.toOthers(st(version))
      return { status: 200, body: { ok: true, version } }
    }
  })

  it('sends the first at once and then only the newest of a burst, to an app and to a CLI', async () => {
    const c = fakeClock()
    const h = await server({ stateClock: c.clock })
    const app = await connectAs(h.address, latest)
    const cli = await connectAs(h.address, { role: 'cli' })
    for (let v = 1; v <= 5; v++) h.s.broadcast(st(v))
    for (const x of [app, cli]) expect(versionOf(await x.ch.next())).toBe(1)
    for (const x of [app, cli]) expect(await x.ch.next(QUIET_MS)).toBeUndefined()
    // One trailing timer per socket, each no longer than the gap.
    expect(c.live()).toBe(2)
    for (const t of c.timers) expect(t.ms).toBeLessThanOrEqual(ORCH_STATE_PUSH_MS)
    c.at.now += ORCH_STATE_PUSH_MS
    c.fire()
    for (const x of [app, cli]) {
      expect(versionOf(await x.ch.next())).toBe(5)
      expect(await x.ch.next(QUIET_MS)).toBeUndefined()
    }
    app.sock.end()
    cli.sock.end()
  })

  // Review of T4 (Important): with the wall clock, a step back (an NTP correction, a resume from sleep)
  // made `now - lastAt` negative and the trailing push was scheduled for the size of the jump, so a
  // quiet app showed a stale state for minutes. The clock is monotonic now, and the wait is clamped to
  // the gap whatever the clock says.
  it('never waits longer than the gap for the trailing push, even when the clock steps back', async () => {
    const c = fakeClock()
    const h = await server({ stateClock: c.clock })
    const app = await connectAs(h.address, latest)
    h.s.broadcast(st(1))
    expect(versionOf(await app.ch.next())).toBe(1)
    c.at.now -= 10 * 60_000
    h.s.broadcast(st(2))
    expect(c.timers).toHaveLength(1)
    expect(c.timers[0].ms).toBeGreaterThanOrEqual(0)
    expect(c.timers[0].ms).toBeLessThanOrEqual(ORCH_STATE_PUSH_MS)
    c.fire()
    expect(versionOf(await app.ch.next())).toBe(2)
    app.sock.end()
  })

  it('reads a monotonic clock by default, not the wall clock', async () => {
    const h = await server()
    const app = await connectAs(h.address, latest)
    h.s.broadcast(st(1))
    // The wall clock steps back ten minutes: read, it would put the trailing push ten minutes away.
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 10 * 60_000)
    try {
      h.s.broadcast(st(2))
      expect(versionOf(await app.ch.next())).toBe(1)
      expect(versionOf(await app.ch.next(ORCH_STATE_PUSH_MS * 20))).toBe(2)
    } finally {
      spy.mockRestore()
    }
    app.sock.end()
  })

  it('still pushes every commit to an app that does not read the latest', async () => {
    const c = fakeClock()
    const h = await server({ stateClock: c.clock })
    const older = await connectAs(h.address, { role: 'app', yields: ['journal'] })
    for (let v = 1; v <= 3; v++) h.s.broadcast(st(v))
    for (let v = 1; v <= 3; v++) expect(versionOf(await older.ch.next())).toBe(v)
    expect(c.timers).toHaveLength(0)
    older.sock.end()
  })

  it('sends a held push before any other message, and not a second time after', async () => {
    const c = fakeClock()
    const h = await server({ stateClock: c.clock })
    const app = await connectAs(h.address, latest)
    h.s.broadcast(st(1))
    h.s.broadcast(st(2))
    h.s.broadcast({ t: 'pty-exit', id: 'p1', exitCode: 0 })
    expect(versionOf(await app.ch.next())).toBe(1)
    expect(versionOf(await app.ch.next())).toBe(2)
    expect(await app.ch.next()).toEqual({ t: 'pty-exit', id: 'p1', exitCode: 0 })
    // The flush cancelled the trailing timer: firing whatever is left sends nothing.
    expect(c.live()).toBe(0)
    c.fire()
    expect(await app.ch.next(QUIET_MS)).toBeUndefined()
    app.sock.end()
  })

  // An `orch-act` is read against the mirror (the app looks up the Dispatch the Host just opened), so
  // the state that commit left goes out ahead of it.
  it('sends a held push before an orch-act to the app', async () => {
    const c = fakeClock()
    const h = await server({ stateClock: c.clock })
    const app = await connectAs(h.address, latest)
    h.s.broadcast(st(1))
    h.s.broadcast(st(2))
    const acted = h.s.act('spawn', ['x'])
    expect(versionOf(await app.ch.next())).toBe(1)
    expect(versionOf(await app.ch.next())).toBe(2)
    const ask = (await app.ch.next()) as { t: string; call: string; act: string }
    expect(ask).toMatchObject({ t: 'orch-act', act: 'spawn' })
    app.ch.send({ t: 'orch-acted', call: ask.call, ok: true, value: 'done' } as ClientMessage)
    await expect(acted).resolves.toBe('done')
    expect(c.live()).toBe(0)
    c.fire()
    expect(await app.ch.next(QUIET_MS)).toBeUndefined()
    app.sock.end()
  })

  it('lets terminal output pass a held push', async () => {
    const c = fakeClock()
    const h = await server({ stateClock: c.clock })
    const app = await connectAs(h.address, latest)
    h.s.broadcast(st(1))
    h.s.broadcast(st(2))
    h.s.broadcast({ t: 'pty-data', id: 'p1', data: 'out' })
    expect(versionOf(await app.ch.next())).toBe(1)
    expect(await app.ch.next()).toEqual({ t: 'pty-data', id: 'p1', data: 'out' })
    expect(await app.ch.next(QUIET_MS)).toBeUndefined()
    c.fire()
    expect(versionOf(await app.ch.next())).toBe(2)
    app.sock.end()
  })

  // A caller that awaits its own mutation reads its mirror when the reply lands: the state that
  // mutation left must be there by then, held or not.
  it('sends the state a call committed before that call’s reply', async () => {
    const c = fakeClock()
    let s!: HostServer
    const h = await server({
      stateClock: c.clock,
      orch: {
        call: async () => {
          s.broadcast(st(2))
          return { status: 200, body: { ok: true } }
        }
      }
    })
    s = h.s
    const app = await connectAs(h.address, latest)
    h.s.broadcast(st(1))
    expect(versionOf(await app.ch.next())).toBe(1)
    app.ch.send({ t: 'orch-call', call: 'c1', cmd: 'tasks-update', args: {}, session: '' } as ClientMessage)
    expect(versionOf(await app.ch.next())).toBe(2)
    expect(await app.ch.next()).toMatchObject({ t: 'orch-result', call: 'c1', status: 200 })
    c.fire()
    expect(await app.ch.next(QUIET_MS)).toBeUndefined()
    app.sock.end()
  })

  // `state-put` pushes to the others only: the sender already holds that state, and a push of an older
  // one arriving after its own write would put its mirror back (orch.ts, statePut). So what was held
  // for the sender is dropped, its trailing timer with it, and the others get the newest.
  it('drops what was held for the sender of a state-put, timer and all, and sends the others the newest', async () => {
    const c = fakeClock()
    const h = await server({ stateClock: c.clock, orch: putOrch(3) })
    const a = await connectAs(h.address, latest)
    const b = await connectAs(h.address, latest)
    h.s.broadcast(st(1))
    h.s.broadcast(st(2))
    expect(versionOf(await a.ch.next())).toBe(1)
    expect(versionOf(await b.ch.next())).toBe(1)
    expect(c.live()).toBe(2)
    a.ch.send({ t: 'orch-call', call: 'put', cmd: 'state-put', args: {}, session: '' } as ClientMessage)
    expect(await a.ch.next()).toMatchObject({ t: 'orch-result', call: 'put', status: 200 })
    // a's timer is gone; b's is still waiting, now holding 3.
    expect(c.live()).toBe(1)
    c.fire()
    expect(await a.ch.next(QUIET_MS)).toBeUndefined()
    expect(versionOf(await b.ch.next())).toBe(3)
    expect(await b.ch.next(QUIET_MS)).toBeUndefined()
    a.sock.end()
    b.sock.end()
  })

  // After a drop the next push is judged by the gap as usual: held when it comes within it, and sent by
  // a trailing timer of its own.
  it('holds a push that comes after a drop and sends it on a fresh trailing timer', async () => {
    const c = fakeClock()
    const h = await server({ stateClock: c.clock, orch: putOrch(3) })
    const a = await connectAs(h.address, latest)
    h.s.broadcast(st(1))
    h.s.broadcast(st(2))
    expect(versionOf(await a.ch.next())).toBe(1)
    a.ch.send({ t: 'orch-call', call: 'put', cmd: 'state-put', args: {}, session: '' } as ClientMessage)
    expect(await a.ch.next()).toMatchObject({ t: 'orch-result', call: 'put' })
    expect(c.live()).toBe(0)
    h.s.broadcast(st(4))
    expect(await a.ch.next(QUIET_MS)).toBeUndefined()
    expect(c.live()).toBe(1)
    c.fire()
    expect(versionOf(await a.ch.next())).toBe(4)
    expect(await a.ch.next(QUIET_MS)).toBeUndefined()
    a.sock.end()
  })
})
