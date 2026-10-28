// The whole Host path for a line process, over a real socket: spawn a node child through proc-spawn,
// talk to it, list it, replay to a second client, kill it. server.test.ts's harness, for procs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { hostAddress } from './address'
import { encodeLine, createLineReader } from './framing'
import { startHostServer, type HostServer } from './server'
import { attachProcHost } from './procHost'
import { attachPtyHost } from './ptyHost'
import { PtyRegistry } from './registry'
import { ProcRegistry } from './procRegistry'
import { nodeProcSpawn } from './nodeProc'
import { HOST_PROTOCOL, type ClientMessage, type HostMessage } from '../core/host/protocol'

const ECHO = 'process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => process.stdout.write("echo:" + d))'

let dir: string
let open: HostServer[] = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-host-proc-'))
  open = []
})
afterEach(async () => {
  for (const s of open) await s.close().catch(() => {})
  await fs.rm(dir, { recursive: true, force: true })
})

/** A client that says hello and collects everything the Host says: as the app, unless `role` names another. */
function client(address: string, role: 'app' | 'cli' = 'app'): Promise<{ send(m: ClientMessage): void; got: HostMessage[]; waitFor(p: (m: HostMessage) => boolean, ms?: number): Promise<HostMessage>; end(): void }> {
  return new Promise((resolve, reject) => {
    const got: HostMessage[] = []
    const waiters: Array<{ p: (m: HostMessage) => boolean; res: (m: HostMessage) => void }> = []
    const sock = net.connect(address)
    sock.setEncoding('utf8')
    const read = createLineReader({
      onMessage: (v) => {
        const m = v as HostMessage
        got.push(m)
        for (const w of [...waiters]) if (w.p(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m) }
      },
      onBadLine: () => {},
      onHandlerError: () => {}
    })
    sock.on('data', read)
    sock.on('error', reject)
    sock.on('connect', () => {
      sock.write(encodeLine({ t: 'hello', protocol: HOST_PROTOCOL, app: 'test', role }))
      resolve({
        send: (m) => { sock.write(encodeLine(m)) },
        got,
        waitFor: (p, ms = 8000) => new Promise((res, rej) => {
          const hit = got.find(p)
          if (hit) return res(hit)
          const timer = setTimeout(() => rej(new Error('timed out waiting for a Host message')), ms)
          waiters.push({ p, res: (m) => { clearTimeout(timer); res(m) } })
        }),
        end: () => sock.end()
      })
    })
  })
}

describe('proc-* over the Host server', () => {
  it('spawns, echoes, lists, replays to a late client, kills', async () => {
    const logs: string[] = []
    // tmpDir is os.tmpdir(), as the app passes it, rather than the fixture directory — nesting the
    // socket one level deeper than the app ever does overran sun_path (104 bytes) on macOS and
    // failed this with `listen EINVAL`. See the same note in src/main/host/client.test.ts.
    const addr = hostAddress({
      profileDir: path.join(dir, 'profile'),
      platform: process.platform,
      tmpDir: os.tmpdir(),
      protocol: HOST_PROTOCOL
    })
    const procs = new ProcRegistry({ spawn: nodeProcSpawn({ log: (m) => logs.push(m), platform: process.platform }), log: (m) => logs.push(m) })
    let handle: ReturnType<typeof attachProcHost> | null = null
    const s = await startHostServer({
      address: addr.address,
      dirToPrepare: addr.dirToPrepare,
      version: '9.9.9',
      idleMs: 60_000,
      onIdle: () => {},
      onMessage: (m, send, from) => handle?.(m, send, { socket: from.socket, role: from.role }) ?? false,
      liveCounts: () => ({ sessions: procs.liveCount(), runs: 0 }),
      log: { write: (m) => logs.push(m), close: () => {} }
    })
    open.push(s)
    handle = attachProcHost({ registry: procs, broadcast: (m) => s.broadcast(m) })

    const a = await client(addr.address)
    await a.waitFor((m) => m.t === 'hello')
    a.send({ t: 'proc-spawn', id: 'p1', file: process.execPath, args: ['-e', ECHO], opts: { cwd: process.cwd(), env: process.env as Record<string, string | undefined> }, meta: { kind: 'chat', id: 'chat_1', restore: { accountId: 'a1' } } })
    const spawned = await a.waitFor((m) => m.t === 'proc-spawned')
    expect((spawned as { pid: number }).pid).toBeGreaterThan(0)

    a.send({ t: 'proc-write', id: 'p1', line: 'ping' })
    const line = await a.waitFor((m) => m.t === 'proc-line')
    expect(line).toEqual({ t: 'proc-line', id: 'p1', seq: 1, line: 'echo:ping' })

    a.send({ t: 'proc-list' })
    const listed = await a.waitFor((m) => m.t === 'proc-listed')
    expect((listed as { entries: unknown[] }).entries).toEqual([{ id: 'p1', pid: (spawned as { pid: number }).pid, meta: { kind: 'chat', id: 'chat_1', restore: { accountId: 'a1' } }, alive: true, truncated: false }])

    // A second client — the app after a restart — gets the buffered line on attach, and only it does.
    const b = await client(addr.address)
    await b.waitFor((m) => m.t === 'hello')
    const before = a.got.length
    b.send({ t: 'proc-attach', id: 'p1' })
    const replayed = await b.waitFor((m) => m.t === 'proc-attached')
    expect(replayed).toEqual({ t: 'proc-attached', id: 'p1', lines: [{ seq: 1, line: 'echo:ping' }] })
    expect(a.got.length).toBe(before)

    a.send({ t: 'proc-kill', id: 'p1' })
    const exit = await a.waitFor((m) => m.t === 'proc-exit')
    expect((exit as { id: string }).id).toBe('p1')
    expect(procs.liveCount()).toBe(0)
    a.end()
    b.end()
  })
})

