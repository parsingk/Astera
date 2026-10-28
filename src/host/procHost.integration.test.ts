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
import { appProof, ensureAppKey } from '../core/host/hostKey'

const ECHO = 'process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => process.stdout.write("echo:" + d))'
/** The app key the servers here check an app's proof against (sandbox follow-ups, item 1). */
const APP_KEY = 'a'.repeat(64)

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

/** A client that says hello and collects everything the Host says: as the app, unless `role` names another. An app
 *  answers the Host's challenge under `proveWith` (APP_KEY unless given; null answers nothing) before anything the test
 *  sends after the hello, as the app's own client does (main/host/client.ts). */
function client(address: string, role: 'app' | 'cli' = 'app', proveWith: string | null = APP_KEY): Promise<{ send(m: ClientMessage): void; got: HostMessage[]; waitFor(p: (m: HostMessage) => boolean, ms?: number): Promise<HostMessage>; end(): void }> {
  return new Promise((resolve, reject) => {
    const got: HostMessage[] = []
    const waiters: Array<{ p: (m: HostMessage) => boolean; res: (m: HostMessage) => void }> = []
    const sock = net.connect(address)
    sock.setEncoding('utf8')
    const read = createLineReader({
      onMessage: (v) => {
        const m = v as HostMessage
        if (m.t === 'hello' && typeof m.challenge === 'string' && proveWith !== null) sock.write(encodeLine({ t: 'app-proof', proof: appProof(proveWith, m.challenge) }))
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
      appKey: () => APP_KEY,
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
  /** The server wired as host/index.ts wires it, with a pty registry that records what it was asked to start. */
  const wired = async (): Promise<{ address: string; spawned: string[]; typed: string[]; emit(data: string): void; ptys: PtyRegistry; procs: ProcRegistry }> => {
    const addr = hostAddress({ profileDir: path.join(dir, 'profile'), platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL })
    const spawned: string[] = []
    const typed: string[] = []
    let onData: (d: string) => void = () => {}
    const ptys = new PtyRegistry({
      spawn: (file) => {
        spawned.push(`pty ${file}`)
        return { pid: 7, onData: (cb) => void (onData = cb), onExit: () => {}, write: (d) => void typed.push(d), resize: () => {}, kill: () => {}, pause: () => {}, resume: () => {} }
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
      appKey: () => APP_KEY,
      log: { write: () => {}, close: () => {} }
    })
    open.push(s)
    handlePty = attachPtyHost({ registry: ptys, broadcast: (m, to) => s.broadcast(m, to) })
    handleProc = attachProcHost({ registry: procs, broadcast: (m) => s.broadcast(m) })
    return { address: addr.address, spawned, typed, emit: (d) => onData(d), ptys, procs }
  }
  /** Asks for a pty and a line process and answers whether each was refused. */
  const refusedBoth = async (c: Awaited<ReturnType<typeof client>>, n: number): Promise<void> => {
    c.send({ t: 'pty-spawn', id: `p${n}`, file: 'calc.exe', args: [], opts: { cwd: process.cwd(), cols: 80, rows: 24, env: {} } })
    expect(await c.waitFor((m) => (m.t === 'pty-failed' || m.t === 'pty-spawned') && m.id === `p${n}`)).toEqual({ t: 'pty-failed', id: `p${n}`, error: 'pty-spawn is served to the Astera app only' })
    c.send({ t: 'proc-spawn', id: `q${n}`, file: process.execPath, args: ['-e', ECHO], opts: { cwd: process.cwd(), env: process.env as Record<string, string | undefined> } })
    expect(await c.waitFor((m) => (m.t === 'proc-failed' || m.t === 'proc-spawned') && m.id === `q${n}`)).toEqual({ t: 'proc-failed', id: `q${n}`, error: 'proc-spawn is served to the Astera app only' })
  }

  it('a cli greeting asking for pty-spawn or proc-spawn is refused, and the app’s is served', async () => {
    const w = await wired()
    const cli = await client(w.address, 'cli')
    await cli.waitFor((m) => m.t === 'hello')
    await refusedBoth(cli, 1)
    expect(w.spawned).toEqual([])
    expect(w.procs.liveCount()).toBe(0)

    const app = await client(w.address)
    await app.waitFor((m) => m.t === 'hello')
    app.send({ t: 'pty-spawn', id: 'p2', file: 'shell', args: [], opts: { cwd: process.cwd(), cols: 80, rows: 24, env: {} } })
    expect(await app.waitFor((m) => m.t === 'pty-spawned' || m.t === 'pty-failed')).toEqual({ t: 'pty-spawned', id: 'p2', pid: 7 })
    expect(w.spawned).toEqual(['pty shell'])
    cli.end()
    app.end()
  })

  // Sandbox follow-ups, item 1: saying `role: 'app'` is not enough. A socket that never answers its challenge, or answers
  // it with another profile's app key, is refused both spawns as a CLI is.
  it('an app greeting that does not prove it, or proves it with another profile’s key, is refused both spawns', async () => {
    const w = await wired()
    const silent = await client(w.address, 'app', null)
    await silent.waitFor((m) => m.t === 'hello')
    await refusedBoth(silent, 1)
    const other = await client(w.address, 'app', await ensureAppKey(path.join(dir, 'other-profile')))
    await other.waitFor((m) => m.t === 'app-proven')
    await refusedBoth(other, 2)
    expect(w.spawned).toEqual([])
    expect(w.procs.liveCount()).toBe(0)
    silent.end()
    other.end()
  })

  // Sandbox follow-ups, round 2: past the spawn, every pty and proc message is the proven app's too. A CLI's socket and
  // one that said it is the app and never proved it reach a terminal and a chat process the app started: nothing they
  // send is typed, read back, listed or answered, and the app is served all of it as before.
  it('a socket that is not the proven app reads and drives no terminal or process', async () => {
    const w = await wired()
    const app = await client(w.address)
    await app.waitFor((m) => m.t === 'app-proven')
    app.send({ t: 'pty-spawn', id: 'p1', file: 'shell', args: [], opts: { cwd: process.cwd(), cols: 80, rows: 24, env: {} } })
    await app.waitFor((m) => m.t === 'pty-spawned')
    app.send({ t: 'proc-spawn', id: 'q1', file: process.execPath, args: ['-e', ECHO], opts: { cwd: process.cwd(), env: process.env as Record<string, string | undefined> } })
    await app.waitFor((m) => m.t === 'proc-spawned')
    // Both are connected before the output and the line are emitted: the push direction, not only the requests
    const others = [await client(w.address, 'cli'), await client(w.address, 'app', null)]
    for (const other of others) await other.waitFor((m) => m.t === 'hello')
    w.emit('a secret on the screen')
    app.send({ t: 'proc-write', id: 'q1', line: 'secret' })
    expect(await app.waitFor((m) => m.t === 'proc-line' && m.line === 'echo:secret')).toBeTruthy()
    expect(await app.waitFor((m) => m.t === 'pty-data' && m.data === 'a secret on the screen')).toBeTruthy()
    for (const other of others) {
      for (const m of [
        { t: 'pty-write', id: 'p1', data: 'rm -rf ~\r', typed: true },
        { t: 'pty-resize', id: 'p1', cols: 100, rows: 40 },
        { t: 'pty-note', id: 'p1', patch: { title: 'taken' } },
        { t: 'pty-list' },
        { t: 'pty-attach', id: 'p1' },
        { t: 'pty-kill', id: 'p1' },
        { t: 'proc-write', id: 'q1', line: 'leak', typed: true },
        { t: 'proc-list' },
        { t: 'proc-attach', id: 'q1' },
        { t: 'proc-kill', id: 'q1' }
      ] as ClientMessage[])
        other.send(m)
      await new Promise((r) => setTimeout(r, 300))
      expect(other.got.map((m) => m.t), 'heard or answered').toEqual(['hello'])
      other.end()
    }
    expect(w.typed).toEqual([])
    expect(w.ptys.lastPersonWrite('p1')).toBeNull()
    expect(w.ptys.metaOf('p1')?.restore ?? {}).not.toHaveProperty('title')
    expect(w.ptys.list().find((e) => e.id === 'p1')?.alive).toBe(true)
    expect(w.procs.list().find((e) => e.id === 'q1')?.alive).toBe(true)
    expect(app.got.some((m) => m.t === 'proc-line' && m.line === 'echo:leak')).toBe(false)
    // The app is served as before
    app.send({ t: 'pty-write', id: 'p1', data: 'ls\r', typed: true })
    app.send({ t: 'pty-attach', id: 'p1' })
    expect(await app.waitFor((m) => m.t === 'pty-data' && m.data === 'a secret on the screen')).toBeTruthy()
    app.send({ t: 'proc-write', id: 'q1', line: 'ok' })
    expect(await app.waitFor((m) => m.t === 'proc-line' && m.line === 'echo:ok')).toBeTruthy()
    expect(w.typed).toEqual(['ls\r'])
    app.send({ t: 'proc-kill', id: 'q1' })
    await app.waitFor((m) => m.t === 'proc-exit')
    app.end()
  })
})
