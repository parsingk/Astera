import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { hostAddress } from './address'
import { encodeLine, createLineReader } from './framing'
import { startHostServer, ADDRESS_TAKEN, UNSAFE_ADDRESS_DIR, type HostServer, type HostServerDeps } from './server'
import { HOST_PROTOCOL, type ClientMessage } from '../core/host/protocol'
import { versionOnlyOrchCall } from '../core/host/orchProtocol'

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
  over: { holdsWork?: HostServerDeps['holdsWork']; liveCounts?: HostServerDeps['liveCounts'] } = {}
): Promise<{
  address: string
  stopped: boolean
  /** The version this Host was started with — the same one its `orch-call version` answers with. */
  version: string
  /** Connects, completes the handshake, and hands back something to send with and read replies from. */
  connect(): Promise<{ send(m: ClientMessage): void; next(waitMs?: number): Promise<unknown> }>
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
    get stopped() {
      return state.stopped
    },
    connect: async () => {
      const sock = await rawConnect()
      const chan = messageChannel(sock)
      chan.send({ t: 'hello', protocol: HOST_PROTOCOL, app: '1.0.0' })
      await chan.next() // the hello reply — consumed here so next() starts on whatever comes after it.
      return chan
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
    const h = await start({ liveCounts: () => ({ sessions: 2, jobs: 1 }) })
    const client = await h.connect()
    client.send({ t: 'retire', reason: 'user' })
    const m = await client.next()
    expect(m).toEqual({ t: 'retire-refused', sessions: 2, jobs: 1 })
    expect(h.stopped).toBe(false)
  })

  it('일하는 것이 없으면 사람의 retire 를 그대로 받아들인다', async () => {
    const h = await start({ liveCounts: () => ({ sessions: 0, jobs: 0 }) })
    const client = await h.connect()
    client.send({ t: 'retire', reason: 'user' })
    await new Promise((r) => setTimeout(r, 100))
    expect(h.stopped).toBe(true)
  })

  // ruling 3: `reason` 이 없는(=`'protocol'`) retire 는 이 거절을 받지 않는다 — 앱이 프로토콜이
  // 다른 Host 를 찾았을 때 보내는 것이 이 경우이고, 그 Host 의 세션은 이미 그 앱에게 닿지 않는다.
  it('reason 이 없는(protocol) retire 는 일하는 것이 있어도 거절하지 않는다', async () => {
    const h = await start({ liveCounts: () => ({ sessions: 2, jobs: 1 }) })
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