// Final fix pass (C2): pty-spawn and proc-spawn start any program outside every sandbox, so over the real server, wired
// as host/index.ts wires it, only a socket whose hello said `role: 'app'` is served them. A CLI's hello asking for one is
// refused and nothing starts; the app on another socket is served as before.
describe('spawns over the Host server are the app’s alone', () => {
  it('a cli greeting asking for pty-spawn or proc-spawn is refused, and the app’s is served', async () => {
    const addr = hostAddress({ profileDir: path.join(dir, 'profile'), platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL })
    const spawned: string[] = []
    const ptys = new PtyRegistry({
      spawn: (file) => {
        spawned.push(`pty ${file}`)
        return { pid: 7, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {}, pause: () => {}, resume: () => {} }
      },
      log: () => {}
    })
    const procs = new ProcRegistry({ spawn: nodeProcSpawn({ log: () => {}, platform: process.platform }), log: () => {} })
    let handlePty: ReturnType<typeof attachPtyHost> | null = null
    let handleProc: ReturnType<typeof attachProcHost> | null = null
    const s = await startHostServer({
      address: addr.address,
      dirToPrepare: addr.dirToPrepare,
      version: '9.9.9',
      idleMs: 60_000,
      onIdle: () => {},
      onMessage: (m, send, from) =>
        (handlePty?.(m, send, { socket: from.socket, role: from.role }) ?? false) || (handleProc?.(m, send, { socket: from.socket, role: from.role }) ?? false),
      liveCounts: () => ({ sessions: ptys.liveCount() + procs.liveCount(), runs: 0 }),
      log: { write: () => {}, close: () => {} }
    })
    open.push(s)
    handlePty = attachPtyHost({ registry: ptys, broadcast: (m, to) => s.broadcast(m, to) })
    handleProc = attachProcHost({ registry: procs, broadcast: (m) => s.broadcast(m) })

    const cli = await client(addr.address, 'cli')
    await cli.waitFor((m) => m.t === 'hello')
    cli.send({ t: 'pty-spawn', id: 'p1', file: 'calc.exe', args: [], opts: { cwd: process.cwd(), cols: 80, rows: 24, env: {} } })
    expect(await cli.waitFor((m) => m.t === 'pty-failed' || m.t === 'pty-spawned')).toEqual({ t: 'pty-failed', id: 'p1', error: 'pty-spawn is served to the Astera app only' })
    cli.send({ t: 'proc-spawn', id: 'q1', file: process.execPath, args: ['-e', ECHO], opts: { cwd: process.cwd(), env: process.env as Record<string, string | undefined> } })
    expect(await cli.waitFor((m) => m.t === 'proc-failed' || m.t === 'proc-spawned')).toEqual({ t: 'proc-failed', id: 'q1', error: 'proc-spawn is served to the Astera app only' })
    expect(spawned).toEqual([])
    expect(procs.liveCount()).toBe(0)

    const app = await client(addr.address)
    await app.waitFor((m) => m.t === 'hello')
    app.send({ t: 'pty-spawn', id: 'p2', file: 'shell', args: [], opts: { cwd: process.cwd(), cols: 80, rows: 24, env: {} } })
    expect(await app.waitFor((m) => m.t === 'pty-spawned' || m.t === 'pty-failed')).toEqual({ t: 'pty-spawned', id: 'p2', pid: 7 })
    expect(spawned).toEqual(['pty shell'])
    cli.end()
    app.end()
  })
})
