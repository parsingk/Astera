import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { hostAddress } from './address'
import { encodeLine, createLineReader } from './framing'
import { startHostServer, ADDRESS_TAKEN, UNSAFE_ADDRESS_DIR, type HostServer, type HostServerDeps } from './server'
import { createHostOrch } from './orch'
import { HOST_PROTOCOL, type ClientMessage } from '../core/host/protocol'
import { versionOnlyOrchCall, AppUnreachable } from '../core/host/orchProtocol'
import { HOST_UNRESPONSIVE_MS } from '../core/host/unresponsive'

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
    holdsWork?: HostServerDeps['holdsWork']
    liveCounts?: HostServerDeps['liveCounts']
    orch?: HostServerDeps['orch']
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
    holdsWork: over.holdsWork,
    liveCounts: over.liveCounts,
    orch: over.orch ?? versionOnlyOrchCall({ version }),
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
        const timer = setTimeout(() => resolve(undefined), waitMs)
        waiters.push((v) => {
          clearTimeout(timer)
          resolve(v)
        })
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
    holdsWork?: HostServerDeps['holdsWork']
    liveCounts?: HostServerDeps['liveCounts']
    /** The default is the version-only stub, which is what almost every test here wants. Overridden
     *  by the one test that has to talk to the real command layer over a real socket. */
    orch?: HostServerDeps['orch']
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
  connect(role?: 'app' | 'cli'): Promise<{
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
    expect(reply).toMatchObject({ t: 'hello', protocol: HOST_PROTOCOL, host: '9.9.9', pid: process.pid, features: ['proc', 'ping', 'orch'] })
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
    const [reply] = await talk(h.address, [{ t: 'pty-list' } as never])
    expect(reply).toEqual({ t: 'pty-listed', entries: [] })
    expect(seen).toContain('pty-list')
  })

  // A Host holding a terminal must not leave when the app closes: that terminal is the whole reason
  // the Host exists (slice 2 design §2.2).
  it('does not leave on the idle timer while something is holding it', async () => {
    let idle = false
    let holding = true
    const h = await server({ idleMs: 50, onIdle: () => { idle = true }, holdsWork: () => holding })
    await talk(h.address, [{ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' }])
    await new Promise((r) => setTimeout(r, 300))
    expect(idle).toBe(false)
    holding = false
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
        log: () => {}
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

    // role 없는 hello 는 CLI 다. 앱이라고 가정하면, 그런 옛 앱은 답할 줄 모르는 orch-act 를 받고
    // 부른 쪽은 영영 기다린다(F12).
    it('role 을 안 밝힌 클라이언트는 앱이 아니다', async () => {
      const h = await start({})
      await h.connect() // role 없이
      await h.connect('cli')
      expect(h.s.hasApp()).toBe(false)
      await expect(h.s.act('startWorker', {})).rejects.toThrow(/APP_REQUIRED/)
    })

    it('앱이 붙어 있으면 hasApp 이 참이다', async () => {
      const h = await start({})
      expect(h.s.hasApp()).toBe(false)
      await h.connect('app')
      expect(h.s.hasApp()).toBe(true)
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
